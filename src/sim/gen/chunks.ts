/**
 * Authored chunks — hand-made skill tests the tower generator splices into the
 * Daily and Endless towers (roadmap P2-9, GEN_VERSION 2).
 *
 * A chunk is a CHUNK_W × (8..14) char grid in the legend of legend.ts, authored
 * with the level DSL in levels/chunks/*.ts and emitted by `npm run levels` into
 * src/sim/chunks.generated.ts — this module never imports the DSL, so the sim
 * bundle stays free of levels/ and client code. Both the client and the server
 * splice the same data with the same code: a daily is reproducible or it is
 * refused ('sim-version').
 *
 * Contract with the generator (validateChunk enforces the geometric part):
 *   - the ENTRY ledge is a run of surface cells on the bottom row; the tower's
 *     previous platform lands the player on it under the ordinary contract
 *     (rise ≤ MAX_STEP_RISE, gap ≤ MAX_STEP_GAP, effectiveClimb ≤ 4). So the
 *     two rows above the ledge, YARD_REACH columns to either side, must be a
 *     free landing yard: no rock, crumble, switch blocks or spikes.
 *   - the EXIT ledge is a run of surface cells on the top row; the generator
 *     continues from it exactly as from one of its own platforms.
 *   - INSIDE the chunk the tower's "wall-jumping is never required" rule is
 *     relaxed: a chunk tagged 'wall' needs wall jumps, 'dash' needs the dash,
 *     'crystal' a mid-air crystal reset and 'switch' a toggle flip. Every chunk
 *     is proven clearable by a golden replay of its solo room
 *     (levels/chunks/solutions/<id>.json, test/levels/chunks.test.ts).
 *   - no player, goal or checkpoint markers; foes are allowed but unused.
 */
import type { LevelDef } from '../types.js';
import {
  CRUMBLE, ONE_WAY, SOLID_CH, SPAWN_CH, SPIKES, SWITCH_A, SWITCH_B, WATER_BODY, WATER_SURFACE,
} from '../legend.js';
import { hash32 } from '../rng.js';

/** Every character a chunk grid may contain (the DSL's ALL_CH, rebuilt here so the sim never imports levels/). */
const ALL_GRID_CH = `.#${ONE_WAY}${CRUMBLE}${WATER_SURFACE}${WATER_BODY}${SPIKES}${SWITCH_A}${SWITCH_B}${SPAWN_CH}`;

export type ChunkTag = 'dash' | 'wall' | 'crystal' | 'switch';
export const CHUNK_TAGS: readonly ChunkTag[] = ['dash', 'wall', 'crystal', 'switch'];

/** Interior width of the tower (TOWER_W minus two 2-thick side walls). */
export const CHUNK_W = 40;
export const CHUNK_MIN_H = 8;
export const CHUNK_MAX_H = 14;
/** Entry / exit ledge widths in cells — the widths the generator's own platforms have (3..9). */
export const LEDGE_MIN_W = 4;
export const LEDGE_MAX_W = 9;
/** Columns beside the entry ledge (and the two rows above it) that must stay free for the approach. */
export const YARD_REACH = 6;
/** Tower column of chunk column 0 (the thickness of the tower's side wall). */
export const CHUNK_X0 = 2;

/** Inclusive column span of a ledge, in chunk-local columns. */
export interface LedgeSpan { x0: number; x1: number }

export interface ChunkDef {
  /** File-safe id: lowercase letters, digits and dashes. */
  id: string;
  /** Korean display name (tooling, logs). */
  name: string;
  tags: readonly ChunkTag[];
  /** Entry ledge on the bottom row. */
  entry: LedgeSpan;
  /** Exit ledge on the top row. */
  exit: LedgeSpan;
  /** CHUNK_W-wide rows, top row first. */
  rows: readonly string[];
}

const ID_RE = /^[a-z][a-z0-9-]*$/;
/** Markers a chunk may never carry: the tower owns start, goal and checkpoints. */
const FORBIDDEN_CH = 'PGC';
const isSurface = (ch: string): boolean => ch === '#' || ch === '=';
const isSolid = (ch: string): boolean => SOLID_CH.includes(ch);

/**
 * Every geometry rule a chunk must satisfy before the generator may splice it.
 * Returns human-readable problems; an empty list means the chunk is sound.
 * Clearability is not checked here — that is the golden replay's job.
 */
export function validateChunk(c: ChunkDef): string[] {
  const errs: string[] = [];
  const id = c.id || '?';
  if (!ID_RE.test(c.id)) errs.push(`${id}: id must match ${ID_RE}`);
  if (!c.name) errs.push(`${id}: empty name`);
  if (!c.tags.length) errs.push(`${id}: no tags`);
  for (const t of c.tags) if (!CHUNK_TAGS.includes(t)) errs.push(`${id}: unknown tag '${t}'`);
  if (new Set(c.tags).size !== c.tags.length) errs.push(`${id}: duplicate tag`);

  const h = c.rows.length;
  if (h < CHUNK_MIN_H || h > CHUNK_MAX_H) errs.push(`${id}: height ${h}, expected ${CHUNK_MIN_H}..${CHUNK_MAX_H}`);
  for (let y = 0; y < h; y++) {
    if (c.rows[y].length !== CHUNK_W) errs.push(`${id}: row ${y} has width ${c.rows[y].length}, expected ${CHUNK_W}`);
  }
  if (errs.length) return errs;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < CHUNK_W; x++) {
      const ch = c.rows[y][x];
      if (!ALL_GRID_CH.includes(ch)) errs.push(`${id}: unknown char '${ch}' at (${x},${y})`);
      else if (FORBIDDEN_CH.includes(ch)) errs.push(`${id}: '${ch}' at (${x},${y}) — chunks carry no start, goal or checkpoint`);
    }
  }

  const ledge = (label: string, s: LedgeSpan, y: number): void => {
    if (!Number.isInteger(s.x0) || !Number.isInteger(s.x1) || s.x0 < 0 || s.x1 >= CHUNK_W || s.x0 > s.x1) {
      errs.push(`${id}: ${label} span ${s.x0}..${s.x1} is outside 0..${CHUNK_W - 1}`);
      return;
    }
    const w = s.x1 - s.x0 + 1;
    if (w < LEDGE_MIN_W || w > LEDGE_MAX_W) errs.push(`${id}: ${label} is ${w} wide, expected ${LEDGE_MIN_W}..${LEDGE_MAX_W}`);
    for (let x = s.x0; x <= s.x1; x++) {
      if (!isSurface(c.rows[y][x])) errs.push(`${id}: ${label} cell (${x},${y}) is '${c.rows[y][x]}', expected rock or a one-way ledge`);
    }
  };
  ledge('entry', c.entry, h - 1);
  ledge('exit', c.exit, 0);
  if (errs.length) return errs;

  // landing yard: the approach from the platform below must see nothing but the ledge
  const yx0 = Math.max(0, c.entry.x0 - YARD_REACH), yx1 = Math.min(CHUNK_W - 1, c.entry.x1 + YARD_REACH);
  for (let x = yx0; x <= yx1; x++) {
    for (let y = h - 3; y <= h - 2; y++) {
      const ch = c.rows[y][x];
      if (isSolid(ch) || ch === SWITCH_A || ch === SWITCH_B) errs.push(`${id}: '${ch}' at (${x},${y}) blocks the landing yard above the entry (rows ${h - 3}..${h - 2}, columns ${yx0}..${yx1})`);
      else if (SPIKES.includes(ch)) errs.push(`${id}: spikes at (${x},${y}) in the landing yard above the entry`);
    }
    if (SPIKES.includes(c.rows[h - 1][x])) errs.push(`${id}: spikes at (${x},${h - 1}) beside the entry ledge`);
  }
  return errs;
}

/** Throw with every problem listed when a chunk fails validation. */
export function assertChunk(c: ChunkDef): ChunkDef {
  const errs = validateChunk(c);
  if (errs.length) throw new Error(`chunk '${c.id}' failed validation:\n  ${errs.join('\n  ')}`);
  return c;
}

// ---------------------------------------------------------------- solo room
/** Par of a chunk's solo room in seconds (the solver must clear inside par × 1.2). */
export const CHUNK_ROOM_PAR = 30;
/** Open rows above the goal deck, and between the deck and the exit / the entry and the floor. */
const ROOM_TOP_PAD = 2;
const ROOM_DECK_RISE = 3;
const ROOM_FLOOR_RISE = 3;
const ROOM_FLOOR_DEPTH = 2;
const ROOM_DECK_W = 8;
const ROOM_W = CHUNK_W + 2 * CHUNK_X0;

/** Seed of a chunk's solo room — fixed per id so its golden replay stays bound to the chunk. */
export function chunkRoomSeed(id: string): number {
  return hash32(`chunk:${id}`);
}

/**
 * The solo room a chunk is proven in: the tower's side walls, a floor with the
 * player standing under the entry ledge (ROOM_FLOOR_RISE rows below it, as a
 * generated platform would be), the chunk itself, and a goal deck ROOM_DECK_RISE
 * rows above the exit ledge — the same approach and departure the generator
 * gives it. Not a tide level: the replay proves the geometry, not the clock.
 */
export function chunkRoom(c: ChunkDef): LevelDef {
  const h = c.rows.length;
  const exitRow = ROOM_TOP_PAD + ROOM_DECK_RISE;
  const entryRow = exitRow + h - 1;
  const floorRow = entryRow + ROOM_FLOOR_RISE;
  const H = floorRow + ROOM_FLOOR_DEPTH;
  const g: string[][] = [];
  for (let y = 0; y < H; y++) g.push(new Array<string>(ROOM_W).fill('.'));
  for (let y = 0; y < H; y++) for (const x of [0, 1, ROOM_W - 2, ROOM_W - 1]) g[y][x] = '#';
  for (let y = floorRow; y < H; y++) for (let x = 0; x < ROOM_W; x++) g[y][x] = '#';
  spliceChunk(g, c, exitRow);

  const deckRow = exitRow - ROOM_DECK_RISE;
  const exitMid = CHUNK_X0 + (c.exit.x0 + c.exit.x1) / 2;
  const dx0 = Math.max(CHUNK_X0, Math.min(ROOM_W - CHUNK_X0 - 1 - ROOM_DECK_W, Math.round(exitMid - ROOM_DECK_W / 2)));
  for (let x = dx0; x <= dx0 + ROOM_DECK_W; x++) g[deckRow][x] = '#';
  g[deckRow - 1][dx0 + (ROOM_DECK_W >> 1)] = 'G';
  g[floorRow - 1][CHUNK_X0 + ((c.entry.x0 + c.entry.x1) >> 1)] = 'P';

  return {
    id: c.id,
    name: c.name,
    en: c.id.toUpperCase(),
    biome: 'tidepool',
    par: CHUNK_ROOM_PAR,
    seed: chunkRoomSeed(c.id),
    rows: g.map((r) => r.join('')),
  };
}

/** Copy the chunk's cells into a tower grid with its top row at `y0`, columns CHUNK_X0.. */
export function spliceChunk(g: string[][], c: ChunkDef, y0: number): void {
  for (let r = 0; r < c.rows.length; r++) {
    const row = g[y0 + r];
    const src = c.rows[r];
    for (let x = 0; x < CHUNK_W; x++) row[CHUNK_X0 + x] = src[x];
  }
}
