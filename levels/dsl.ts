/**
 * Level DSL. Hand-authored zones are expressed as primitives on a Room and
 * emitted as the rectangular char grids the runtime expects. Keeping the
 * source in primitives means every row is the same width by construction,
 * a shaft is always exactly SHAFT_WIDTH_TILES wide and a pit can never be
 * accidentally nine tiles wide — and `validate()` proves it before the grid
 * is written to src/sim/levels.generated.ts.
 *
 * Coordinates are tile indices, x to the right and y DOWN (row 0 is the top).
 * All ranges are inclusive. Spawn characters (P G C o R S D k w h f t c m M s z)
 * sit in the empty tile directly above the floor they stand on; the runtime
 * anchors them to the bottom of that tile.
 */
import type { BiomeId, LevelDef } from '../src/sim/types.js';
import {
  CRUMBLE, MAX_PIT_TILES, ONE_WAY, SHAFT_WIDTH_TILES, SPAWN_CH, SPIKES,
  SWITCH_A, SWITCH_B, WATER_BODY, WATER_SURFACE,
} from '../src/sim/legend.js';
import type { ChunkDef, ChunkTag } from '../src/sim/gen/chunks.js';
import { hasRawKeyName } from '../src/client/ui/hints.js';

export const EMPTY = '.';
export const ROCK = '#';

/** Every character a grid may contain. Anything else is a typo. */
export const GRID_CH = EMPTY + ROCK + ONE_WAY + CRUMBLE + WATER_SURFACE + WATER_BODY + SPIKES + SWITCH_A + SWITCH_B;
export const ALL_CH = GRID_CH + SPAWN_CH;

export type SpikeDir = 'up' | 'down' | 'right' | 'left';
const SPIKE_CH: Record<SpikeDir, string> = { up: '^', down: 'V', right: '{', left: '}' };

/** Characters that count as a floor when measuring bottomless pits. */
const FLOOR_CH = ROCK + CRUMBLE + ONE_WAY + WATER_SURFACE + WATER_BODY;

/** Interior widths up to this are considered "facing walls" for the shaft rule; wider is a room or a yard. */
const SHAFT_SCAN_MAX = 6;
/** Facing walls must both be at least this tall to count as a shaft. */
const SHAFT_MIN_TALL = 5;
export const SHAFT_MIN_WIDTH = 3;
export const SHAFT_MAX_WIDTH = 5;

export interface ZoneMeta {
  id: string;
  name: string;
  en: string;
  biome: BiomeId;
  par: number;
  seed: number;
  hint: string;
  spikers?: [number, number][];
  tide?: boolean;
  baseY?: number;
  /** Geometry revision: bump whenever a shipped zone's cells (terrain or spawns) change. Missing = 0. */
  rev?: number;
}

/**
 * Metadata of an authored tower chunk (levels/chunks/*.ts → Room.chunk()).
 * `entry` / `exit` are inclusive column spans of the ledge on the bottom / top
 * row; the generator lands the player on the entry and continues from the exit.
 */
export interface ChunkMeta {
  id: string;
  name: string;
  tags: readonly ChunkTag[];
  entry: readonly [number, number];
  exit: readonly [number, number];
}

export interface ShaftOpts {
  /** Wall thickness in tiles (default 2). */
  thick?: number;
  /** Top row of the left / right wall; default y0 for both. The lower wall top is the exit. */
  leftTop?: number;
  rightTop?: number;
}

const lo = (a: number, b: number) => Math.min(a, b);
const hi = (a: number, b: number) => Math.max(a, b);

/** A named tile anchor placed with Room.mark(). */
export interface Anchor { x: number; y: number }

export class Room {
  readonly w: number;
  readonly h: number;
  private readonly g: string[][];
  private readonly anchors = new Map<string, Anchor>();

  constructor(w: number, h: number) {
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) throw new Error(`room: bad size ${w}x${h}`);
    this.w = w;
    this.h = h;
    this.g = Array.from({ length: h }, () => new Array<string>(w).fill(EMPTY));
  }

  /**
   * Name a tile so later primitives can be placed relative to it:
   *   m.mark('shaftFloor', 21, 27); const a = m.at('shaftFloor'); m.ent('S', a.x + 1, a.y - 1);
   * Marks are authoring aids only — they never reach the LevelDef.
   */
  mark(name: string, x: number, y: number): this {
    if (!name) throw new Error('mark: empty name');
    if (!Number.isInteger(x) || !Number.isInteger(y)) throw new Error(`mark '${name}': non-integer position (${x}, ${y})`);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) throw new Error(`mark '${name}': (${x}, ${y}) is outside the ${this.w}x${this.h} room`);
    this.anchors.set(name, { x, y });
    return this;
  }

  /** The tile a mark names. Throws for an unknown name so a typo fails the build, not the level. */
  at(name: string): Anchor {
    const a = this.anchors.get(name);
    if (!a) throw new Error(`at '${name}': no such mark (known: ${[...this.anchors.keys()].join(', ') || 'none'})`);
    return { x: a.x, y: a.y };
  }

  /** Every mark, for tooling. */
  marks(): Record<string, Anchor> {
    const out: Record<string, Anchor> = {};
    for (const [k, v] of this.anchors) out[k] = { x: v.x, y: v.y };
    return out;
  }

  /** Character at (x, y); out of range reads as rock so callers can test edges safely. */
  get(x: number, y: number): string {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return ROCK;
    return this.g[y][x];
  }

  /** Set one cell. Writes outside the room are ignored (like the reference builder). */
  set(x: number, y: number, ch: string): this {
    if (ch.length !== 1 || !ALL_CH.includes(ch)) throw new Error(`set: unknown char '${ch}'`);
    if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.g[y][x] = ch;
    return this;
  }

  /** Fill the inclusive rectangle. */
  fill(x0: number, x1: number, y0: number, y1: number, ch: string): this {
    for (let y = lo(y0, y1); y <= hi(y0, y1); y++) for (let x = lo(x0, x1); x <= hi(x0, x1); x++) this.set(x, y, ch);
    return this;
  }

  /** Solid from row y down `depth` rows (default: to the bottom of the room). */
  ground(x0: number, x1: number, y: number, depth = Infinity): this {
    const yEnd = Math.min(this.h - 1, y + (Number.isFinite(depth) ? depth - 1 : this.h));
    return this.fill(x0, x1, y, yEnd, ROCK);
  }

  /** Solid rectangle. */
  block(x0: number, x1: number, y0: number, y1: number): this { return this.fill(x0, x1, y0, y1, ROCK); }
  /** One-tile-thick solid ledge. */
  plat(x0: number, x1: number, y: number): this { return this.fill(x0, x1, y, y, ROCK); }
  /** One-way platform: passable from below, stood on from above. */
  owp(x0: number, x1: number, y: number): this { return this.fill(x0, x1, y, y, ONE_WAY); }
  /** Crumbling ledge: breaks PHYS.crumbleDelay after being stepped on. */
  crumble(x0: number, x1: number, y: number): this { return this.fill(x0, x1, y, y, CRUMBLE); }

  /** Horizontal run of spikes. `dir` is the direction the points face. */
  spikes(x0: number, x1: number, y: number, dir: SpikeDir = 'up'): this { return this.fill(x0, x1, y, y, SPIKE_CH[dir]); }
  /** Vertical run of spikes on a wall face. */
  spikesV(x: number, y0: number, y1: number, dir: SpikeDir): this { return this.fill(x, x, y0, y1, SPIKE_CH[dir]); }

  /** Water: surface row y0, body down to y1. */
  water(x0: number, x1: number, y0: number, y1: number): this {
    this.fill(x0, x1, y0, y0, WATER_SURFACE);
    if (y1 > y0) this.fill(x0, x1, y0 + 1, y1, WATER_BODY);
    return this;
  }

  /** Vertical solid column(s) from y0 to y1, `thick` tiles wide starting at x. */
  wall(x: number, y0: number, y1: number, thick = 1): this { return this.fill(x, x + thick - 1, y0, y1, ROCK); }

  /**
   * Wall-jump shaft. Interior columns x .. x+SHAFT_WIDTH_TILES-1 stay empty;
   * both walls rise from y0 (or their own top) down to y1-3, leaving the
   * two-tile doorway rows y1-2 and y1-1 open above the floor row y1. The
   * floor under the shaft is solid to the bottom of the room. Rest ledges
   * inside must be one-way (`owp`) so the shaft is never sealed from below.
   */
  shaft(x: number, y0: number, y1: number, opts: ShaftOpts = {}): this {
    const thick = opts.thick ?? 2;
    const lt = opts.leftTop ?? y0, rt = opts.rightTop ?? y0;
    const wallBottom = y1 - 3;
    if (wallBottom - Math.max(lt, rt) < SHAFT_MIN_TALL - 1) throw new Error(`shaft at x=${x}: walls too short`);
    const xl = x - thick, xr = x + SHAFT_WIDTH_TILES;
    this.fill(xl, xr + thick - 1, y1, this.h - 1, ROCK);
    this.fill(xl, x - 1, lt, wallBottom, ROCK);
    this.fill(xr, xr + thick - 1, rt, wallBottom, ROCK);
    this.fill(x, xr - 1, Math.min(lt, rt), y1 - 1, EMPTY);
    return this;
  }

  /** Switch blocks: '%' is solid while switchA (the initial state); '&' is solid while !switchA. */
  switchA(x0: number, x1: number, y0: number, y1 = y0): this { return this.fill(x0, x1, y0, y1, SWITCH_A); }
  switchB(x0: number, x1: number, y0: number, y1 = y0): this { return this.fill(x0, x1, y0, y1, SWITCH_B); }

  /** Place a spawn character. */
  ent(ch: string, x: number, y: number): this {
    if (!SPAWN_CH.includes(ch)) throw new Error(`ent: '${ch}' is not a spawn char`);
    return this.set(x, y, ch);
  }

  shards(pts: readonly (readonly [number, number])[]): this {
    for (const [x, y] of pts) this.set(x, y, 'o');
    return this;
  }

  /** A row of shards. */
  shardRow(x0: number, x1: number, y: number, step = 1): this {
    for (let x = lo(x0, x1); x <= hi(x0, x1); x += step) this.set(x, y, 'o');
    return this;
  }

  /**
   * Shard trail along a lobbed arc from (x0,y0) to (x1,y1) — reads as a jump
   * invitation. `n` points (default one per column), `lift` = apex height in tiles.
   */
  arc(x0: number, y0: number, x1: number, y1: number, n = Math.abs(x1 - x0) + 1, ch = 'o', lift = 3.2): this {
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0.5 : i / (n - 1);
      const x = Math.round(x0 + (x1 - x0) * t);
      const y = Math.round(y0 + (y1 - y0) * t - lift * (1 - (2 * t - 1) ** 2));
      this.set(x, y, ch);
    }
    return this;
  }

  rows(): string[] { return this.g.map((r) => r.join('')); }

  /** Count a character in the grid. */
  count(ch: string): number {
    let n = 0;
    for (const r of this.g) for (const c of r) if (c === ch) n++;
    return n;
  }

  /** Finish: attach metadata and produce the LevelDef the runtime consumes. */
  def(meta: ZoneMeta): LevelDef {
    const d: LevelDef = {
      id: meta.id, name: meta.name, en: meta.en, biome: meta.biome,
      par: meta.par, seed: meta.seed, hint: meta.hint, rows: this.rows(),
    };
    if (meta.spikers?.length) d.spikers = meta.spikers.map(([x, y]) => [x, y]);
    if (meta.tide) d.tide = true;
    if (meta.baseY !== undefined) d.baseY = meta.baseY;
    if (meta.rev !== undefined && meta.rev > 0) d.rev = meta.rev;
    return d;
  }

  /**
   * Finish as an authored tower chunk (src/sim/gen/chunks.ts). The room must be
   * CHUNK_W wide; the geometry rules are checked by validateChunk() at build time.
   */
  chunk(meta: ChunkMeta): ChunkDef {
    return {
      id: meta.id, name: meta.name, tags: [...meta.tags],
      entry: { x0: meta.entry[0], x1: meta.entry[1] },
      exit: { x0: meta.exit[0], x1: meta.exit[1] },
      rows: this.rows(),
    };
  }
}

export function room(w: number, h: number): Room { return new Room(w, h); }

// ------------------------------------------------------------------ validation

/** Rows above / below and columns left / right of the offending cell shown by `dumpAt`. */
export const DUMP_ROWS = 3;
export const DUMP_COLS = 12;

/**
 * ASCII excerpt of `rows` around (x, y): a two-line column ruler (tens over
 * units), the rows y-3..y+3 prefixed with their index, and a caret under the
 * offending cell. Every located validator error carries one so a failing
 * build shows the geometry, not just a coordinate.
 */
export function dumpAt(rows: readonly string[], x: number, y: number): string {
  const h = rows.length, w = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const x0 = Math.max(0, x - DUMP_COLS), x1 = Math.min(w - 1, x + DUMP_COLS);
  const y0 = Math.max(0, y - DUMP_ROWS), y1 = Math.min(h - 1, y + DUMP_ROWS);
  const gutter = String(y1).length + 3;                    // "y=NN "
  const pad = ' '.repeat(gutter);
  let tens = '', units = '';
  for (let cx = x0; cx <= x1; cx++) {
    tens += cx % 10 === 0 ? String(Math.floor(cx / 10) % 10) : ' ';
    units += String(cx % 10);
  }
  const out = [`cell (${x}, ${y}) — rows ${y0}..${y1}, columns ${x0}..${x1}:`, `${pad}${tens}`, `${pad}${units}`];
  for (let cy = y0; cy <= y1; cy++) {
    const line = (rows[cy] ?? '').padEnd(w, ' ').slice(x0, x1 + 1);
    out.push(`${`y=${cy}`.padEnd(gutter)}${line}`);
    if (cy === y) out.push(`${pad}${' '.repeat(Math.max(0, x - x0))}^ (${x}, ${y})`);
  }
  return out.join('\n');
}

interface Grid { w: number; h: number; at(x: number, y: number): string }

function parse(rows: string[]): Grid {
  const h = rows.length, w = rows[0]?.length ?? 0;
  return { w, h, at: (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? ROCK : rows[y][x]) };
}

/** Wall for the reachability flood fill under one switch polarity. Spawn chars were never terrain. */
function isWall(ch: string, switchA: boolean): boolean {
  if (ch === ROCK) return true;
  if (ch === SWITCH_A) return switchA;
  if (ch === SWITCH_B) return !switchA;
  return false;
}

/**
 * Cells reachable from (sx, sy) starting in the given switch polarity. The
 * walk may flip polarity whenever it stands on a toggle cell ('k' — dashing
 * through one flips the switch), so a corridor of alternating '%' and '&'
 * gates with toggles between them is reachable, while a chamber sealed by
 * rock — or by both block kinds with no toggle — is not.
 */
function floodFrom(g: Grid, sx: number, sy: number, switchA: boolean): Uint8Array {
  const n = g.w * g.h;
  const seen = new Uint8Array(n * 2);          // [polarity][cell]
  const stack: number[] = [];
  const push = (x: number, y: number, a: boolean) => {
    if (x < 0 || y < 0 || x >= g.w || y >= g.h) return;
    const ch = g.at(x, y);
    if (isWall(ch, a)) return;
    const k = (a ? 0 : n) + y * g.w + x;
    if (seen[k]) return;
    seen[k] = 1;
    stack.push(k);
    if (ch === 'k') push(x, y, !a);
  };
  push(sx, sy, switchA);
  while (stack.length) {
    const k = stack.pop()!;
    const a = k < n;
    const c = a ? k : k - n;
    const x = c % g.w, y = (c - x) / g.w;
    push(x + 1, y, a); push(x - 1, y, a); push(x, y + 1, a); push(x, y - 1, a);
  }
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = seen[i] | seen[i + n];
  return out;
}

/**
 * Check a level definition against every geometry rule. Returns a list of
 * human-readable problems; an empty list means the level is sound.
 *
 *  - rows must be rectangular and contain only legend characters
 *  - exactly one P and one G, both standing on rock
 *  - every o / R / G must be reachable from P by a flood fill over non-solid
 *    cells in at least one switch polarity (X = ~ W spikes are passable);
 *    the fill may flip polarity on a toggle cell ('k')
 *  - no run of bottomless columns wider than MAX_PIT_TILES
 *  - two rock walls ≥ 5 tall facing each other across an empty interior
 *    form a shaft, which must be 3..5 wide (real shafts are 4)
 *  - the hint is a token template ({move} {jump} {dash} {stomp} {down}): raw
 *    key names (Shift, Space, ← →, A/D, R) are wrong on a phone or after a rebind
 *
 * Every error located at a cell ends with an ASCII excerpt of the rows around
 * it (`dumpAt`: ±3 rows, ±12 columns, a column ruler and a caret at "(x, y)").
 */
export function validate(def: LevelDef): string[] {
  const id = def.id || '?';
  const errs = validateGeometry(def, id);
  if (def.hint && hasRawKeyName(def.hint)) {
    errs.push(`${id}: hint names a raw key ('${def.hint}') — use {move} {jump} {dash} {stomp} {down} tokens`);
  }
  return errs;
}

/** The grid rules of validate(); the hint rule is checked separately so a bad hint never hides a geometry problem. */
function validateGeometry(def: LevelDef, id: string): string[] {
  const errs: string[] = [];
  const rows = def.rows;
  if (!rows || rows.length === 0) return [`${id}: no rows`];
  const w = rows[0].length;
  if (w === 0) return [`${id}: empty rows`];
  /** An error located at a cell: the message plus the ASCII excerpt around it. */
  const located = (msg: string, x: number, y: number) => errs.push(`${msg}\n${dumpAt(rows, x, y)}`);
  for (let y = 0; y < rows.length; y++) {
    if (rows[y].length !== w) located(`${id}: row ${y} has width ${rows[y].length}, expected ${w}`, Math.max(0, Math.min(rows[y].length, w) - 1), y);
  }
  if (errs.length) return errs;
  const g = parse(rows);

  // legend
  for (let y = 0; y < g.h; y++) {
    for (let x = 0; x < g.w; x++) {
      const ch = g.at(x, y);
      if (!ALL_CH.includes(ch)) located(`${id}: unknown char '${ch}' at (${x},${y})`, x, y);
    }
  }
  if (errs.length) return errs;

  // spawn bookkeeping
  const find = (ch: string): [number, number][] => {
    const out: [number, number][] = [];
    for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) if (g.at(x, y) === ch) out.push([x, y]);
    return out;
  };
  const ps = find('P'), gs = find('G');
  for (const [label, pts] of [['P', ps], ['G', gs]] as const) {
    if (pts.length === 1) continue;
    const msg = `${id}: expected exactly one ${label}, found ${pts.length}`;
    if (pts.length > 1) located(msg, pts[1][0], pts[1][1]); else errs.push(msg);
  }
  for (const [label, pts] of [['P', ps], ['G', gs]] as const) {
    for (const [x, y] of pts) {
      if (g.at(x, y + 1) !== ROCK || y + 1 >= g.h) located(`${id}: ${label} at (${x},${y}) is not standing on rock`, x, y);
    }
  }

  // reachability in either polarity
  if (ps.length === 1) {
    const [px, py] = ps[0];
    const seenA = floodFrom(g, px, py, true);
    const seenB = floodFrom(g, px, py, false);
    for (const ch of ['o', 'R', 'G']) {
      for (const [x, y] of find(ch)) {
        const k = y * g.w + x;
        if (!seenA[k] && !seenB[k]) located(`${id}: ${ch} at (${x},${y}) is not reachable from P`, x, y);
      }
    }
  }

  // bottomless pits
  let run = 0, runStart = 0;
  for (let x = 0; x <= g.w; x++) {
    let floored = x === g.w;
    for (let y = 0; y < g.h && !floored; y++) if (FLOOR_CH.includes(g.at(x, y))) floored = true;
    if (!floored) {
      if (run === 0) runStart = x;
      run++;
    } else {
      if (run > MAX_PIT_TILES) located(`${id}: bottomless pit ${run} wide at x=${runStart}..${x - 1} (max ${MAX_PIT_TILES})`, runStart, g.h - 1);
      run = 0;
    }
  }

  // shafts: facing rock walls with an empty interior
  const rock = (x: number, y: number) => g.at(x, y) === ROCK; // out of range reads as rock (the map edge)
  const facingRun = new Map<string, { width: number; y0: number; len: number }>();
  const reported = new Set<string>();
  for (let y = 0; y < g.h; y++) {
    const rowPairs = new Set<string>();
    for (let xl = -1; xl < g.w; xl++) {
      if (!rock(xl, y) || rock(xl + 1, y)) continue;
      let xr = xl + 1;
      while (xr <= g.w && !rock(xr, y) && xr - xl - 1 <= SHAFT_SCAN_MAX) xr++;
      if (xr > g.w || !rock(xr, y)) continue;
      const width = xr - xl - 1;
      if (width > SHAFT_SCAN_MAX) continue;
      const key = `${xl}:${xr}`;
      rowPairs.add(key);
      const cur = facingRun.get(key);
      if (cur && cur.y0 + cur.len === y) cur.len++;
      else facingRun.set(key, { width, y0: y, len: 1 });
    }
    for (const [key, r] of facingRun) {
      if (!rowPairs.has(key) || y === g.h - 1) {
        if (r.len >= SHAFT_MIN_TALL && (r.width < SHAFT_MIN_WIDTH || r.width > SHAFT_MAX_WIDTH) && !reported.has(key + r.y0)) {
          reported.add(key + r.y0);
          const [xl, xr] = key.split(':').map(Number);
          located(`${id}: shaft ${r.width} wide between x=${xl} and x=${xr}, rows ${r.y0}..${r.y0 + r.len - 1} (allowed ${SHAFT_MIN_WIDTH}..${SHAFT_MAX_WIDTH})`, Math.max(0, xl + 1), r.y0);
        }
        if (!rowPairs.has(key)) facingRun.delete(key);
      }
    }
  }

  return errs;
}

/** Throw with every problem listed when a level fails validation. */
export function assertValid(def: LevelDef): LevelDef {
  const errs = validate(def);
  if (errs.length) throw new Error(`level '${def.id}' failed validation:\n  ${errs.join('\n  ')}`);
  return def;
}

/** Counts the builder and tests care about. */
export function census(def: LevelDef): { w: number; h: number; shards: number; relics: number; checkpoints: number; crystals: number; toggles: number } {
  const flat = def.rows.join('');
  const n = (ch: string) => flat.split(ch).length - 1;
  return {
    w: def.rows[0]?.length ?? 0, h: def.rows.length,
    shards: n('o'), relics: n('R'), checkpoints: n('C'), crystals: n('D'), toggles: n('k'),
  };
}
