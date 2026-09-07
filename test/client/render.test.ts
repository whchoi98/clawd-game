// @vitest-environment happy-dom
/**
 * Renderer tests against a recording canvas stub.
 *
 * The Sim class is owned by another task, so these tests never construct one:
 * a fake `{ state, level }` shaped like SimState drives the renderer instead.
 * Every 2D context is a Proxy that records method calls and keeps a real
 * save/restore stack for properties, so we can assert on draw structure
 * (Path2D fill counts, globalAlpha handling) without a rasteriser.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { Level } from '../../src/sim/level.js';
import { ENTITY_CH, FOE_CH } from '../../src/sim/legend.js';
import { PLAYER_H, PLAYER_W } from '../../src/sim/config.js';
import type { EntityState, FoeState, LevelDef, PlayerState, SimEvent, SimState } from '../../src/sim/types.js';
import { BIOMES, BIOME_ORDER, C } from '../../src/shared/biomes.js';
import type { FxState, GhostView, Settings, WorldView } from '../../src/client/contracts.js';
import {
  AFTER_IMAGE_SPACING, AUTOTIER_KEY, FRAME_WINDOW_S, FrameHistogram, GOAL_LOOK_TILES, MENU_BUCKET_MS, MENU_COST_RATIO, MENU_FRAME_MS,
  MENU_SLOW_RATIO, MIN_MENU_SAMPLES, MIN_WINDOW_SAMPLES, Renderer, SKINS, STEP_DOWN_LOCK_S, STEP_UP_AFTER_S, Stage, drawClawd, lookTarget,
  readStoredTier, setLookTarget, skinById, snapRefreshRate,
} from '../../src/client/render/index.js';
import { TILE } from '../../src/sim/types.js';
import { MENU_FRAME_DT } from '../../src/client/scenes.js';
import type { SimView, TierStorage } from '../../src/client/render/index.js';
import { DEATH_MARK_COLOR, hopperCrouch, walkerBlink } from '../../src/client/render/actors.js';
import type { BiomeId } from '../../src/sim/types.js';
import { AURORA_RIBBONS, FLOCK_SIZE } from '../../src/client/render/sky.js';
import { TERRAIN_MAX_PATH_FILLS, type Terrain } from '../../src/client/render/tiles.js';

/** Every biome the renderer must draw: the shipped order plus the Phase 5 summit (which joins BIOME_ORDER with P5-1). */
const ALL_BIOMES: BiomeId[] = [...new Set<BiomeId>([...BIOME_ORDER, 'summit'])];

// ------------------------------------------------------------------ stubs
class StubPath2D {
  rects = 0;
  rect(): void { this.rects++; }
  moveTo(): void {}
  lineTo(): void {}
  closePath(): void {}
  arc(): void {}
  ellipse(): void {}
  quadraticCurveTo(): void {}
  bezierCurveTo(): void {}
  roundRect(): void {}
  addPath(): void {}
}

interface Call { name: string; args: unknown[] }
interface RecordingCtx {
  __calls: Call[];
  __sets: Record<string, unknown[]>;
  [k: string]: unknown;
}

function makeCtx(canvas: StubCanvas): RecordingCtx {
  const calls: Call[] = [];
  const sets: Record<string, unknown[]> = {};
  let state: Record<string, unknown> = {
    canvas,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    filter: 'none',
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    miterLimit: 10,
    lineDashOffset: 0,
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    imageSmoothingEnabled: true,
    imageSmoothingQuality: 'low',
    shadowBlur: 0,
    shadowColor: 'rgba(0,0,0,0)',
    shadowOffsetX: 0,
    shadowOffsetY: 0,
  };
  const stack: Record<string, unknown>[] = [];
  const fns = new Map<string, (...args: unknown[]) => unknown>();
  const imageData = (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(Math.max(1, w * h * 4)) });
  return new Proxy({} as RecordingCtx, {
    get(_t, prop) {
      if (prop === '__calls') return calls;
      if (prop === '__sets') return sets;
      if (typeof prop !== 'string') return undefined;
      if (prop in state) return state[prop];
      let fn = fns.get(prop);
      if (!fn) {
        fn = (...args: unknown[]) => {
          calls.push({ name: prop, args });
          switch (prop) {
            case 'save': stack.push({ ...state }); return undefined;
            case 'restore': if (stack.length) state = stack.pop()!; return undefined;
            case 'createLinearGradient':
            case 'createRadialGradient':
            case 'createConicGradient':
              return { addColorStop() {} };
            case 'createPattern': return { setTransform() {} };
            case 'createImageData': return imageData(Number(args[0]) || 1, Number(args[1]) || 1);
            case 'getImageData': return imageData(Number(args[2]) || 1, Number(args[3]) || 1);
            case 'measureText': return { width: String(args[0]).length * 6, actualBoundingBoxAscent: 6, actualBoundingBoxDescent: 2 };
            case 'getTransform': return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
            case 'getLineDash': return [];
            case 'isPointInPath':
            case 'isPointInStroke':
              return false;
            default: return undefined;
          }
        };
        fns.set(prop, fn);
      }
      return fn;
    },
    set(_t, prop, value) {
      if (typeof prop === 'string') {
        state[prop] = value;
        (sets[prop] ||= []).push(value);
      }
      return true;
    },
    has() { return true; },
  });
}

class StubCanvas {
  width = 300;
  height = 150;
  style: Record<string, string> = {};
  readonly ctx: RecordingCtx;
  constructor() { this.ctx = makeCtx(this); }
  getContext(): RecordingCtx { return this.ctx; }
  toDataURL(): string { return ''; }
}

function makeRenderer(w = 960, h = 540, dpr = 1, storage: TierStorage | null = null) {
  const canvas = new StubCanvas();
  const r = new Renderer(canvas as unknown as HTMLCanvasElement, {
    createCanvas: () => new StubCanvas() as unknown as HTMLCanvasElement,
    viewport: () => ({ w, h, dpr }),
    // never happy-dom's shared localStorage: each test decides where the auto tier is remembered
    storage,
  });
  return { r, canvas, ctx: canvas.ctx };
}

// ------------------------------------------------------------------ fixtures
const FIXTURE_ROWS = [
  '..........................................',
  '..o...o...o....R....................t.....',
  '.....==.....%%%..&&&......................',
  '..P.........................f.......G.....',
  '####..X.X....^^..........~~~~...k...######',
  '####.......###...........WWWW..###.#######',
  '###.......#####..........WWWW.#####.######',
  '.....S..D..c......m....M....s....z...w.h..',
  '##########################################',
  '###########{...}##########################',
  '##########################################',
];

function fixtureDef(biome: LevelDef['biome'], rows = FIXTURE_ROWS, extra: Partial<LevelDef> = {}): LevelDef {
  return { id: 't1', name: '조수 웅덩이 1', en: 'Tide 1', biome, par: 45, seed: 7, rows, ...extra };
}

function basePlayer(level: Level, over: Partial<PlayerState> = {}): PlayerState {
  const s = level.start;
  return {
    x: s.x - PLAYER_W / 2, y: s.y - PLAYER_H, w: PLAYER_W, h: PLAYER_H,
    vx: 40, vy: -100, facing: 1, grounded: false, onWall: 0, jumps: 1,
    dashT: 0, dashDirX: 1, dashDirY: 0, dashReady: true, dashCd: 0, stomping: false,
    hp: 3, invuln: 0, dead: false, deadT: 0, inWater: false, pose: 'jump', t: 1.2,
    ...over,
  };
}

function fakeState(level: Level, opts: { tide?: boolean } = {}): SimState {
  const entities: EntityState[] = [];
  const foes: FoeState[] = [];
  let id = 1;
  for (const sp of level.spawns) {
    const ek = ENTITY_CH[sp.ch];
    if (ek) {
      const moving = ek === 'platH' || ek === 'platV' || ek === 'saw';
      entities.push({
        id: id++, kind: ek, x: sp.x, y: sp.y, w: ek === 'platH' || ek === 'platV' ? 48 : 16, h: ek === 'platH' || ek === 'platV' ? 6 : 16,
        alive: true, t: 0.5 + sp.tx * 0.1, state: ek === 'toggle' || ek === 'checkpoint' ? 1 : 0,
        ...(moving ? { vx: 10, vy: 0, span: 48, dir: 1 as const } : {}),
      });
    }
    const fk = FOE_CH[sp.ch];
    if (fk) {
      foes.push({ id: id++, kind: fk, x: sp.x, y: sp.y, w: 14, h: 12, vx: -20, vy: 0, face: -1, hp: 1, dying: 0, dead: false, flash: 0, t: 0.3, state: 0 });
    }
  }
  // a dying foe, a collected shard and a respawning crystal exercise the fade paths
  foes.push({ id: id++, kind: 'spiker', x: 300, y: 120, w: 15, h: 12, vx: 0, vy: 0, face: 1, hp: 0, dying: 0.2, dead: false, flash: 0.5, t: 2, state: 0 });
  entities.push({ id: id++, kind: 'shard', x: 200, y: 40, w: 9, h: 9, alive: false, t: 3, state: 0 });
  entities.push({ id: id++, kind: 'crystal', x: 260, y: 40, w: 16, h: 16, alive: true, t: 3, state: 1.2 });
  return {
    tick: 0, time: 0, phase: 'play', phaseT: 0,
    player: basePlayer(level),
    entities, foes,
    bolts: [{ id: 999, x: 120, y: 60, vx: 100, vy: 20, dead: false, t: 0.1 }],
    respawn: { x: level.start.x, y: level.start.y },
    switchA: true,
    stats: { shards: 0, relics: 0, deaths: 0, jumps: 0, dashes: 0, wallJumps: 0, foes: 0, combo: 0, bestCombo: 0 },
    tide: opts.tide ? { y: level.pxH - 24, speed: 11, height: 0, maxHeight: 0 } : undefined,
  };
}

function fakeSim(def: LevelDef, opts: { tide?: boolean } = {}): SimView {
  const level = new Level(def);
  return { level, state: fakeState(level, opts) };
}

const VIEW: WorldView = { camX: 256, camY: 96, zoom: 1 };
const FX: FxState = { shakeX: 0, shakeY: 0, shakeRot: 0, flash: 0, flashColor: '#ffffff', fade: 0, zoom: 1, aberr: 0, vignette: 0 };
const FX_BUSY: FxState = { shakeX: 3, shakeY: -2, shakeRot: 0.01, flash: 0.4, flashColor: C.danger, fade: 0.2, zoom: 1.03, aberr: 0.5, vignette: 0.4 };

const SETTINGS: Settings = {
  v: 1, master: 1, music: 1, sfx: 1, shake: 1, bloom: true, grain: true, quality: 'auto', flashes: true,
  showTimer: true, skin: 'clawd', assist: false, invincible: false, echoSelf: true, echoWorld: true,
  binds: { left: [], right: [], up: [], down: [], jump: [], dash: [], pause: [], confirm: [], cancel: [], restart: [] },
};

const ALL_EVENTS: SimEvent[] = [
  { type: 'phase', phase: 'intro' },
  { type: 'phase', phase: 'play' },
  { type: 'jump', x: 40, y: 60, air: false },
  { type: 'jump', x: 40, y: 60, air: true },
  { type: 'land', x: 40, y: 64, impact: 0.8 },
  { type: 'dash', x: 40, y: 60, dx: 1, dy: 0 },
  { type: 'dashEnd', x: 60, y: 60 },
  { type: 'wallJump', x: 40, y: 60, dir: 1 },
  { type: 'wallSlide', x: 40, y: 60, dir: -1 },
  { type: 'stomp', x: 40, y: 60 },
  { type: 'stompLand', x: 40, y: 64 },
  { type: 'shard', x: 40, y: 30, n: 3, total: 10, combo: 3 },
  { type: 'relic', x: 40, y: 30, n: 1, total: 1 },
  { type: 'crystal', x: 40, y: 30 },
  { type: 'toggle', x: 40, y: 30, switchA: false },
  { type: 'checkpoint', x: 40, y: 64 },
  { type: 'spring', x: 40, y: 64 },
  { type: 'hurt', x: 40, y: 60, hp: 2 },
  { type: 'death', x: 40, y: 60, cause: 'spike', deaths: 1 },
  { type: 'respawn', x: 40, y: 64 },
  { type: 'foeHit', x: 80, y: 60, kind: 'walker' },
  { type: 'foeKilled', x: 80, y: 60, kind: 'turret' },
  { type: 'bolt', x: 80, y: 60 },
  { type: 'crumble', tx: 6, ty: 4 },
  { type: 'splash', x: 400, y: 64, enter: true },
  { type: 'splash', x: 400, y: 64, enter: false },
];

beforeAll(() => {
  (globalThis as unknown as { Path2D: unknown }).Path2D = StubPath2D;
});

// ------------------------------------------------------------------ tests
describe('Renderer', () => {
  it('constructs and exposes the RendererPort surface', () => {
    const { r } = makeRenderer();
    expect(r.viewW).toBeGreaterThan(0);
    expect(r.viewH).toBeGreaterThan(0);
    expect(r.fps).toBeGreaterThanOrEqual(0);
    expect(['high', 'balanced', 'low']).toContain(r.qualityTier);
    expect(Object.keys(r.skins)).toEqual(expect.arrayContaining(['clawd', 'azure', 'ember', 'void']));
    for (const id of Object.keys(r.skins)) {
      expect(r.skins[id].name.length).toBeGreaterThan(0);
      expect(r.skins[id].kr.length).toBeGreaterThan(0);
      expect(SKINS[id]).toBeDefined();
    }
  });

  it.each(ALL_BIOMES)('setLevel + draw does not throw for biome %s', (biomeId) => {
    const { r, ctx } = makeRenderer();
    const sim = fakeSim(fixtureDef(biomeId), { tide: true });
    r.applySettings(SETTINGS);
    r.setLevel(sim, BIOMES[biomeId]);
    for (const ev of ALL_EVENTS) r.onEvent(ev, sim);
    for (let i = 0; i < 6; i++) {
      r.draw(sim, VIEW, i % 2 ? FX_BUSY : FX, [], 1 / 60);
      // mutate the fake state so transitions (landing, dash, death, water) are exercised
      const p = sim.state.player;
      if (i === 1) { p.grounded = true; p.vy = 0; p.pose = 'run'; p.vx = 120; }
      if (i === 2) { p.dashT = 0.1; p.pose = 'dash'; p.dashReady = false; p.vx = 300; }
      if (i === 3) { p.dashT = 0; p.dashReady = true; p.pose = 'wall'; p.onWall = 1; p.grounded = false; p.vy = 40; }
      if (i === 4) { p.pose = 'dead'; p.dead = true; p.deadT = 0.3; p.vx = -40; p.vy = -100; }
      sim.state.switchA = !sim.state.switchA;
      sim.state.tide!.y -= 4;
    }
    expect(ctx.__calls.length).toBeGreaterThan(50);
    // the sky always paints an opaque backdrop first
    expect(ctx.__calls.some((c) => c.name === 'fillRect')).toBe(true);
  });

  it('draws switch blocks in their polarity colour and dash crystals in green', () => {
    const { r, ctx } = makeRenderer();
    const sim = fakeSim(fixtureDef('stormspire'));
    r.setLevel(sim, BIOMES.stormspire);
    r.draw(sim, { camX: 240, camY: 80, zoom: 1 }, FX, [], 1 / 60);
    const styles = [...(ctx.__sets.fillStyle ?? []), ...(ctx.__sets.strokeStyle ?? [])].filter((v): v is string => typeof v === 'string');
    const rgbOf = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
    };
    const mentions = (hex: string) => styles.some((s) => s.toLowerCase().includes(hex.toLowerCase()) || s.includes(rgbOf(hex)));
    expect(mentions(C.switchA)).toBe(true);
    expect(mentions(C.switchB)).toBe(true);
    expect(mentions(C.crystal)).toBe(true);
  });

  it('bounds terrain Path2D fills per frame regardless of tile count', () => {
    const { r, ctx } = makeRenderer(1920, 1080, 2);
    const rows = Array.from({ length: 40 }, () => '#'.repeat(200));
    const sim = fakeSim(fixtureDef('voidreef', rows));
    r.setLevel(sim, BIOMES.voidreef);
    // warm up, then measure a frame whose window includes the surface row and deep rock
    r.draw(sim, { camX: 1600, camY: 120, zoom: 1 }, FX, [], 1 / 60);
    ctx.__calls.length = 0;
    r.draw(sim, { camX: 1600, camY: 120, zoom: 1 }, FX, [], 1 / 60);
    const pathFills = ctx.__calls.filter((c) => c.name === 'fill' && c.args[0] instanceof StubPath2D);
    expect(pathFills.length).toBeGreaterThan(0);
    expect(pathFills.length).toBeLessThanOrEqual(6);
    // and the merged path is not a per-tile list: far fewer rects than tiles on screen
    const rectsPerPath = pathFills.map((c) => (c.args[0] as StubPath2D).rects);
    const visibleTiles = Math.ceil((r.viewW / 16) + 2) * Math.ceil((r.viewH / 16) + 2);
    expect(Math.max(...rectsPerPath)).toBeLessThan(visibleTiles);
    // deep camera: every visible tile is far below the surface, still bounded
    ctx.__calls.length = 0;
    r.draw(sim, { camX: 1600, camY: 400, zoom: 1 }, FX, [], 1 / 60);
    const deepFills = ctx.__calls.filter((c) => c.name === 'fill' && c.args[0] instanceof StubPath2D);
    expect(deepFills.length).toBeLessThanOrEqual(6);
  });

  it('draws ghosts with globalAlpha = ghost.alpha and restores it', () => {
    const { r, ctx } = makeRenderer();
    const sim = fakeSim(fixtureDef('tidepool'));
    r.setLevel(sim, BIOMES.tidepool);
    const ghosts: GhostView[] = [
      { player: basePlayer(sim.level, { x: 120, y: 40, pose: 'run', grounded: true, vy: 0, vx: 100 }), color: C.echoWorld, alpha: 0.4, label: '세계' },
      { player: basePlayer(sim.level, { x: 90, y: 40, pose: 'dash', dashT: 0.1, vx: 300 }), color: C.echoSelf, alpha: 0.35, label: '나' },
    ];
    ctx.__sets.globalAlpha = [];
    r.draw(sim, VIEW, FX, ghosts, 1 / 60);
    const alphas = ctx.__sets.globalAlpha as number[];
    expect(alphas.some((a) => Math.abs(a - 0.4) < 1e-9)).toBe(true);
    expect(alphas.some((a) => Math.abs(a - 0.35) < 1e-9)).toBe(true);
    expect(ctx.globalAlpha).toBe(1);
    // save/restore are balanced over the whole frame
    const saves = ctx.__calls.filter((c) => c.name === 'save').length;
    const restores = ctx.__calls.filter((c) => c.name === 'restore').length;
    expect(saves).toBe(restores);
    // the label is drawn on canvas above the echo
    const texts = ctx.__calls.filter((c) => c.name === 'fillText').map((c) => String(c.args[0]));
    expect(texts).toContain('세계');
    expect(texts).toContain('나');
    // the echo is tinted with its colour, not the live skin
    const styles = [...(ctx.__sets.fillStyle ?? []), ...(ctx.__sets.strokeStyle ?? [])].filter((v): v is string => typeof v === 'string');
    expect(styles.some((s) => s.toLowerCase() === C.echoWorld.toLowerCase())).toBe(true);
  });

  it('draws the title backdrop and portraits for every biome and skin', () => {
    const { r, ctx } = makeRenderer();
    for (const id of ALL_BIOMES) {
      for (let i = 0; i < 3; i++) r.drawTitle(i * 0.5, 1 / 60, BIOMES[id]);
      // the title vista carries the new layers too (structures, flock; aurora on the summit)
      expect(r.sky.counters.structures + r.sky.counters.flock + r.sky.counters.aurora).toBeGreaterThan(0);
    }
    expect(ctx.__calls.some((c) => c.name === 'fillRect')).toBe(true);
    const portrait = new StubCanvas();
    for (const skin of Object.keys(r.skins)) {
      r.drawPortrait(portrait.ctx as unknown as CanvasRenderingContext2D, skin, 64, 1.5);
    }
    r.drawPortrait(portrait.ctx as unknown as CanvasRenderingContext2D, 'not-a-skin', 64, 0);
    expect(portrait.ctx.__calls.filter((c) => c.name === 'fill').length).toBeGreaterThan(4);
    expect(portrait.ctx.globalAlpha).toBe(1);
  });

  it('honours settings (quality tier, bloom off) and survives resize / clearParticles', () => {
    const { r, ctx } = makeRenderer(640, 360, 1);
    const sim = fakeSim(fixtureDef('stormspire'));
    r.setLevel(sim, BIOMES.stormspire);
    r.applySettings({ ...SETTINGS, quality: 'low', bloom: false, grain: false, flashes: false, skin: 'void' });
    expect(r.qualityTier).toBe('low');
    r.draw(sim, VIEW, FX_BUSY, [], 1 / 30);
    // no bloom: the blurred glow buffer is never composited with 'lighter'
    const lighterAfterWorld = (ctx.__sets.globalCompositeOperation ?? []).filter((v) => v === 'lighter');
    expect(Array.isArray(lighterAfterWorld)).toBe(true);
    r.resize();
    r.clearParticles();
    for (const ev of ALL_EVENTS) r.onEvent(ev, sim);
    r.clearParticles();
    r.draw(sim, VIEW, FX, [], 1 / 60);
    r.applySettings({ ...SETTINGS, quality: 'high' });
    expect(r.qualityTier).toBe('high');
    r.applySettings({ ...SETTINGS, quality: 'auto' });
    for (let i = 0; i < 400; i++) r.draw(sim, VIEW, FX, [], 1 / 20); // sustained 20 fps → adaptive step-down
    expect(r.qualityTier).not.toBe('high');
    expect(r.fps).toBeGreaterThan(0);
  });

  it('falls back to the level biome when draw is called before setLevel', () => {
    const { r, ctx } = makeRenderer();
    const sim = fakeSim(fixtureDef('voidreef'));
    r.draw(sim, VIEW, FX, [], 1 / 60);
    expect(ctx.__calls.length).toBeGreaterThan(20);
  });

  // ---------------------------------------------------------------- readability pass (P1-6)
  /**
   * Replace the fixture's own (one-tile, half-visible) 'z' column with a single
   * live 12-tile updraft inside VIEW (x 0..512, y -48..240 on the 960x540 stub).
   */
  function withUpdraft(sim: SimView): EntityState {
    sim.state.entities = sim.state.entities.filter((e) => e.kind !== 'updraft');
    const e: EntityState = { id: 9001, kind: 'updraft', x: 200, y: 100, w: 16, h: 192, alive: true, t: 0, state: 0 };
    sim.state.entities.push(e);
    return e;
  }

  it.each([['high', 60], ['low', 30]] as const)('a live updraft adds >= %s streak particles over 60 frames on quality %s', (quality, min) => {
    const { r } = makeRenderer();
    const sim = fakeSim(fixtureDef('voidreef'));
    withUpdraft(sim);
    r.applySettings({ ...SETTINGS, quality });
    r.setLevel(sim, BIOMES.voidreef);
    expect(r.qualityTier).toBe(quality);
    const before = r.particles.count;
    for (let i = 0; i < 60; i++) r.draw(sim, VIEW, FX, [], 1 / 60);
    expect(r.particles.count - before).toBeGreaterThanOrEqual(min);
  });

  it('does not emit updraft streaks for a column that is off screen', () => {
    const { r } = makeRenderer();
    const sim = fakeSim(fixtureDef('voidreef'));
    const e = withUpdraft(sim);
    e.x = 2000;
    r.setLevel(sim, BIOMES.voidreef);
    for (let i = 0; i < 60; i++) r.draw(sim, VIEW, FX, [], 1 / 60);
    expect(r.particles.count).toBe(0);
  });

  it('draws the updraft column with edge highlights and a floor glow', () => {
    const { r, ctx } = makeRenderer();
    const sim = fakeSim(fixtureDef('voidreef'));
    withUpdraft(sim);
    r.setLevel(sim, BIOMES.voidreef);
    ctx.__calls.length = 0;
    r.draw(sim, VIEW, FX, [], 1 / 60);
    // two 1 px boundary lines spanning the column height (x, y, 1px, h)
    const edges = ctx.__calls.filter((c) => c.name === 'fillRect' && Math.abs(Number(c.args[3]) - 192) < 1e-6 && Number(c.args[2]) < 1);
    expect(edges.length).toBeGreaterThanOrEqual(2);
    // the floor glow is a radial gradient ellipse sitting on the column base
    expect(ctx.__calls.some((c) => c.name === 'ellipse' && Math.abs(Number(c.args[1]) - 196) < 1e-6)).toBe(true);
  });

  it('exposes goalScreen: null before setLevel, on screen over the goal, off screen with a far camera', () => {
    const { r, ctx } = makeRenderer();
    expect(r.goalScreen).toBeNull();
    const sim = fakeSim(fixtureDef('tidepool'));
    r.setLevel(sim, BIOMES.tidepool);
    expect(r.goalScreen).toBeNull();
    const goal = sim.state.entities.find((e) => e.kind === 'goal')!;
    expect(goal).toBeDefined();

    r.draw(sim, { camX: goal.x, camY: goal.y, zoom: 1 }, FX, [], 1 / 60);
    expect(r.goalScreen).not.toBeNull();
    expect(r.goalScreen!.onScreen).toBe(true);
    // camera on the goal → the projection lands at the canvas centre (960x540 CSS px, dpr 1)
    expect(Math.abs(r.goalScreen!.x - 480)).toBeLessThan(2);
    expect(Math.abs(r.goalScreen!.y - 270)).toBeLessThan(40);

    ctx.__sets.fillStyle = [];
    ctx.__sets.strokeStyle = [];
    r.draw(sim, { camX: 0, camY: 0, zoom: 1 }, FX, [], 1 / 60);
    expect(r.goalScreen!.onScreen).toBe(false);
    expect(r.goalScreen!.x).toBeGreaterThan(960);
    // and an edge beacon in the biome accent was drawn
    const styles = [...(ctx.__sets.fillStyle ?? []), ...(ctx.__sets.strokeStyle ?? [])].filter((v): v is string => typeof v === 'string');
    expect(styles.some((s) => s.toLowerCase() === BIOMES.tidepool.accent.toLowerCase())).toBe(true);
    // save/restore stay balanced with the beacon on
    const saves = ctx.__calls.filter((c) => c.name === 'save').length;
    const restores = ctx.__calls.filter((c) => c.name === 'restore').length;
    expect(saves).toBe(restores);
  });

  it('clips spikes to their tile and rims voidreef spikes in the magenta accent', () => {
    const { r, ctx } = makeRenderer();
    const sim = fakeSim(fixtureDef('voidreef'));
    r.setLevel(sim, BIOMES.voidreef);
    // fixture '^^' at row 4, columns 13-14 → world x 208..240, y 64..80
    r.draw(sim, { camX: 224, camY: 72, zoom: 1 }, FX, [], 1 / 60);
    expect(ctx.__calls.filter((c) => c.name === 'clip').length).toBeGreaterThanOrEqual(2);
    const styles = [...(ctx.__sets.fillStyle ?? []), ...(ctx.__sets.strokeStyle ?? [])].filter((v): v is string => typeof v === 'string');
    const rgbOf = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
    };
    const mentions = (hex: string) => styles.some((s) => s.toLowerCase().includes(hex.toLowerCase()) || s.includes(rgbOf(hex)));
    expect(mentions(BIOMES.voidreef.accent)).toBe(true);
    expect(mentions(BIOMES.voidreef.spike.hi)).toBe(true);
  });

  // ---------------------------------------------------------------- P2-4 death marks
  it('draws one X per death mark the shell set, keeps them across a respawn, and culls off-screen marks', () => {
    const { r, ctx } = makeRenderer();
    const sim = fakeSim(fixtureDef('tidepool'));
    r.setLevel(sim, BIOMES.tidepool);
    // every mark sets the stroke colour exactly once, and nothing else in a frame uses it
    const marksDrawn = () => (ctx.__sets.strokeStyle ?? []).filter((s) => s === DEATH_MARK_COLOR).length;
    ctx.__sets.strokeStyle = [];
    r.draw(sim, VIEW, FX, [], 1 / 60);
    expect(marksDrawn()).toBe(0);
    // three deaths inside VIEW (x 0..512, y -48..240)
    r.setDeathMarks([{ x: 100, y: 60 }, { x: 200, y: 60 }, { x: 300, y: 60 }]);
    ctx.__sets.strokeStyle = [];
    r.draw(sim, VIEW, FX, [], 1 / 60);
    expect(marksDrawn()).toBe(3);
    // the respawn wipes particles and streaks, never the marks
    r.onEvent({ type: 'respawn', x: 40, y: 64 }, sim);
    ctx.__sets.strokeStyle = [];
    r.draw(sim, VIEW, FX, [], 1 / 60);
    expect(marksDrawn()).toBe(3);
    // nor does a phase intro (a full zone restart keeps the zone session's marks until the shell says otherwise)
    r.onEvent({ type: 'phase', phase: 'intro' }, sim);
    ctx.__sets.strokeStyle = [];
    r.draw(sim, VIEW, FX, [], 1 / 60);
    expect(marksDrawn()).toBe(3);
    // an off-screen mark is culled; alpha and the save / restore stack are left balanced
    r.setDeathMarks([{ x: 100, y: 60 }, { x: 5000, y: 60 }]);
    ctx.__sets.strokeStyle = [];
    ctx.__calls.length = 0;
    r.draw(sim, VIEW, FX, [], 1 / 60);
    expect(marksDrawn()).toBe(1);
    expect(ctx.globalAlpha).toBe(1);
    const saves = ctx.__calls.filter((c) => c.name === 'save').length;
    const restores = ctx.__calls.filter((c) => c.name === 'restore').length;
    expect(saves).toBe(restores);
    r.setDeathMarks([]);
    ctx.__sets.strokeStyle = [];
    r.draw(sim, VIEW, FX, [], 1 / 60);
    expect(marksDrawn()).toBe(0);
  });
});

// ------------------------------------------------------------------ background pass (P5-3)
describe('background pass (P5-3)', () => {
  /** The renderer's terrain (TypeScript-private; a plain property at runtime). */
  const terrainOf = (r: Renderer): Terrain => (r as unknown as { terrain: Terrain }).terrain;
  /** A 44×72 tower box (rows > cols): the vertical fixture with the FIXTURE rows stacked on a tall shaft. */
  const TOWER_ROWS = (() => {
    const w = 44, rows: string[] = [];
    for (let y = 0; y < 72; y++) {
      if (y === 3) rows.push('##' + '.'.repeat(w - 4).replace(/^(.{5})./, '$1P') + '##');
      else if (y === 68) rows.push('##' + '.'.repeat(20) + 'G' + '.'.repeat(w - 25) + '##');
      else if (y >= 69) rows.push('#'.repeat(w));
      else if (y % 6 === 0) rows.push('##' + '###'.padEnd(12, '.') + '.'.repeat(w - 4 - 12 - 8) + '.....###' + '##');
      else rows.push('##' + '.'.repeat(w - 4) + '##');
    }
    return rows;
  })();

  it('quality gating: the low tier draws no flock, aurora or structures while high draws them all (summit)', () => {
    const low = makeRenderer();
    const simLow = fakeSim(fixtureDef('summit'));
    low.r.applySettings({ ...SETTINGS, quality: 'low' });
    low.r.setLevel(simLow, BIOMES.summit);
    for (let i = 0; i < 90; i++) low.r.draw(simLow, { camX: 256 + i * 4, camY: 96, zoom: 1 }, FX, [], 1 / 60);
    expect(low.r.qualityTier).toBe('low');
    expect(low.r.sky.counters.flock).toBe(0);
    expect(low.r.sky.counters.aurora).toBe(0);
    expect(low.r.sky.counters.structures).toBe(0);

    const high = makeRenderer();
    const simHigh = fakeSim(fixtureDef('summit'));
    high.r.applySettings({ ...SETTINGS, quality: 'high' });
    high.r.setLevel(simHigh, BIOMES.summit);
    for (let i = 0; i < 90; i++) high.r.draw(simHigh, { camX: 256 + i * 4, camY: 96, zoom: 1 }, FX, [], 1 / 60);
    expect(high.r.sky.counters.aurora).toBe(90 * AURORA_RIBBONS);
    expect(high.r.sky.counters.structures).toBeGreaterThan(0);
    // the flock crosses the screen slowly: give it time, then it must have been drawn
    for (let i = 0; i < 40; i++) { high.r.sky.update(1, 400, 96); high.r.draw(simHigh, { camX: 400, camY: 96, zoom: 1 }, FX, [], 1 / 60); }
    expect(high.r.sky.counters.flock).toBeGreaterThan(0);

    const mid = makeRenderer();
    const simMid = fakeSim(fixtureDef('tidepool'));
    mid.r.applySettings({ ...SETTINGS, quality: 'balanced' });
    mid.r.setLevel(simMid, BIOMES.tidepool);
    let last = 0, maxPerFrame = 0;
    for (let i = 0; i < 60; i++) {
      mid.r.sky.update(1, 300, 96);
      mid.r.draw(simMid, { camX: 300, camY: 96, zoom: 1 }, FX, [], 1 / 60);
      maxPerFrame = Math.max(maxPerFrame, mid.r.sky.counters.flock - last);
      last = mid.r.sky.counters.flock;
    }
    expect(maxPerFrame).toBeGreaterThan(0);
    expect(maxPerFrame).toBeLessThanOrEqual(Math.floor(FLOCK_SIZE / 2));
  });

  it('snow weather on the summit: 90 motes at high, 31 at low (budget 0.35), and they keep falling', () => {
    const { r } = makeRenderer();
    const sim = fakeSim(fixtureDef('summit'));
    r.applySettings({ ...SETTINGS, quality: 'high' });
    r.setLevel(sim, BIOMES.summit);
    r.draw(sim, VIEW, FX, [], 1 / 60);
    expect(r.sky.weatherCount).toBe(90);
    for (let i = 0; i < 120; i++) r.draw(sim, VIEW, FX, [], 1 / 30);
    expect(r.sky.weatherCount).toBe(90);
    r.applySettings({ ...SETTINGS, quality: 'low' });
    r.draw(sim, VIEW, FX, [], 1 / 60);
    expect(r.sky.weatherCount).toBe(Math.round(90 * 0.35));
  });

  it('cloud deck: a vertical level gets one whose factor rises monotonically as the camera climbs; horizontal levels none', () => {
    const { r } = makeRenderer();
    const tower = fakeSim(fixtureDef('voidreef', TOWER_ROWS));
    expect(tower.level.pxH).toBeGreaterThan(tower.level.pxW);
    r.setLevel(tower, BIOMES.voidreef);
    expect(r.sky.hasCloudDeck).toBe(true);
    let prev = -1;
    for (let camY = tower.level.pxH; camY >= 0; camY -= 48) {
      r.draw(tower, { camX: tower.level.pxW / 2, camY, zoom: 1 }, FX, [], 1 / 60);
      const k = r.sky.deckLast;
      expect(k).toBeGreaterThanOrEqual(prev);
      expect(k).toBeGreaterThanOrEqual(0);
      expect(k).toBeLessThanOrEqual(1);
      prev = k;
    }
    expect(r.sky.deckLast).toBe(1);
    expect(r.sky.counters.deck).toBeGreaterThan(0);
    const flat = fakeSim(fixtureDef('voidreef'));
    r.setLevel(flat, BIOMES.voidreef);
    expect(r.sky.hasCloudDeck).toBe(false);
    r.draw(flat, { camX: 200, camY: -500, zoom: 1 }, FX, [], 1 / 60);
    expect(r.sky.deckLast).toBe(0);
    expect(r.sky.counters.deck).toBe(0);
  });

  it('time of day: the sky drifts with progress on a horizontal level only', () => {
    const { r } = makeRenderer();
    const sim = fakeSim(fixtureDef('tidepool'));
    r.setLevel(sim, BIOMES.tidepool);
    r.draw(sim, { camX: 0, camY: 96, zoom: 1 }, FX, [], 1 / 60);
    expect(r.sky.dayShift).toBe(0);
    r.draw(sim, { camX: sim.level.pxW, camY: 96, zoom: 1 }, FX, [], 1 / 60);
    expect(r.sky.dayShift).toBeCloseTo(0.15, 9);
    const tower = fakeSim(fixtureDef('tidepool', TOWER_ROWS));
    r.setLevel(tower, BIOMES.tidepool);
    r.draw(tower, { camX: tower.level.pxW, camY: 300, zoom: 1 }, FX, [], 1 / 60);
    expect(r.sky.dayShift).toBe(0);
  });

  it.each(ALL_BIOMES)('%s: face decor is batched — terrain Path2D fills stay within TERRAIN_MAX_PATH_FILLS and the decor count is deterministic', (biomeId) => {
    const { r, ctx } = makeRenderer(1280, 800, 1);
    const sim = fakeSim(fixtureDef(biomeId));
    r.setLevel(sim, BIOMES[biomeId]);
    r.draw(sim, { camX: 300, camY: 96, zoom: 1 }, FX, [], 1 / 60);
    ctx.__calls.length = 0;
    r.draw(sim, { camX: 300, camY: 96, zoom: 1 }, FX, [], 1 / 60);
    const pathFills = ctx.__calls.filter((c) => c.name === 'fill' && c.args[0] instanceof StubPath2D);
    // terrain + decor batches only: the other Path2D fills of a frame come from nowhere else
    expect(pathFills.length).toBeLessThanOrEqual(TERRAIN_MAX_PATH_FILLS);
    const t = terrainOf(r);
    expect(t.decorCount).toBeGreaterThan(0);
    const first = t.decorCount;
    r.draw(sim, { camX: 300, camY: 96, zoom: 1 }, FX, [], 1 / 60);
    expect(t.decorCount).toBe(first);
    // a different window → possibly different count, but still bounded fills
    ctx.__calls.length = 0;
    r.draw(sim, { camX: 500, camY: 60, zoom: 1 }, FX, [], 1 / 60);
    expect(ctx.__calls.filter((c) => c.name === 'fill' && c.args[0] instanceof StubPath2D).length).toBeLessThanOrEqual(TERRAIN_MAX_PATH_FILLS);
  });

  it('summit spikes carry the mint accent rim and the snow caps paint near-white', () => {
    const { r, ctx } = makeRenderer();
    const sim = fakeSim(fixtureDef('summit'));
    r.setLevel(sim, BIOMES.summit);
    // fixture '^^' at row 4, columns 13-14 → world x 208..240, y 64..80
    r.draw(sim, { camX: 224, camY: 72, zoom: 1 }, FX, [], 1 / 60);
    const styles = [...(ctx.__sets.fillStyle ?? []), ...(ctx.__sets.strokeStyle ?? [])].filter((v): v is string => typeof v === 'string');
    const rgbOf = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
    };
    const mentions = (hex: string) => styles.some((s) => s.toLowerCase().includes(hex.toLowerCase()) || s.includes(rgbOf(hex)));
    expect(mentions(BIOMES.summit.accent)).toBe(true);
    expect(mentions(BIOMES.summit.spike.hi)).toBe(true);
    // the snow cap fill: white mixed 12 % toward crustHi at alpha 0.92
    const capRgb = styles.find((s) => /^rgba\(2(4\d|5\d),2(4\d|5\d),255,0\.92\)$/.test(s.replace(/\s/g, '')));
    expect(capRgb).toBeDefined();
  });
});

// ------------------------------------------------------------------ adaptive quality v2 (P3-13)
class MemTier implements TierStorage {
  readonly map = new Map<string, string>();
  writes = 0;
  getItem(k: string): string | null { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string): void { this.map.set(k, v); this.writes++; }
}

function makeStage(storage: TierStorage | null = null): Stage {
  return new Stage(new StubCanvas() as unknown as HTMLCanvasElement, {
    createCanvas: () => new StubCanvas() as unknown as HTMLCanvasElement,
    viewport: () => ({ w: 960, h: 540, dpr: 1 }),
    storage,
  });
}

/** Feed `seconds` of frames whose interval is `dtOf(frameIndex)` seconds; `work` is the render cost handed along, if any. */
function feed(st: Stage, seconds: number, dtOf: (i: number) => number, work?: (i: number) => number): void {
  let t = 0;
  for (let i = 0; t < seconds; i++) {
    const dt = dtOf(i);
    st.sampleFps(dt, work ? work(i) : undefined);
    t += dt;
  }
}

/** Auto tier changes across a run of frames, with the tiers visited. */
function changesDuring(st: Stage, run: () => void): { changes: number; tiers: string[] } {
  const before = st.autoChanges;
  const tiers = [st.quality as string];
  const origSet = st.setQuality.bind(st);
  st.setQuality = (q) => { origSet(q); if (tiers.at(-1) !== q) tiers.push(q); };
  run();
  return { changes: st.autoChanges - before, tiers };
}

describe('Stage · adaptive quality v2 (P3-13)', () => {
  it('FrameHistogram: 1 ms buckets, conservative percentiles, exact bucket means, an open last bucket', () => {
    const h = new FrameHistogram();
    expect(h.percentile(95)).toBe(0);
    for (let i = 0; i < 95; i++) h.add(16.67);
    for (let i = 0; i < 5; i++) h.add(28.5);
    expect(h.n).toBe(100);
    expect(h.percentile(50)).toBe(17);
    expect(h.percentile(95)).toBe(17);
    h.add(28.5); // 6 of 101 slow frames → the 95th percentile crosses into the slow bucket
    expect(h.percentile(95)).toBe(29);
    expect(h.meanAt(50)).toBeCloseTo(16.67, 5);
    expect(h.meanAt(99)).toBeCloseTo(28.5, 5);
    h.add(250); h.add(33.4); h.add(-1); h.add(NaN);
    expect(h.counts[31]).toBe(2); // 31 ms and slower share the open last bucket
    expect(h.percentile(100)).toBe(32);
    expect(h.n).toBe(103);
    h.reset();
    expect(h.n).toBe(0);
    expect(h.percentile(50)).toBe(0);
    // a wider grid for throttled menu frames: 4 ms buckets up to 124 ms, then open
    const wide = new FrameHistogram(MENU_BUCKET_MS);
    wide.add(33.3);
    expect(wide.percentile(50)).toBe(36);
    wide.reset();
    wide.add(250);
    expect(wide.percentile(50)).toBe(128);
    wide.reset();
    wide.add(50);
    expect(wide.percentile(50)).toBe(52);
  });

  it('snapRefreshRate reads the median rAF interval as a known refresh rate, or nothing when the loop is not vsync-locked', () => {
    expect(snapRefreshRate(1000 / 60)).toBe(60);
    expect(snapRefreshRate(1000 / 120)).toBe(120);
    expect(snapRefreshRate(1000 / 144)).toBe(144);
    expect(snapRefreshRate(1000 / 165)).toBe(165);
    expect(snapRefreshRate(1000 / 90)).toBe(90);
    expect(snapRefreshRate(18.2)).toBe(60);   // 55 fps on a 60 Hz display, slightly late
    expect(snapRefreshRate(24.4)).toBeNull(); // 41 fps: dropped frames, not a 41 Hz display
    expect(snapRefreshRate(33.3)).toBeNull();
    expect(snapRefreshRate(0)).toBeNull();
  });

  it('alternating 58 / 41 fps for 60 s changes the tier at most twice (down, down) and never flaps back up', () => {
    // per frame
    const a = makeStage();
    const perFrame = changesDuring(a, () => feed(a, 60, (i) => (i % 2 ? 1 / 41 : 1 / 58)));
    expect(perFrame.changes).toBeLessThanOrEqual(2);
    expect(perFrame.tiers.slice(1).every((t, i, arr) => i === 0 || t !== arr[i - 1])).toBe(true);
    expect(a.quality).toBe('low');
    expect(a.hz).toBe(60);
    // per 2 s window: 2 s at 58 fps, 2 s at 41 fps, …
    const b = makeStage();
    const perWindow = changesDuring(b, () => feed(b, 60, (i) => {
      const at = i * (1 / 50);
      return Math.floor(at / 2) % 2 ? 1 / 41 : 1 / 58;
    }));
    expect(perWindow.changes).toBeLessThanOrEqual(2);
    expect(perWindow.tiers).not.toContain('high-again');
    expect(['balanced', 'low']).toContain(b.quality);
    expect(b.hz).toBe(60);
  });

  it('a steady 55 fps never changes the tier (not slow enough to drop, not smooth enough to rise)', () => {
    const st = makeStage();
    const r = changesDuring(st, () => feed(st, 60, () => 1 / 55, () => 4));
    expect(r.changes).toBe(0);
    expect(st.quality).toBe('high');
    expect(st.hz).toBe(60);
    const s = st.fpsStats();
    expect(s.p50).toBe(19);
    expect(s.p95).toBe(19);
    expect(s.tier).toBe('high');
  });

  it('sustained 20 fps steps down twice, window by window; the smoothed fps follows', () => {
    const st = makeStage();
    feed(st, FRAME_WINDOW_S + 0.1, () => 1 / 20);
    expect(st.quality).toBe('balanced');
    feed(st, FRAME_WINDOW_S + 0.1, () => 1 / 20);
    expect(st.quality).toBe('low');
    feed(st, FRAME_WINDOW_S + 0.1, () => 1 / 20);
    expect(st.quality).toBe('low');
    expect(st.autoChanges).toBe(2);
    expect(st.fps).toBeLessThan(25);
  });

  it('thresholds are in display periods: a steady 60 fps on a 120 Hz display is dropped frames and steps down', () => {
    const st = makeStage();
    feed(st, 4.1, () => 1 / 120, () => 2);
    expect(st.hz).toBe(120);
    expect(st.quality).toBe('high');
    expect(st.fpsStats().p95).toBe(9);
    feed(st, FRAME_WINDOW_S + 0.1, () => 1 / 60, () => 2);
    expect(st.quality).toBe('balanced');
    // the estimate never drops within a session, even when the loop slows to 60
    expect(st.hz).toBe(120);
  });

  it('steps up once per session, only after 60 s of smooth cheap frames and never inside the 60 s lock after a step down', () => {
    const st = makeStage();
    feed(st, FRAME_WINDOW_S + 0.1, () => 1 / 20);
    expect(st.quality).toBe('balanced');
    // smooth 60 fps with a cheap render: locked for STEP_DOWN_LOCK_S, then STEP_UP_AFTER_S of smooth windows
    feed(st, STEP_DOWN_LOCK_S - 2, () => 1 / 60, () => 3);
    expect(st.quality).toBe('balanced');
    feed(st, STEP_UP_AFTER_S - 2, () => 1 / 60, () => 3);
    expect(st.quality).toBe('balanced');
    feed(st, 8, () => 1 / 60, () => 3);
    expect(st.quality).toBe('high');
    expect(st.autoChanges).toBe(2);
    // once per session: after another step down (the slow burst may straddle two windows and cost a
    // second step), 130 s of the same smooth frames never raise the tier again
    feed(st, FRAME_WINDOW_S + 0.1, () => 1 / 20);
    expect(st.quality).not.toBe('high');
    feed(st, 2 * FRAME_WINDOW_S + 0.1, () => 1 / 60, () => 3);
    const settled = st.quality, changes = st.autoChanges;
    feed(st, 130, () => 1 / 60, () => 3);
    expect(st.quality).toBe(settled);
    expect(st.autoChanges).toBe(changes);
  });

  it('a measured render cost near the budget blocks the step up; without a measurement smooth intervals suffice', () => {
    const costly = makeStage();
    feed(costly, FRAME_WINDOW_S + 0.1, () => 1 / 20);
    feed(costly, STEP_DOWN_LOCK_S + STEP_UP_AFTER_S + 10, () => 1 / 60, () => 14); // 14 ms > 0.78 × 16.7
    expect(costly.quality).toBe('balanced');
    const blind = makeStage();
    feed(blind, FRAME_WINDOW_S + 0.1, () => 1 / 20);
    feed(blind, STEP_DOWN_LOCK_S + STEP_UP_AFTER_S + 10, () => 1 / 60);
    expect(blind.quality).toBe('high');
  });

  it('ignores a tab-switch gap and a single hiccup, still judges a crawling device, and cheap menu frames change nothing', () => {
    const st = makeStage();
    feed(st, 1.9, () => 1 / 60);
    st.sampleFps(3);     // hidden tab: not a sample
    st.sampleFps(0);
    st.sampleFps(-1);
    feed(st, 0.3, () => 1 / 60);
    expect(st.quality).toBe('high');
    // one 250 ms hiccup (the shell's dt clamp) inside a smooth window is one sample: no decision
    const hiccup = makeStage();
    feed(hiccup, 1.5, () => 1 / 60);
    hiccup.sampleFps(0.25);
    feed(hiccup, 0.6, () => 1 / 60);
    expect(hiccup.quality).toBe('high');
    // a device crawling at 2 fps (four 500 ms frames in a window) is judged, not excused for being too slow to sample
    const crawling = makeStage();
    for (let i = 0; i < MIN_WINDOW_SAMPLES; i++) crawling.sampleFps(0.5);
    expect(crawling.quality).toBe('balanced');
    expect(crawling.fpsStats().p95).toBe(32);
    // fewer than MIN_WINDOW_SAMPLES frames never close a window (dt caps at 0.5 s)
    const few = makeStage();
    for (let i = 0; i < MIN_WINDOW_SAMPLES - 1; i++) few.sampleFps(0.5);
    expect(few.quality).toBe('high');
    // the title backdrop runs at 30 fps: its intervals move the smoothed fps only, and a cheap backdrop changes nothing
    const menu = makeStage();
    for (let i = 0; i < 300; i++) menu.noteFrame(1 / 30);
    for (let i = 0; i < 300; i++) menu.noteFrame(1 / 30, 4);
    expect(menu.quality).toBe('high');
    expect(menu.autoChanges).toBe(0);
    expect(menu.fps).toBeLessThan(35);
  });

  it('menu frames are an interval probe too: a backdrop that cannot hold the 30 fps throttle steps down even when its JS cost reads cheap', () => {
    expect(MENU_FRAME_MS).toBeCloseTo(1000 * MENU_FRAME_DT, 9);
    expect(MENU_SLOW_RATIO * MENU_FRAME_MS).toBeCloseTo(48, 5);
    // a fast device draws the backdrop every 33 ms (60 Hz) or every 33–42 ms (120 Hz): never slow
    const fast = makeStage();
    for (let i = 0; i < 70; i++) fast.noteFrame(1 / 30, 2);
    for (let i = 0; i < 70; i++) fast.noteFrame(i % 2 ? 5 / 120 : 4 / 120, 2);
    expect(fast.quality).toBe('high');
    // a raster-bound device: 20 fps backdrop frames whose JS-side cost is tiny
    const raster = makeStage();
    for (let i = 0; i < 41; i++) raster.noteFrame(1 / 20, 2);
    expect(raster.quality).toBe('balanced');
    for (let i = 0; i < 41; i++) raster.noteFrame(1 / 20, 2);
    expect(raster.quality).toBe('low');
    // without any cost measurement the interval alone still judges
    const blind = makeStage();
    for (let i = 0; i < 9; i++) blind.noteFrame(0.25);
    expect(blind.quality).toBe('balanced');
  });

  it('menu frames are a cost probe: a backdrop costing more than a display period steps down before play, once per window, never up', () => {
    const storage = new MemTier();
    const st = makeStage(storage);
    // 2 s of 30 fps title frames whose render cost is 40 ms (a weak device at high on a big canvas)
    for (let i = 0; i < 50; i++) st.noteFrame(1 / 30, 40);
    expect(st.quality).toBe('high'); // the window has not closed yet
    for (let i = 0; i < 11; i++) st.noteFrame(1 / 30, 40);
    expect(st.quality).toBe('balanced');
    expect(JSON.parse(storage.getItem(AUTOTIER_KEY)!)).toEqual({ v: 1, tier: 'balanced' });
    for (let i = 0; i < 62; i++) st.noteFrame(1 / 30, 30);
    expect(st.quality).toBe('low');
    expect(st.autoChanges).toBe(2);
    // a cheap backdrop never steps up, and neither does a long smooth play stretch inside the lock
    for (let i = 0; i < 400; i++) st.noteFrame(1 / 30, 2);
    expect(st.quality).toBe('low');
    feed(st, 30, () => 1 / 60, () => 2);
    expect(st.quality).toBe('low');
    // a crawling device (250 ms title frames, the shell's clamp) is judged after eight of them; fewer than
    // MIN_MENU_SAMPLES frames never close a window; an explicit setting stops the probe
    const crawling = makeStage();
    for (let i = 0; i < 8; i++) crawling.noteFrame(0.25, 240);
    expect(crawling.quality).toBe('balanced');
    const few = makeStage();
    for (let i = 0; i < MIN_MENU_SAMPLES - 1; i++) few.noteFrame(0.5, 200);
    expect(few.quality).toBe('high');
    const fixed = makeStage();
    fixed.setSettings({ bloom: true, grain: true, flashes: true, quality: 'high' });
    for (let i = 0; i < 200; i++) fixed.noteFrame(1 / 30, 200);
    expect(fixed.quality).toBe('high');
    // the probe judges cost in display periods: 12 ms backdrops are fine at 60 Hz but not on a 120 Hz display
    const hz60 = makeStage();
    for (let i = 0; i < 70; i++) hz60.noteFrame(1 / 30, 12);
    expect(hz60.quality).toBe('high');
    const hz120 = makeStage();
    feed(hz120, 2.1, () => 1 / 120, () => 2);
    expect(hz120.hz).toBe(120);
    for (let i = 0; i < 70; i++) hz120.noteFrame(1 / 30, 12);
    expect(hz120.quality).toBe('balanced');
    expect(MENU_COST_RATIO).toBe(1);
  });

  it('Renderer.drawTitle measures its own cost for the probe and a stub-canvas title never changes the tier', () => {
    const { r } = makeRenderer();
    for (let i = 0; i < 120; i++) r.drawTitle(i / 30, 1 / 30, BIOMES.tidepool);
    expect(r.qualityTier).toBe('high');
    expect(r.fps).toBeLessThan(35);
  });

  it('persists the settled tier under clawd-echo.autotier.v1 and a new Stage starts from it on its first frame', () => {
    const storage = new MemTier();
    const a = makeStage(storage);
    feed(a, 2 * FRAME_WINDOW_S + 0.2, () => 1 / 20);
    expect(a.quality).toBe('low');
    expect(AUTOTIER_KEY).toBe('clawd-echo.autotier.v1');
    expect(JSON.parse(storage.getItem(AUTOTIER_KEY)!)).toEqual({ v: 1, tier: 'low' });
    expect(readStoredTier(storage)).toBe('low');

    const b = makeStage(storage);
    expect(b.quality).toBe('low');
    expect(b.fpsStats().tier).toBe('low');
    // the renderer built on it draws its first frame at that tier too
    const r = makeRenderer(960, 540, 1, storage);
    expect(r.r.qualityTier).toBe('low');

    // junk or a foreign document → the default
    storage.setItem(AUTOTIER_KEY, '{"v":1,"tier":"ultra"}');
    expect(readStoredTier(storage)).toBeNull();
    expect(makeStage(storage).quality).toBe('high');
    storage.setItem(AUTOTIER_KEY, 'not json');
    expect(makeStage(storage).quality).toBe('high');
    expect(makeStage(null).quality).toBe('high');
    // an explicit setting overrides the remembered tier
    storage.setItem(AUTOTIER_KEY, JSON.stringify({ v: 1, tier: 'low' }));
    const c = makeStage(storage);
    c.setSettings({ bloom: true, grain: true, flashes: true, quality: 'high' });
    expect(c.quality).toBe('high');
  });

  it('an explicit quality setting stops the scaler and writes nothing', () => {
    const storage = new MemTier();
    const st = makeStage(storage);
    st.setSettings({ bloom: true, grain: true, flashes: true, quality: 'balanced' });
    feed(st, 10, () => 1 / 20);
    expect(st.quality).toBe('balanced');
    expect(st.autoChanges).toBe(0);
    expect(storage.writes).toBe(0);
    // back to auto: the scaler resumes from the current tier
    st.setSettings({ bloom: true, grain: true, flashes: true, quality: 'auto' });
    feed(st, FRAME_WINDOW_S + 0.1, () => 1 / 20);
    expect(st.quality).toBe('low');
    expect(storage.writes).toBe(1);
  });

  it('Renderer exposes fpsStats and draws the ?fps=1 overlay only when asked', () => {
    const { r, ctx } = makeRenderer();
    const sim = fakeSim(fixtureDef('tidepool'));
    r.setLevel(sim, BIOMES.tidepool);
    const texts = () => ctx.__calls.filter((c) => c.name === 'fillText').map((c) => String(c.args[0]));
    r.draw(sim, VIEW, FX, [], 1 / 60);
    expect(texts().some((t) => t.includes('p95'))).toBe(false);
    r.showFps = true;
    ctx.__calls.length = 0;
    r.draw(sim, VIEW, FX, [], 1 / 60);
    const line = texts().find((t) => t.includes('p95'));
    expect(line).toBeDefined();
    expect(line).toMatch(/p50 \d+ms · p95 \d+ms · draw \d+ms · \d+Hz · (high|balanced|low) · \d+fps/);
    const s = r.fpsStats();
    expect(s.tier).toBe(r.qualityTier);
    expect(s.hz).toBe(60);
  });
});

// ================================================================ character juice (P3-9)
describe('character juice (P3-9)', () => {
  const SUMMARY = {
    levelId: 't1', cleared: true, ticks: 1200, time: 10, shards: 3, totalShards: 20, relics: 0, totalRelics: 1,
    deaths: 0, par: 45, rank: 'A' as const, height: 0,
  };

  /** The fixture without its updraft and foes, so only the player's own juice puts particles in the pool. */
  function quietSim(biome: LevelDef['biome'] = 'tidepool'): SimView {
    const sim = fakeSim(fixtureDef(biome));
    sim.state.entities = sim.state.entities.filter((e) => e.kind !== 'updraft');
    sim.state.foes = [];
    return sim;
  }

  it('landing dust scales with impact; slide sparks, confetti, the after-image and the respawn pop all emit', () => {
    const { r } = makeRenderer();
    const P = r.particles;
    expect(r.qualityTier).toBe('high');
    P.landDust(40, 64, 0.1, '#ffffff');
    const soft = P.count;
    P.clear();
    P.landDust(40, 64, 1, '#ffffff');
    const hard = P.count;
    expect(soft).toBeGreaterThan(0);
    expect(hard).toBeGreaterThan(soft * 2);
    P.clear(); P.slideSparks(40, 60, 1, '#ffffff'); expect(P.count).toBeGreaterThanOrEqual(1);
    P.clear(); P.confetti(40, 40, 36, ['#ffffff', '#000000']); expect(P.count).toBe(36);
    P.clear(); P.confetti(40, 40, 10, []); expect(P.count).toBe(0);
    P.clear(); P.afterImage(40, 64, 1, '#ffffff'); expect(P.count).toBe(1);
    P.clear(); P.pop(40, 60, '#ffffff'); expect(P.count).toBeGreaterThanOrEqual(5);
    // every kind draws without throwing (the blob included)
    r.setLevel(quietSim(), BIOMES.tidepool);
    P.afterImage(200, 100, -1, '#ffffff');
    P.confetti(200, 100, 6, ['#ffffff']);
    expect(() => r.draw(quietSim(), VIEW, FX, [], 1 / 60)).not.toThrow();
  });

  it('renderer events: wall slides spark, a hard landing throws more dust, the goal bursts confetti, the respawn pops the rig', () => {
    const { r } = makeRenderer();
    const sim = quietSim();
    r.setLevel(sim, BIOMES.tidepool);
    const count = (ev: SimEvent): number => { r.particles.clear(); r.onEvent(ev, sim); return r.particles.count; };
    expect(count({ type: 'wallSlide', x: 40, y: 60, dir: 1 })).toBeGreaterThanOrEqual(2);
    expect(count({ type: 'land', x: 40, y: 64, impact: 1 })).toBeGreaterThan(count({ type: 'land', x: 40, y: 64, impact: 0.05 }));
    expect(count({ type: 'goal', x: 200, y: 64, summary: SUMMARY })).toBeGreaterThan(80);
    const vis = (r as unknown as { playerVis: { squash: number } }).playerVis;
    r.particles.clear();
    r.onEvent({ type: 'respawn', x: 40, y: 64 }, sim);
    expect(vis.squash).toBeLessThan(-0.3);
    expect(r.particles.count).toBeGreaterThan(1);
  });

  it('a dash leaves skin-coloured after-images spaced along the way and none once it ends', () => {
    const { r, ctx } = makeRenderer();
    const sim = quietSim();
    r.applySettings({ ...SETTINGS, skin: 'void' });
    r.setLevel(sim, BIOMES.tidepool);
    const p = sim.state.player;
    p.dashT = 0.15; p.pose = 'dash'; p.vx = 400; p.vy = 0;
    r.particles.clear();
    const x0 = p.x;
    for (let i = 0; i < 8; i++) { p.x += AFTER_IMAGE_SPACING / 2; r.draw(sim, VIEW, FX, [], 1 / 60); }
    const travelled = p.x - x0;
    expect(r.particles.count).toBeGreaterThanOrEqual(Math.floor(travelled / AFTER_IMAGE_SPACING) - 1);
    expect(r.particles.count).toBeLessThanOrEqual(Math.ceil(travelled / AFTER_IMAGE_SPACING) + 1);
    // the void skin's shell colour is what gets stamped (alpha() writes rgba(r,g,b,a))
    const hex = SKINS.void.shell;
    const rgb = `${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)}`;
    const fills = (ctx.__sets.fillStyle ?? []).filter((v): v is string => typeof v === 'string');
    expect(fills.some((f) => f.replace(/\s/g, '').startsWith(`rgba(${rgb},`))).toBe(true);
    p.dashT = 0; p.pose = 'run';
    r.draw(sim, VIEW, FX, [], 1 / 60);
    const n = r.particles.count;
    for (let i = 0; i < 4; i++) { p.x += AFTER_IMAGE_SPACING; r.draw(sim, VIEW, FX, [], 1 / 60); }
    expect(r.particles.count).toBeLessThanOrEqual(n);
  });

  it('the eyes lead toward a goal within GOAL_LOOK_TILES, only for the live player, and the pupils move for it', () => {
    const { r } = makeRenderer();
    const sim = quietSim();
    r.setLevel(sim, BIOMES.tidepool);
    const goal = sim.state.entities.find((e) => e.kind === 'goal')!;
    const p = sim.state.player;
    p.y = goal.y - p.h;
    p.x = goal.x - GOAL_LOOK_TILES * TILE * 2;
    expect(r.goalLook(p)).toBeNull();
    p.x = goal.x - 3 * TILE - p.w / 2;
    const look = r.goalLook(p);
    expect(look).not.toBeNull();
    expect(look!.x).toBeGreaterThan(0.9);
    p.dead = true;
    expect(r.goalLook(p)).toBeNull();
    p.dead = false;
    // set for the live player's draw only, cleared right after
    r.draw(sim, VIEW, FX, [], 1 / 60);
    expect(lookTarget()).toBeNull();
    // the same rig draws different eye ellipses with a target
    const canvas = new StubCanvas();
    const rig = () => ({
      x: 0, y: 0, vx: 0, vy: 0, grounded: true, facing: 1 as const, state: 'idle' as const, t: 0, anim: 0, squash: 0, invuln: 0, blink: 0,
      skin: skinById('clawd'), dashReady: true, dashFlash: 0,
    });
    drawClawd(canvas.ctx as unknown as CanvasRenderingContext2D, null, rig());
    const plain = canvas.ctx.__calls.filter((c) => c.name === 'ellipse').map((c) => JSON.stringify(c.args));
    canvas.ctx.__calls.length = 0;
    setLookTarget({ x: -1, y: 0 });
    drawClawd(canvas.ctx as unknown as CanvasRenderingContext2D, null, rig());
    setLookTarget(null);
    const led = canvas.ctx.__calls.filter((c) => c.name === 'ellipse').map((c) => JSON.stringify(c.args));
    expect(led.length).toBe(plain.length);
    expect(led).not.toEqual(plain);
  });
});

// ================================================================ character pass · foe anticipation (P5-2)
describe('character pass · foe anticipation through the renderer (P5-2)', () => {
  it('foes in their anticipation windows (hopper crouch, turret aim line, chaser wind-up, flyer flap, walker blink) draw without throwing and add calls', () => {
    const { r, ctx } = makeRenderer();
    const sim = fakeSim(fixtureDef('tidepool'));
    r.setLevel(sim, BIOMES.tidepool);
    const p = sim.state.player;
    // park the player within turret range so the aim smoothing runs, and lay the foes out beside it
    const turret = sim.state.foes.find((f) => f.kind === 'turret')!;
    p.x = turret.x - 60; p.y = turret.y - p.h / 2;
    const at = (kind: FoeState['kind'], dx: number, over: Partial<FoeState>): FoeState => ({
      id: 900 + dx, kind, x: p.x + dx, y: p.y, w: 14, h: 12, vx: 0, vy: 0, face: -1, hp: 1, dying: 0, dead: false, flash: 0, t: 0.3, state: 0, ...over,
    });
    turret.state = 1.0;
    sim.state.foes = [turret, at('hopper', 20, { state: 0.9 }), at('chaser', 40, { state: 0 }), at('flyer', 60, {}), at('walker', 80, { t: 0.5 })];
    const view: WorldView = { camX: p.x, camY: p.y, zoom: 1 };
    r.draw(sim, view, FX, [], 1 / 60);
    const count = (name: string) => ctx.__calls.filter((c) => c.name === name).length;
    const calmLineTo = count('lineTo'), calmTranslate = count('translate');
    const calm = JSON.stringify(ctx.__calls);
    ctx.__calls.length = 0;
    // now every foe is telegraphing: the hopper about to hop, the turret about to fire, the chaser winding up, a walker mid-blink
    let blinkT = 0;
    for (let t = 0; t < 6; t += 1 / 120) if (walkerBlink(t, 980) > 0.5) { blinkT = t; break; }
    turret.state = 0.15;
    sim.state.foes = [
      turret, at('hopper', 20, { state: 0.1 }), at('chaser', 40, { state: 0.2 }), at('flyer', 60, { vx: 80 }), at('walker', 80, { t: blinkT }),
    ];
    expect(() => r.draw(sim, view, FX, [], 1 / 60)).not.toThrow();
    expect(JSON.stringify(ctx.__calls)).not.toBe(calm);
    // the turret's aim line and the walker's closed eyes are line segments, the chaser's jitter an extra translate
    expect(count('lineTo')).toBeGreaterThan(calmLineTo);
    expect(count('translate')).toBeGreaterThan(calmTranslate);
    // the hopper's telegraph is monotonic in the countdown
    expect(hopperCrouch(0.25)).toBeLessThan(hopperCrouch(0.1));
    expect(hopperCrouch(0.1)).toBeLessThan(hopperCrouch(0.02));
    expect(hopperCrouch(0.5)).toBe(0);
  });
});
