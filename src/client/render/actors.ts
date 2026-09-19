/**
 * Everything that moves, drawn from SimState alone.
 *
 * The sim owns positions, phases and life flags; this module owns only the
 * visual memory that makes them read well — fade-out timers for collected
 * pickups, damped "lit" values for checkpoints and the goal, observed travel
 * ranges for platform rails, turret aim smoothing, updraft streaks, and the
 * player's squash / trail / blink. None of it can influence a replay.
 */
import { TILE } from '../../sim/types.js';
import type { BoltState, EntityState, FoeState, PlayerState, SimState, TideState } from '../../sim/types.js';
import { PHYS } from '../../sim/config.js';
import type { Level } from '../../sim/level.js';
import { C, type Biome } from '../../shared/biomes.js';
import type { GhostView } from '../contracts.js';
import { Stage, TAU, UI_FONT, alpha, clamp, clamp01, damp, easeOutCubic, lerp, mixHex, sign } from './stage.js';
import { CHAIN_ANCHOR, CHAIN_N, CHAIN_SEG, SMILE_T, drawClawd, tintedSkin, type RigPose, type RigState, type Skin } from './clawd.js';
import type { Particles } from './particles.js';

const FOE_DIE_T = 0.3;
const SHARD_POP_T = 0.4;
const RELIC_POP_T = 0.7;
const TRAIL_N = 14;

// ============================================================ scene cues (P5-2)
/**
 * Visual cues the actors publish for the player visuals, render-side only:
 * the biome's wind (for the scarf chain) and the moment a pickup was consumed
 * (for the live player's smile). Module state on purpose, like clawd.ts's
 * look target: `Actors` and `PlayerVisual` are built separately by the
 * renderer and share nothing else. Echoes never read the pickup cue.
 */
const scene = { wind: 0, gust: 0, pickup: 0, t: 0 };
/** Wind strength and direction per weather (world units of drift per second, signed). */
const WIND_BY_WEATHER: Readonly<Record<Biome['weather'], number>> = { spray: 26, rain: -70, spores: 12, snow: 44 };
/** Seconds of pickup smile left for the live player (0 = none). */
export function pickupCue(): number { return scene.pickup; }
/** Current wind on the scarf (signed world units per second), gusts included. */
export function sceneWind(): number { return scene.wind * (1 + 0.6 * scene.gust); }

// ============================================================ foe anticipation (P5-2, pure)
/** Seconds before a hop during which the hopper crouches (FoeState.state counts down to the hop). */
export const HOPPER_CROUCH_T = 0.3;
/** 0 → 1 as the hopper's state runs out; 0 while it still has more than HOPPER_CROUCH_T to wait or is mid-air. */
export function hopperCrouch(state: number): number {
  return state > 0 && state < HOPPER_CROUCH_T ? clamp01(1 - state / HOPPER_CROUCH_T) : 0;
}
/** Seconds of reload during which the turret's aim line brightens (state = reload seconds left). */
export const TURRET_AIM_T = 0.4;
export function turretCharge(state: number): number {
  return state > 0 && state < TURRET_AIM_T ? clamp01(1 - state / TURRET_AIM_T) : 0;
}
/** The chaser's wind-up length in the sim (state starts here and counts down to the charge). */
export const CHASER_WINDUP_T = 0.5;
/** Wind-up shake offset (world units) while state > 0: a fast jitter that grows as the charge nears. */
export function chaserShake(state: number, t: number): number {
  if (state <= 0) return 0;
  const k = clamp01(1 - state / CHASER_WINDUP_T);
  return Math.sin(t * 70) * (0.4 + 1.2 * k);
}
/** Flyer wing-flap phase (radians): a steady beat that quickens with speed. */
export function flyerFlap(t: number, speed: number): number {
  return t * (8 + Math.min(200, speed) * 0.03);
}
/** Walker blink, 0 open .. 1 closed: a short close every ~3.3 s, staggered by id so a pack never blinks together. */
export function walkerBlink(t: number, id: number): number {
  const ph = (t * 0.3 + id * 0.37) % 1;
  return ph < 0.05 ? 1 : 0;
}

// ============================================================ bubble foe (P5-5, pure)
/**
 * Seconds before an inactive bubble re-forms during which the shimmer ring gathers at its home.
 * The sim counts `FoeState.state` down to 0 while the bubble is `dead`; the renderer only reads it.
 */
export const BUBBLE_SHIMMER_T = 0.5;
/** 0 → 1 as the re-form countdown runs out; 0 while more than BUBBLE_SHIMMER_T is left or the timer is not running. */
export function bubbleShimmer(state: number): number {
  return state > 0 && state < BUBBLE_SHIMMER_T ? clamp01(1 - state / BUBBLE_SHIMMER_T) : 0;
}
/**
 * Surface wobble of a live bubble: a slow ±3.5 % breathe of the horizontal radius (the vertical radius
 * takes the inverse so the area — what the eye reads as the hitbox — holds). Staggered by id.
 */
export function bubbleWobble(t: number, id: number): number {
  return 1 + 0.035 * Math.sin(t * 3.1 + id * 1.7);
}
/** Soap-film hues that drift around the rim: pink · cyan · pale gold. */
const BUBBLE_IRIDESCENCE: readonly string[] = ['#FFB6E6', '#B6F0FF', '#FFF3B0'];

/**
 * Rising streaks emitted per second per visible updraft column (halved on the
 * low tier). Each streak travels the whole column, so the live population is
 * rate × (column height / rise speed) — about eight per tile of column.
 */
export const UPDRAFT_STREAKS_PER_S = 72;
const UPDRAFT_COL = '#BFF0FF';
const UPDRAFT_HI = '#DFF6FF';

interface EntVis {
  pop: number;          // seconds since the pickup was consumed
  lit: number;          // damped 0..1 (checkpoint active / goal open)
  minX: number; maxX: number; minY: number; maxY: number;   // observed travel range (rails)
  /** Updraft: streak emission accumulator, and whether the column was pre-filled on first sight. */
  acc: number;
  seeded: boolean;
  /** Alive on the previous update — a pickup consumed between two updates cues the smile (P5-2). */
  wasAlive: boolean;
}
interface FoeVis { aim: number; charge: number }

function entVis(map: Map<number, EntVis>, e: EntityState): EntVis {
  let v = map.get(e.id);
  if (!v) {
    v = { pop: 0, lit: 0, minX: e.x, maxX: e.x, minY: e.y, maxY: e.y, acc: 0, seeded: false, wasAlive: e.alive };
    map.set(e.id, v);
  }
  return v;
}

// ============================================================ actors
export class Actors {
  private readonly ent = new Map<number, EntVis>();
  private readonly foe = new Map<number, FoeVis>();
  /** Frame delta from the last `update`, consumed by emitters that run during the draw pass. */
  private dt = 0;

  constructor(private readonly stage: Stage, public biome: Biome, private readonly particles: Particles | null = null) {
    scene.wind = WIND_BY_WEATHER[biome.weather] ?? 0;
  }

  setLevel(biome: Biome): void {
    this.ent.clear();
    this.foe.clear();
    this.setBiome(biome);
    scene.pickup = 0;
  }

  /**
   * Switch the palette and the wind only (P5-4b: a tide level's band changed
   * under the player). Unlike `setLevel` this keeps every entity's visual
   * memory — lit checkpoints, observed platform rails, pickup pops — so the
   * band crossfade never makes the actors blink.
   */
  setBiome(biome: Biome): void {
    this.biome = biome;
    scene.wind = WIND_BY_WEATHER[biome.weather] ?? 0;
  }

  /** After the particle pool was wiped (respawn, intro): refill every updraft column on its next draw. */
  resetStreaks(): void {
    for (const v of this.ent.values()) { v.seeded = false; v.acc = 0; }
  }

  /** Advance visual-only timers. */
  update(dt: number, state: SimState): void {
    this.dt = dt;
    scene.t += dt;
    scene.gust = 0.5 + 0.5 * Math.sin(scene.t * 0.7) * Math.sin(scene.t * 1.9 + 1);
    scene.pickup = Math.max(0, scene.pickup - dt);
    for (const e of state.entities) {
      const v = entVis(this.ent, e);
      if (v.wasAlive && !e.alive && (e.kind === 'shard' || e.kind === 'relic')) scene.pickup = SMILE_T;
      v.wasAlive = e.alive;
      if (!e.alive) v.pop += dt;
      if (e.kind === 'checkpoint') v.lit = damp(v.lit, e.state >= 0.5 ? 1 : 0, 0.12, dt);
      else if (e.kind === 'goal') v.lit = damp(v.lit, 1, 0.4, dt);
      if (e.kind === 'platH' || e.kind === 'platV' || e.kind === 'saw') {
        if (e.x < v.minX) v.minX = e.x; if (e.x > v.maxX) v.maxX = e.x;
        if (e.y < v.minY) v.minY = e.y; if (e.y > v.maxY) v.maxY = e.y;
      }
    }
    const p = state.player;
    const pcx = p.x + p.w / 2, pcy = p.y + p.h / 2;
    for (const f of state.foes) {
      if (f.kind !== 'turret') continue;
      let v = this.foe.get(f.id);
      if (!v) { v = { aim: f.face > 0 ? 0 : Math.PI, charge: 0 }; this.foe.set(f.id, v); }
      const dx = pcx - f.x, dy = pcy - f.y;
      if (Math.hypot(dx, dy) < 190 && f.dying <= 0) {
        const target = Math.atan2(dy, dx);
        // shortest-arc damping so the barrel never spins the long way round
        let diff = target - v.aim;
        while (diff > Math.PI) diff -= TAU;
        while (diff < -Math.PI) diff += TAU;
        v.aim += diff * (1 - Math.pow(2, -dt / 0.16));
        v.charge = f.state > 0 && f.state < 0.4 ? clamp01(1 - f.state / 0.4) : 0;
      } else {
        v.charge = 0;
      }
    }
  }

  // ------------------------------------------------------------ entities
  drawEntities(state: SimState): void {
    const st = this.stage;
    for (const e of state.entities) {
      // tall columns and wide platforms are culled on their real extent, small props on a 80-unit box
      const hw = Math.max(40, (e.w || 0) / 2), hh = Math.max(40, (e.h || 0) / 2);
      if (!st.visible(e.x - hw, e.y - hh, hw * 2, hh * 2, 40)) continue;
      const v = entVis(this.ent, e);
      switch (e.kind) {
        case 'shard': this.shard(e, v); break;
        case 'relic': this.relic(e, v); break;
        case 'checkpoint': this.checkpoint(e, v); break;
        case 'goal': this.goal(e, v); break;
        case 'spring': this.spring(e); break;
        case 'crystal': this.crystal(e); break;
        case 'toggle': this.toggle(e, state.switchA); break;
        case 'platH': case 'platV': this.platform(e, v); break;
        case 'saw': this.saw(e, v); break;
        case 'updraft': this.updraft(e, v); break;
      }
    }
  }

  private shard(e: EntityState, v: EntVis): void {
    const ctx = this.stage.ctx, gctx = this.stage.gctx;
    if (!e.alive) {
      const k = clamp01(v.pop / SHARD_POP_T);
      if (k >= 1) return;
      ctx.save();
      ctx.globalAlpha *= 1 - k;
      ctx.strokeStyle = C.shardHi;
      ctx.lineWidth = 1.6 * (1 - k);
      ctx.beginPath(); ctx.arc(e.x, e.y, 5 + k * 22, 0, TAU); ctx.stroke();
      ctx.restore();
      return;
    }
    const ph = e.t;
    const bob = Math.sin(ph * 2.1) * 2.2;
    const spin = ph * 2.4;
    const sc = 1 + Math.sin(ph * 3.3) * 0.06;
    const x = e.x, y = e.y + bob;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.sin(spin) * 0.35);
    ctx.scale(sc * (0.55 + 0.45 * Math.abs(Math.cos(spin))), sc);
    const g = ctx.createLinearGradient(-4, -6, 4, 6);
    g.addColorStop(0, '#FFFFFF');
    g.addColorStop(0.35, C.shardHi);
    g.addColorStop(1, '#2196A8');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, -6.2); ctx.lineTo(3.6, 0); ctx.lineTo(0, 6.2); ctx.lineTo(-3.6, 0);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = alpha('#FFFFFF', 0.75);
    ctx.lineWidth = 0.5;
    ctx.stroke();
    ctx.fillStyle = alpha('#FFFFFF', 0.55);
    ctx.beginPath();
    ctx.moveTo(0, -5); ctx.lineTo(1.6, -0.6); ctx.lineTo(0, 2); ctx.lineTo(-1.4, -0.6);
    ctx.closePath(); ctx.fill();
    ctx.restore();

    if (this.stage.settings.bloom) {
      const pulse = 0.55 + 0.45 * Math.sin(ph * 3.1);
      gctx.fillStyle = alpha(C.shard, 0.3 * pulse);
      gctx.beginPath(); gctx.arc(x, y, 4.6, 0, TAU); gctx.fill();
    }
  }

  private relic(e: EntityState, v: EntVis): void {
    const ctx = this.stage.ctx, gctx = this.stage.gctx;
    if (!e.alive) {
      const k = clamp01(v.pop / RELIC_POP_T);
      if (k >= 1) return;
      ctx.save();
      ctx.globalAlpha *= 1 - k;
      ctx.strokeStyle = C.relicHi;
      ctx.lineWidth = 2.4 * (1 - k);
      ctx.beginPath(); ctx.arc(e.x, e.y, 6 + easeOutCubic(k) * 46, 0, TAU); ctx.stroke();
      ctx.restore();
      return;
    }
    const ph = e.t;
    const y = e.y + Math.sin(ph * 1.6) * 3;
    ctx.save();
    ctx.translate(e.x, y);
    for (let i = 0; i < 3; i++) {
      const a = ph * 1.7 + (i / 3) * TAU;
      const ox = Math.cos(a) * 11, oy = Math.sin(a) * 4.5;
      ctx.fillStyle = alpha(C.relicHi, 0.55 + 0.35 * Math.sin(a * 2));
      ctx.beginPath(); ctx.arc(ox, oy, 1.2, 0, TAU); ctx.fill();
    }
    ctx.rotate(Math.sin(ph) * 0.18);
    const g = ctx.createLinearGradient(-7, -7, 7, 7);
    g.addColorStop(0, '#FFF8DC');
    g.addColorStop(0.4, C.relic);
    g.addColorStop(1, '#A87418');
    ctx.fillStyle = g;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU - Math.PI / 2;
      const r = i % 2 === 0 ? 7.4 : 5.2;
      const px = Math.cos(a) * r, py = Math.sin(a) * r;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = alpha('#FFFDF0', 0.8);
    ctx.lineWidth = 0.6; ctx.stroke();
    ctx.fillStyle = alpha('#FFFFFF', 0.6);
    ctx.beginPath(); ctx.ellipse(-1.8, -2.2, 2.2, 1.3, -0.6, 0, TAU); ctx.fill();
    ctx.restore();

    if (this.stage.settings.bloom) {
      const pulse = 0.6 + 0.4 * Math.sin(ph * 2.4);
      gctx.fillStyle = alpha(C.relic, 0.42 * pulse);
      gctx.beginPath(); gctx.arc(e.x, y, 8.5, 0, TAU); gctx.fill();
    }
  }

  private checkpoint(e: EntityState, v: EntVis): void {
    const ctx = this.stage.ctx, gctx = this.stage.gctx;
    const x = e.x, y = e.y + TILE / 2;   // base of the tile
    const ph = e.t, lit = v.lit;
    const g = ctx.createLinearGradient(x - 3, 0, x + 3, 0);
    g.addColorStop(0, '#4A4258'); g.addColorStop(0.5, '#8D839F'); g.addColorStop(1, '#332C40');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.roundRect(x - 2.6, y - 24, 5.2, 24, 2); ctx.fill();
    ctx.fillStyle = '#2A2434';
    ctx.beginPath(); ctx.ellipse(x, y, 7, 2.4, 0, 0, TAU); ctx.fill();

    const col = lit > 0.5 ? C.checkpoint : '#6C6480';
    const pulse = 0.7 + 0.3 * Math.sin(ph * (lit > 0.5 ? 4 : 1.6));
    ctx.save();
    ctx.translate(x, y - 27 + Math.sin(ph * 1.8) * (0.6 + lit));
    ctx.rotate(ph * (0.4 + lit * 1.4));
    const cg = ctx.createLinearGradient(-5, -5, 5, 5);
    cg.addColorStop(0, lit > 0.5 ? '#FFFFFF' : '#9A93AC');
    cg.addColorStop(1, col);
    ctx.fillStyle = cg;
    ctx.beginPath();
    ctx.moveTo(0, -6); ctx.lineTo(4.4, 0); ctx.lineTo(0, 6); ctx.lineTo(-4.4, 0);
    ctx.closePath(); ctx.fill();
    ctx.restore();

    if (lit > 0.02) {
      for (let i = 0; i < 3; i++) {
        const k = (ph * 0.7 + i / 3) % 1;
        ctx.strokeStyle = alpha(C.checkpoint, (1 - k) * 0.5 * lit);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(x, y - 4 - k * 30, 4 + k * 8, 0, Math.PI, true);
        ctx.stroke();
      }
      if (this.stage.settings.bloom) {
        gctx.fillStyle = alpha(C.checkpoint, 0.6 * lit * pulse);
        gctx.beginPath(); gctx.arc(x, y - 27, 14, 0, TAU); gctx.fill();
      }
    }
  }

  private goal(e: EntityState, v: EntVis): void {
    const ctx = this.stage.ctx, gctx = this.stage.gctx;
    const base = e.y + TILE / 2;
    const x = e.x, y = base - 18;
    const k = v.lit, ph = e.t;

    ctx.save();
    ctx.translate(x, y);
    for (let i = 4; i >= 0; i--) {
      const r = (5 + i * 3.4) * k;
      const a0 = ph * (1.1 + i * 0.5) + i;
      ctx.strokeStyle = alpha(i % 2 ? C.goal : C.relicHi, 0.28 + 0.14 * (4 - i));
      ctx.lineWidth = 1.6 - i * 0.16;
      ctx.beginPath();
      ctx.ellipse(0, 0, r, r * 1.28, 0, a0, a0 + 2.4 + i * 0.3);
      ctx.stroke();
    }
    const core = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(0.01, 9 * k));
    core.addColorStop(0, alpha('#FFFFFF', 0.9));
    core.addColorStop(0.4, alpha(C.goal, 0.6));
    core.addColorStop(1, alpha(C.goal, 0));
    ctx.fillStyle = core;
    ctx.beginPath(); ctx.arc(0, 0, 10 * k, 0, TAU); ctx.fill();
    ctx.restore();

    ctx.strokeStyle = alpha(C.goal, 0.5);
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.ellipse(x, base, 12, 3.4, 0, 0, TAU); ctx.stroke();

    if (this.stage.settings.bloom) {
      gctx.fillStyle = alpha(C.goal, 0.55);
      gctx.beginPath(); gctx.arc(x, y, 20 * k, 0, TAU); gctx.fill();
    }
  }

  private spring(e: EntityState): void {
    const ctx = this.stage.ctx, gctx = this.stage.gctx;
    const base = e.y + TILE / 2;
    const c = clamp01(e.state);
    const top = base - 9 + c * 6;
    ctx.save();
    ctx.fillStyle = '#3A3448';
    ctx.beginPath(); ctx.roundRect(e.x - 8, base - 3.5, 16, 3.5, 1.5); ctx.fill();
    ctx.strokeStyle = '#8D839F';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const coils = 3;
    for (let i = 0; i <= coils * 8; i++) {
      const u = i / (coils * 8);
      const yy = lerp(base - 3.5, top + 2, u);
      const xx = e.x + Math.sin(u * coils * TAU) * 5.4;
      if (i === 0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy);
    }
    ctx.stroke();
    const g = ctx.createLinearGradient(0, top - 3, 0, top + 3);
    g.addColorStop(0, '#D8FFC0'); g.addColorStop(0.5, C.spring); g.addColorStop(1, '#3E8F2A');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.roundRect(e.x - 8.5, top - 2.6, 17, 5.2, 2.6); ctx.fill();
    ctx.fillStyle = alpha('#FFFFFF', 0.5);
    ctx.beginPath(); ctx.roundRect(e.x - 6.5, top - 1.8, 13, 1.5, 1); ctx.fill();
    ctx.restore();
    if (this.stage.settings.bloom) {
      gctx.fillStyle = alpha(C.spring, 0.3 + c * 0.5);
      gctx.beginPath(); gctx.ellipse(e.x, top, 12, 5, 0, 0, TAU); gctx.fill();
    }
  }

  /** Dash crystal: a green gem that refills the dash; dim while it respawns. */
  private crystal(e: EntityState): void {
    const ctx = this.stage.ctx, gctx = this.stage.gctx;
    const ready = e.state <= 0;
    const ph = e.t;
    const bob = Math.sin(ph * 1.9) * 1.8;
    const x = e.x, y = e.y + bob;
    const pulse = 0.5 + 0.5 * Math.sin(ph * 4.2);

    ctx.save();
    if (!ready) ctx.globalAlpha *= 0.22;
    ctx.translate(x, y);
    ctx.rotate(Math.sin(ph * 1.3) * 0.25);
    const sc = ready ? 1 + pulse * 0.08 : 0.9;
    ctx.scale(sc * (0.7 + 0.3 * Math.abs(Math.cos(ph * 1.6))), sc);
    const g = ctx.createLinearGradient(-5, -8, 5, 8);
    g.addColorStop(0, '#FFFFFF');
    g.addColorStop(0.3, C.crystalHi);
    g.addColorStop(0.7, C.crystal);
    g.addColorStop(1, '#2F7A34');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, -8); ctx.lineTo(4.2, -3.2); ctx.lineTo(4.2, 3.2); ctx.lineTo(0, 8);
    ctx.lineTo(-4.2, 3.2); ctx.lineTo(-4.2, -3.2);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = alpha('#FFFFFF', 0.7);
    ctx.lineWidth = 0.6; ctx.stroke();
    // facet lines
    ctx.strokeStyle = alpha('#1E5A24', 0.45);
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(0, -8); ctx.lineTo(0, 8);
    ctx.moveTo(-4.2, -3.2); ctx.lineTo(4.2, 3.2);
    ctx.moveTo(4.2, -3.2); ctx.lineTo(-4.2, 3.2);
    ctx.stroke();
    ctx.fillStyle = alpha('#FFFFFF', 0.55);
    ctx.beginPath();
    ctx.moveTo(-1.2, -6); ctx.lineTo(1.4, -3.4); ctx.lineTo(-0.4, -0.8); ctx.lineTo(-2.6, -3.2);
    ctx.closePath(); ctx.fill();
    ctx.restore();

    if (ready) {
      // orbiting sparkle
      const a = ph * 2.6;
      ctx.fillStyle = alpha(C.crystalHi, 0.6 + 0.4 * pulse);
      ctx.beginPath(); ctx.arc(x + Math.cos(a) * 9, y + Math.sin(a) * 3.6, 1.1, 0, TAU); ctx.fill();
      if (this.stage.settings.bloom) {
        gctx.fillStyle = alpha(C.crystal, 0.28 + 0.22 * pulse);
        gctx.beginPath(); gctx.arc(x, y, 7, 0, TAU); gctx.fill();
      }
    } else {
      // respawn progress ring
      const k = clamp01(1 - e.state / PHYS.crystalRespawn);
      ctx.save();
      ctx.strokeStyle = alpha(C.crystal, 0.5);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x, e.y, 9, -Math.PI / 2, -Math.PI / 2 + k * TAU); ctx.stroke();
      ctx.restore();
    }
  }

  /** Switch toggle: a lens showing the active polarity colour. Dash through it to flip. */
  private toggle(e: EntityState, switchA: boolean): void {
    const ctx = this.stage.ctx, gctx = this.stage.gctx;
    const col = switchA ? C.switchA : C.switchB;
    const other = switchA ? C.switchB : C.switchA;
    const ph = e.t;
    const x = e.x, y = e.y;
    const pulse = 0.5 + 0.5 * Math.sin(ph * 3.4);

    ctx.save();
    ctx.translate(x, y);
    // housing ring
    const hg = ctx.createLinearGradient(-8, -8, 8, 8);
    hg.addColorStop(0, '#9A93AC'); hg.addColorStop(0.5, '#4A4258'); hg.addColorStop(1, '#2A2434');
    ctx.fillStyle = hg;
    ctx.beginPath(); ctx.arc(0, 0, 8.2, 0, TAU); ctx.fill();
    // rotating tick marks
    ctx.strokeStyle = alpha(col, 0.7);
    ctx.lineWidth = 1;
    for (let i = 0; i < 4; i++) {
      const a = ph * 1.2 + (i / 4) * TAU;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * 6.4, Math.sin(a) * 6.4);
      ctx.lineTo(Math.cos(a) * 7.6, Math.sin(a) * 7.6);
      ctx.stroke();
    }
    // lens
    const lg = ctx.createRadialGradient(-1.6, -1.8, 0.5, 0, 0, 5.6);
    lg.addColorStop(0, mixHex(col, '#ffffff', 0.7));
    lg.addColorStop(0.5, col);
    lg.addColorStop(1, mixHex(col, '#000000', 0.45));
    ctx.fillStyle = lg;
    ctx.beginPath(); ctx.arc(0, 0, 5.6, 0, TAU); ctx.fill();
    ctx.strokeStyle = alpha('#ffffff', 0.35 + 0.25 * pulse);
    ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.arc(0, 0, 5.6, 0, TAU); ctx.stroke();
    ctx.fillStyle = alpha('#ffffff', 0.5);
    ctx.beginPath(); ctx.ellipse(-1.8, -2.2, 1.8, 1.0, -0.6, 0, TAU); ctx.fill();
    // polarity pips: the lit one is the active colour, the dim one what a flip brings
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(-3, 10.5, 1.4, 0, TAU); ctx.fill();
    ctx.fillStyle = alpha(other, 0.35);
    ctx.beginPath(); ctx.arc(3, 10.5, 1.4, 0, TAU); ctx.fill();
    ctx.restore();

    if (this.stage.settings.bloom) {
      gctx.fillStyle = alpha(col, 0.3 + 0.2 * pulse);
      gctx.beginPath(); gctx.arc(x, y, 9, 0, TAU); gctx.fill();
    }
  }

  private platform(e: EntityState, v: EntVis): void {
    const ctx = this.stage.ctx, gctx = this.stage.gctx;
    const w = e.w || 3 * TILE, h = Math.max(6, e.h || 6);
    const x = e.x - w / 2, y = e.y;
    ctx.save();
    // rail guide over the range the platform has been seen to travel
    ctx.strokeStyle = alpha('#FFFFFF', 0.08);
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    if (e.kind === 'platV') { ctx.moveTo(e.x, v.minY); ctx.lineTo(e.x, v.maxY); }
    else { ctx.moveTo(v.minX - w / 2, y + 2); ctx.lineTo(v.maxX + w / 2, y + 2); }
    ctx.stroke();
    ctx.setLineDash([]);

    const g = ctx.createLinearGradient(0, y - 3, 0, y + h - 1);
    g.addColorStop(0, '#C9C2D8'); g.addColorStop(0.4, '#8D839F'); g.addColorStop(1, '#39334A');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.roundRect(x, y - 3, w, h + 1, 3); ctx.fill();
    ctx.fillStyle = alpha(C.shard, 0.85);
    const n = Math.max(1, Math.floor(w / 16));
    for (let i = 0; i < n; i++) ctx.fillRect(x + 6 + i * 16, y - 1.6, 4, 1.4);
    ctx.restore();
    if (this.stage.settings.bloom) {
      gctx.fillStyle = alpha(C.shard, 0.3);
      gctx.fillRect(x + 4, y - 2, w - 8, 3);
    }
  }

  private saw(e: EntityState, v: EntVis): void {
    const ctx = this.stage.ctx, gctx = this.stage.gctx;
    const r = Math.max(6, (e.w || 19) / 2);
    const spin = e.t * 14;
    ctx.save();
    ctx.strokeStyle = alpha('#FF6B7A', 0.1);
    ctx.lineWidth = 1.4;
    ctx.setLineDash([2, 5]);
    ctx.beginPath();
    if (v.maxY - v.minY > v.maxX - v.minX) { ctx.moveTo(e.x, v.minY); ctx.lineTo(e.x, v.maxY); }
    else { ctx.moveTo(v.minX, e.y); ctx.lineTo(v.maxX, e.y); }
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.translate(e.x, e.y);
    ctx.rotate(spin);
    const teeth = 10;
    const g = ctx.createRadialGradient(0, 0, 1, 0, 0, r);
    g.addColorStop(0, '#F2ECF8'); g.addColorStop(0.6, '#B6ACC6'); g.addColorStop(1, '#6B6180');
    ctx.fillStyle = g;
    ctx.beginPath();
    for (let i = 0; i < teeth * 2; i++) {
      const a = (i / (teeth * 2)) * TAU;
      const rr = i % 2 === 0 ? r : r * 0.72;
      const px = Math.cos(a) * rr, py = Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#2E2838';
    ctx.beginPath(); ctx.arc(0, 0, r * 0.3, 0, TAU); ctx.fill();
    ctx.strokeStyle = alpha(C.danger, 0.6);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(0, 0, r * 0.5, 0, TAU); ctx.stroke();
    ctx.restore();

    if (this.stage.settings.bloom) {
      gctx.fillStyle = alpha(C.danger, 0.2);
      gctx.beginPath(); gctx.arc(e.x, e.y, r * 1.3, 0, TAU); gctx.fill();
    }
  }

  /**
   * Updraft column: a body that brightens toward the floor, a soft core beam
   * down the centre, 1 px boundary lines on both edges, a floor glow where the
   * air enters, and a stream of rising streaks from the particle pool. The
   * column must read at a glance — it is the only thing that carries you up.
   */
  private updraft(e: EntityState, v: EntVis): void {
    const st = this.stage, ctx = st.ctx, gctx = st.gctx;
    const w = e.w || TILE, h = Math.max(TILE, e.h || TILE * 3);
    const x = e.x - w / 2, y = e.y - h / 2;
    const bottom = y + h;
    const pulse = 0.5 + 0.5 * Math.sin(e.t * 3.1 + e.x * 0.01);
    ctx.save();
    // body: air is densest where it enters the column
    const g = ctx.createLinearGradient(0, bottom, 0, y);
    g.addColorStop(0, alpha(UPDRAFT_COL, 0.16));
    g.addColorStop(0.55, alpha(UPDRAFT_COL, 0.08));
    g.addColorStop(1, alpha(UPDRAFT_COL, 0.03));
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
    // core beam, brightest along the centre line — air, not a pillar, so it stays translucent
    const core = ctx.createLinearGradient(x, 0, x + w, 0);
    core.addColorStop(0, alpha(UPDRAFT_HI, 0));
    core.addColorStop(0.5, alpha(UPDRAFT_HI, 0.14 + 0.04 * pulse));
    core.addColorStop(1, alpha(UPDRAFT_HI, 0));
    ctx.fillStyle = core;
    ctx.fillRect(x, y, w, h);
    // 1 px boundary highlight on both edges (one device pixel, whatever the zoom)
    const px1 = 1 / Math.max(1e-6, st.scale * st.zoom);
    ctx.fillStyle = alpha(UPDRAFT_HI, 0.38);
    ctx.fillRect(x, y, px1, h);
    ctx.fillRect(x + w - px1, y, px1, h);
    // floor glow: a half-ellipse of light sitting on the column base
    const fg = ctx.createRadialGradient(e.x, bottom, 0, e.x, bottom, w * 1.1);
    fg.addColorStop(0, alpha(UPDRAFT_HI, 0.45 + 0.1 * pulse));
    fg.addColorStop(1, alpha(UPDRAFT_HI, 0));
    ctx.fillStyle = fg;
    ctx.beginPath();
    ctx.ellipse(e.x, bottom, w * 1.1, 7, 0, Math.PI, TAU);
    ctx.fill();
    ctx.restore();

    this.emitStreaks(v, x, y, w, h);

    if (st.settings.bloom) {
      gctx.fillStyle = alpha(UPDRAFT_COL, 0.06);
      gctx.fillRect(x, y, w, h);
      gctx.fillStyle = alpha(UPDRAFT_HI, 0.2);
      gctx.beginPath(); gctx.ellipse(e.x, bottom, w, 5, 0, Math.PI, TAU); gctx.fill();
    }
  }

  /**
   * Rising streaks for one visible column. Emission runs from the draw pass
   * (so only columns on screen pay), at UPDRAFT_STREAKS_PER_S — half on the
   * low tier. The first time a column is seen it is pre-filled along its
   * height so a fresh view never shows an empty column.
   */
  private emitStreaks(v: EntVis, x: number, y: number, w: number, h: number): void {
    const P = this.particles;
    if (!P) return;
    const rate = this.stage.quality === 'low' ? UPDRAFT_STREAKS_PER_S / 2 : UPDRAFT_STREAKS_PER_S;
    const speed = clamp(h * 0.75, 60, 150);        // world units per second, upward
    const life = h / speed;                         // one streak spans the whole column
    const bottom = y + h;
    const spawn = (f: number) => {
      const len = 4 + Math.random() * 4;
      const sx = x + 1.5 + Math.random() * (w - 3);
      P.streak(sx, bottom - f * h, -speed, len, UPDRAFT_HI, (1 - f) * life, life, 0.35);
    };
    if (!v.seeded) {
      v.seeded = true;
      v.acc = 0;
      const n = Math.round(rate * life);
      for (let i = 0; i < n; i++) spawn(Math.random());
    }
    v.acc += rate * this.dt;
    while (v.acc >= 1) {
      v.acc -= 1;
      spawn(0);
    }
  }

  // ------------------------------------------------------------ foes
  drawFoes(state: SimState, t: number): void {
    const st = this.stage;
    for (const f of state.foes) {
      if (!st.visible(f.x - 20, f.y - 20, 40, 40)) continue;
      if (f.dead) {
        // an inactive bubble draws nothing but the re-form shimmer at its home, over the last BUBBLE_SHIMMER_T of its countdown (P5-5)
        if (f.kind === 'bubble') this.bubbleShimmer(f, t);
        continue;
      }
      switch (f.kind) {
        case 'walker': this.walker(f, t, false); break;
        case 'spiker': this.walker(f, t, true); break;
        case 'hopper': this.hopper(f, t); break;
        case 'flyer': this.flyer(f); break;
        case 'turret': this.turret(f, t); break;
        case 'chaser': this.chaser(f); break;
        case 'bubble': this.bubble(f, t); break;
      }
    }
  }

  /** Death animation: `dying` counts down; the body swells and fades. */
  private dieK(f: FoeState): { scale: number; alpha: number } {
    if (f.dying <= 0) return { scale: 1, alpha: 1 };
    const k = clamp01(f.dying / FOE_DIE_T);          // 1 → 0
    return { scale: 1 + (1 - k) * 3, alpha: k };
  }

  private walker(f: FoeState, t: number, armoured: boolean): void {
    const ctx = this.stage.ctx, gctx = this.stage.gctx;
    const d = this.dieK(f);
    ctx.save();
    ctx.globalAlpha *= d.alpha;
    ctx.translate(f.x, f.y);
    ctx.scale(d.scale, d.scale);
    const wob = Math.sin(f.t * 9) * 0.9;
    const moving = Math.abs(f.vx) > 2;

    ctx.strokeStyle = '#4A3A82';
    ctx.lineWidth = 1.5; ctx.lineCap = 'round';
    for (let i = -1; i <= 1; i++) {
      const ph = moving ? f.t * 9 + i * 1.6 : i * 1.6;
      ctx.beginPath();
      ctx.moveTo(i * 4, 3.4);
      ctx.lineTo(i * 4 + Math.cos(ph) * 2.4, 6.2 - Math.max(0, Math.sin(ph)) * 1.6);
      ctx.stroke();
    }
    const g = ctx.createLinearGradient(-7, -6, 5, 6);
    g.addColorStop(0, f.flash > 0.1 ? '#FFFFFF' : C.enemyHi);
    g.addColorStop(0.5, f.flash > 0.1 ? '#FFD8D8' : C.enemy);
    g.addColorStop(1, '#3A2A6A');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(0, wob * 0.3, 7.4, 5.6, 0, 0, TAU);
    ctx.fill();
    if (!armoured) {
      // stompable crown highlight
      ctx.strokeStyle = alpha('#FFE9A8', 0.55 + 0.25 * Math.sin(t * 4));
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.ellipse(0, -1.4 + wob * 0.3, 5.4, 3.4, 0, Math.PI * 1.12, Math.PI * 1.88); ctx.stroke();
    }
    // eyes; a short blink every few seconds, staggered per walker (P5-2)
    if (walkerBlink(f.t, f.id) > 0.5) {
      ctx.strokeStyle = '#150C28';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      for (const s of [-1, 1]) { ctx.moveTo(f.face * 2.2 + s * 1.9 - 1.2, -0.6); ctx.lineTo(f.face * 2.2 + s * 1.9 + 1.2, -0.6); }
      ctx.stroke();
    } else {
      for (const s of [-1, 1]) {
        ctx.fillStyle = '#FFFFFF';
        ctx.beginPath(); ctx.arc(f.face * 2.2 + s * 1.9, -0.6, 1.5, 0, TAU); ctx.fill();
        ctx.fillStyle = '#150C28';
        ctx.beginPath(); ctx.arc(f.face * 2.9 + s * 1.9, -0.5, 0.75, 0, TAU); ctx.fill();
      }
    }
    if (armoured) {
      ctx.fillStyle = '#E8E2F2';
      for (let i = -2; i <= 2; i++) {
        const bx = i * 2.8;
        ctx.beginPath();
        ctx.moveTo(bx - 1.3, -4.2); ctx.lineTo(bx, -8.4); ctx.lineTo(bx + 1.3, -4.2);
        ctx.closePath(); ctx.fill();
      }
      ctx.fillStyle = alpha(C.danger, 0.55 + 0.3 * Math.sin(t * 5));
      for (let i = -2; i <= 2; i++) {
        const bx = i * 2.8;
        ctx.beginPath();
        ctx.moveTo(bx - 0.5, -6); ctx.lineTo(bx, -8.4); ctx.lineTo(bx + 0.5, -6);
        ctx.closePath(); ctx.fill();
      }
    }
    ctx.restore();
    if (this.stage.settings.bloom) {
      gctx.fillStyle = alpha(C.enemyHi, (0.16 + f.flash * 0.5) * d.alpha);
      gctx.beginPath(); gctx.arc(f.x, f.y, 10, 0, TAU); gctx.fill();
    }
  }

  private hopper(f: FoeState, t: number): void {
    const ctx = this.stage.ctx, gctx = this.stage.gctx;
    const d = this.dieK(f);
    // squash from motion: crouch before a hop, stretch on the way up; the last HOPPER_CROUCH_T before the hop
    // the crouch deepens with the countdown (state = seconds until the hop) so the jump is telegraphed (P5-2)
    const crouch = Math.abs(f.vy) < 1 ? hopperCrouch(f.state) : 0;
    const sq = f.vy < -30 ? -0.35 : Math.abs(f.vy) < 1 ? 0.18 + 0.12 * Math.sin(f.t * 5) + crouch * 0.55 : 0;
    ctx.save();
    ctx.globalAlpha *= d.alpha;
    ctx.translate(f.x, f.y);
    ctx.scale(d.scale * (1 + sq * 0.5), d.scale * (1 - sq * 0.45));
    const g = ctx.createRadialGradient(-2, -3, 1, 0, 1, 8);
    g.addColorStop(0, f.flash > 0.1 ? '#FFFFFF' : '#9AE8C8');
    g.addColorStop(0.6, '#3FA98A');
    g.addColorStop(1, '#1E5F4E');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-6.6, 5.5);
    ctx.quadraticCurveTo(-7.4, -6.4, 0, -6.4);
    ctx.quadraticCurveTo(7.4, -6.4, 6.6, 5.5);
    ctx.quadraticCurveTo(0, 7.2, -6.6, 5.5);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = alpha('#FFE9A8', 0.5 + 0.25 * Math.sin(t * 4));
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(0, -2.4, 4.6, 3, 0, Math.PI * 1.1, Math.PI * 1.9); ctx.stroke();
    for (const sd of [-1, 1]) {
      ctx.fillStyle = '#0E2A24';
      // the eyes narrow with the crouch
      ctx.beginPath(); ctx.ellipse(sd * 2.4 + f.face * 0.8, -1.4, 1.1, 1.5 * (1 - crouch * 0.6), 0, 0, TAU); ctx.fill();
    }
    ctx.restore();
    if (this.stage.settings.bloom) {
      gctx.fillStyle = alpha('#9AE8C8', (0.14 + f.flash * 0.5) * d.alpha);
      gctx.beginPath(); gctx.arc(f.x, f.y, 10, 0, TAU); gctx.fill();
    }
  }

  private flyer(f: FoeState): void {
    const ctx = this.stage.ctx, gctx = this.stage.gctx;
    const d = this.dieK(f);
    ctx.save();
    ctx.globalAlpha *= d.alpha;
    ctx.translate(f.x, f.y);
    ctx.scale(d.scale, d.scale);
    ctx.strokeStyle = alpha('#C9B4FF', 0.75);
    ctx.lineWidth = 1.1; ctx.lineCap = 'round';
    for (let i = 0; i < 4; i++) {
      const bx = -4.2 + i * 2.8;
      const tent = Math.sin(f.t * 3.2 + i * 0.9) * 2.4 - f.vx * 0.02;
      ctx.beginPath();
      ctx.moveTo(bx, 3.4);
      ctx.quadraticCurveTo(bx + tent, 7, bx + tent * 1.7, 11);
      ctx.stroke();
    }
    // wing membranes flapping either side of the bell, quicker when it moves (P5-2)
    const flap = Math.sin(flyerFlap(f.t, Math.hypot(f.vx, f.vy)));
    ctx.fillStyle = alpha('#C9B4FF', 0.45);
    ctx.strokeStyle = alpha('#EDE4FF', 0.6);
    ctx.lineWidth = 0.6;
    for (const sd of [-1, 1]) {
      const wy = -1.5 - flap * 3.2;
      ctx.beginPath();
      ctx.moveTo(sd * 5.2, -1.2);
      ctx.quadraticCurveTo(sd * 9.6, wy - 2.4, sd * 12.4, wy);
      ctx.quadraticCurveTo(sd * 9.0, wy + 2.2 + flap, sd * 5.6, 1.6);
      ctx.closePath();
      ctx.fill(); ctx.stroke();
    }
    const pump = 1 + Math.sin(f.t * 3.2) * 0.08;
    const g = ctx.createRadialGradient(0, -3, 1, 0, 1, 9);
    g.addColorStop(0, f.flash > 0.1 ? '#FFFFFF' : '#EDE4FF');
    g.addColorStop(0.5, '#A78BFA');
    g.addColorStop(1, '#5B3FA8');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(0, 0, 7.2 * pump, 6.2 / pump, 0, Math.PI, TAU);
    ctx.quadraticCurveTo(4, 4.4, 0, 3.6);
    ctx.quadraticCurveTo(-4, 4.4, -7.2 * pump, 0);
    ctx.fill();
    ctx.strokeStyle = alpha('#FFFFFF', 0.5);
    ctx.lineWidth = 0.7;
    ctx.beginPath(); ctx.ellipse(0, 0, 7.2 * pump, 6.2 / pump, 0, Math.PI, TAU); ctx.stroke();
    for (const sd of [-1, 1]) {
      ctx.fillStyle = '#1C1030';
      ctx.beginPath(); ctx.arc(sd * 2.4, -1.4, 1.15, 0, TAU); ctx.fill();
    }
    ctx.restore();
    if (this.stage.settings.bloom) {
      gctx.fillStyle = alpha('#A78BFA', (0.3 + f.flash * 0.5) * d.alpha);
      gctx.beginPath(); gctx.arc(f.x, f.y, 13, 0, TAU); gctx.fill();
    }
  }

  private turret(f: FoeState, t: number): void {
    const ctx = this.stage.ctx, gctx = this.stage.gctx;
    const d = this.dieK(f);
    const v = this.foe.get(f.id) ?? { aim: f.face > 0 ? 0 : Math.PI, charge: 0 };
    ctx.save();
    ctx.globalAlpha *= d.alpha;
    ctx.translate(f.x, f.y);
    ctx.scale(d.scale, d.scale);
    ctx.save();
    ctx.rotate(v.aim);
    // the aim line brightens and reaches out over the last TURRET_AIM_T of the reload (P5-2)
    if (v.charge > 0.01) {
      ctx.strokeStyle = alpha(C.danger, 0.1 + v.charge * 0.55);
      ctx.lineWidth = 0.6 + v.charge * 0.7;
      ctx.beginPath(); ctx.moveTo(11, 0); ctx.lineTo(11 + 30 * v.charge, 0); ctx.stroke();
    }
    ctx.fillStyle = '#57506B';
    ctx.beginPath(); ctx.roundRect(2, -2.4, 9, 4.8, 2); ctx.fill();
    ctx.fillStyle = alpha(C.danger, 0.4 + v.charge * 0.6);
    ctx.beginPath(); ctx.arc(10, 0, 1.6 + v.charge * 1.6, 0, TAU); ctx.fill();
    ctx.restore();
    const g = ctx.createRadialGradient(-2, -3, 1, 0, 0, 9);
    g.addColorStop(0, f.flash > 0.1 ? '#FFFFFF' : '#8D839F');
    g.addColorStop(1, '#332D42');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, 7.4, 0, TAU); ctx.fill();
    ctx.strokeStyle = alpha('#FFE9A8', 0.45 + 0.25 * Math.sin(t * 4));
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(0, 0, 5.6, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke();
    ctx.fillStyle = alpha(C.danger, 0.65 + 0.3 * Math.sin(t * 6));
    ctx.beginPath(); ctx.arc(0, 0, 2.4, 0, TAU); ctx.fill();
    ctx.restore();
    if (this.stage.settings.bloom) {
      gctx.fillStyle = alpha(C.danger, (0.2 + v.charge * 0.5 + f.flash * 0.4) * d.alpha);
      gctx.beginPath(); gctx.arc(f.x, f.y, 11, 0, TAU); gctx.fill();
    }
  }

  private chaser(f: FoeState): void {
    const ctx = this.stage.ctx, gctx = this.stage.gctx;
    const d = this.dieK(f);
    const speed = Math.hypot(f.vx, f.vy);
    const charging = speed > 120;
    const winding = !charging && f.state > 0 && speed < 20;
    const spin = f.t * (charging ? 18 : 4);
    ctx.save();
    ctx.globalAlpha *= d.alpha;
    ctx.translate(f.x, f.y);
    // wind-up: a jitter that grows as the charge nears (state counts down to it), on top of the pulse (P5-2)
    if (f.state > 0 && f.dying <= 0) {
      const shake = chaserShake(f.state, f.t);
      ctx.translate(shake, shake * 0.35);
    }
    if (winding) {
      const k = 0.5 + 0.5 * Math.sin(f.t * 12);
      ctx.scale(1 + k * 0.16, 1 - k * 0.1);
    }
    ctx.scale(d.scale, d.scale);
    ctx.save();
    ctx.rotate(spin * 0.3);
    ctx.fillStyle = charging ? '#FFD9DE' : '#C9C2D8';
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU;
      ctx.save(); ctx.rotate(a);
      ctx.beginPath();
      ctx.moveTo(-1.5, -5.6); ctx.lineTo(0, -10.4); ctx.lineTo(1.5, -5.6);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }
    ctx.restore();
    const g = ctx.createRadialGradient(-2, -2, 1, 0, 0, 7);
    g.addColorStop(0, f.flash > 0.1 ? '#FFFFFF' : charging ? '#FF9AA6' : '#7A6BA8');
    g.addColorStop(1, '#2A1F4A');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, 6.2, 0, TAU); ctx.fill();
    ctx.fillStyle = charging ? C.danger : '#E8E2F2';
    ctx.beginPath(); ctx.arc(f.face * 1.4, -0.4, 2.4, 0, TAU); ctx.fill();
    ctx.fillStyle = '#120B20';
    ctx.beginPath(); ctx.arc(f.face * 2.1, -0.4, 1.1, 0, TAU); ctx.fill();
    ctx.restore();
    if (this.stage.settings.bloom) {
      gctx.fillStyle = alpha(charging ? C.danger : C.enemyHi, (0.2 + (charging ? 0.4 : 0) + f.flash * 0.4) * d.alpha);
      gctx.beginPath(); gctx.arc(f.x, f.y, 13, 0, TAU); gctx.fill();
    }
  }

  /**
   * Bubble foe (P5-5): a translucent iridescent sphere the sim bobs in place.
   * The body sits on the hitbox exactly (rx = w/2, ry = h/2, drawn at f.x/f.y
   * with no offset — the sim's bob is the only motion); the one liberty is the
   * slow surface wobble that trades a few percent between the axes. The crown
   * highlight on top is the same "land on me" cue the walker, hopper and
   * turret carry; the lower rim takes a faint danger tint because side and
   * underside contact kills. The glow buffer gets a hint only — it is mostly air.
   */
  private bubble(f: FoeState, t: number): void {
    const ctx = this.stage.ctx, gctx = this.stage.gctx;
    const d = this.dieK(f);
    const accent = this.biome.accent;
    const wob = bubbleWobble(f.t, f.id);
    const rx = (f.w / 2) * wob, ry = (f.h / 2) / wob;
    const r = Math.min(rx, ry);
    const flash = f.flash > 0.1;
    ctx.save();
    ctx.globalAlpha *= d.alpha;
    ctx.translate(f.x, f.y);
    ctx.scale(d.scale, d.scale);
    // body: nearly clear in the middle, the accent gathers toward the rim like a soap film
    const g = ctx.createRadialGradient(-rx * 0.3, -ry * 0.35, r * 0.1, 0, 0, r);
    g.addColorStop(0, alpha('#FFFFFF', flash ? 0.55 : 0.16));
    g.addColorStop(0.55, alpha(accent, flash ? 0.35 : 0.07));
    g.addColorStop(0.88, alpha(accent, flash ? 0.5 : 0.2));
    g.addColorStop(1, alpha('#FFFFFF', flash ? 0.7 : 0.34));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.ellipse(0, 0, rx, ry, 0, 0, TAU); ctx.fill();
    // rim: a thin white line, then the iridescent arcs drifting around it
    ctx.lineWidth = 0.9;
    ctx.strokeStyle = alpha('#FFFFFF', 0.55);
    ctx.beginPath(); ctx.ellipse(0, 0, rx, ry, 0, 0, TAU); ctx.stroke();
    ctx.lineWidth = 1.3;
    for (let i = 0; i < BUBBLE_IRIDESCENCE.length; i++) {
      const a0 = f.t * 0.9 + (i / BUBBLE_IRIDESCENCE.length) * TAU;
      ctx.strokeStyle = alpha(BUBBLE_IRIDESCENCE[i], 0.42);
      ctx.beginPath(); ctx.ellipse(0, 0, rx - 0.6, ry - 0.6, 0, a0, a0 + 1.1); ctx.stroke();
    }
    // lower rim: side and underside contact kills — a faint danger tint, never loud enough to read as a hazard
    ctx.strokeStyle = alpha(C.danger, 0.22);
    ctx.lineWidth = 1.1;
    ctx.beginPath(); ctx.ellipse(0, 0, rx - 0.4, ry - 0.4, 0, Math.PI * 0.2, Math.PI * 0.8); ctx.stroke();
    // stompable crown highlight, pulsing on the same clock as the walker's and the hopper's
    ctx.strokeStyle = alpha('#FFE9A8', 0.55 + 0.25 * Math.sin(t * 4));
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(0, 0, rx * 0.72, ry * 0.72, 0, Math.PI * 1.12, Math.PI * 1.88); ctx.stroke();
    // glints: a soft oval up-left, a pin-point down-right
    ctx.fillStyle = alpha('#FFFFFF', 0.75);
    ctx.beginPath(); ctx.ellipse(-rx * 0.38, -ry * 0.42, r * 0.22, r * 0.13, -0.7, 0, TAU); ctx.fill();
    ctx.fillStyle = alpha('#FFFFFF', 0.35);
    ctx.beginPath(); ctx.arc(rx * 0.42, ry * 0.4, r * 0.08, 0, TAU); ctx.fill();
    ctx.restore();
    if (this.stage.settings.bloom) {
      gctx.fillStyle = alpha(accent, (0.08 + f.flash * 0.3) * d.alpha);
      gctx.beginPath(); gctx.arc(f.x, f.y, r * 0.9, 0, TAU); gctx.fill();
    }
  }

  /**
   * The last BUBBLE_SHIMMER_T of an inactive bubble's countdown: a ring closes
   * in on the home position and brightens while four motes spiral in, so the
   * re-form is telegraphed the way the hopper's crouch and the turret's aim
   * line are (P5-2). Nothing else is drawn while the bubble is inactive.
   */
  private bubbleShimmer(f: FoeState, t: number): void {
    const k = bubbleShimmer(f.state);
    if (k <= 0) return;
    const ctx = this.stage.ctx, gctx = this.stage.gctx;
    const accent = this.biome.accent;
    const r = Math.min(f.w, f.h) / 2;
    const ring = r * (2.4 - 1.4 * easeOutCubic(k));   // closes in: 2.4 r → r
    ctx.save();
    ctx.translate(f.x, f.y);
    ctx.strokeStyle = alpha(mixHex(accent, '#FFFFFF', 0.5), 0.15 + 0.45 * k);
    ctx.lineWidth = 0.7 + 0.8 * k;
    ctx.beginPath(); ctx.arc(0, 0, ring, 0, TAU); ctx.stroke();
    ctx.fillStyle = alpha('#FFFFFF', 0.3 + 0.5 * k);
    for (let i = 0; i < 4; i++) {
      const a = t * 3 + i * (TAU / 4) + k * 2.2;
      const rr = ring * (1.05 + 0.25 * (1 - k));
      ctx.beginPath(); ctx.arc(Math.cos(a) * rr, Math.sin(a) * rr, 0.7 + 0.5 * k, 0, TAU); ctx.fill();
    }
    ctx.restore();
    if (this.stage.settings.bloom) {
      gctx.fillStyle = alpha(accent, 0.12 * k);
      gctx.beginPath(); gctx.arc(f.x, f.y, r, 0, TAU); gctx.fill();
    }
  }

  // ------------------------------------------------------------ bolts
  drawBolts(state: SimState): void {
    const st = this.stage, ctx = st.ctx, gctx = st.gctx;
    for (const b of state.bolts) {
      if (b.dead || !st.visible(b.x - 8, b.y - 8, 16, 16)) continue;
      this.bolt(ctx, gctx, b);
    }
  }

  private bolt(ctx: CanvasRenderingContext2D, gctx: CanvasRenderingContext2D, b: BoltState): void {
    const col = C.dangerHi;
    const a = Math.atan2(b.vy, b.vx);
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(a);
    const g = ctx.createLinearGradient(-6, 0, 4, 0);
    g.addColorStop(0, alpha(col, 0));
    g.addColorStop(1, col);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.ellipse(-1, 0, 6, 2.1, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath(); ctx.arc(1.6, 0, 1.5, 0, TAU); ctx.fill();
    ctx.restore();
    if (this.stage.settings.bloom) {
      gctx.fillStyle = alpha(col, 0.75);
      gctx.beginPath(); gctx.arc(b.x, b.y, 6, 0, TAU); gctx.fill();
    }
  }

  // ------------------------------------------------------------ tide
  /** The rising flood in tide modes: a wobbling water line with a deep body below. */
  drawTide(tide: TideState, t: number): void {
    const st = this.stage, ctx = st.ctx, gctx = st.gctx;
    const y = tide.y;
    if (y > st.wBottom + 20) return;
    const x0 = st.wLeft - 20, w = (st.wRight - st.wLeft) + 40;
    const bottom = st.wBottom + 40;
    const wave = (i: number) => y + Math.sin(t * 2.4 + i * 0.7) * 2.6 + Math.sin(t * 1.1 + i * 0.31) * 1.8;
    const g = ctx.createLinearGradient(0, y - 10, 0, y + 90);
    g.addColorStop(0, alpha(C.tide, 0));
    g.addColorStop(0.12, alpha(C.shard, 0.5));
    g.addColorStop(1, alpha('#123C5A', 0.9));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(x0, y + 6);
    const n = 22;
    for (let i = 0; i <= n; i++) ctx.lineTo(x0 + (i / n) * w, wave(i));
    ctx.lineTo(x0 + w, bottom);
    ctx.lineTo(x0, bottom);
    ctx.closePath();
    ctx.fill();
    // foam line
    ctx.strokeStyle = alpha('#DFF6FF', 0.75);
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const x = x0 + (i / n) * w;
      if (i === 0) ctx.moveTo(x, wave(i)); else ctx.lineTo(x, wave(i));
    }
    ctx.stroke();
    // speed reads as urgency: faster tide, brighter and busier foam
    const urgency = clamp01((tide.speed - PHYS.tideSpeed0) / 30);
    if (urgency > 0.05) {
      ctx.strokeStyle = alpha('#FFFFFF', 0.35 * urgency);
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      for (let i = 0; i <= n; i++) {
        const x = x0 + (i / n) * w;
        const yy = wave(i) + 3 + Math.sin(t * 5 + i * 1.7) * 1.2;
        if (i === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
      }
      ctx.stroke();
    }
    if (st.settings.bloom) {
      gctx.fillStyle = alpha(C.tide, 0.24 + urgency * 0.2);
      gctx.fillRect(x0, y - 4, w, 10);
    }
  }
}

// ============================================================ player visuals
interface TrailNode { x: number; y: number; a: number; dash: boolean }

/**
 * Antenna springs: stiffness, damping and how much of the body's velocity change
 * the tip misses (the impulse that sets it swinging), per stalk. Driving the
 * springs with velocity deltas rather than accelerations keeps the response
 * independent of the frame rate: a run-up to top speed swings the tips the same
 * whether it took six frames or sixty.
 */
const STALK_K = [90, 58] as const;
const STALK_C = [9, 7] as const;
const STALK_G = [0.25, 0.32] as const;
/** A velocity change larger than this per update (a dash, a hard landing) counts as this much; a teleport is ignored. */
const STALK_DV_MAX = 250;
/** Largest deflection of a stalk tip (rig units). */
const STALK_MAX = 6;
/** Scarf chain physics: gravity, air drag per second, wind coupling, position-constraint passes. */
const CHAIN_GRAVITY = 55;
const CHAIN_DRAG = 0.82;
const CHAIN_WIND = 1.0;
const CHAIN_PASSES = 2;
/** A feet jump larger than this between two updates is a teleport: the chain snaps instead of whipping. */
const TELEPORT_DIST = 40;
/** Substep ceiling for the springs and the chain (seconds). */
const VIS_STEP = 1 / 30;

/**
 * Visual-only state of one Clawd (the live player or an echo): squash spring,
 * run-cycle phase, blink, dash-refill flash, spawn warp, afterimage trail and
 * the death tumble. Derived from PlayerState deltas so it works for ghosts too.
 *
 * The cat's secondary motion uses two ear tips on damped
 * springs that lag the body's acceleration, and a CHAIN_N-point scarf chain
 * blown by the biome wind — plus the idle clock and the pickup smile. All of
 * it is derived from PlayerState deltas; nothing feeds back into the sim.
 */
export class PlayerVisual {
  squash = 0;
  anim = 0;
  blink = 0;
  dashFlash = 0;
  spawnT = 0;
  deadSpin = 0;
  alpha = 1;
  /** Seconds standing still (feeds RigState.idle). */
  idleT = 0;
  /** Seconds of smile left after `smile()` (feeds RigState.smile as a 0..1 remainder). */
  smileT = 0;
  /** Ear tip offsets [x0, y0, x1, y1] in rig units (RigState.stalk). */
  readonly stalk = new Float32Array(4);
  /** Scarf chain points in world units, [x, y, …], CHAIN_N of them; `chain[0..1]` is the anchor. */
  readonly chain = new Float32Array(CHAIN_N * 2);
  private readonly stalkV = new Float32Array(4);
  private readonly chainV = new Float32Array(CHAIN_N * 2);
  /** The chain as offsets from the feet, what the rig draws (RigState.chain). */
  private readonly chainRel = new Float32Array(CHAIN_N * 2);
  private chainSet = false;
  private blinkT = 1.5;
  private readonly trail: TrailNode[] = [];
  private head = 0;
  private prev: { grounded: boolean; vx: number; vy: number; dashReady: boolean; dead: boolean; stomping: boolean; dashT: number; x: number; y: number } | null = null;

  constructor() {
    for (let i = 0; i < TRAIL_N; i++) this.trail.push({ x: 0, y: 0, a: 0, dash: false });
  }

  /** New level or respawn: forget deltas, play the spawn warp. */
  reset(p?: PlayerState): void {
    this.squash = 0; this.anim = 0; this.blink = 0; this.blinkT = 1.5;
    this.dashFlash = 0; this.spawnT = 0.42; this.deadSpin = 0; this.alpha = 1;
    this.idleT = 0; this.smileT = 0;
    this.stalk.fill(0); this.stalkV.fill(0);
    this.chainSet = false;
    if (p) this.snapChain(p);
    this.prev = null;
    for (const tr of this.trail) { tr.a = 0; if (p) { tr.x = p.x; tr.y = p.y; } }
  }

  /** Start the pickup smile (SMILE_T seconds); the renderer may call this from a shard / relic event. */
  smile(): void { this.smileT = SMILE_T; }

  /** Where the scarf hangs from, in world units. */
  private anchorX(p: PlayerState): number { return p.x + p.w / 2 - p.facing * CHAIN_ANCHOR.dx; }
  private anchorY(p: PlayerState): number { return p.y + p.h + CHAIN_ANCHOR.dy; }

  /** Lay the whole chain out behind the anchor at rest (spawn, teleport). */
  private snapChain(p: PlayerState): void {
    const ax = this.anchorX(p), ay = this.anchorY(p);
    for (let i = 0; i < CHAIN_N; i++) {
      this.chain[i * 2] = ax - p.facing * i * CHAIN_SEG * 0.8;
      this.chain[i * 2 + 1] = ay + i * CHAIN_SEG * 0.6;
    }
    this.chainV.fill(0);
    this.chainSet = true;
    this.relChain(p);
  }

  private relChain(p: PlayerState): void {
    const fx = p.x + p.w / 2, fy = p.y + p.h;
    for (let i = 0; i < CHAIN_N; i++) {
      this.chainRel[i * 2] = this.chain[i * 2] - fx;
      this.chainRel[i * 2 + 1] = this.chain[i * 2 + 1] - fy;
    }
  }

  /** The body's velocity changed by (dvx, dvy): each tip keeps a share of its old velocity, so it swings the other way. */
  private kickStalks(dvx: number, dvy: number): void {
    const V = this.stalkV;
    for (let i = 0; i < 2; i++) {
      V[i * 2] -= dvx * STALK_G[i];
      V[i * 2 + 1] -= dvy * STALK_G[i];
    }
  }

  /** Damped springs for the two ear tips, back toward rest. */
  private stepStalks(dt: number): void {
    const S = this.stalk, V = this.stalkV;
    for (let i = 0; i < 2; i++) {
      const k = STALK_K[i], c = STALK_C[i];
      for (let axis = 0; axis < 2; axis++) {
        const j = i * 2 + axis;
        V[j] += (-k * S[j] - c * V[j]) * dt;
        const s = S[j] + V[j] * dt;
        if (s > STALK_MAX) { S[j] = STALK_MAX; V[j] *= 0.2; }
        else if (s < -STALK_MAX) { S[j] = -STALK_MAX; V[j] *= 0.2; }
        else S[j] = s;
      }
    }
  }

  /** One chain step: forces on every free point, then CHAIN_PASSES distance-constraint passes from the anchor out. */
  private stepChain(dt: number, p: PlayerState): void {
    const P = this.chain, V = this.chainV;
    P[0] = this.anchorX(p); P[1] = this.anchorY(p);
    const wind = sceneWind() * CHAIN_WIND;
    const drag = Math.pow(CHAIN_DRAG, dt * 60);
    for (let i = 1; i < CHAIN_N; i++) {
      const j = i * 2;
      V[j] = (V[j] + (wind + Math.sin(scene.t * 3 + i) * Math.abs(wind) * 0.4) * dt) * drag;
      V[j + 1] = (V[j + 1] + CHAIN_GRAVITY * dt) * drag;
      P[j] += V[j] * dt; P[j + 1] += V[j + 1] * dt;
    }
    for (let pass = 0; pass < CHAIN_PASSES; pass++) {
      for (let i = 1; i < CHAIN_N; i++) {
        const j = i * 2, k = j - 2;
        const dx = P[j] - P[k], dy = P[j + 1] - P[k + 1];
        const len = Math.hypot(dx, dy);
        if (len > 1e-6) { P[j] = P[k] + dx / len * CHAIN_SEG; P[j + 1] = P[k + 1] + dy / len * CHAIN_SEG; }
        else { P[j] = P[k] - p.facing * CHAIN_SEG; P[j + 1] = P[k + 1]; }
      }
    }
  }

  /** Landing squash from an explicit sim event (richer than the delta guess). */
  land(impact: number, stomp = false): void {
    this.squash = Math.max(this.squash, 0.2 + clamp01(impact) * 0.5 + (stomp ? 0.3 : 0));
  }
  jump(): void { this.squash = -0.34; }
  wallJump(): void { this.squash = -0.28; }
  refill(): void { this.dashFlash = 1; }

  update(dt: number, p: PlayerState): void {
    const pr = this.prev;
    if (pr) {
      if (p.grounded && !pr.grounded && pr.vy > 60) this.land(pr.vy / 380, pr.stomping);
      if (!p.grounded && pr.grounded && p.vy < -120 && this.squash > -0.1) this.squash = -0.3;
      if (p.dashReady && !pr.dashReady) this.dashFlash = 1;
      if (pr.dead && !p.dead) this.reset(p);
    }
    this.squash = damp(this.squash, 0, 0.055, dt);
    this.dashFlash = Math.max(0, this.dashFlash - dt * 3);
    if (this.spawnT > 0) this.spawnT -= dt;
    this.smileT = Math.max(0, this.smileT - dt);

    // Ear springs react to the body's velocity change; the scarf follows the neck anchor.
    if (dt > 0) {
      const prev = this.prev;    // reset() above may have cleared it
      const teleport = !prev || Math.abs(p.x - prev.x) > TELEPORT_DIST || Math.abs(p.y - prev.y) > TELEPORT_DIST;
      if (prev && !teleport) {
        this.kickStalks(clamp(p.vx - prev.vx, -STALK_DV_MAX, STALK_DV_MAX), clamp(p.vy - prev.vy, -STALK_DV_MAX, STALK_DV_MAX));
      }
      if (!this.chainSet || teleport) this.snapChain(p);
      let left = Math.min(dt, 0.1);
      while (left > 1e-6) {
        const h = Math.min(VIS_STEP, left);
        this.stepStalks(h);
        this.stepChain(h, p);
        left -= h;
      }
      this.relChain(p);
    }
    // the idle clock: still on the ground, not dashing or stomping
    if (!p.dead && p.grounded && Math.abs(p.vx) < 6 && p.dashT <= 0 && !p.stomping) this.idleT += dt;
    else this.idleT = 0;

    if (!p.dead) {
      this.blinkT -= dt;
      if (this.blinkT <= 0) { this.blinkT = 2 + Math.random() * 4; this.blink = 1; }
      this.blink = Math.max(0, this.blink - dt * 7);
      if (p.grounded && Math.abs(p.vx) > 12) this.anim += dt * (0.5 + Math.abs(p.vx) / PHYS.maxRun * 1.3) * 1.5;
      else this.anim += dt * 0.3;
      this.deadSpin = 0;
      this.alpha = 1;
    } else {
      this.deadSpin += dt * 7 * -sign(p.vx || 1);
      this.alpha = clamp01(1 - p.deadT * 1.2);
    }

    // afterimage ring buffer
    const tr = this.trail[this.head];
    this.head = (this.head + 1) % TRAIL_N;
    tr.x = p.x; tr.y = p.y;
    tr.dash = p.dashT > 0;
    tr.a = p.dashT > 0 ? 1 : Math.abs(p.vx) > 200 || Math.abs(p.vy) > 300 ? 0.45 : 0;

    this.prev = { grounded: p.grounded, vx: p.vx, vy: p.vy, dashReady: p.dashReady, dead: p.dead, stomping: p.stomping, dashT: p.dashT, x: p.x, y: p.y };
  }

  private pose(p: PlayerState): RigPose {
    if (p.dead || p.pose === 'dead') return 'dead';
    if (p.dashT > 0) return 'dash';
    switch (p.pose) {
      case 'spawn': return 'idle';
      case 'idle': case 'run': case 'jump': case 'fall': case 'wall': case 'stomp': case 'hurt': case 'swim':
        return p.pose;
      default:
        return p.grounded ? (Math.abs(p.vx) > 14 ? 'run' : 'idle') : (p.vy < 0 ? 'jump' : 'fall');
    }
  }

  rig(p: PlayerState, skin: Skin): RigState {
    return {
      x: p.x + p.w / 2, y: p.y + p.h,
      vx: p.vx, vy: p.vy,
      grounded: p.grounded, facing: p.facing,
      state: this.pose(p),
      t: p.t, anim: this.anim, squash: this.squash,
      invuln: p.invuln, blink: this.blink, skin,
      dashReady: p.dashReady, dashFlash: this.dashFlash,
      deadSpin: p.dead ? this.deadSpin : 0,
      alpha: this.alpha,
      idle: this.idleT,
      smile: this.smileT > 0 ? clamp01(this.smileT / SMILE_T) : 0,
      stalk: this.stalk,
      chain: this.chainSet ? this.chainRel : undefined,
    };
  }

  drawTrail(stage: Stage, p: PlayerState, skin: Skin): void {
    const ctx = stage.ctx;
    for (let i = 0; i < TRAIL_N; i++) {
      const tr = this.trail[(this.head + i) % TRAIL_N];
      if (tr.a <= 0.01) continue;
      const age = i / TRAIL_N;                 // 0 = oldest
      const a = tr.a * age * age * 0.5;
      if (a < 0.02) continue;
      ctx.save();
      ctx.globalAlpha *= a;
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = skin.glow;
      ctx.beginPath();
      ctx.ellipse(tr.x + p.w / 2, tr.y + p.h / 2, tr.dash ? 7.2 : 6.4, tr.dash ? 5.2 : 5.6, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
  }

  drawSpawnRing(stage: Stage, p: PlayerState, skin: Skin): void {
    if (this.spawnT <= 0) return;
    const ctx = stage.ctx;
    const k = 1 - this.spawnT / 0.42;
    ctx.save();
    ctx.globalAlpha *= 1 - k;
    ctx.strokeStyle = skin.glow;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(p.x + p.w / 2, p.y + p.h / 2, 6 + (1 - k) * 40, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  drawShadow(stage: Stage, level: Level, p: PlayerState): void {
    if (p.dead) return;
    const ctx = stage.ctx;
    const cx = p.x + p.w / 2;
    const feet = p.y + p.h;
    let gy = -1;
    for (let i = 0; i < 9; i++) {
      const y = feet + i * TILE;
      if (level.solid(Math.floor(cx / TILE), Math.floor(y / TILE))) { gy = y; break; }
    }
    if (gy < 0) return;
    const gd = clamp01(1 - (gy - feet) / 120);
    const ty = Math.floor(gy / TILE) * TILE;
    ctx.save();
    ctx.globalAlpha *= 0.3 * gd;
    ctx.fillStyle = '#000000';
    ctx.beginPath();
    ctx.ellipse(cx, ty + 1.5, 5.5 * (0.5 + gd * 0.5), 1.7 * gd, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  /** Full live-player draw: trail, spawn warp, ground shadow, rig with glow. The live player alone smiles at a pickup. */
  draw(stage: Stage, level: Level, p: PlayerState, skin: Skin): void {
    this.drawTrail(stage, p, skin);
    this.drawSpawnRing(stage, p, skin);
    this.drawShadow(stage, level, p);
    const rig = this.rig(p, skin);
    if (scene.pickup > 0 && !p.dead) rig.smile = Math.max(rig.smile ?? 0, clamp01(scene.pickup / SMILE_T));
    drawClawd(stage.ctx, stage.gctx, rig);
  }
}

/**
 * An echo: the same rig tinted in the ghost's colour, drawn translucent, with
 * no glow, no particles, and a small tag above it.
 */
export function drawGhost(stage: Stage, ghost: GhostView, vis: PlayerVisual): void {
  const ctx = stage.ctx;
  const p = ghost.player;
  const skin = tintedSkin(ghost.color);
  ctx.save();
  ctx.globalAlpha = clamp(ghost.alpha, 0, 1);
  vis.drawTrail(stage, p, skin);
  drawClawd(ctx, null, vis.rig(p, skin));
  if (ghost.label) {
    const cx = p.x + p.w / 2, ty = p.y - 7;
    ctx.font = `700 5.5px ${UI_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const w = (ctx.measureText(ghost.label).width || 12) + 6;
    ctx.fillStyle = alpha('#07060B', 0.6);
    ctx.beginPath(); ctx.roundRect(cx - w / 2, ty - 4.2, w, 8.4, 3); ctx.fill();
    ctx.fillStyle = ghost.color;
    ctx.fillText(ghost.label, cx, ty);
  }
  ctx.restore();
}

// ============================================================ death marks (P2-4)
/** A death position in world units (the shell keeps the list; see Scenes.markDeath). */
export interface DeathMarkView { x: number; y: number }
/** Soft danger pink, used by nothing else in a frame so a test can count the marks by stroke colour. */
export const DEATH_MARK_COLOR = '#FFA3B1';
/** Half-size of the X in world units. */
export const DEATH_MARK_R = 4.5;

/**
 * Small X marks where the player died earlier in this zone session, oldest
 * first and dimmest, the newest breathing a little. Drawn in world space
 * behind the echoes and the player, culled off screen, never glowing.
 */
export function drawDeathMarks(stage: Stage, marks: readonly DeathMarkView[], t: number): void {
  if (marks.length === 0) return;
  const ctx = stage.ctx;
  const r = DEATH_MARK_R;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineWidth = 1.5;
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i];
    if (!stage.visible(m.x - r - 2, m.y - r - 2, r * 2 + 4, r * 2 + 4, 8)) continue;
    const newest = i === marks.length - 1;
    const fade = 0.32 + 0.4 * ((i + 1) / marks.length);
    ctx.globalAlpha = clamp(fade + (newest ? 0.12 * (0.5 + 0.5 * Math.sin(t * 3.2)) : 0), 0, 1);
    // dark backing disc so the mark reads over bright terrain
    ctx.fillStyle = alpha('#07060B', 0.55);
    ctx.beginPath(); ctx.arc(m.x, m.y, r + 2.2, 0, TAU); ctx.fill();
    ctx.strokeStyle = DEATH_MARK_COLOR;
    ctx.beginPath();
    ctx.moveTo(m.x - r, m.y - r); ctx.lineTo(m.x + r, m.y + r);
    ctx.moveTo(m.x + r, m.y - r); ctx.lineTo(m.x - r, m.y + r);
    ctx.stroke();
  }
  ctx.restore();
}
