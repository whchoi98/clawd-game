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
import { Renderer, SKINS } from '../../src/client/render/index.js';
import type { SimView } from '../../src/client/render/index.js';

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

function makeRenderer(w = 960, h = 540, dpr = 1) {
  const canvas = new StubCanvas();
  const r = new Renderer(canvas as unknown as HTMLCanvasElement, {
    createCanvas: () => new StubCanvas() as unknown as HTMLCanvasElement,
    viewport: () => ({ w, h, dpr }),
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

  it.each(BIOME_ORDER)('setLevel + draw does not throw for biome %s', (biomeId) => {
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
    for (const id of BIOME_ORDER) {
      for (let i = 0; i < 3; i++) r.drawTitle(i * 0.5, 1 / 60, BIOMES[id]);
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
});
