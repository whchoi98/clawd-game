/**
 * `Renderer` — the client's RendererPort implementation.
 *
 * Reads `sim.state` and `sim.level` only, never writes them. Everything that is
 * presentation — squash, trails, particles, bloom, weather, the title vista —
 * lives here and is advanced by `dtFrame`, so a replay verified on the server
 * is never influenced by what the player saw.
 *
 * Frame order: sky (device space) → world transform → terrain → hazards →
 * entities → foes → bolts → echoes → player → particles → tide → screen-space
 * fog band → composite (bloom, vignette, grain, flash, fade, letterbox).
 */
import { TILE } from '../../sim/types.js';
import type { BiomeId, SimEvent, SimState } from '../../sim/types.js';
import type { Level } from '../../sim/level.js';
import { makeRng } from '../../sim/rng.js';
import { BIOMES, C, type Biome } from '../../shared/biomes.js';
import type { FxState, GhostView, RendererPort, Settings, WorldView } from '../contracts.js';
import {
  Stage, UI_FONT, TAU, alpha, clamp01, defaultCreateCanvas, fbm, lerp,
  type QualityTier, type StageOptions,
} from './stage.js';
import { Sky } from './sky.js';
import { Terrain } from './tiles.js';
import { Particles } from './particles.js';
import { SKINS, drawClawd, drawClawdPortrait, skinById, type Skin } from './clawd.js';
import { Actors, PlayerVisual, drawGhost } from './actors.js';

/**
 * The slice of `Sim` the renderer reads. Structural, so tests can drive the
 * renderer with a plain object and the real `Sim` satisfies it unchanged.
 */
export interface SimView {
  readonly state: SimState;
  readonly level: Level;
}

export type RendererOptions = StageOptions;

const TITLE_SEEDS: Record<BiomeId, number> = { tidepool: 3, stormspire: 12, voidreef: 21 };

export class Renderer implements RendererPort {
  /** Goal projection after the last draw; see RendererPort. Filled in by the readability pass. */
  goalScreen: { x: number; y: number; onScreen: boolean } | null = null;
  readonly stage: Stage;
  readonly sky: Sky;
  readonly particles: Particles;
  readonly actors: Actors;
  readonly skins: Record<string, { name: string; kr: string }>;

  private readonly createCanvas: () => HTMLCanvasElement;
  private terrain: Terrain | null = null;
  private level: Level | null = null;
  private biome: Biome | null = null;
  /** Who last configured the sky: the level or the title vista. */
  private skyOwner: 'level' | 'title' | null = null;
  private t = 0;
  private switchFlash = 0;
  private skinId = 'clawd';
  private readonly playerVis = new PlayerVisual();
  private readonly ghostVis: PlayerVisual[] = [];

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
    this.sky = new Sky(this.stage);
    this.particles = new Particles(this.stage);
    this.actors = new Actors(this.stage, BIOMES.tidepool);
    const skins: Record<string, { name: string; kr: string }> = {};
    for (const s of Object.values(SKINS)) skins[s.id] = { name: s.name, kr: s.kr };
    this.skins = skins;
  }

  // ------------------------------------------------------------ port: read-only
  get viewW(): number { return this.stage.viewW; }
  get viewH(): number { return this.stage.viewH; }
  get fps(): number { return this.stage.fps; }
  get qualityTier(): QualityTier { return this.stage.quality; }

  // ------------------------------------------------------------ port: lifecycle
  setLevel(sim: SimView, biome: Biome): void {
    this.level = sim.level;
    this.biome = biome;
    this.sky.setBiome(biome, sim.level.def.seed);
    this.skyOwner = 'level';
    this.terrain = new Terrain(this.stage, sim.level, biome, this.createCanvas);
    this.actors.setLevel(biome);
    this.playerVis.reset(sim.state.player);
    this.ghostVis.length = 0;
    this.particles.clear();
    this.switchFlash = 0;
    this.t = 0;
  }

  resize(): void { this.stage.resize(); }

  applySettings(s: Settings): void {
    this.stage.setSettings({ bloom: s.bloom, grain: s.grain, flashes: s.flashes, quality: s.quality });
    this.sky.flashesAllowed = s.flashes;
    this.skinId = SKINS[s.skin] ? s.skin : 'clawd';
  }

  clearParticles(): void { this.particles.clear(); }

  private skin(): Skin { return skinById(this.skinId); }

  // ------------------------------------------------------------ port: draw
  draw(sim: SimView, view: WorldView, fx: FxState, ghosts: GhostView[], dtFrame: number): void {
    if (!this.terrain || this.level !== sim.level || this.skyOwner !== 'level' || !this.biome) {
      this.setLevel(sim, this.biome && this.level === sim.level ? this.biome : BIOMES[sim.level.def.biome]);
    }
    const st = this.stage, level = sim.level, state = sim.state, biome = this.biome!;
    const dt = Math.min(Math.max(0, dtFrame), 0.1);
    this.t += dt;

    // ---- advance visual-only state ----
    st.sampleFps(dtFrame);
    this.sky.update(dt, view.camX, view.camY);
    this.particles.update(dt, (x, y) => level.solid(Math.floor(x / TILE), Math.floor(y / TILE)));
    this.playerVis.update(dt, state.player);
    while (this.ghostVis.length < ghosts.length) this.ghostVis.push(new PlayerVisual());
    for (let i = 0; i < ghosts.length; i++) this.ghostVis[i].update(dt, ghosts[i].player);
    this.actors.update(dt, state);
    this.switchFlash = Math.max(0, this.switchFlash - dt * 2.4);

    // ---- frame ----
    st.begin();
    this.sky.draw(view.camX, view.camY);
    st.world(view.camX, view.camY, fx.shakeX, fx.shakeY, view.zoom * (fx.zoom || 1), fx.shakeRot);

    this.terrain!.draw(this.t, this.switchFlash);
    this.terrain!.drawHazards(this.t);

    this.actors.drawEntities(state);
    this.actors.drawFoes(state, this.t);
    this.actors.drawBolts(state);

    for (let i = 0; i < ghosts.length; i++) drawGhost(st, ghosts[i], this.ghostVis[i]);

    this.playerVis.draw(st, level, state.player, this.skin());
    this.particles.draw(UI_FONT);

    if (state.tide) this.actors.drawTide(state.tide, this.t);

    // foreground haze band adds depth separation from the terrain
    st.screen();
    const ctx = st.ctx;
    const fg = ctx.createLinearGradient(0, st.viewH * 0.72, 0, st.viewH);
    fg.addColorStop(0, alpha(biome.fog, 0));
    fg.addColorStop(1, alpha(biome.fog, 0.14 + biome.ambient * 0.3));
    ctx.fillStyle = fg;
    ctx.fillRect(0, st.viewH * 0.72, st.viewW, st.viewH * 0.28);

    st.composite(fx);
  }

  // ------------------------------------------------------------ port: events
  onEvent(ev: SimEvent, sim: SimView): void {
    const P = this.particles;
    const b = this.biome ?? BIOMES[sim.level.def.biome];
    const skin = this.skin();
    const p = sim.state.player;
    switch (ev.type) {
      case 'phase':
        if (ev.phase === 'intro') { this.playerVis.reset(p); P.clear(); }
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
        P.dust(ev.x, ev.y, 4 + Math.round(impact * 12), 0, b.crustHi, 40 + impact * 110);
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
        P.spark(ev.x, ev.y, 10, C.shardHi, 150, null, TAU, 1.1);
        P.ring(ev.x, ev.y, 2, 16, 0.26, C.shardHi, 1.4, 1);
        if (ev.combo > 2) P.text(ev.x, ev.y - 10, `×${ev.combo}`, C.shardHi, 0.8);
        break;
      case 'relic':
        P.spark(ev.x, ev.y, 26, C.relicHi, 240, null, TAU, 1.3);
        P.ring(ev.x, ev.y, 3, 60, 0.6, C.relic, 3, 1.4);
        this.playerVis.refill();
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
        P.ring(ev.x, ev.y - 8, 2, 34, 0.4, skin.glow, 2, 1.2);
        break;
      case 'goal':
        for (let i = 0; i < 5; i++) {
          P.ring(ev.x, ev.y - 18, 3 + i * 6, 70 + i * 18, 0.7 + i * 0.1, i % 2 ? C.goal : C.relicHi, 2.2, 1.2);
        }
        P.spark(ev.x, ev.y - 18, 40, C.goal, 260, null, TAU, 1.4);
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
      this.sky.setBiome(biome, TITLE_SEEDS[biome.id] ?? 3);
      this.skyOwner = 'title';
      this.titleBiome = biome.id;
      this.titleProfile = this.profile(7 + (TITLE_SEEDS[biome.id] ?? 3) * 13);
      this.particles.clear();
    }
    st.sampleFps(dtFrame);
    this.titleCamX += dt * 12;
    this.sky.update(dt, this.titleCamX, 0);
    this.particles.update(dt, null);
    this.titleBlinkT -= dt;
    if (this.titleBlinkT <= 0) { this.titleBlinkT = 2.4 + Math.random() * 4; this.titleBlink = 1; }
    this.titleBlink = Math.max(0, this.titleBlink - dt * 7);
    this.titleAnim += dt * 0.3;

    st.begin();
    this.sky.draw(this.titleCamX, 0);
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
