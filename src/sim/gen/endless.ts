/**
 * Procedural towers — shared by Endless (560 rows) and the Daily Tower (finite).
 *
 * Generation is a single upward sweep under a reachability contract: a measured
 * jump-plus-double-jump reaches 4.92 tiles up and ~7 tiles across at that
 * height, so every step rises at most 4 rows and the horizontal gap between
 * consecutive platforms never exceeds 5 tiles. Wall-jumping is never required.
 *
 * The contract is enforced on the rendered grid, not only on the abstract step
 * list: `effectiveClimb` measures the highest solid cell a player must clear
 * between two consecutive platforms (stub columns, the summit deck, a buried
 * landing), and the generator only keeps decorations that respect it.
 *
 * Danger density and foe variety scale with height (`depth` 0 → 1).
 *
 * Authored chunks (GEN_VERSION 2): with `chunks`, every full band of
 * CHUNK_BAND_ROWS rows gets one or two hand-made skill tests (levels/chunks,
 * see gen/chunks.ts). A chunk is spliced across the whole interior width; its
 * entry ledge is reached from the platform below under the ordinary contract
 * (the generator steers one or two "approach" platforms under it first) and
 * its exit ledge is where the sweep continues. INSIDE a chunk the contract —
 * and the "wall-jumping is never required" rule — is relaxed on purpose: that
 * is the skill ceiling. `towerChunks` reports where they landed so tests can
 * hold the contract on every step pair that is not a chunk interior.
 */
import type { LevelDef } from '../types.js';
import { SOLID_CH } from '../legend.js';
import { makeRng } from '../rng.js';
import type { Rng } from '../rng.js';
import { CHUNK_X0, spliceChunk } from './chunks.js';
import type { ChunkDef, ChunkTag } from './chunks.js';
import { CHUNKS as CHUNKS_DATA } from '../chunks.generated.js';

export const TOWER_W = 44;
export const ENDLESS_ROWS = 560;
/** Row of the summit deck; the goal stands one row above it. */
export const SUMMIT_ROW = 4;
/** Empty tiles allowed between consecutive platforms. */
export const MAX_STEP_GAP = 5;
export const MAX_STEP_RISE = 4;
/** Rows a stub column may rise above the surface of its platform. */
export const MAX_STUB_RISE = 4;
/** Minimum rise from the final platform to the summit deck: two open rows between them, so the deck never buries it. */
const DECK_CLEARANCE = 3;
const DECK_W = 8;
/** Rows per chunk band: each full band of the climb receives 1–2 authored chunks. */
export const CHUNK_BAND_ROWS = 50;
/** Chance a band gets a second chunk. */
const SECOND_CHUNK_P = 0.4;
/** Heights inside a band (rows above its start) at which its first / second chunk is called for. */
const FIRST_SLOT = [3, 12] as const;
const SECOND_SLOT = [26, 32] as const;
/** A chunk's exit ledge must sit at least this far under the summit deck so the sweep can still finish normally. */
const MIN_EXIT_ROW = SUMMIT_ROW + 6;
/** Approach platforms the generator steers toward a pending chunk before giving it up. */
const MAX_APPROACH = 8;

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
  /** Authored chunks to splice in, one or two per CHUNK_BAND_ROWS band (none when empty or omitted). */
  chunks?: readonly ChunkDef[];
}

/** Where an authored chunk landed in a generated tower (tile coordinates). */
export interface ChunkPlacement {
  id: string;
  tags: readonly ChunkTag[];
  /** Top and bottom rows of the chunk. */
  y0: number;
  y1: number;
  /** Its ledges as steps of the climb (also present in `towerSteps`, consecutively). */
  entry: TowerStep;
  exit: TowerStep;
}

const STEPS = new WeakMap<LevelDef, TowerStep[]>();
const PLACED = new WeakMap<LevelDef, ChunkPlacement[]>();

/** The platforms a generated tower was built from (empty for hand-made levels). Chunk entry and exit ledges are steps too. */
export function towerSteps(def: LevelDef): TowerStep[] {
  return STEPS.get(def) ?? [];
}

/** The authored chunks a generated tower contains, bottom first (empty for hand-made levels or towers built without chunks). */
export function towerChunks(def: LevelDef): ChunkPlacement[] {
  return PLACED.get(def) ?? [];
}

/** Band index (0 = bottom) of tile row `ty` in a tower whose base row is `baseY` — the band scheme chunks are scheduled in. */
export function chunkBand(baseY: number, ty: number): number {
  return Math.floor((baseY - 1 - ty) / CHUNK_BAND_ROWS);
}

const clampInt = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** A grid as the generator (string[][]) or a LevelDef (string[]) holds it. */
export type GridRows = ReadonlyArray<string | ReadonlyArray<string>>;

const ONE_WAY = '=';
const isObstacle = (ch: string): boolean => SOLID_CH.includes(ch);
const isSurface = (ch: string): boolean => SOLID_CH.includes(ch) || ch === ONE_WAY;

function cell(g: GridRows, x: number, y: number): string {
  if (y < 0 || y >= g.length) return '.';
  const row = g[y];
  if (x < 0 || x >= row.length) return '#';
  return row[x];
}

/** Columns of `s` where the player can stand: a surface cell with two open rows above it. */
export function standableColumns(g: GridRows, s: TowerStep): number[] {
  const out: number[] = [];
  for (let x = s.x0; x <= s.x1; x++) {
    if (isSurface(cell(g, x, s.y)) && !isObstacle(cell(g, x, s.y - 1)) && !isObstacle(cell(g, x, s.y - 2))) out.push(x);
  }
  return out;
}

/** Highest obstacle (smallest row) in columns lo..hi between just above `a` and the headroom of `b`; `b.y` if none. */
function topObstacle(g: GridRows, a: TowerStep, b: TowerStep, lo: number, hi: number): number {
  let top = b.y;
  const yMin = Math.max(0, b.y - 2);
  for (let x = Math.min(lo, hi); x <= Math.max(lo, hi); x++) {
    for (let y = a.y - 1; y >= yMin; y--) {
      if (isObstacle(cell(g, x, y)) && y < top) top = y;
    }
  }
  return top;
}

/**
 * Effective climb from platform `a` to the next platform `b`, in rows: the
 * nominal rise `a.y - b.y` grown by whatever solid cell the player has to
 * clear on the way — a stub column in the gap, a platform welded to the
 * landing, the summit deck. `Infinity` when `b` has no standable cell.
 *
 * Approach corridors: from the near end of `a` to the nearest standable
 * column of `b` when `b` lies to one side; when they overlap horizontally the
 * player jumps straight up through a one-way ledge, or rounds an edge of a
 * solid one — whichever edge gives the lower climb.
 */
export function effectiveClimb(g: GridRows, a: TowerStep, b: TowerStep): number {
  const landing = standableColumns(g, b);
  if (!landing.length) return Infinity;
  const nominal = a.y - b.y;

  if (b.x0 > a.x1) {
    const land = landing[0];
    return a.y - topObstacle(g, a, b, a.x1 + 1, land);
  }
  if (b.x1 < a.x0) {
    const land = landing[landing.length - 1];
    return a.y - topObstacle(g, a, b, land, a.x0 - 1);
  }

  // overlapping columns
  const lo = Math.max(a.x0, b.x0), hi = Math.min(a.x1, b.x1);
  const oneWay = cell(g, lo, b.y) === ONE_WAY;
  if (oneWay) {
    // straight up through the ledge: the clearest overlapping column wins
    let best = Infinity;
    for (const x of landing) {
      if (x < lo || x > hi) continue;
      best = Math.min(best, a.y - topObstacle(g, a, b, x, x));
    }
    if (best < Infinity) return best;
  }
  // round an edge of the solid platform: rise beside it, land on its end column
  let best = Infinity;
  const leftEdge = b.x0 - 1, rightEdge = b.x1 + 1;
  if (leftEdge >= 2) {
    const takeoff = a.x0 <= leftEdge ? leftEdge : a.x0;       // stand under open sky beside b, or at a's near end
    const land = landing[0];
    best = Math.min(best, a.y - topObstacle(g, a, b, Math.min(takeoff, land), Math.max(takeoff, land)));
  }
  if (rightEdge <= TOWER_W - 3) {
    const takeoff = a.x1 >= rightEdge ? rightEdge : a.x1;
    const land = landing[landing.length - 1];
    best = Math.min(best, a.y - topObstacle(g, a, b, Math.min(takeoff, land), Math.max(takeoff, land)));
  }
  return best < Infinity ? best : nominal;
}

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

  // side walls the whole way up — something to wall-jump against, never required (outside chunks)
  for (let y = 0; y < H; y++) { set(0, y, '#'); set(1, y, '#'); set(W - 2, y, '#'); set(W - 1, y, '#'); }

  const within = (a: TowerStep, b: TowerStep): boolean => effectiveClimb(g, a, b) <= MAX_STEP_RISE;

  /**
   * Wall-jump chimney beside platform `a`: a stub column two tiles off one end,
   * at most MAX_STUB_RISE rows above the surface, never on a side facing the
   * lower neighbour `below` or the next step `above`, and only kept when the
   * grid-level climb into and out of `a` still holds.
   */
  const placeStub = (a: TowerStep, below: TowerStep | null, above: TowerStep): void => {
    const n = rng.int(3, MAX_STUB_RISE + 1);
    const mid = (s: TowerStep): number => (s.x0 + s.x1) / 2;
    const facesRight = (s: TowerStep): boolean => s.x1 > a.x1 || mid(s) > mid(a);
    const facesLeft = (s: TowerStep): boolean => s.x0 < a.x0 || mid(s) < mid(a);
    const sides: number[] = [];
    if (!facesLeft(above) && !(below && facesLeft(below))) sides.push(a.x0 - 2);
    if (!facesRight(above) && !(below && facesRight(below))) sides.push(a.x1 + 2);
    if (sides.length === 2 && rng.chance(0.5)) sides.reverse();
    for (const wx of sides) {
      if (wx <= 2 || wx >= W - 3) continue;
      // never weld onto rock above or below: a stacked column would exceed the cap
      if (isObstacle(cell(g, wx, a.y - n)) || isObstacle(cell(g, wx, a.y + 1))) continue;
      const saved: string[] = [];
      for (let k = 0; k < n; k++) { saved.push(g[a.y - k][wx]); set(wx, a.y - k, '#'); }
      if ((!below || within(below, a)) && within(a, above)) return;
      for (let k = 0; k < n; k++) set(wx, a.y - k, saved[k]);
    }
  };

  // ---- authored chunks: one or two slots per full band, drawn up front so the schedule is part of the seed ----
  const chunks = opts.chunks ?? [];
  /** Heights (rows above the base) at which a chunk is called for, ascending. */
  const slots: number[] = [];
  if (chunks.length) {
    const fullBands = Math.floor((baseY - SUMMIT_ROW) / CHUNK_BAND_ROWS);
    for (let k = 0; k < fullBands; k++) {
      const start = k * CHUNK_BAND_ROWS;
      slots.push(start + rng.int(FIRST_SLOT[0], FIRST_SLOT[1]));
      if (rng.chance(SECOND_CHUNK_P)) slots.push(start + rng.int(SECOND_SLOT[0], SECOND_SLOT[1]));
    }
  }
  const placements: ChunkPlacement[] = [];
  const used = new Set<string>();
  const heightOf = (row: number): number => baseY - 1 - row;
  const ledgeStep = (span: { x0: number; x1: number }, row: number): TowerStep => ({ y: row, x0: CHUNK_X0 + span.x0, x1: CHUNK_X0 + span.x1 });
  /** Exit row of chunk `c` when its entry lands `rise` rows above the platform at `row`. */
  const exitRowFor = (c: ChunkDef, row: number, rise: number): number => row - rise - (c.rows.length - 1);
  /** A chunk that still fits under the summit from here; unused ones first, repeats only once every chunk has been placed. */
  const pickChunk = (row: number, rise: number): ChunkDef | null => {
    const fitting = chunks.filter((c) => exitRowFor(c, row, rise) >= MIN_EXIT_ROW);
    if (!fitting.length) return null;
    let fresh = fitting.filter((c) => !used.has(c.id));
    if (!fresh.length) { used.clear(); fresh = fitting; }
    return rng.pick(fresh);
  };
  let pending: ChunkDef | null = null;
  let approach = 0;
  let slotIdx = 0;

  const steps: TowerStep[] = [{ y: baseY, x0: 2, x1: W - 3 }];
  let prev = steps[0];
  let ax = W >> 1;
  let y = baseY;
  let idx = 0;
  const climb = baseY - SUMMIT_ROW;
  /** The previous platform rolled a stub; it is placed once its upper neighbour is known. */
  let stubWanted = false;

  while (y - SUMMIT_ROW > MAX_STEP_RISE) {
    const depth = (baseY - y) / climb;                 // 0 at the bottom, 1 at the top
    let rise = rng.int(3, 4);
    // Steps are always 3 or 4 rows (anything shorter buries the platform below).
    // The climb must end on a row DECK_CLEARANCE..MAX_STEP_RISE above the deck,
    // so a rise that would land one row short of that band is swapped for the other.
    const landsWell = (r: number): boolean => y - r >= SUMMIT_ROW + DECK_CLEARANCE && y - r !== SUMMIT_ROW + MAX_STEP_RISE + 1;
    if (!landsWell(rise)) rise = 7 - rise;

    // ---- chunk placement: called for at the slot height, spliced once the platform below sits under its entry ----
    if (!pending && slotIdx < slots.length && heightOf(y) >= slots[slotIdx]) {
      slotIdx++;
      pending = pickChunk(y, rise);
      approach = 0;
    }
    if (pending && exitRowFor(pending, y, rise) < MIN_EXIT_ROW) pending = pickChunk(y, rise);   // climbed too high for it: a shorter one, or none
    if (pending) {
      const entry = ledgeStep(pending.entry, y - rise);
      const gap = Math.max(0, entry.x0 - prev.x1 - 1, prev.x0 - entry.x1 - 1);
      if (gap <= MAX_STEP_GAP) {
        const exitRow = exitRowFor(pending, y, rise);
        const saved = g.slice(exitRow, entry.y + 1).map((r) => r.slice());
        spliceChunk(g, pending, exitRow);
        if (within(prev, entry)) {
          const exit = ledgeStep(pending.exit, exitRow);
          placements.push({ id: pending.id, tags: pending.tags, y0: exitRow, y1: entry.y, entry, exit });
          used.add(pending.id);
          steps.push(entry, exit);
          // no stub on the platform below (it would poke into the chunk) and none on the exit ledge
          stubWanted = false;
          prev = exit;
          y = exitRow;
          ax = exit.x0;
          pending = null;
          continue;
        }
        // something below (a stub of an earlier platform) spoils the approach: another approach platform re-seats it
        for (let i = 0; i < saved.length; i++) g[exitRow + i] = saved[i];
      }
      if (++approach > MAX_APPROACH) pending = null;
    }

    // ---- ordinary platform (steered under the pending chunk's entry when there is one) ----
    y -= rise;
    const width = Math.max(2, rng.int(6, 9) - Math.floor(depth * 3));
    const spread = Math.min(9, 4 + Math.floor(depth * 5));
    if (pending) {
      const mid = CHUNK_X0 + (pending.entry.x0 + pending.entry.x1) / 2;
      ax = Math.round(mid - width / 2);
    } else {
      ax = clampInt(ax + rng.int(-spread, spread), 3, W - 4 - width);
    }
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

    const cur: TowerStep = { y, x0: ax, x1: ax + width };
    // wall-jump chimneys: the previous platform's stub, now that both its neighbours are known
    if (stubWanted) placeStub(prev, steps.length >= 2 ? steps[steps.length - 2] : null, cur);
    // none while a chunk is pending: a stub beside an approach platform could reach into its landing yard
    stubWanted = rng.chance(0.14) && !pending;

    prev = cur;
    steps.push(prev);
    idx++;
  }

  // ---- summit: a deck within reach of the last platform, goal in its centre ----
  const sxMax = W - 4 - DECK_W;
  let sx = clampInt(ax + rng.int(-3, 3), 3, sxMax);
  if (sx > prev.x1 + MAX_STEP_GAP + 1) sx = prev.x1 + MAX_STEP_GAP + 1;
  if (sx + DECK_W < prev.x0 - MAX_STEP_GAP - 1) sx = prev.x0 - MAX_STEP_GAP - 1 - DECK_W;
  // candidates: the rolled spot, then a deck hanging two tiles over either end of the platform
  const candidates = [clampInt(sx, 3, sxMax), clampInt(prev.x1 - 1, 3, sxMax), clampInt(prev.x0 + 1 - DECK_W, 3, sxMax)];
  let deck: TowerStep = { y: SUMMIT_ROW, x0: candidates[0], x1: candidates[0] + DECK_W };
  for (const cx of candidates) {
    const trial: TowerStep = { y: SUMMIT_ROW, x0: cx, x1: cx + DECK_W };
    const saved = g[SUMMIT_ROW].slice(cx, cx + DECK_W + 1);
    plat(cx, cx + DECK_W, SUMMIT_ROW);
    deck = trial;
    if (within(prev, trial)) break;
    for (let i = 0; i <= DECK_W; i++) set(cx + i, SUMMIT_ROW, saved[i]);
  }
  plat(deck.x0, deck.x1, SUMMIT_ROW);
  set(deck.x0 + (DECK_W >> 1), SUMMIT_ROW - 1, 'G');
  if (stubWanted) placeStub(prev, steps.length >= 2 ? steps[steps.length - 2] : null, deck);
  steps.push(deck);

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
  PLACED.set(def, placements);
  return def;
}

/** Endless Ascent: a 560-row tower, local seed, rising tide, personal best only. Authored chunks in every band. */
export function makeEndlessLevel(seed: number): LevelDef {
  return buildTower(seed, {
    id: 'endless',
    name: '끝없는 등반',
    en: 'ENDLESS ASCENT',
    hint: '아래에서 조류가 밀려온다. 멈추지 마라.',
    par: 999,
    rows: ENDLESS_ROWS,
    crystals: true,
    chunks: CHUNKS_DATA,
  });
}
