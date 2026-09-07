/**
 * `Renderer` — the client's RendererPort implementation.
 *
 * Reads `sim.state` and `sim.level` only, never writes them. Everything that is
 * presentation — squash, trails, particles, bloom, weather, the title vista —
 * lives here and is advanced by `dtFrame`, so a replay verified on the server
 * is never influenced by what the player saw.
 *
 * Frame order: sky (device space: gradient, stars, aurora, sun, clouds,
 * ridges with far structures, props, cloud deck, flock, back wall, weather) →
 * world transform → terrain (with the biome face decor) → hazards → entities →
 * foes → bolts → echoes → player → particles → tide → screen-space fog band →
 * composite (bloom, vignette, grain, flash, fade, letterbox).
 *
 * Band crossfade (P5-4b): on a tide level (daily / endless, `def.tide`) the
 * band under the player's feet decides the biome — `bandBiome(def, row)`, the
 * same call the HUD label uses — and a change starts a BAND_FADE_S crossfade:
 * a second Sky (same seed and box, so the silhouettes coincide) and a cached
 * Terrain of the new band draw underneath while the old pair fades out over
 * them; the fog band and the goal beacon blend their colours; the actors
 * switch palette at once. Hysteresis needs the feet one tile past the boundary
 * in the direction of travel; a respawn or a teleport (a feet-row jump of
 * BAND_SNAP_ROWS or more in one frame) and the `low` tier hard-cut instead.
 * Story zones never run any of it. All of it is visual: the sim is only read.
 */
import { TILE } from '../../sim/types.js';
import type { BiomeId, LevelDef, PlayerState, SimEvent, SimState } from '../../sim/types.js';
import type { Level } from '../../sim/level.js';
import { makeRng } from '../../sim/rng.js';
import { bandBiome } from '../../sim/gen/daily.js';
import { BIOMES, C, type Biome } from '../../shared/biomes.js';
import type { FxState, GhostView, RendererPort, Settings, WorldView } from '../contracts.js';
import {
  Stage, UI_FONT, TAU, alpha, clamp01, defaultCreateCanvas, fbm, lerp, mixHex,
  type FpsStats, type QualityTier, type StageOptions,
} from './stage.js';
import { Sky } from './sky.js';
import { Terrain } from './tiles.js';
import { Particles } from './particles.js';
import { GOAL_LOOK_TILES, SKINS, drawClawd, drawClawdPortrait, setLookTarget, skinById, type Skin } from './clawd.js';
import { Actors, PlayerVisual, drawDeathMarks, drawGhost, type DeathMarkView } from './actors.js';

/**
 * The slice of `Sim` the renderer reads. Structural, so tests can drive the
 * renderer with a plain object and the real `Sim` satisfies it unchanged.
 */
export interface SimView {
  readonly state: SimState;
  readonly level: Level;
}

export type RendererOptions = StageOptions;

const TITLE_SEEDS: Record<BiomeId, number> = { tidepool: 3, stormspire: 12, voidreef: 21, summit: 30 };

/** The goal counts as on screen only when its orb sits this far (world units) inside the view. */
const GOAL_EDGE_MARGIN = 10;
/** Distance of the edge beacon's centre from the rendered box's edge, in world units. */
const BEACON_INSET = 20;
/** World units the player travels between two dash after-images (P3-9). */
export const AFTER_IMAGE_SPACING = 10;
/** Seconds a tide level's band crossfade takes (P5-4b). */
export const BAND_FADE_S = 1.2;
/**
 * A feet-row jump of this many tiles between two draws is a teleport or a
 * respawn, never movement (PHYS.maxFall 340 and springVel 430 stay under
 * 3 tiles even over the 0.1 s frame clamp): the band then hard-cuts.
 */
export const BAND_SNAP_ROWS = 4;

/** Monotonic milliseconds for the render-cost sample; -1 when the platform has no clock (the scaler then ignores cost). */
function nowMs(): number {
  const p = (globalThis as { performance?: { now?: () => number } }).performance;
  return p && typeof p.now === 'function' ? p.now() : -1;
}

/** The tile row under the player's feet — exactly the HUD's band row (scenes.hudState). */
function feetRowOf(p: PlayerState): number {
  return Math.floor((p.y + p.h - 1) / TILE);
}

/**
 * Every band biome a tide level shows, bottom band first: sampled every 8 rows
 * (bands are 50 or 90 rows) plus the top row, so a partial band capping the
 * tower (the 160-row daily ends 10 rows into its fourth) is never missed.
 */
function bandBiomesOf(def: LevelDef): BiomeId[] {
  const out: BiomeId[] = [];
  const add = (ty: number): void => { const id = bandBiome(def, ty); if (!out.includes(id)) out.push(id); };
  for (let ty = def.rows.length - 1; ty >= 0; ty -= 8) add(ty);
  add(0);
  return out;
}

export class Renderer implements RendererPort {
  /** Goal projection after the last draw in CSS px relative to the canvas; see RendererPort. */
  goalScreen: { x: number; y: number; onScreen: boolean } | null = null;
  /** `?fps=1`: draw the frame-statistics line on the world canvas (main.ts sets it from the query string). */
  showFps = false;
  /** Render cost (ms) of the previous draw(), handed to the adaptive scaler with the next frame; undefined without a clock. */
  private lastWorkMs: number | undefined = undefined;
  /** Render cost (ms) of the previous drawTitle(): the pre-play capability probe (Stage.noteFrame). */
  private lastTitleWorkMs: number | undefined = undefined;
  readonly stage: Stage;
  readonly particles: Particles;
  readonly actors: Actors;
  readonly skins: Record<string, { name: string; kr: string }>;

  private readonly createCanvas: () => HTMLCanvasElement;
  /** Two backdrops: the current band's, and one to fade out during a band change (P5-4b). */
  private readonly skies: readonly [Sky, Sky];
  private skyCur: Sky;
  private skyPrev: Sky | null = null;
  private terrain: Terrain | null = null;
  private terrainPrev: Terrain | null = null;
  /** One Terrain per band biome of the current level (a story zone has one). */
  private readonly terrains = new Map<BiomeId, Terrain>();
  private level: Level | null = null;
  private biome: Biome | null = null;
  /** The band fading out; null outside a crossfade. */
  private prevBiome: Biome | null = null;
  /** Seconds left of the band crossfade; 0 when none runs. */
  private bandFade = 0;
  /** The feet row of the last draw, and the sign of its last change (hysteresis works against it). */
  private feetRow = 0;
  private bandDir = 0;
  /** Set by a respawn / intro event: the next band change hard-cuts. */
  private snapBand = false;
  /** Who last configured the sky: the level or the title vista. */
  private skyOwner: 'level' | 'title' | null = null;
  private t = 0;
  private switchFlash = 0;
  private skinId = 'clawd';
  private readonly playerVis = new PlayerVisual();
  private readonly ghostVis: PlayerVisual[] = [];
  /** Death X marks of the current zone session, as the shell last set them (render only). */
  private deathMarks: readonly DeathMarkView[] = [];
  /** The level's goal orb (world units), for the eye lead; null without a goal. */
  private goal: { x: number; y: number } | null = null;
  /** Where the last dash after-image was stamped; null when the player is not dashing. */
  private afterAt: { x: number; y: number } | null = null;

  // title vista
  private titleBiome: BiomeId | null = null;
  private titleCamX = 0;
  private titleProfile: Float32Array = new Float32Array(97);
  private titleBlink = 0;
  private titleBlinkT = 2;
  private titleAnim = 0;

  constructor(canvas: HTMLCanvasElement, opts: RendererOptions = {}) {
    this.createCanvas = opts.createCanvas ?? defaultCreateCanvas;
    this.stage = new Stage(canvas, opts);
    this.skies = [new Sky(this.stage), new Sky(this.stage)];
    this.skyCur = this.skies[0];
    this.particles = new Particles(this.stage);
    this.actors = new Actors(this.stage, BIOMES.tidepool, this.particles);
    const skins: Record<string, { name: string; kr: string }> = {};
    for (const s of Object.values(SKINS)) skins[s.id] = { name: s.name, kr: s.kr };
    this.skins = skins;
  }

  // ------------------------------------------------------------ port: read-only
  get viewW(): number { return this.stage.viewW; }
  get viewH(): number { return this.stage.viewH; }
  get fps(): number { return this.stage.fps; }
  get qualityTier(): QualityTier { return this.stage.quality; }
  /** The backdrop of the current band (the title vista's while a menu is up). */
  get sky(): Sky { return this.skyCur; }
  /** Band state (tide levels): the current band, the band fading out (null when none) and the seconds left. */
  get band(): { biome: BiomeId | null; prev: BiomeId | null; fade: number } {
    return { biome: this.biome?.id ?? null, prev: this.prevBiome?.id ?? null, fade: this.bandFade };
  }

  // ------------------------------------------------------------ port: lifecycle
  setLevel(sim: SimView, biome: Biome): void {
    const def = sim.level.def;
    this.level = sim.level;
    this.terrains.clear();
    this.skyPrev = null;
    this.terrainPrev = null;
    this.prevBiome = null;
    this.bandFade = 0;
    this.snapBand = false;
    this.bandDir = 0;
    this.feetRow = feetRowOf(sim.state.player);
    // a tide level starts on the band under the player's feet (the shell passes the bottom band's biome)
    const b = def.tide ? BIOMES[bandBiome(def, this.feetRow)] : biome;
    this.biome = b;
    // the level box tells the sky whether this is a vertical zone (cloud deck) or a horizontal one (time-of-day drift)
    this.skyCur.setBiome(b, def.seed, { pxW: sim.level.pxW, pxH: sim.level.pxH });
    this.skyOwner = 'level';
    this.terrain = this.terrainFor(b);
    // bake every band's rock texture now, behind the level's fade-in, so a band change costs no frame later
    if (def.tide) for (const id of bandBiomesOf(def)) this.terrainFor(BIOMES[id]);
    this.actors.setLevel(b);
    this.playerVis.reset(sim.state.player);
    this.ghostVis.length = 0;
    this.particles.clear();
    this.switchFlash = 0;
    this.t = 0;
    this.goalScreen = null;
    const goal = sim.state.entities.find((e) => e.kind === 'goal');
    this.goal = goal ? { x: goal.x, y: goal.y } : null;
    this.afterAt = null;
  }

  /**
   * Eye lead (P3-9): the direction from the player's centre to the goal orb
   * when it lies within GOAL_LOOK_TILES, as a -1..1 vector; null otherwise.
   */
  goalLook(p: PlayerState): { x: number; y: number } | null {
    const g = this.goal;
    if (!g || p.dead) return null;
    const dx = g.x - (p.x + p.w / 2), dy = (g.y - 8) - (p.y + p.h / 2);
    const d = Math.hypot(dx, dy);
    if (d < 1 || d > GOAL_LOOK_TILES * TILE) return null;
    return { x: dx / d, y: dy / d };
  }

  /** Dash after-images (P3-9): a skin-coloured silhouette every AFTER_IMAGE_SPACING units while the dash lasts. */
  private dashAfterImages(p: PlayerState, skin: Skin): void {
    if (!(p.dashT > 0) || p.dead) { this.afterAt = null; return; }
    const cx = p.x + p.w / 2, cy = p.y + p.h;
    const last = this.afterAt;
    if (last && Math.hypot(cx - last.x, cy - last.y) < AFTER_IMAGE_SPACING) return;
    this.afterAt = { x: cx, y: cy };
    this.particles.afterImage(cx, cy, p.facing, skin.shell, 0.6);
  }

  resize(): void { this.stage.resize(); }

  applySettings(s: Settings): void {
    this.stage.setSettings({ bloom: s.bloom, grain: s.grain, flashes: s.flashes, quality: s.quality });
    for (const sky of this.skies) sky.flashesAllowed = s.flashes;
    this.skinId = SKINS[s.skin] ? s.skin : 'clawd';
  }

  // ------------------------------------------------------------ band crossfade (P5-4b)
  /** The Terrain of a biome over the current level, built once per level. */
  private terrainFor(b: Biome): Terrain {
    let t = this.terrains.get(b.id);
    if (!t) {
      t = new Terrain(this.stage, this.level!, b, this.createCanvas);
      this.terrains.set(b.id, t);
    }
    return t;
  }

  /**
   * Per frame on a tide level: follow the band under the player's feet, with
   * hysteresis, and advance a running crossfade. Frozen while the player is
   * dead — the death tumble crosses no band; the respawn snaps.
   */
  private trackBand(sim: SimView, dt: number): void {
    const def = sim.level.def, p = sim.state.player;
    const low = this.stage.quality === 'low';
    if (!p.dead) {
      const row = feetRowOf(p);
      const from = this.feetRow;
      if (row !== from) this.bandDir = Math.sign(row - from);
      const jump = this.snapBand || Math.abs(row - from) >= BAND_SNAP_ROWS;
      this.feetRow = row;
      this.snapBand = false;
      const want = bandBiome(def, row);
      // hysteresis: the row one tile back toward where the feet came from must already lie in the new band
      if (want !== this.biome!.id && (jump || bandBiome(def, row - this.bandDir) === want)) {
        this.switchBand(BIOMES[want], jump || low);
      }
    }
    if (this.bandFade > 0) {
      this.bandFade = Math.max(0, this.bandFade - dt);
      if (this.bandFade === 0 || low) this.endFade();
    }
  }

  /** Make `next` the current band: at once, or by starting (or reversing) a crossfade from the current one. */
  private switchBand(next: Biome, instant: boolean): void {
    const level = this.level!, cur = this.biome!;
    const box = { pxW: level.pxW, pxH: level.pxH };
    const nextTerrain = this.terrainFor(next);
    if (instant) {
      this.skyCur.setBiome(next, level.def.seed, box);
      this.terrain = nextTerrain;
      this.endFade();
    } else {
      const spare = this.skyCur === this.skies[0] ? this.skies[1] : this.skies[0];
      // a hop back across the boundary mid-fade: the spare still shows the band we return to — keep its motes, mirror the progress
      const reversing = this.skyPrev === spare && spare.biome?.id === next.id;
      if (!reversing) spare.setBiome(next, level.def.seed, box);
      this.skyPrev = this.skyCur;
      this.skyCur = spare;
      this.terrainPrev = this.terrain;
      this.terrain = nextTerrain;
      this.prevBiome = cur;
      this.bandFade = reversing ? BAND_FADE_S - this.bandFade : BAND_FADE_S;
    }
    this.biome = next;
    this.actors.setBiome(next);
  }

  private endFade(): void {
    this.skyPrev = null;
    this.terrainPrev = null;
    this.prevBiome = null;
    this.bandFade = 0;
  }

  /** Crossfade progress 0 → 1 (smoothstep); 1 outside a fade. */
  private fadeK(): number {
    if (this.bandFade <= 0 || !this.prevBiome) return 1;
    const u = clamp01(1 - this.bandFade / BAND_FADE_S);
    return u * u * (3 - 2 * u);
  }

  clearParticles(): void { this.particles.clear(); }

  /**
   * Where the player died earlier in this zone session (world units), drawn as
   * small X marks under the echoes. The shell owns the list and passes it on
   * every change; a respawn or a restart never clears it here.
   */
  setDeathMarks(marks: readonly DeathMarkView[]): void { this.deathMarks = marks; }

  private skin(): Skin { return skinById(this.skinId); }

  // ------------------------------------------------------------ port: draw
  draw(sim: SimView, view: WorldView, fx: FxState, ghosts: GhostView[], dtFrame: number): void {
    if (!this.terrain || this.level !== sim.level || this.skyOwner !== 'level' || !this.biome) {
      this.setLevel(sim, this.biome && this.level === sim.level ? this.biome : BIOMES[sim.level.def.biome]);
    }
    const st = this.stage, level = sim.level, state = sim.state;
    const dt = Math.min(Math.max(0, dtFrame), 0.1);
    this.t += dt;
    const t0 = nowMs();
    // The adaptive scaler sees this frame's interval and the previous frame's render cost — before anything
    // is drawn, so a tier change (a canvas resize) never blanks the frame it was decided on.
    st.sampleFps(dtFrame, this.lastWorkMs);

    // ---- the band under the feet (tide levels only; story zones keep def.biome) ----
    if (level.def.tide) this.trackBand(sim, dt);
    const biome = this.biome!, prev = this.prevBiome;
    const k = this.fadeK();
    const fading = k < 1 && prev !== null;

    // ---- advance visual-only state ----
    this.skyCur.update(dt, view.camX, view.camY);
    if (fading && this.skyPrev) this.skyPrev.update(dt, view.camX, view.camY);
    this.particles.update(dt, (x, y) => level.solid(Math.floor(x / TILE), Math.floor(y / TILE)));
    this.playerVis.update(dt, state.player);
    this.dashAfterImages(state.player, this.skin());
    while (this.ghostVis.length < ghosts.length) this.ghostVis.push(new PlayerVisual());
    for (let i = 0; i < ghosts.length; i++) this.ghostVis[i].update(dt, ghosts[i].player);
    this.actors.update(dt, state);
    this.switchFlash = Math.max(0, this.switchFlash - dt * 2.4);

    // ---- frame ----
    st.begin();
    // the new band's sky, then the old one fading out over it (their silhouettes coincide: same seed and box)
    this.skyCur.draw(view.camX, view.camY);
    if (fading && this.skyPrev) {
      this.skyPrev.opacity = 1 - k;
      this.skyPrev.draw(view.camX, view.camY);
      this.skyPrev.opacity = 1;
    }
    st.world(view.camX, view.camY, fx.shakeX, fx.shakeY, view.zoom * (fx.zoom || 1), fx.shakeRot);

    this.terrain!.draw(this.t, this.switchFlash);
    this.terrain!.drawHazards(this.t);
    if (fading && this.terrainPrev) {
      // the old palette over the new on the same tiles; the bloom hints fade with it
      st.ctx.globalAlpha = 1 - k;
      st.gctx.globalAlpha = 1 - k;
      this.terrainPrev.draw(this.t, this.switchFlash);
      this.terrainPrev.drawHazards(this.t);
      st.ctx.globalAlpha = 1;
      st.gctx.globalAlpha = 1;
    }

    this.actors.drawEntities(state);
    this.actors.drawFoes(state, this.t);
    this.actors.drawBolts(state);
    drawDeathMarks(st, this.deathMarks, this.t);

    for (let i = 0; i < ghosts.length; i++) drawGhost(st, ghosts[i], this.ghostVis[i]);

    // the live player alone gets the eye lead toward a near goal (set → draw → clear, see clawd.ts)
    setLookTarget(this.goalLook(state.player));
    this.playerVis.draw(st, level, state.player, this.skin());
    setLookTarget(null);
    this.particles.draw(UI_FONT);

    if (state.tide) this.actors.drawTide(state.tide, this.t);

    // foreground haze band adds depth separation from the terrain (its colour blends across a band change)
    st.screen();
    const ctx = st.ctx;
    const fog = fading && prev ? mixHex(prev.fog, biome.fog, k) : biome.fog;
    const ambient = fading && prev ? lerp(prev.ambient, biome.ambient, k) : biome.ambient;
    const fg = ctx.createLinearGradient(0, st.viewH * 0.72, 0, st.viewH);
    fg.addColorStop(0, alpha(fog, 0));
    fg.addColorStop(1, alpha(fog, 0.14 + ambient * 0.3));
    ctx.fillStyle = fg;
    ctx.fillRect(0, st.viewH * 0.72, st.viewW, st.viewH * 0.28);

    st.composite(fx);

    // HUD-like, so after the film pass: never bloomed, vignetted or grained
    this.goalBeacon(state, fx, fading && prev ? mixHex(prev.accent, biome.accent, k) : biome.accent);

    if (this.showFps) this.fpsOverlay();
    this.lastWorkMs = t0 >= 0 ? Math.max(0, nowMs() - t0) : undefined;
  }

  /** Frame statistics of the adaptive scaler's last window (p50 / p95 interval, render cost, display Hz, tier). */
  fpsStats(): FpsStats { return this.stage.fpsStats(); }

  /** `?fps=1` diagnostics: one line of canvas text, top-left of the rendered box. Never drawn without the flag. */
  private fpsOverlay(): void {
    const st = this.stage, ctx = st.ctx, s = st.fpsStats();
    st.screen();
    ctx.save();
    ctx.font = `600 7px ${UI_FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const text = `p50 ${s.p50}ms · p95 ${s.p95}ms · draw ${s.workP95}ms · ${s.hz}Hz · ${s.tier} · ${Math.round(st.fps)}fps`;
    ctx.fillStyle = 'rgba(5,10,18,0.7)';
    ctx.fillRect(4, 4, text.length * 3.6 + 6, 11);
    ctx.fillStyle = '#CFFBF4';
    ctx.fillText(text, 7, 6);
    ctx.restore();
  }

  /**
   * Project the goal orb to the canvas (CSS px) into `goalScreen` and, when it
   * lies outside the view, draw a pulsing edge beacon toward it in the biome
   * accent (blended across a band change). Mirrors the transform `Stage.world`
   * pushed for this frame.
   */
  private goalBeacon(state: SimState, fx: FxState, accent: string): void {
    const goal = state.entities.find((e) => e.kind === 'goal');
    if (!goal) { this.goalScreen = null; return; }
    const st = this.stage;
    const gx = goal.x, gy = goal.y + TILE / 2 - 18;      // the orb, see Actors.goal
    const zoom = st.zoom;
    const rx = (gx - st.camX) * zoom, ry = (gy - st.camY) * zoom;
    const rot = fx.shakeRot || 0;
    const cos = Math.cos(rot), sin = Math.sin(rot);
    // screen units: origin top-left of the rendered box, world units per unit
    const sx = rx * cos - ry * sin + st.viewW / 2 + (fx.shakeX || 0);
    const sy = rx * sin + ry * cos + st.viewH / 2 + (fx.shakeY || 0);
    const m = GOAL_EDGE_MARGIN;
    const onScreen = sx > m && sx < st.viewW - m && sy > m && sy < st.viewH - m;
    const dpr = st.dpr || 1;
    this.goalScreen = { x: (st.ox + sx * st.scale) / dpr, y: (st.oy + sy * st.scale) / dpr, onScreen };
    if (onScreen) return;

    // clamp the centre→goal ray to the box inset by BEACON_INSET
    const cx = st.viewW / 2, cy = st.viewH / 2;
    const dx = sx - cx, dy = sy - cy;
    const kx = Math.abs(dx) > 1e-6 ? (cx - BEACON_INSET) / Math.abs(dx) : Infinity;
    const ky = Math.abs(dy) > 1e-6 ? (cy - BEACON_INSET) / Math.abs(dy) : Infinity;
    const k = Math.min(kx, ky);
    if (!Number.isFinite(k)) return;
    const bx = cx + dx * k, by = cy + dy * k;
    const ang = Math.atan2(dy, dx);
    const pulse = 0.5 + 0.5 * Math.sin(this.t * 5);
    const ctx = st.ctx;
    st.screen();
    ctx.save();
    ctx.globalAlpha = 1 - clamp01(fx.fade);
    ctx.translate(bx, by);
    const haloR = 15 + pulse * 5;
    const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, haloR);
    halo.addColorStop(0, alpha(accent, 0.38));
    halo.addColorStop(1, alpha(accent, 0));
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(0, 0, haloR, 0, TAU); ctx.fill();
    // dark backing so the chevron reads over a bright sky
    ctx.fillStyle = alpha('#07060B', 0.5);
    ctx.beginPath(); ctx.arc(0, 0, 9.5, 0, TAU); ctx.fill();
    ctx.strokeStyle = alpha(accent, 0.3 + 0.4 * pulse);
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(0, 0, 11 + pulse * 2.5, 0, TAU); ctx.stroke();
    // chevron pointing at the goal, opaque in the accent
    ctx.rotate(ang);
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.moveTo(8, 0); ctx.lineTo(-4.5, -6.5); ctx.lineTo(-1.5, 0); ctx.lineTo(-4.5, 6.5);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = alpha('#FFF6C8', 0.9);
    ctx.beginPath(); ctx.arc(1.2, 0, 1.6, 0, TAU); ctx.fill();
    ctx.restore();
  }

  // ------------------------------------------------------------ port: events
  onEvent(ev: SimEvent, sim: SimView): void {
    const P = this.particles;
    const b = this.biome ?? BIOMES[sim.level.def.biome];
    const skin = this.skin();
    const p = sim.state.player;
    switch (ev.type) {
      case 'phase':
        if (ev.phase === 'intro') { this.playerVis.reset(p); P.clear(); this.actors.resetStreaks(); this.snapBand = true; }
        break;
      case 'jump':
        this.playerVis.jump();
        if (ev.air) {
          P.ring(ev.x, ev.y - 3, 3, 15, 0.34, C.shardHi, 1.6, 1);
          P.spark(ev.x, ev.y, 9, C.shardHi, 120, Math.PI / 2, 2.2, 1);
        } else {
          P.dust(ev.x, ev.y, 7, 0, b.crustHi, 62);
        }
        break;
      case 'land': {
        const impact = clamp01(ev.impact);
        this.playerVis.land(impact);
        P.landDust(ev.x, ev.y, impact, b.crustHi);
        if (impact > 0.55) P.ring(ev.x, ev.y, 2, 22 + impact * 18, 0.3, b.crustHi, 1.8, 0.7);
        break;
      }
      case 'dash':
        P.ring(ev.x, ev.y, 4, 26, 0.32, skin.glow, 2.2, 1.2);
        P.spark(ev.x, ev.y, 16, skin.glow, 230, Math.atan2(-ev.dy, -ev.dx), 1.5, 1.2);
        break;
      case 'dashEnd':
        P.spark(ev.x, ev.y, 4, skin.glow, 90, null, TAU, 0.8);
        break;
      case 'wallJump': {
        this.playerVis.wallJump();
        const dir = ev.dir > 0 ? Math.PI : 0;    // kick away from the wall
        P.dust(ev.x, ev.y, 8, dir, b.crustHi, 90);
        P.spark(ev.x, ev.y, 6, b.crustHi, 130, dir, 1.4, 0.7);
        break;
      }
      case 'wallSlide':
        P.dust(ev.x, ev.y, 1, ev.dir > 0 ? Math.PI : 0, b.crustHi, 26);
        P.slideSparks(ev.x, ev.y, ev.dir, b.crustHi);
        break;
      case 'stomp':
        P.spark(ev.x, ev.y, 5, C.shardHi, 90, Math.PI / 2, 1.1, 0.7);
        break;
      case 'stompLand':
        this.playerVis.land(1, true);
        P.ring(ev.x, ev.y, 4, 46, 0.34, b.crustHi, 2.4, 0.9);
        P.spark(ev.x, ev.y, 14, b.crustHi, 200, 0, Math.PI, 0.8);
        P.dust(ev.x, ev.y, 12, 0, b.crustHi, 120);
        break;
      case 'shard':
        this.playerVis.smile();
        P.spark(ev.x, ev.y, 10, C.shardHi, 150, null, TAU, 1.1);
        P.ring(ev.x, ev.y, 2, 16, 0.26, C.shardHi, 1.4, 1);
        if (ev.combo > 2) P.text(ev.x, ev.y - 10, `×${ev.combo}`, C.shardHi, 0.8);
        break;
      case 'relic':
        P.spark(ev.x, ev.y, 26, C.relicHi, 240, null, TAU, 1.3);
        P.ring(ev.x, ev.y, 3, 60, 0.6, C.relic, 3, 1.4);
        this.playerVis.refill();
        this.playerVis.smile();
        break;
      case 'crystal':
        this.playerVis.refill();
        P.spark(ev.x, ev.y, 14, C.crystalHi, 170, null, TAU, 1.1);
        P.ring(ev.x, ev.y, 3, 28, 0.36, C.crystal, 2, 1.2);
        P.tri(ev.x, ev.y, 5, C.crystal, 120, 0.8);
        break;
      case 'toggle': {
        const col = ev.switchA ? C.switchA : C.switchB;
        this.switchFlash = 1;
        P.ring(ev.x, ev.y, 4, 40, 0.42, col, 2.4, 1.3);
        P.spark(ev.x, ev.y, 12, col, 180, null, TAU, 1);
        break;
      }
      case 'checkpoint':
        P.ring(ev.x, ev.y - 20, 4, 40, 0.5, C.checkpoint, 2, 1.2);
        P.spark(ev.x, ev.y - 20, 8, C.checkpoint, 110, -Math.PI / 2, 1.6, 0.9);
        break;
      case 'spring':
        this.playerVis.squash = -0.4;
        P.ring(ev.x, ev.y - 4, 3, 26, 0.32, C.spring, 2, 1);
        P.spark(ev.x, ev.y - 4, 12, C.spring, 190, -Math.PI / 2, 1.7, 1);
        break;
      case 'hurt':
        P.spark(ev.x, ev.y, 18, C.dangerHi, 220, null, TAU, 1.2);
        P.ring(ev.x, ev.y, 3, 32, 0.4, C.danger, 2.4, 1.2);
        break;
      case 'death':
        P.tri(ev.x, ev.y, 12, skin.shell, 190, 0.8);
        P.spark(ev.x, ev.y, 22, skin.glow, 260, null, TAU, 1.2);
        P.ring(ev.x, ev.y, 3, 44, 0.55, skin.glow, 3, 1.4);
        if (ev.cause === 'tide') P.dust(ev.x, ev.y, 10, -Math.PI / 2, C.tide, 80);
        break;
      case 'respawn':
        this.playerVis.reset(p);
        P.clear();
        this.actors.resetStreaks();
        this.snapBand = true;   // a checkpoint in another band: hard-cut, no fade
        P.ring(ev.x, ev.y - 8, 2, 34, 0.4, skin.glow, 2, 1.2);
        // the respawn pop: a tall stretch that settles, and glowing motes flung out of the arrival point
        this.playerVis.squash = -0.5;
        P.pop(ev.x, ev.y - 8, skin.glow);
        break;
      case 'goal':
        for (let i = 0; i < 5; i++) {
          P.ring(ev.x, ev.y - 18, 3 + i * 6, 70 + i * 18, 0.7 + i * 0.1, i % 2 ? C.goal : C.relicHi, 2.2, 1.2);
        }
        P.spark(ev.x, ev.y - 18, 40, C.goal, 260, null, TAU, 1.4);
        // goal-touch burst: confetti in the goal, relic, biome accent and skin colours
        P.confetti(ev.x, ev.y - 18, 36, [C.goal, C.relicHi, b.accent, skin.shell]);
        break;
      case 'foeHit':
        P.spark(ev.x, ev.y, 6, C.enemyHi, 130, null, TAU, 0.8);
        break;
      case 'foeKilled':
        P.tri(ev.x, ev.y, 8, C.enemy, 170, 0.7);
        P.spark(ev.x, ev.y, 14, C.enemyHi, 210, null, TAU, 1);
        P.ring(ev.x, ev.y, 2, 26, 0.32, C.enemyHi, 1.8, 1);
        P.text(ev.x, ev.y - 8, '+', C.enemyHi, 0.55, 0.8);
        break;
      case 'bubblePop':
        // the film lets go (P5-5): accent droplets falling out of a thin white ring; the bounce itself is the player's
        P.droplets(ev.x, ev.y, 10, b.accent);
        P.ring(ev.x, ev.y, 5, 22, 0.28, '#FFFFFF', 1.4, 0.8);
        break;
      case 'bubbleBack':
        // the film re-forms: a ring closing inward with a few motes flying into the centre
        P.shimmerIn(ev.x, ev.y, b.accent);
        break;
      case 'bolt':
        P.spark(ev.x, ev.y, 5, C.dangerHi, 120, null, 0.9, 1);
        break;
      case 'crumble': {
        const cx = ev.tx * TILE + TILE / 2, cy = ev.ty * TILE + TILE / 2;
        P.chunk(cx, cy, 7, b.rockHi, 110, 0);
        P.dust(cx, cy, 6, 0, b.rock, 50);
        break;
      }
      case 'splash':
        P.spark(ev.x, ev.y, 12, '#BFF0FF', ev.enter ? 140 : 100, -Math.PI / 2, 2, 0.8);
        P.dust(ev.x, ev.y, 6, 0, '#BFF0FF', 60);
        break;
      case 'tideOver':
        break;
    }
  }

  // ------------------------------------------------------------ port: title & portrait
  /** Title-screen backdrop: the biome's sky, a slow pan, a dark plateau and an idle Clawd. */
  drawTitle(t: number, dtFrame: number, biome: Biome): void {
    const st = this.stage;
    const dt = Math.min(Math.max(0, dtFrame), 0.1);
    if (this.skyOwner !== 'title' || this.titleBiome !== biome.id) {
      this.endFade();
      this.skyCur.setBiome(biome, TITLE_SEEDS[biome.id] ?? 3);
      this.skyOwner = 'title';
      this.titleBiome = biome.id;
      this.titleProfile = this.profile(7 + (TITLE_SEEDS[biome.id] ?? 3) * 13);
      this.particles.clear();
    }
    // Menu backdrops are throttled to 30 fps by the shell, so only their measured render cost reaches the
    // scaler (the previous backdrop frame's, before anything is drawn — a tier change resizes the canvas).
    const t0 = nowMs();
    st.noteFrame(dtFrame, this.lastTitleWorkMs);
    this.titleCamX += dt * 12;
    this.skyCur.update(dt, this.titleCamX, 0);
    this.particles.update(dt, null);
    this.titleBlinkT -= dt;
    if (this.titleBlinkT <= 0) { this.titleBlinkT = 2.4 + Math.random() * 4; this.titleBlink = 1; }
    this.titleBlink = Math.max(0, this.titleBlink - dt * 7);
    this.titleAnim += dt * 0.3;

    st.begin();
    this.skyCur.draw(this.titleCamX, 0);
    const ctx = st.ctx;
    st.screen();
    const W = st.viewW, H = st.viewH;

    // foreground plateau, near-black so the type stays readable over it
    const pts = this.titleProfile;
    const off = (this.titleCamX * 0.55) % W;
    ctx.beginPath();
    ctx.moveTo(-off - W, H);
    for (let rep = 0; rep < 3; rep++) {
      for (let i = 0; i < pts.length; i++) {
        const x = -off + (rep - 1) * W + (i / (pts.length - 1)) * W;
        const y = H * 0.72 + pts[i] * H * 0.2;
        ctx.lineTo(x, y);
      }
    }
    ctx.lineTo(W * 2, H);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, H * 0.6, 0, H);
    g.addColorStop(0, biome.rockDeep);
    g.addColorStop(1, '#05040A');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = alpha(biome.crustHi, 0.28);
    ctx.lineWidth = 0.8;
    ctx.stroke();

    // Clawd idles on the right third where the menu isn't; feet sample the plateau.
    const cx = W * 0.76;
    const u = (((cx + off) / W) % 1 + 1) % 1;
    const pi = u * (pts.length - 1);
    const p0 = pts[Math.floor(pi)], p1 = pts[Math.min(pts.length - 1, Math.floor(pi) + 1)];
    const cy = H * 0.72 + lerp(p0, p1, pi - Math.floor(pi)) * H * 0.2;
    ctx.save();
    ctx.translate(cx, cy);
    const s = H / 150;
    ctx.scale(s, s);
    // the glow buffer is still in device space; match the same transform there
    const gctx = st.gctx;
    gctx.save();
    gctx.setTransform(1, 0, 0, 1, 0, 0);
    gctx.scale(1 / st.glowDiv, 1 / st.glowDiv);
    gctx.translate(st.ox, st.oy);
    gctx.scale(st.scale, st.scale);
    gctx.translate(cx, cy);
    gctx.scale(s, s);
    drawClawd(ctx, gctx, {
      x: 0, y: 0, vx: 0, vy: 0, grounded: true, facing: -1, state: 'idle',
      t, anim: this.titleAnim, squash: 0, invuln: 0, blink: this.titleBlink,
      skin: this.skin(), dashReady: true, dashFlash: 0, alpha: 1,
    });
    gctx.restore();
    ctx.restore();

    st.composite({ vignette: 0.25, fade: 0 });
    this.lastTitleWorkMs = t0 >= 0 ? Math.max(0, nowMs() - t0) : undefined;
  }

  drawPortrait(ctx: CanvasRenderingContext2D, skin: string, size: number, t: number): void {
    drawClawdPortrait(ctx, size, skinById(skin), t);
  }

  private profile(seed: number): Float32Array {
    const rng = makeRng(seed >>> 0);
    const pts = new Float32Array(97);
    const o = rng() * 50;
    for (let i = 0; i < pts.length; i++) {
      const u = i / (pts.length - 1);
      pts[i] = fbm(u * 3.4 + o, o * 0.7, 4);
    }
    return pts;
  }
}
