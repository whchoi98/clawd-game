// @vitest-environment happy-dom
/**
 * Band crossfade (P5-4b). On a tide level (daily / endless) the renderer
 * follows the band under the player's feet — `bandBiome(def, row)`, the very
 * call the HUD label uses — and blends backdrop, terrain palette, fog band and
 * goal beacon from the old band to the new over BAND_FADE_S. Hysteresis wants
 * the feet one tile past the boundary in the direction of travel; a teleport,
 * a respawn and the `low` tier hard-cut; story zones never run any of it.
 *
 * Driven with a fake tower and a swallowing canvas stub that records every
 * `globalAlpha` assignment. Nothing here constructs a Sim or touches one.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { Level } from '../../src/sim/level.js';
import { PLAYER_H, PLAYER_W } from '../../src/sim/config.js';
import { TILE } from '../../src/sim/types.js';
import type { BiomeId, LevelDef, PlayerState, SimState } from '../../src/sim/types.js';
import { BIOMES } from '../../src/shared/biomes.js';
import { DAILY_BAND_ROWS, ENDLESS_BAND_ROWS, bandBiome } from '../../src/sim/gen/daily.js';
import { BAND_FADE_S, BAND_SNAP_ROWS, Renderer } from '../../src/client/render/index.js';
import type { SimView } from '../../src/client/render/index.js';
import type { Terrain } from '../../src/client/render/tiles.js';
import type { FxState, Settings } from '../../src/client/contracts.js';

// ------------------------------------------------------------------ stubs
class StubPath2D {
  rect(): void {}
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

/** What the stub remembers: every globalAlpha assignment on any context, and the number of method calls. */
interface Rec { alphas: number[]; calls: number }

function stubCanvas(rec: Rec): HTMLCanvasElement {
  let state: Record<string, unknown> = {
    globalAlpha: 1, globalCompositeOperation: 'source-over', filter: 'none', fillStyle: '#000000', strokeStyle: '#000000',
    lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic',
    imageSmoothingEnabled: true, lineDashOffset: 0,
  };
  const stack: Record<string, unknown>[] = [];
  const fns = new Map<string, (...args: unknown[]) => unknown>();
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(_t, p) {
      if (typeof p !== 'string') return undefined;
      if (p in state) return state[p];
      let fn = fns.get(p);
      if (!fn) {
        fn = (...args: unknown[]) => {
          rec.calls++;
          switch (p) {
            case 'save': stack.push({ ...state }); return undefined;
            case 'restore': if (stack.length) state = stack.pop()!; return undefined;
            case 'createLinearGradient': case 'createRadialGradient': case 'createConicGradient': return { addColorStop() {} };
            case 'createPattern': return { setTransform() {} };
            case 'createImageData': return { width: 1, height: 1, data: new Uint8ClampedArray(Math.max(4, Number(args[0] || 1) * Number(args[1] || 1) * 4)) };
            case 'getImageData': return { width: 1, height: 1, data: new Uint8ClampedArray(Math.max(4, Number(args[2] || 1) * Number(args[3] || 1) * 4)) };
            case 'measureText': return { width: 10, actualBoundingBoxAscent: 6, actualBoundingBoxDescent: 2 };
            case 'getTransform': return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
            case 'getLineDash': return [];
            default: return undefined;
          }
        };
        fns.set(p, fn);
      }
      return fn;
    },
    set(_t, p, v) {
      if (typeof p === 'string') {
        state[p] = v;
        if (p === 'globalAlpha') rec.alphas.push(Number(v));
      }
      return true;
    },
    has() { return true; },
  });
  const cv = { width: 300, height: 150, style: {}, getContext: () => ctx, toDataURL: () => '' } as unknown as HTMLCanvasElement;
  (state as { canvas?: unknown }).canvas = cv;
  return cv;
}

function makeRenderer(): { r: Renderer; rec: Rec } {
  const rec: Rec = { alphas: [], calls: 0 };
  const r = new Renderer(stubCanvas(rec), {
    createCanvas: () => stubCanvas(rec),
    viewport: () => ({ w: 960, h: 540, dpr: 1 }),
    storage: null,
  });
  return { r, rec };
}

// ------------------------------------------------------------------ fixtures
/**
 * A 12-wide tower `height` rows tall: a four-row floor (so baseY = height - 4,
 * as buildTower lays it), the start on the floor, a ledge every six rows and
 * a goal near the top. `tide` makes it a band level; without it, a story zone
 * of the same shape.
 */
function tower(id: string, biome: BiomeId, height: number, tide: boolean): LevelDef {
  const w = 12, rows: string[] = [];
  for (let y = 0; y < height; y++) {
    if (y >= height - 4) rows.push('#'.repeat(w));
    else if (y === height - 5) rows.push('##...P....##');
    else if (y === 2) rows.push('##....G...##');
    else if (y % 6 === 0) rows.push(y % 12 === 0 ? '#####.....##' : '##.....#####');
    else rows.push('##........##');
  }
  return { id, name: '탑', en: 'TOWER', biome, par: 200, seed: 11, rows, ...(tide ? { tide: true, baseY: height - 4 } : {}) };
}

/** 140 rows above a voidreef bottom band: rows 86..135 voidreef, 36..85 summit, 0..35 tidepool. */
const DAILY = tower('daily', 'voidreef', 140, true);
/** The first (topmost-reached-first) row of the daily's second band. */
const DAILY_EDGE = (DAILY.baseY ?? 0) - 1 - DAILY_BAND_ROWS;   // 85
const START_ROW = (DAILY.baseY ?? 0) - 1;                       // 135

function player(level: Level): PlayerState {
  const s = level.start;
  return {
    x: s.x - PLAYER_W / 2, y: s.y - PLAYER_H, w: PLAYER_W, h: PLAYER_H,
    vx: 0, vy: 0, facing: 1, grounded: true, onWall: 0, jumps: 0,
    dashT: 0, dashDirX: 1, dashDirY: 0, dashReady: true, dashCd: 0, stomping: false,
    hp: 3, invuln: 0, dead: false, deadT: 0, inWater: false, pose: 'idle', t: 0,
  };
}

function fakeSim(def: LevelDef): SimView {
  const level = new Level(def);
  const goal = level.spawns.find((s) => s.ch === 'G');
  const state: SimState = {
    tick: 0, time: 0, phase: 'play', phaseT: 0,
    player: player(level),
    entities: goal ? [{ id: 1, kind: 'goal', x: goal.x, y: goal.y, w: 16, h: 16, alive: true, t: 0, state: 0 }] : [],
    foes: [], bolts: [],
    respawn: { x: level.start.x, y: level.start.y },
    switchA: true,
    stats: { shards: 0, relics: 0, deaths: 0, jumps: 0, dashes: 0, wallJumps: 0, foes: 0, combo: 0, bestCombo: 0 },
    tide: def.tide ? { y: level.pxH - 24, speed: 11, height: 0, maxHeight: 0 } : undefined,
  };
  return { level, state };
}

const FX: FxState = { shakeX: 0, shakeY: 0, shakeRot: 0, flash: 0, flashColor: '#ffffff', fade: 0, zoom: 1, aberr: 0, vignette: 0 };
const SETTINGS: Settings = {
  v: 1, master: 1, music: 1, sfx: 1, shake: 1, bloom: true, grain: true, quality: 'high', flashes: true,
  showTimer: true, skin: 'clawd', assist: false, invincible: false, echoSelf: true, echoWorld: true,
  binds: { left: [], right: [], up: [], down: [], jump: [], dash: [], pause: [], confirm: [], cancel: [], restart: [] },
};

const feetRow = (p: PlayerState): number => Math.floor((p.y + p.h - 1) / TILE);
/** Put the player's feet on tile row `row` (mid-shaft), exactly as the HUD would read it. */
function setFeet(sim: SimView, row: number): void {
  const p = sim.state.player;
  p.y = row * TILE + TILE - p.h;
  p.x = 5 * TILE;
}
function frame(r: Renderer, sim: SimView, dt = 1 / 60): void {
  r.draw(sim, { camX: sim.level.pxW / 2, camY: sim.state.player.y, zoom: 1 }, FX, [], dt);
}
/** Move one tile per frame from the current row to `to` (never a snap: 1 < BAND_SNAP_ROWS). */
function walk(r: Renderer, sim: SimView, to: number): void {
  const step = to < feetRow(sim.state.player) ? -1 : 1;
  for (let row = feetRow(sim.state.player) + step; ; row += step) {
    setFeet(sim, row);
    frame(r, sim);
    if (row === to) break;
  }
}
const terrainOf = (r: Renderer): Terrain => (r as unknown as { terrain: Terrain }).terrain;
const terrainsOf = (r: Renderer): Map<BiomeId, Terrain> => (r as unknown as { terrains: Map<BiomeId, Terrain> }).terrains;
/** Progress 0 → 1 the renderer used for `fade` seconds left (smoothstep). */
const progress = (fade: number): number => { const u = 1 - fade / BAND_FADE_S; return u * u * (3 - 2 * u); };

beforeAll(() => {
  (globalThis as unknown as { Path2D: unknown }).Path2D = StubPath2D;
});

// ------------------------------------------------------------------ tests
describe('band crossfade (P5-4b)', () => {
  it('the fixture matches the generator contract: 50-row daily bands counted up from baseY, bottom band = def.biome', () => {
    expect(DAILY_BAND_ROWS).toBe(50);
    expect(ENDLESS_BAND_ROWS).toBe(90);
    expect(bandBiome(DAILY, START_ROW)).toBe('voidreef');
    expect(bandBiome(DAILY, DAILY_EDGE + 1)).toBe('voidreef');
    expect(bandBiome(DAILY, DAILY_EDGE)).toBe('summit');
    expect(bandBiome(DAILY, DAILY_EDGE - DAILY_BAND_ROWS)).toBe('tidepool');
    expect(BAND_FADE_S).toBeCloseTo(1.2, 9);
    expect(BAND_SNAP_ROWS).toBeGreaterThanOrEqual(3);   // maxFall 340 / springVel 430 stay under 3 tiles per clamped frame
  });

  it('a tide level starts on the band under the feet, whatever biome the shell passes; a story zone keeps the biome it is given', () => {
    const { r } = makeRenderer();
    const bottom = fakeSim(DAILY);
    r.setLevel(bottom, BIOMES.tidepool);          // the shell passes the bottom band's biome; here deliberately wrong
    expect(r.band).toEqual({ biome: 'voidreef', prev: null, fade: 0 });
    expect(r.sky.biome?.id).toBe('voidreef');
    expect(terrainOf(r).biome.id).toBe('voidreef');
    const high = fakeSim(DAILY);
    setFeet(high, 60);                             // a run resumed mid-tower (or the shot harness's `at=`)
    r.setLevel(high, BIOMES.voidreef);
    expect(r.band.biome).toBe('summit');
    expect(r.sky.biome?.id).toBe('summit');
    expect(r.actors.biome.id).toBe('summit');
    const story = fakeSim(tower('t9', 'stormspire', 140, false));
    setFeet(story, 60);
    r.setLevel(story, BIOMES.stormspire);
    expect(r.band).toEqual({ biome: 'stormspire', prev: null, fade: 0 });
  });

  it('setLevel bakes one Terrain per band biome of a tide level (three for the 140-row daily), one for a story zone', () => {
    const { r } = makeRenderer();
    r.setLevel(fakeSim(DAILY), BIOMES.voidreef);
    expect([...terrainsOf(r).keys()].sort()).toEqual(['summit', 'tidepool', 'voidreef']);
    r.setLevel(fakeSim(tower('t9', 'stormspire', 140, false)), BIOMES.stormspire);
    expect([...terrainsOf(r).keys()]).toEqual(['stormspire']);
  });

  it('climbing past a boundary starts a BAND_FADE_S crossfade one tile inside the new band and ends on it for sky, terrain and actors', () => {
    const { r, rec } = makeRenderer();
    const sim = fakeSim(DAILY);
    r.applySettings(SETTINGS);
    r.setLevel(sim, BIOMES.voidreef);
    frame(r, sim);
    const skyBefore = r.sky, terrainBefore = terrainOf(r);
    walk(r, sim, DAILY_EDGE + 1);
    expect(r.band).toEqual({ biome: 'voidreef', prev: null, fade: 0 });
    walk(r, sim, DAILY_EDGE);                      // on the boundary row itself: not yet (hysteresis)
    expect(r.band).toEqual({ biome: 'voidreef', prev: null, fade: 0 });
    rec.alphas.length = 0;
    rec.calls = 0;
    walk(r, sim, DAILY_EDGE - 1);                  // one tile inside: the fade starts (and this frame already advanced it by dt)
    const fadingCalls = rec.calls;
    expect(r.band.biome).toBe('summit');
    expect(r.band.prev).toBe('voidreef');
    expect(r.band.fade).toBeGreaterThan(BAND_FADE_S - 0.05);
    expect(r.band.fade).toBeLessThanOrEqual(BAND_FADE_S);
    // the new band is current at once — sky, terrain and actors — while the old sky and terrain fade out over it
    expect(r.sky).not.toBe(skyBefore);
    expect(r.sky.biome?.id).toBe('summit');
    expect(skyBefore.biome?.id).toBe('voidreef');
    expect(terrainOf(r)).not.toBe(terrainBefore);
    expect(terrainOf(r).biome.id).toBe('summit');
    expect(r.actors.biome.id).toBe('summit');
    // the outgoing layers were drawn at exactly 1 - progress (sky opacity, old terrain on both contexts)
    const k = progress(r.band.fade);
    expect(k).toBeGreaterThan(0);
    expect(k).toBeLessThan(0.1);
    expect(rec.alphas.filter((a) => Math.abs(a - (1 - k)) < 1e-9).length).toBeGreaterThanOrEqual(2);
    // the fade runs down monotonically and is gone after BAND_FADE_S
    let last = r.band.fade;
    for (let i = 0; i < Math.ceil(BAND_FADE_S * 60); i++) {
      frame(r, sim);
      expect(r.band.fade).toBeLessThanOrEqual(last);
      last = r.band.fade;
    }
    expect(r.band).toEqual({ biome: 'summit', prev: null, fade: 0 });
    expect(r.sky.biome?.id).toBe('summit');
    expect(terrainOf(r).biome.id).toBe('summit');
    // a steady frame afterwards draws one sky and one terrain: clearly less work than the fading frame
    rec.calls = 0;
    frame(r, sim);
    expect(fadingCalls).toBeGreaterThan(rec.calls * 1.3);
  });

  it('hysteresis: hopping across the boundary by less than a tile never switches, either way', () => {
    const { r } = makeRenderer();
    const sim = fakeSim(DAILY);
    r.setLevel(sim, BIOMES.voidreef);
    walk(r, sim, DAILY_EDGE + 1);
    for (let i = 0; i < 6; i++) {
      walk(r, sim, DAILY_EDGE);                    // up onto the first summit row
      expect(r.band).toEqual({ biome: 'voidreef', prev: null, fade: 0 });
      walk(r, sim, DAILY_EDGE + 1);                // back down
      expect(r.band).toEqual({ biome: 'voidreef', prev: null, fade: 0 });
    }
    walk(r, sim, DAILY_EDGE - 1);                  // one tile inside → summit
    expect(r.band.biome).toBe('summit');
    for (let i = 0; i < 100; i++) frame(r, sim);   // let the fade finish
    expect(r.band).toEqual({ biome: 'summit', prev: null, fade: 0 });
    // coming back down: the last voidreef row (edge + 1) is not enough, one tile inside (edge + 2) is
    for (let i = 0; i < 6; i++) {
      walk(r, sim, DAILY_EDGE + 1);
      expect(r.band.biome).toBe('summit');
      walk(r, sim, DAILY_EDGE);
      expect(r.band.biome).toBe('summit');
    }
    walk(r, sim, DAILY_EDGE + 2);
    expect(r.band.biome).toBe('voidreef');
    expect(r.band.prev).toBe('summit');
  });

  it('a hop back across the boundary mid-fade reverses the crossfade: progress mirrored, the returning sky reused', () => {
    const { r } = makeRenderer();
    const sim = fakeSim(DAILY);
    r.setLevel(sim, BIOMES.voidreef);
    const skyVoid = r.sky;
    walk(r, sim, DAILY_EDGE - 1);                  // → summit, fade starts
    const skySummit = r.sky;
    for (let i = 0; i < 30; i++) frame(r, sim);    // 0.5 s in
    const left = r.band.fade;
    expect(left).toBeGreaterThan(BAND_FADE_S * 0.5);
    expect(left).toBeLessThan(BAND_FADE_S * 0.65);
    walk(r, sim, DAILY_EDGE + 2);                  // three frames down → back to voidreef
    expect(r.band.biome).toBe('voidreef');
    expect(r.band.prev).toBe('summit');
    // mirrored: the progress made toward summit is now what is left of the way back (± the three frames walked)
    expect(Math.abs(r.band.fade - (BAND_FADE_S - left))).toBeLessThan(3 / 60 + 1e-9);
    expect(r.sky).toBe(skyVoid);                   // the old instance comes back with its weather
    expect(skySummit.biome?.id).toBe('summit');
    for (let i = 0; i < 100; i++) frame(r, sim);
    expect(r.band).toEqual({ biome: 'voidreef', prev: null, fade: 0 });
    expect(terrainOf(r).biome.id).toBe('voidreef');
  });

  it('a teleport switches at once: two bands up hard-cuts, and so does any feet-row jump of BAND_SNAP_ROWS or more', () => {
    const { r } = makeRenderer();
    const sim = fakeSim(DAILY);
    r.setLevel(sim, BIOMES.voidreef);
    frame(r, sim);
    const skyBefore = r.sky;
    setFeet(sim, 20);                              // two bands up in one frame (the `?shot=daily&at=` harness)
    frame(r, sim);
    expect(r.band).toEqual({ biome: 'tidepool', prev: null, fade: 0 });
    expect(r.sky).toBe(skyBefore);                 // retinted in place: no second sky
    expect(r.sky.biome?.id).toBe('tidepool');
    expect(terrainOf(r).biome.id).toBe('tidepool');
    expect(r.actors.biome.id).toBe('tidepool');
    // an adjacent band, but reached by a jump of ≥ BAND_SNAP_ROWS rows → still a hard cut
    setFeet(sim, 20 + DAILY_BAND_ROWS);            // row 70: summit
    frame(r, sim);
    expect(r.band).toEqual({ biome: 'summit', prev: null, fade: 0 });
    // a small jump below the threshold across the boundary fades as walking would
    setFeet(sim, DAILY_EDGE - 1);                  // 84 → summit already
    frame(r, sim);
    setFeet(sim, DAILY_EDGE + 2);                  // 3 rows down (< BAND_SNAP_ROWS) → voidreef with a fade
    frame(r, sim);
    expect(r.band.biome).toBe('voidreef');
    expect(r.band.prev).toBe('summit');
    expect(r.band.fade).toBeGreaterThan(0);
  });

  it('a respawn or an intro event makes the next band change a hard cut, and the death tumble never switches bands', () => {
    const { r } = makeRenderer();
    const sim = fakeSim(DAILY);
    r.setLevel(sim, BIOMES.voidreef);
    walk(r, sim, DAILY_EDGE + 1);
    // dying and drifting up into the summit band: frozen while dead
    sim.state.player.dead = true;
    setFeet(sim, DAILY_EDGE - 2);
    frame(r, sim);
    expect(r.band).toEqual({ biome: 'voidreef', prev: null, fade: 0 });
    // the respawn lands one tile inside the summit band: hard cut, no fade
    sim.state.player.dead = false;
    r.onEvent({ type: 'respawn', x: 5 * TILE, y: (DAILY_EDGE - 1) * TILE + TILE }, sim);
    setFeet(sim, DAILY_EDGE - 1);
    frame(r, sim);
    expect(r.band).toEqual({ biome: 'summit', prev: null, fade: 0 });
    // and the same for the intro phase
    r.onEvent({ type: 'phase', phase: 'intro' }, sim);
    setFeet(sim, DAILY_EDGE + 2);
    frame(r, sim);
    expect(r.band).toEqual({ biome: 'voidreef', prev: null, fade: 0 });
  });

  it('story zones never start a fade: def.biome for the whole level, however tall', () => {
    const { r } = makeRenderer();
    const def = tower('t9', 'stormspire', 140, false);
    const sim = fakeSim(def);
    r.setLevel(sim, BIOMES.stormspire);
    const sky = r.sky;
    expect(bandBiome(def, 20)).not.toBe('stormspire');   // the band maths would say otherwise — the renderer must not ask
    walk(r, sim, 20);
    expect(r.band).toEqual({ biome: 'stormspire', prev: null, fade: 0 });
    expect(r.sky).toBe(sky);
    expect(r.sky.biome?.id).toBe('stormspire');
    expect(terrainOf(r).biome.id).toBe('stormspire');
    expect(r.actors.biome.id).toBe('stormspire');
  });

  it("the 'low' tier hard-cuts at the boundary: correct colours, no second sky, no fade", () => {
    const { r } = makeRenderer();
    const sim = fakeSim(DAILY);
    r.applySettings({ ...SETTINGS, quality: 'low' });
    r.setLevel(sim, BIOMES.voidreef);
    expect(r.qualityTier).toBe('low');
    const sky = r.sky;
    walk(r, sim, DAILY_EDGE - 1);
    expect(r.band).toEqual({ biome: 'summit', prev: null, fade: 0 });
    expect(r.sky).toBe(sky);
    expect(r.sky.biome?.id).toBe('summit');
    expect(terrainOf(r).biome.id).toBe('summit');
    // hysteresis still holds on low
    walk(r, sim, DAILY_EDGE + 1);
    expect(r.band.biome).toBe('summit');
    walk(r, sim, DAILY_EDGE + 2);
    expect(r.band).toEqual({ biome: 'voidreef', prev: null, fade: 0 });
  });

  it('dropping to the low tier mid-fade finishes the fade on the spot', () => {
    const { r } = makeRenderer();
    const sim = fakeSim(DAILY);
    r.applySettings(SETTINGS);
    r.setLevel(sim, BIOMES.voidreef);
    walk(r, sim, DAILY_EDGE - 1);
    expect(r.band.fade).toBeGreaterThan(0);
    r.applySettings({ ...SETTINGS, quality: 'low' });
    frame(r, sim);
    expect(r.band).toEqual({ biome: 'summit', prev: null, fade: 0 });
  });

  it('endless bands are 90 rows: the first change comes ENDLESS_BAND_ROWS rows above the base', () => {
    const { r } = makeRenderer();
    const def = tower('endless', 'tidepool', 200, true);
    const sim = fakeSim(def);
    r.setLevel(sim, BIOMES.tidepool);
    const edge = (def.baseY ?? 0) - 1 - ENDLESS_BAND_ROWS;   // 105
    expect(bandBiome(def, edge)).toBe('stormspire');
    walk(r, sim, edge);
    expect(r.band.biome).toBe('tidepool');
    walk(r, sim, edge - 1);
    expect(r.band.biome).toBe('stormspire');
    expect(r.band.prev).toBe('tidepool');
    expect(r.band.biome).toBe(bandBiome(def, feetRow(sim.state.player)));
  });

  it('every frame of a crossfade draws without throwing across all four boundaries of a full daily, with fx and ghosts', () => {
    const { r } = makeRenderer();
    const def = tower('daily', 'tidepool', 210, true);     // 4 bands: tidepool, stormspire, voidreef, summit
    const sim = fakeSim(def);
    r.applySettings(SETTINGS);
    r.setLevel(sim, BIOMES.tidepool);
    const seen = new Set<BiomeId>();
    const ghost = { player: { ...sim.state.player }, alpha: 0.5, label: 'echo', color: '#ffffff' };
    // down to row 6: rows 0..5 would be a fifth band (tidepool again, the cycle wraps) — the summit band's floor is row 6
    expect(bandBiome(def, 6)).toBe('summit');
    for (let row = (def.baseY ?? 0) - 1; row >= 6; row--) {
      setFeet(sim, row);
      expect(() => r.draw(sim, { camX: 96, camY: sim.state.player.y, zoom: 1 }, FX, [ghost as never], 1 / 60)).not.toThrow();
      seen.add(r.band.biome!);
      // the band of the row, or — on the hysteresis tile just past a boundary — still the band of the row below
      expect([bandBiome(def, row), bandBiome(def, row + 1)]).toContain(r.band.biome);
    }
    expect([...seen].sort()).toEqual(['stormspire', 'summit', 'tidepool', 'voidreef']);
    for (let i = 0; i < 100; i++) frame(r, sim);
    expect(r.band).toEqual({ biome: 'summit', prev: null, fade: 0 });
  });
});
