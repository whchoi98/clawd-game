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
import { drawClawd, tintedSkin, type RigPose, type RigState, type Skin } from './clawd.js';

const FOE_DIE_T = 0.3;
const SHARD_POP_T = 0.4;
const RELIC_POP_T = 0.7;
const TRAIL_N = 14;

interface Streak { x: number; y: number; s: number }
interface EntVis {
  pop: number;          // seconds since the pickup was consumed
  lit: number;          // damped 0..1 (checkpoint active / goal open)
  minX: number; maxX: number; minY: number; maxY: number;   // observed travel range (rails)
  streaks: Streak[] | null;
}
interface FoeVis { aim: number; charge: number }

function entVis(map: Map<number, EntVis>, e: EntityState): EntVis {
  let v = map.get(e.id);
  if (!v) {
    v = { pop: 0, lit: 0, minX: e.x, maxX: e.x, minY: e.y, maxY: e.y, streaks: null };
    map.set(e.id, v);
  }
  return v;
}

// ============================================================ actors
export class Actors {
  private readonly ent = new Map<number, EntVis>();
  private readonly foe = new Map<number, FoeVis>();

  constructor(private readonly stage: Stage, public biome: Biome) {}

  setLevel(biome: Biome): void {
    this.biome = biome;
    this.ent.clear();
    this.foe.clear();
  }

  /** Advance visual-only timers. */
  update(dt: number, state: SimState): void {
    for (const e of state.entities) {
      const v = entVis(this.ent, e);
      if (!e.alive) v.pop += dt;
      if (e.kind === 'checkpoint') v.lit = damp(v.lit, e.state >= 0.5 ? 1 : 0, 0.12, dt);
      else if (e.kind === 'goal') v.lit = damp(v.lit, 1, 0.4, dt);
      if (e.kind === 'platH' || e.kind === 'platV' || e.kind === 'saw') {
        if (e.x < v.minX) v.minX = e.x; if (e.x > v.maxX) v.maxX = e.x;
        if (e.y < v.minY) v.minY = e.y; if (e.y > v.maxY) v.maxY = e.y;
      }
      if (e.kind === 'updraft') {
        if (!v.streaks) {
          v.streaks = [];
          for (let i = 0; i < 7; i++) v.streaks.push({ x: Math.random(), y: Math.random(), s: 0.5 + Math.random() });
        }
        for (const s of v.streaks) {
          s.y -= dt * s.s * 0.9;
          if (s.y < 0) { s.y = 1; s.x = Math.random(); }
        }
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
      if (!st.visible(e.x - 40, e.y - 40, 80, 80, 40)) continue;
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

  private updraft(e: EntityState, v: EntVis): void {
    const ctx = this.stage.ctx, gctx = this.stage.gctx;
    const w = e.w || TILE, h = Math.max(TILE, e.h || TILE * 3);
    const x = e.x - w / 2, y = e.y - h / 2;
    ctx.save();
    const g = ctx.createLinearGradient(0, y + h, 0, y);
    g.addColorStop(0, alpha('#BFF0FF', 0.16));
    g.addColorStop(1, alpha('#BFF0FF', 0));
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = alpha('#DFF6FF', 0.5);
    ctx.lineWidth = 0.9;
    const base = ctx.globalAlpha;
    for (const s of v.streaks ?? []) {
      const sx = x + 2 + s.x * (w - 4);
      const sy = y + s.y * h;
      ctx.globalAlpha = base * 0.5 * Math.sin(s.y * Math.PI);
      ctx.beginPath();
      ctx.moveTo(sx, sy); ctx.lineTo(sx, sy - 7 * s.s);
      ctx.stroke();
    }
    ctx.restore();
    if (this.stage.settings.bloom) {
      gctx.fillStyle = alpha('#BFF0FF', 0.08);
      gctx.fillRect(x, y, w, h);
    }
  }

  // ------------------------------------------------------------ foes
  drawFoes(state: SimState, t: number): void {
    const st = this.stage;
    for (const f of state.foes) {
      if (f.dead) continue;
      if (!st.visible(f.x - 20, f.y - 20, 40, 40)) continue;
      switch (f.kind) {
        case 'walker': this.walker(f, t, false); break;
        case 'spiker': this.walker(f, t, true); break;
        case 'hopper': this.hopper(f, t); break;
        case 'flyer': this.flyer(f); break;
        case 'turret': this.turret(f, t); break;
        case 'chaser': this.chaser(f); break;
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
    for (const s of [-1, 1]) {
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath(); ctx.arc(f.face * 2.2 + s * 1.9, -0.6, 1.5, 0, TAU); ctx.fill();
      ctx.fillStyle = '#150C28';
      ctx.beginPath(); ctx.arc(f.face * 2.9 + s * 1.9, -0.5, 0.75, 0, TAU); ctx.fill();
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
    // squash from motion: crouch before a hop, stretch on the way up
    const sq = f.vy < -30 ? -0.35 : Math.abs(f.vy) < 1 ? 0.18 + 0.12 * Math.sin(f.t * 5) : 0;
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
      ctx.beginPath(); ctx.ellipse(sd * 2.4 + f.face * 0.8, -1.4, 1.1, 1.5, 0, 0, TAU); ctx.fill();
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
 * Visual-only state of one Clawd (the live player or an echo): squash spring,
 * run-cycle phase, blink, dash-refill flash, spawn warp, afterimage trail and
 * the death tumble. Derived from PlayerState deltas so it works for ghosts too.
 */
export class PlayerVisual {
  squash = 0;
  anim = 0;
  blink = 0;
  dashFlash = 0;
  spawnT = 0;
  deadSpin = 0;
  alpha = 1;
  private blinkT = 1.5;
  private readonly trail: TrailNode[] = [];
  private head = 0;
  private prev: { grounded: boolean; vy: number; dashReady: boolean; dead: boolean; stomping: boolean; dashT: number } | null = null;

  constructor() {
    for (let i = 0; i < TRAIL_N; i++) this.trail.push({ x: 0, y: 0, a: 0, dash: false });
  }

  /** New level or respawn: forget deltas, play the spawn warp. */
  reset(p?: PlayerState): void {
    this.squash = 0; this.anim = 0; this.blink = 0; this.blinkT = 1.5;
    this.dashFlash = 0; this.spawnT = 0.42; this.deadSpin = 0; this.alpha = 1;
    this.prev = null;
    for (const tr of this.trail) { tr.a = 0; if (p) { tr.x = p.x; tr.y = p.y; } }
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

    this.prev = { grounded: p.grounded, vy: p.vy, dashReady: p.dashReady, dead: p.dead, stomping: p.stomping, dashT: p.dashT };
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

  /** Full live-player draw: trail, spawn warp, ground shadow, rig with glow. */
  draw(stage: Stage, level: Level, p: PlayerState, skin: Skin): void {
    this.drawTrail(stage, p, skin);
    this.drawSpawnRing(stage, p, skin);
    this.drawShadow(stage, level, p);
    drawClawd(stage.ctx, stage.gctx, this.rig(p, skin));
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
