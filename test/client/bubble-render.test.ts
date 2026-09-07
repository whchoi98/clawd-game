// @vitest-environment happy-dom
/**
 * The bubble foe on the client (P5-5): drawing, the re-form shimmer and the
 * pop / re-form particles. Like render.test.ts this never builds a Sim — a
 * hand-made FoeState of kind `bubble` drives the renderer through a recording
 * canvas stub — because the sim side is another task's work and the summit
 * zones that place bubbles are not in this tree.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { Level } from '../../src/sim/level.js';
import { PLAYER_H, PLAYER_W } from '../../src/sim/config.js';
import type { FoeState, LevelDef, PlayerState, SimEvent, SimState } from '../../src/sim/types.js';
import type { BiomeId } from '../../src/sim/types.js';
import { BIOMES, BIOME_ORDER } from '../../src/shared/biomes.js';
import type { FxState, Settings, WorldView } from '../../src/client/contracts.js';
import { Renderer } from '../../src/client/render/index.js';
import type { SimView } from '../../src/client/render/index.js';
import { BUBBLE_SHIMMER_T, bubbleShimmer, bubbleWobble } from '../../src/client/render/actors.js';

// ------------------------------------------------------------------ canvas stub
interface Call { name: string; args: unknown[] }
interface RecordingCtx { __calls: Call[]; [k: string]: unknown }

class StubPath2D {
  rect(): void {} moveTo(): void {} lineTo(): void {} closePath(): void {} arc(): void {} ellipse(): void {}
  quadraticCurveTo(): void {} bezierCurveTo(): void {} roundRect(): void {} addPath(): void {}
}

function makeCtx(canvas: StubCanvas): RecordingCtx {
  const calls: Call[] = [];
  let state: Record<string, unknown> = {
    canvas, globalAlpha: 1, globalCompositeOperation: 'source-over', filter: 'none', fillStyle: '#000000', strokeStyle: '#000000',
    lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', miterLimit: 10, lineDashOffset: 0, font: '10px sans-serif', textAlign: 'start',
    textBaseline: 'alphabetic', imageSmoothingEnabled: true, imageSmoothingQuality: 'low', shadowBlur: 0, shadowColor: 'rgba(0,0,0,0)',
    shadowOffsetX: 0, shadowOffsetY: 0,
  };
  const stack: Record<string, unknown>[] = [];
  const fns = new Map<string, (...args: unknown[]) => unknown>();
  const imageData = (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(Math.max(1, w * h * 4)) });
  return new Proxy({} as RecordingCtx, {
    get(_t, prop) {
      if (prop === '__calls') return calls;
      if (typeof prop !== 'string') return undefined;
      if (prop in state) return state[prop];
      let fn = fns.get(prop);
      if (!fn) {
        fn = (...args: unknown[]) => {
          calls.push({ name: prop, args });
          switch (prop) {
            case 'save': stack.push({ ...state }); return undefined;
            case 'restore': if (stack.length) state = stack.pop()!; return undefined;
            case 'createLinearGradient': case 'createRadialGradient': case 'createConicGradient': return { addColorStop() {} };
            case 'createPattern': return { setTransform() {} };
            case 'createImageData': return imageData(Number(args[0]) || 1, Number(args[1]) || 1);
            case 'getImageData': return imageData(Number(args[2]) || 1, Number(args[3]) || 1);
            case 'measureText': return { width: String(args[0]).length * 6, actualBoundingBoxAscent: 6, actualBoundingBoxDescent: 2 };
            case 'getTransform': return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
            case 'getLineDash': return [];
            case 'isPointInPath': case 'isPointInStroke': return false;
            default: return undefined;
          }
        };
        fns.set(prop, fn);
      }
      return fn;
    },
    set(_t, prop, value) { if (typeof prop === 'string') state[prop] = value; return true; },
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

/** The renderer plus its main context and the glow buffer's (the first offscreen canvas the Stage creates). */
function makeRenderer() {
  const canvas = new StubCanvas();
  const created: StubCanvas[] = [];
  const r = new Renderer(canvas as unknown as HTMLCanvasElement, {
    createCanvas: () => { const c = new StubCanvas(); created.push(c); return c as unknown as HTMLCanvasElement; },
    viewport: () => ({ w: 960, h: 540, dpr: 1 }),
    storage: null,
  });
  return { r, ctx: canvas.ctx, glow: created[0].ctx };
}

// ------------------------------------------------------------------ fixtures
const ALL_BIOMES: BiomeId[] = [...new Set<BiomeId>([...BIOME_ORDER, 'summit'])];

const ROWS = [
  '..............',
  '..P.....b...G.',
  '##############',
];

function def(biome: BiomeId): LevelDef {
  return { id: 'm3', name: '바람의 첨탑', en: 'Wind Spire', biome, par: 60, seed: 3, rows: ROWS };
}

function player(level: Level): PlayerState {
  const s = level.start;
  return {
    x: s.x - PLAYER_W / 2, y: s.y - PLAYER_H, w: PLAYER_W, h: PLAYER_H, vx: 0, vy: 0, facing: 1, grounded: true, onWall: 0, jumps: 0,
    dashT: 0, dashDirX: 1, dashDirY: 0, dashReady: true, dashCd: 0, stomping: false, hp: 3, invuln: 0, dead: false, deadT: 0,
    inWater: false, pose: 'idle', t: 1,
  };
}

/** A hand-made bubble: 14 × 14 like the other small foes, alive unless overridden. */
function bubble(over: Partial<FoeState> = {}): FoeState {
  return { id: 7, kind: 'bubble', x: 120, y: 80, w: 14, h: 14, vx: 0, vy: 0, face: -1, hp: 1, dying: 0, dead: false, flash: 0, t: 0.3, state: 0, ...over };
}

function sim(biome: BiomeId, foes: FoeState[]): SimView {
  const level = new Level(def(biome));
  const state: SimState = {
    tick: 0, time: 0, phase: 'play', phaseT: 0, player: player(level), entities: [], foes, bolts: [],
    respawn: { x: level.start.x, y: level.start.y }, switchA: true,
    stats: { shards: 0, relics: 0, deaths: 0, jumps: 0, dashes: 0, wallJumps: 0, foes: 0, combo: 0, bestCombo: 0 },
  };
  return { level, state };
}

const SETTINGS: Settings = {
  v: 1, master: 1, music: 1, sfx: 1, shake: 1, bloom: true, grain: true, quality: 'auto', flashes: true,
  showTimer: true, skin: 'clawd', assist: false, invincible: false, echoSelf: true, echoWorld: true,
  binds: { left: [], right: [], up: [], down: [], jump: [], dash: [], pause: [], confirm: [], cancel: [], restart: [] },
};
const VIEW: WorldView = { camX: 120, camY: 80, zoom: 1 };
const FX: FxState = { shakeX: 0, shakeY: 0, shakeRot: 0, flash: 0, flashColor: '#ffffff', fade: 0, zoom: 1, aberr: 0, vignette: 0 };

const names = (calls: Call[]): string[] => calls.map((c) => c.name);

beforeAll(() => {
  (globalThis as unknown as { Path2D: unknown }).Path2D = StubPath2D;
});

// ------------------------------------------------------------------ tests
describe('bubble foe rendering (P5-5)', () => {
  it('bubbleShimmer is 0 outside the last BUBBLE_SHIMMER_T of the countdown and rises to 1 as it runs out', () => {
    expect(BUBBLE_SHIMMER_T).toBe(0.5);
    expect(bubbleShimmer(2.0)).toBe(0);
    expect(bubbleShimmer(BUBBLE_SHIMMER_T)).toBe(0);
    expect(bubbleShimmer(0)).toBe(0);
    expect(bubbleShimmer(-1)).toBe(0);
    expect(bubbleShimmer(0.3)).toBeCloseTo(0.4, 6);
    expect(bubbleShimmer(0.05)).toBeCloseTo(0.9, 6);
    let prev = 0;
    for (let s = 0.49; s > 0.001; s -= 0.01) { const k = bubbleShimmer(s); expect(k).toBeGreaterThanOrEqual(prev); prev = k; }
  });

  it('bubbleWobble stays within ±3.5 % so the drawn body never leaves the hitbox read', () => {
    for (let t = 0; t < 10; t += 0.05) {
      for (const id of [1, 2, 9]) {
        const w = bubbleWobble(t, id);
        expect(w).toBeGreaterThanOrEqual(0.965);
        expect(w).toBeLessThanOrEqual(1.035);
      }
    }
  });

  it('a live bubble is drawn on its hitbox: translated to f.x/f.y, every ellipse within the wobble of w/2 · h/2, one glow hint', () => {
    const { r, ctx, glow } = makeRenderer();
    const f = bubble();
    const view = sim('summit', [f]);
    r.applySettings(SETTINGS);
    r.setLevel(view, BIOMES.summit);
    const c0 = ctx.__calls.length, g0 = glow.__calls.length;
    const snapshot = JSON.stringify(f);
    r.actors.drawFoes(view.state, 1.0);
    const calls = ctx.__calls.slice(c0);
    expect(calls.length).toBeGreaterThan(10);
    expect(calls.some((c) => c.name === 'translate' && c.args[0] === f.x && c.args[1] === f.y)).toBe(true);
    const ellipses = calls.filter((c) => c.name === 'ellipse');
    expect(ellipses.length).toBeGreaterThanOrEqual(5);   // body, rim, three iridescent arcs, danger rim, crown, glint
    for (const e of ellipses) {
      expect(e.args[2] as number).toBeLessThanOrEqual((f.w / 2) * 1.036);
      expect(e.args[3] as number).toBeLessThanOrEqual((f.h / 2) * 1.036);
    }
    // the sim state is read-only to the renderer
    expect(JSON.stringify(f)).toBe(snapshot);
    // the glow buffer gets one small arc, not a flood
    const glowArcs = glow.__calls.slice(g0).filter((c) => c.name === 'arc');
    expect(glowArcs).toHaveLength(1);
    expect(glowArcs[0].args[2] as number).toBeLessThanOrEqual(f.w / 2);
  });

  it('an inactive bubble with 2.0 s left draws nothing at all', () => {
    const { r, ctx, glow } = makeRenderer();
    const view = sim('tidepool', [bubble({ dead: true, state: 2.0 })]);
    r.applySettings(SETTINGS);
    r.setLevel(view, BIOMES.tidepool);
    const c0 = ctx.__calls.length, g0 = glow.__calls.length;
    r.actors.drawFoes(view.state, 1.0);
    expect(ctx.__calls.length).toBe(c0);
    expect(glow.__calls.length).toBe(g0);
    // right at the edge of the shimmer window, and with the timer not running: still nothing
    for (const state of [BUBBLE_SHIMMER_T, 0]) {
      view.state.foes[0].state = state;
      r.actors.drawFoes(view.state, 1.0);
      expect(ctx.__calls.length).toBe(c0);
    }
  });

  it('an inactive bubble with 0.3 s left draws the re-form shimmer at its home: a ring, four motes, a glow hint', () => {
    const { r, ctx, glow } = makeRenderer();
    const f = bubble({ dead: true, state: 0.3 });
    const view = sim('voidreef', [f]);
    r.applySettings(SETTINGS);
    r.setLevel(view, BIOMES.voidreef);
    const c0 = ctx.__calls.length, g0 = glow.__calls.length;
    r.actors.drawFoes(view.state, 1.0);
    const calls = ctx.__calls.slice(c0);
    expect(calls.some((c) => c.name === 'translate' && c.args[0] === f.x && c.args[1] === f.y)).toBe(true);
    expect(names(calls).filter((n) => n === 'arc')).toHaveLength(5);    // the ring + four motes
    expect(names(calls).filter((n) => n === 'stroke')).toHaveLength(1);
    expect(names(calls).filter((n) => n === 'fill')).toHaveLength(4);
    expect(names(calls)).not.toContain('ellipse');                       // no body while inactive
    expect(glow.__calls.slice(g0).filter((c) => c.name === 'arc')).toHaveLength(1);
    // the ring closes in as the countdown runs out, landing on the bubble's own radius
    const ringAt = (state: number): number => {
      view.state.foes[0].state = state;
      const n = ctx.__calls.length;
      r.actors.drawFoes(view.state, 1.0);
      return ctx.__calls.slice(n).find((c) => c.name === 'arc')!.args[2] as number;
    };
    expect(ringAt(0.45)).toBeGreaterThan(ringAt(0.25));
    expect(ringAt(0.25)).toBeGreaterThan(ringAt(0.02));
    expect(ringAt(0.02)).toBeGreaterThanOrEqual(f.w / 2 - 0.01);
  });

  it('flash, dying, bloom-off and low-tier states render without throwing', () => {
    const { r } = makeRenderer();
    const view = sim('stormspire', [bubble({ flash: 1 }), bubble({ id: 8, x: 150, dying: 0.1, hp: 0 }), bubble({ id: 9, x: 180, dead: true, state: 0.1 })]);
    r.applySettings({ ...SETTINGS, bloom: false });
    r.setLevel(view, BIOMES.stormspire);
    expect(() => r.actors.drawFoes(view.state, 0)).not.toThrow();
    r.applySettings({ ...SETTINGS, quality: 'low' });
    expect(() => r.actors.drawFoes(view.state, 3.7)).not.toThrow();
  });

  it.each(ALL_BIOMES)('setLevel + full draw with live and inactive bubbles does not throw for biome %s', (biomeId) => {
    const { r, ctx } = makeRenderer();
    const view = sim(biomeId, [bubble(), bubble({ id: 8, x: 150, dead: true, state: 0.3 }), bubble({ id: 9, x: 170, dead: true, state: 2.0 })]);
    r.applySettings(SETTINGS);
    r.setLevel(view, BIOMES[biomeId]);
    r.onEvent({ type: 'bubblePop', x: 120, y: 80 }, view);
    r.onEvent({ type: 'bubbleBack', x: 150, y: 80 }, view);
    for (let i = 0; i < 4; i++) {
      r.draw(view, VIEW, FX, [], 1 / 60);
      for (const f of view.state.foes) { f.t += 1 / 60; if (f.dead) f.state = Math.max(0.01, f.state - 1 / 60); }
    }
    expect(ctx.__calls.length).toBeGreaterThan(50);
    expect(ctx.__calls.some((c) => c.name === 'ellipse')).toBe(true);
  });

  it('onEvent bubblePop spawns the droplet burst and a ring; bubbleBack the inward shimmer; nothing lingers past a second', () => {
    const { r } = makeRenderer();
    const view = sim('summit', [bubble()]);
    r.applySettings(SETTINGS);
    r.setLevel(view, BIOMES.summit);
    const count = (ev: SimEvent): number => { r.particles.clear(); r.onEvent(ev, view); return r.particles.count; };
    expect(count({ type: 'bubblePop', x: 120, y: 80 })).toBeGreaterThanOrEqual(9);     // 8–12 droplets + the ring
    expect(count({ type: 'bubbleBack', x: 120, y: 80 })).toBeGreaterThanOrEqual(3);    // the ring + at least two motes
    r.particles.clear();
    r.onEvent({ type: 'bubblePop', x: 120, y: 80 }, view);
    const n0 = r.particles.count;
    for (let i = 0; i < 30; i++) r.particles.update(1 / 60, null);
    expect(r.particles.count).toBeLessThanOrEqual(n0);
    for (let i = 0; i < 60; i++) r.particles.update(1 / 60, null);
    expect(r.particles.count).toBe(0);
  });
});
