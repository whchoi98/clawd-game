/**
 * Procedural towers — shared by Endless (560 rows) and the Daily Tower (finite).
 *
 * Generation is a single upward sweep under a reachability contract: a measured
 * jump-plus-double-jump reaches 4.92 tiles up and ~7 tiles across at that
 * height, so every step rises at most 4 rows and the horizontal gap between
 * consecutive platforms never exceeds 5 tiles. Wall-jumping is never required.
 *
 * Danger density and foe variety scale with height (`depth` 0 → 1).
 */
import type { LevelDef } from '../types.js';
import { makeRng } from '../rng.js';
import type { Rng } from '../rng.js';

export const TOWER_W = 44;
export const ENDLESS_ROWS = 560;
/** Row of the summit deck; the goal stands one row above it. */
export const SUMMIT_ROW = 4;
/** Empty tiles allowed between consecutive platforms. */
export const MAX_STEP_GAP = 5;
export const MAX_STEP_RISE = 4;

/** One platform of the climb (tile coordinates, inclusive columns). */
export interface TowerStep { y: number; x0: number; x1: number }

export interface TowerOptions {
  id: string;
  name: string;
  en: string;
  hint: string;
  par: number;
  rows: number;
  /** Sprinkle dash crystals over wide gaps. */
  crystals: boolean;
}

const STEPS = new WeakMap<LevelDef, TowerStep[]>();

/** The platforms a generated tower was built from (empty for hand-made levels). */
export function towerSteps(def: LevelDef): TowerStep[] {
  return STEPS.get(def) ?? [];
}

const clampInt = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export function buildTower(seed: number, opts: TowerOptions): LevelDef {
  const W = TOWER_W, H = opts.rows;
  const rng: Rng = makeRng(seed >>> 0);
  const g: string[][] = [];
  for (let y = 0; y < H; y++) g.push(new Array<string>(W).fill('.'));

  const set = (x: number, y: number, ch: string): void => { if (x >= 0 && x < W && y >= 0 && y < H) g[y][x] = ch; };
  const plat = (x0: number, x1: number, y: number, ch = '#'): void => { for (let x = x0; x <= x1; x++) set(x, y, ch); };

  // ---- base camp ----
  const baseY = H - 4;
  for (let y = baseY; y < H; y++) plat(0, W - 1, y);
  set(W >> 1, baseY - 1, 'P');

  // side walls the whole way up — something to wall-jump against, never required
  for (let y = 0; y < H; y++) { set(0, y, '#'); set(1, y, '#'); set(W - 2, y, '#'); set(W - 1, y, '#'); }

  const steps: TowerStep[] = [{ y: baseY, x0: 2, x1: W - 3 }];
  let prev = steps[0];
  let ax = W >> 1;
  let y = baseY;
  let idx = 0;
  const climb = baseY - SUMMIT_ROW;

  while (y - SUMMIT_ROW > MAX_STEP_RISE) {
    const depth = (baseY - y) / climb;                 // 0 at the bottom, 1 at the top
    let rise = rng.int(3, 4);
    rise = Math.min(rise, y - SUMMIT_ROW - 1);         // leave at least one row for the final step
    y -= rise;
    const width = Math.max(2, rng.int(6, 9) - Math.floor(depth * 3));
    const spread = Math.min(9, 4 + Math.floor(depth * 5));
    ax = clampInt(ax + rng.int(-spread, spread), 3, W - 4 - width);
    // reachability: the empty gap to the previous platform stays within MAX_STEP_GAP
    if (ax > prev.x1 + MAX_STEP_GAP + 1) ax = prev.x1 + MAX_STEP_GAP + 1;
    if (ax + width < prev.x0 - MAX_STEP_GAP - 1) ax = prev.x0 - MAX_STEP_GAP - 1 - width;
    ax = clampInt(ax, 3, W - 4 - width);

    // platform type
    const roll = rng();
    let ch = '#';
    if (roll < 0.16 + depth * 0.16) ch = 'X';          // crumbling
    else if (roll < 0.3 + depth * 0.1) ch = '=';       // one-way
    plat(ax, ax + width, y, ch);

    // shards along the platform
    const nS = rng.int(1, 3);
    for (let i = 0; i < nS; i++) set(ax + 1 + rng.int(0, Math.max(0, width - 2)), y - 1, 'o');

    // furniture
    if (rng.chance(0.14)) set(ax + (width >> 1), y - 1, 'S');
    if (rng.chance(0.1 + depth * 0.1)) set(ax + rng.int(0, width), y - 1, rng.chance(0.5) ? 'w' : 'h');
    if (depth > 0.16 && rng.chance(0.08 + depth * 0.12)) set(ax + (width >> 1), y - 4, 'f');
    if (depth > 0.34 && rng.chance(0.07 + depth * 0.1)) set(ax + rng.int(0, width), y - 1, 't');
    if (depth > 0.5 && rng.chance(0.06 + depth * 0.1)) set(ax + (width >> 1), y - 3, 'c');
    if (depth > 0.22 && rng.chance(0.12)) {
      // spike garnish on one end
      const sx = rng.chance(0.5) ? ax : ax + width;
      set(sx, y - 1, '^');
    }
    if (depth > 0.28 && rng.chance(0.1)) set(ax + (width >> 1), y - 2, 's');
    if (depth > 0.4 && rng.chance(0.09)) set(ax + (width >> 1), y - 1, 'z');

    // a dash crystal hangs over wide gaps so the dash can be spent early
    if (opts.crystals) {
      const gapR = ax - prev.x1 - 1, gapL = prev.x0 - (ax + width) - 1;
      if (gapR >= 3 && rng.chance(0.6)) set(Math.floor((prev.x1 + ax) / 2), y + 1, 'D');
      else if (gapL >= 3 && rng.chance(0.6)) set(Math.floor((prev.x0 + ax + width) / 2), y + 1, 'D');
    }

    // a relic-shaped bonus every ~20 platforms
    if (idx > 0 && idx % 20 === 0) set(ax + (width >> 1), y - 2, 'R');

    // wall-jump chimneys: a stub column that narrows the route
    if (rng.chance(0.14)) {
      const wx = rng.chance(0.5) ? ax - 2 : ax + width + 2;
      if (wx > 2 && wx < W - 3) { const n = rng.int(3, 6); for (let k = 0; k < n; k++) set(wx, y - k, '#'); }
    }

    prev = { y, x0: ax, x1: ax + width };
    steps.push(prev);
    idx++;
  }

  // ---- summit: a deck within reach of the last platform, goal in its centre ----
  const deckW = 8;
  let sx = clampInt(ax + rng.int(-3, 3), 3, W - 4 - deckW);
  if (sx > prev.x1 + MAX_STEP_GAP + 1) sx = prev.x1 + MAX_STEP_GAP + 1;
  if (sx + deckW < prev.x0 - MAX_STEP_GAP - 1) sx = prev.x0 - MAX_STEP_GAP - 1 - deckW;
  sx = clampInt(sx, 3, W - 4 - deckW);
  plat(sx, sx + deckW, SUMMIT_ROW);
  set(sx + (deckW >> 1), SUMMIT_ROW - 1, 'G');
  steps.push({ y: SUMMIT_ROW, x0: sx, x1: sx + deckW });

  const def: LevelDef = {
    id: opts.id,
    name: opts.name,
    en: opts.en,
    biome: 'tidepool',
    par: opts.par,
    seed: seed >>> 0,
    hint: opts.hint,
    rows: g.map((r) => r.join('')),
    tide: true,
    baseY,
  };
  STEPS.set(def, steps);
  return def;
}

/** Endless Ascent: a 560-row tower, local seed, rising tide, personal best only. */
export function makeEndlessLevel(seed: number): LevelDef {
  return buildTower(seed, {
    id: 'endless',
    name: '끝없는 등반',
    en: 'ENDLESS ASCENT',
    hint: '아래에서 조류가 밀려온다. 멈추지 마라.',
    par: 999,
    rows: ENDLESS_ROWS,
    crystals: true,
  });
}
