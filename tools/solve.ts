/**
 * Golden replay solver — finds a death-free clear of a story zone on the real
 * Sim and writes it to a solutions corpus.
 *
 *   npx tsx tools/solve.ts [zoneId...] [--budget=300] [--beam=40] [--random=8] [--seed=1] [--nohurt] [--force]
 *       → levels/solutions/<zoneId>.json — the FAST corpus (shortest clear found; regression net)
 *
 *   npx tsx tools/solve.ts --pace=1.025 --pace-tolerance=0.075 --no-dash-chain --out=levels/solutions/par [zoneId...]
 *       → levels/solutions/par/<zoneId>.json — the PACED corpus: a clear inside
 *         (pace ± tolerance) × par that looks like a competent human and feeds
 *         GOAL_ECHOES (the '목표' echo and the seeded '개발자' board entry)
 *
 * Without zone ids every zone in tower order is attempted (tidepool → storm →
 * void). Zones that already have a valid solution are skipped unless --force.
 * A zone the solver cannot clear within its budget is recorded in the corpus's
 * PENDING.json with the reason and the best progress reached; a solution file
 * is written only when a fresh Sim replays the masks to a clear with zero
 * deaths inside par × 1.2 (verifyReplay is the judge, never the search state).
 * In paced mode a zone whose clear lands outside the window keeps its closest
 * verified clear on disk AND stays in PENDING.json with the ratio it reached.
 *
 * Method: beam search over macro-actions (hold a direction, jump tap / hold,
 * timed and double jumps, 8-way dashes, jump→dash and dash→jump combos, stomp,
 * wait) in 16-tick time slices. Each beam entry keeps a live Sim; children are
 * forked by deep-cloning the Sim object graph (0.05 ms) rather than replaying
 * the prefix. The mulberry32 closure cannot be cloned, so the Sim's rng is
 * wrapped in a call counter and a clone gets a fresh generator advanced the
 * same number of times. The final verifyReplay from scratch is what makes this
 * safe: a clone that drifted could never pass it.
 *
 * Progress is a Dijkstra potential over (tile, switch polarity) from the goal
 * through passable cells: climbing costs 3× a horizontal step, spikes cost 40,
 * water 3, and the polarity may flip on a toggle cell — so switch gates route
 * through their toggle and a wall the player cannot jump is worth going
 * around. Deaths prune the branch; a lost hp is a heavy penalty.
 *
 * Pacing (--pace): the objective becomes "clear with |time − target| minimal".
 * A reference route (the fast corpus when current, else an unpaced solve of the
 * same zone) tells how many ticks a run needs to bring the potential down to
 * any value; the pause budget (target − reference) is spread over the first
 * 80 % of the route, a twentieth of it before the first step, and the last
 * 20 % is scheduled at reference speed so the finish lands on the target even
 * though the stretch before a goal rarely offers a place to stand. A node
 * ahead of that schedule may pause — only at a SAFE SPOT: grounded on rock (not
 * a moving platform, crumble or one-way ledge), not in water, no foe / saw
 * within 200 units, no bolt in flight, no tide — and must pause once it is a
 * lead (4–8 s) ahead; a pause (wait macros, mask 0) lasts until the schedule
 * catches up. Between pauses an ahead node has to make progress: three actions
 * without a potential gain, a shard or a switch flip drop it, so slack is never
 * burned by hopping in place or hanging on a wall. In the beam, being early
 * buys almost nothing (progress counts a twentieth within the lead and is a
 * cost past it), moving ahead-of-schedule nodes get few slots, pausing ones are
 * cheap and kept, and a clear that arrives before the window is discarded (kept
 * only as a fallback). --no-dash-chain charges every dash 8 tiles of potential,
 * so a dash survives only where running and jumping cannot progress; a jump
 * costs half a tile for the same reason; shards near the route earn a bonus.
 * The result is re-judged and, when the ratio misses the window, the target is
 * shifted by the miss and the search runs again inside the zone budget.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { INTRO_TICKS, Sim } from '../src/sim/sim.js';
import type { Level } from '../src/sim/level.js';
import { makeRng } from '../src/sim/rng.js';
import type { Rng } from '../src/sim/rng.js';
import { decodeMasks, encodeMasks, verifyReplay } from '../src/sim/replay.js';
import { IN, SIM_VERSION, TICK_HZ, TILE } from '../src/sim/types.js';
import type { InputMask, LevelDef } from '../src/sim/types.js';
import { CRUMBLE, ONE_WAY, SPIKES, SWITCH_A, SWITCH_B, WATER_BODY, WATER_SURFACE } from '../src/sim/legend.js';
import { ZONES } from '../levels/build.js';
import {
  PACE_WINDOW, SOLUTIONS_DIR, corpusDir, inPaceWindow, pendingPath, readPendingFile, readSolution, readSolutionFile, staleReason,
} from '../levels/solutions.js';
import type { Pending, PendingEntry, Solution } from '../levels/solutions.js';

// ---------------------------------------------------------------- files
function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Merge this process's verdicts into the corpus's PENDING.json: zones it solved
 * leave the file, zones it gave up on are recorded, everything else (another
 * solver run in parallel) is kept as found on disk.
 */
function writePending(dir: string, solved: Set<string>, given: Pending): void {
  const path = pendingPath(dir);
  const merged = readPendingFile(path);
  for (const id of solved) delete merged[id];
  Object.assign(merged, given);
  const sorted: Pending = {};
  for (const id of Object.keys(merged).sort()) sorted[id] = merged[id];
  writeJson(path, sorted);
}

// ---------------------------------------------------------------- forking a live Sim
/**
 * Structural deep clone preserving prototypes and aliasing (memo), skipping
 * `shared` immutable objects. Functions are returned as-is unless remapped in
 * `memo` (the rng closure).
 */
function deepClone<T>(v: T, memo: Map<object, unknown>, shared: Set<object>): T {
  if (v === null || (typeof v !== 'object' && typeof v !== 'function')) return v;
  const o = v as unknown as object;
  const hit = memo.get(o);
  if (hit !== undefined) return hit as T;
  if (typeof v === 'function' || shared.has(o)) return v;
  if (Array.isArray(o)) {
    const out: unknown[] = new Array(o.length);
    memo.set(o, out);
    for (let i = 0; i < o.length; i++) out[i] = deepClone(o[i], memo, shared);
    return out as unknown as T;
  }
  if (o instanceof Map) {
    const out = new Map<unknown, unknown>();
    memo.set(o, out);
    for (const [k, val] of o) out.set(k, deepClone(val, memo, shared));
    return out as unknown as T;
  }
  if (o instanceof Set) {
    const out = new Set<unknown>();
    memo.set(o, out);
    for (const val of o) out.add(deepClone(val, memo, shared));
    return out as unknown as T;
  }
  if (ArrayBuffer.isView(o)) {
    const out = (o as Uint8Array).slice();
    memo.set(o, out);
    return out as unknown as T;
  }
  const out = Object.create(Object.getPrototypeOf(o) as object | null) as Record<string, unknown>;
  memo.set(o, out);
  const src = o as Record<string, unknown>;
  for (const k of Object.keys(src)) out[k] = deepClone(src[k], memo, shared);
  return out as unknown as T;
}

/** A Sim plus the bookkeeping that makes it cloneable. */
class Fork {
  private calls: number;
  private constructor(readonly sim: Sim, private readonly seed: number, private readonly baseCalls: number, calls: number, private readonly shared: Set<object>) {
    this.calls = calls;
    this.install(sim.rng);
  }

  static fresh(def: LevelDef): Fork {
    const sim = new Sim(def, { seed: def.seed });
    // hoppers roll the rng once each at spawn, before we start counting
    const baseCalls = sim.level.spawns.filter((s) => s.ch === 'h').length;
    const shared = new Set<object>([def, sim.level.def, sim.level.grid, ...sim.level.grid, sim.level.spawns, ...sim.level.spawns]);
    return new Fork(sim, sim.seed, baseCalls, 0, shared);
  }

  /** Replace the sim's rng with a counting wrapper around `real`. */
  private install(real: Rng): void {
    const counting = (() => { this.calls++; return real(); }) as Rng;
    counting.int = (lo, hi) => lo + Math.floor(counting() * (hi - lo + 1));
    counting.chance = (p) => counting() < p;
    counting.pick = (arr) => arr[Math.floor(counting() * arr.length)];
    counting.range = (lo, hi) => lo + counting() * (hi - lo);
    (this.sim as { rng: Rng }).rng = counting;
  }

  clone(): Fork {
    const fresh = makeRng(this.seed);
    for (let i = 0; i < this.baseCalls + this.calls; i++) fresh();
    const memo = new Map<object, unknown>();
    memo.set(this.sim.rng, fresh);
    const sim = deepClone(this.sim, memo, this.shared);
    return new Fork(sim, this.seed, this.baseCalls, this.calls, this.shared);
  }
}

// ---------------------------------------------------------------- potential field
const BLOCKED = Number.POSITIVE_INFINITY;
/** Cost multiplier of a step the player would have to climb. */
const UP_COST = 3;
const SPIKE_COST = 40;
const WATER_COST = 3;
/**
 * Gravity, approximately: entering a cell costs its base cost plus the number
 * of empty cells between it and the support below (capped). Open air high
 * above a floor is therefore a poor route, ledges and shafts stay cheap, and a
 * beam that wall-jumped up the map edge into nothing reads as far from the goal
 * — which it is.
 */
const HEIGHT_CAP = 8;

/** Dijkstra distance (in tile-steps) to the goal for every (tile, polarity). */
class Potential {
  readonly w: number;
  readonly h: number;
  readonly dist: Float64Array;
  readonly goal: { tx: number; ty: number; x: number; y: number };
  /** Empty cells between a cell and the support below it, per polarity (0 = standing height). */
  private readonly height: Uint8Array;

  constructor(level: Level) {
    this.w = level.w; this.h = level.h;
    const n = this.w * this.h;
    this.dist = new Float64Array(n * 2).fill(BLOCKED);
    this.height = new Uint8Array(n * 2);
    const g = level.spawns.find((s) => s.ch === 'G');
    if (!g) throw new Error(`${level.id}: no goal`);
    this.goal = { tx: g.tx, ty: g.ty, x: g.x, y: g.ty * TILE + TILE };
    this.measureHeights(level);
    this.run(level);
  }

  /** Anything that stops a fall: rock, crumble, one-way, water, spikes, a solid switch block. */
  private support(level: Level, x: number, y: number, polA: boolean): boolean {
    if (y >= this.h) return false;
    if (x < 0 || x >= this.w || y < 0) return true;
    const ch = level.grid[y][x];
    if (ch === '#' || ch === CRUMBLE || ch === '=' || ch === WATER_SURFACE || ch === WATER_BODY || SPIKES.includes(ch)) return true;
    if (ch === SWITCH_A) return polA;
    if (ch === SWITCH_B) return !polA;
    return false;
  }

  private measureHeights(level: Level): void {
    const n = this.w * this.h;
    for (const pol of [0, 1]) {
      const polA = pol === 0;
      for (let x = 0; x < this.w; x++) {
        let run = HEIGHT_CAP;                      // below the map is the pit
        for (let y = this.h - 1; y >= 0; y--) {
          if (this.support(level, x, y, polA)) { run = 0; continue; }
          this.height[pol * n + y * this.w + x] = run;
          run = Math.min(HEIGHT_CAP, run + 1);
        }
      }
      // an updraft column carries the player: its cells are as good as a floor
      for (const s of level.spawns) {
        if (s.ch !== 'z') continue;
        const span = Math.max(3 * TILE, level.patrolSpan(s.tx, s.ty, 0, -1, 12) + TILE) / TILE;
        for (let y = s.ty; y > s.ty - span && y >= 0; y--) this.height[pol * n + y * this.w + s.tx] = 0;
      }
    }
  }

  private cellCost(level: Level, x: number, y: number, polA: boolean): number {
    if (x < 0 || x >= this.w || y < 0 || y >= this.h) return BLOCKED;
    const ch = level.grid[y][x];
    if (ch === '#' || ch === CRUMBLE) return BLOCKED;
    let base = 1;
    if (ch === SWITCH_A) { if (polA) return BLOCKED; }
    else if (ch === SWITCH_B) { if (!polA) return BLOCKED; }
    else if (SPIKES.includes(ch)) base = SPIKE_COST;
    else if (ch === WATER_SURFACE || ch === WATER_BODY) base = WATER_COST;
    return base + this.height[(polA ? 0 : this.w * this.h) + y * this.w + x];
  }

  private run(level: Level): void {
    const n = this.w * this.h;
    const toggles = new Set<number>();
    for (const s of level.spawns) if (s.ch === 'k') toggles.add(s.ty * this.w + s.tx);
    // binary heap of [dist, key]
    const heap: [number, number][] = [];
    const push = (d: number, k: number) => {
      heap.push([d, k]);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p][0] <= heap[i][0]) break;
        [heap[p], heap[i]] = [heap[i], heap[p]];
        i = p;
      }
    };
    const pop = (): [number, number] => {
      const top = heap[0];
      const last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1, r = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]];
          i = m;
        }
      }
      return top;
    };
    const gk = this.goal.ty * this.w + this.goal.tx;
    for (const pol of [0, 1]) { this.dist[pol * n + gk] = 0; push(0, pol * n + gk); }
    const DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    while (heap.length) {
      const [d, key] = pop();
      if (d > this.dist[key]) continue;
      const pol = key >= n ? 1 : 0;
      const c = key - pol * n;
      const x = c % this.w, y = (c - x) / this.w;
      const polA = pol === 0;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx, ny = y + dy;
        const base = this.cellCost(level, nx, ny, polA);
        if (base === BLOCKED) continue;
        // the player would move from (nx, ny) into (x, y): climbing when the neighbour lies below
        const step = base * (dy > 0 ? UP_COST : 1);
        const nk = pol * n + ny * this.w + nx;
        if (d + step < this.dist[nk]) { this.dist[nk] = d + step; push(d + step, nk); }
      }
      if (toggles.has(c)) {
        const fk = (1 - pol) * n + c;
        if (d + 1 < this.dist[fk]) { this.dist[fk] = d + 1; push(d + 1, fk); }
      }
    }
  }

  at(tx: number, ty: number, polA: boolean): number {
    if (tx < 0 || tx >= this.w || ty < 0 || ty >= this.h) return BLOCKED;
    return this.dist[(polA ? 0 : this.w * this.h) + ty * this.w + tx];
  }

  /** World-unit potential of a player centre: tile distance × 16 plus the way to the best next tile centre. */
  value(cx: number, cy: number, polA: boolean): number {
    const tx = Math.floor(cx / TILE), ty = Math.floor(cy / TILE);
    let d = this.at(tx, ty, polA);
    if (d === BLOCKED) {
      // centre inside rock (corner correction mid-step) — read the feet / head tiles instead
      d = Math.min(this.at(tx, ty + 1, polA), this.at(tx, ty - 1, polA));
      if (d === BLOCKED) return 1e6;
    }
    let best = d, bx = tx, by = ty;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nd = this.at(tx + dx, ty + dy, polA);
      if (nd < best) { best = nd; bx = tx + dx; by = ty + dy; }
    }
    if (best === d) return d * TILE + Math.hypot(cx - this.goal.x, cy - (this.goal.y - TILE / 2));
    return best * TILE + Math.hypot(cx - (bx * TILE + TILE / 2), cy - (by * TILE + TILE / 2));
  }
}

// ---------------------------------------------------------------- macro-actions
/** Every action length is a multiple of the slice so children always land in a later slice. */
const SLICE = 16;

interface Action {
  dir: -1 | 0 | 1;
  /** JUMP press offsets (ticks) and how long each press is held. */
  jumps: number[];
  jumpHold: number;
  dash: { at: number; dx: -1 | 0 | 1; dy: -1 | 0 | 1 } | null;
  down: boolean;
  len: number;
}

function act(dir: -1 | 0 | 1, len: number, o: Partial<Omit<Action, 'dir' | 'len'>> = {}): Action {
  return { dir, len, jumps: o.jumps ?? [], jumpHold: o.jumpHold ?? 12, dash: o.dash ?? null, down: o.down ?? false };
}

const DASH_DIRS: [-1 | 0 | 1, -1 | 0 | 1][] = [[1, 0], [-1, 0], [0, -1], [1, -1], [-1, -1], [1, 1], [-1, 1]];

/** The fixed part of every expansion: ~40 actions covering the sim's whole verb set. */
function fixedActions(): Action[] {
  const A: Action[] = [];
  for (const dir of [1, -1] as const) { A.push(act(dir, 16), act(dir, 48)); }
  A.push(act(0, 16), act(0, 48));
  for (const dir of [-1, 0, 1] as const) {
    A.push(act(dir, 32, { jumps: [0], jumpHold: 5 }));
    A.push(act(dir, 32, { jumps: [0], jumpHold: 28 }));
  }
  for (const dir of [-1, 1] as const) for (const at of [8, 16, 24]) A.push(act(dir, 32, { jumps: [at], jumpHold: 12 }));
  for (const dir of [-1, 1] as const) for (const k of [14, 24, 34]) A.push(act(dir, 48, { jumps: [0, k], jumpHold: 12 }));
  for (const [dx, dy] of DASH_DIRS) A.push(act(dx, 32, { dash: { at: 0, dx, dy } }));
  for (const dir of [-1, 1] as const) {
    A.push(act(dir, 48, { jumps: [0], jumpHold: 10, dash: { at: 14, dx: dir, dy: 0 } }));
    A.push(act(dir, 48, { jumps: [0], jumpHold: 10, dash: { at: 14, dx: dir, dy: -1 } }));
    A.push(act(dir, 48, { dash: { at: 0, dx: dir, dy: 0 }, jumps: [20], jumpHold: 14 }));
    A.push(act(dir, 48, { jumps: [0, 20], jumpHold: 10, dash: { at: 34, dx: dir, dy: 0 } }));
  }
  A.push(act(0, 32, { down: true }), act(1, 32, { down: true }), act(-1, 32, { down: true }));
  return A;
}

/**
 * The compact set an ahead-of-schedule runner expands with (paced search): it
 * is on a corridor the reference already proved, so breadth is worth less than
 * the time — half the verbs, the ones a person actually uses.
 */
function compactActions(): Action[] {
  const A: Action[] = [];
  for (const dir of [1, -1] as const) { A.push(act(dir, 16), act(dir, 48)); }
  A.push(act(0, 16), act(0, 48));
  for (const dir of [-1, 0, 1] as const) {
    A.push(act(dir, 32, { jumps: [0], jumpHold: 5 }));
    A.push(act(dir, 32, { jumps: [0], jumpHold: 28 }));
  }
  for (const dir of [-1, 1] as const) {
    A.push(act(dir, 32, { jumps: [16], jumpHold: 12 }));
    A.push(act(dir, 48, { jumps: [0, 24], jumpHold: 12 }));
    A.push(act(dir, 48, { jumps: [0], jumpHold: 10, dash: { at: 14, dx: dir, dy: 0 } }));
  }
  for (const [dx, dy] of DASH_DIRS.slice(0, 5)) A.push(act(dx, 32, { dash: { at: 0, dx, dy } }));
  A.push(act(0, 32, { down: true }), act(1, 32, { down: true }));
  return A;
}

function randomAction(rng: Rng): Action {
  const dir = ([-1, 0, 1] as const)[rng.int(0, 2)];
  const len = SLICE * rng.int(1, 4);
  const jumps: number[] = [];
  const nj = rng.int(0, 2);
  for (let i = 0; i < nj; i++) jumps.push(rng.int(0, len - 4));
  jumps.sort((a, b) => a - b);
  const dash = rng.chance(0.35) ? { at: rng.int(0, len - 4), ...(() => { const [dx, dy] = DASH_DIRS[rng.int(0, DASH_DIRS.length - 1)]; return { dx, dy }; })() } : null;
  return { dir, len, jumps, jumpHold: rng.int(4, 30), dash, down: rng.chance(0.08) };
}

/** Expand an action into per-tick masks. */
function masksOf(a: Action): Uint8Array {
  const out = new Uint8Array(a.len);
  const dirBit = a.dir > 0 ? IN.RIGHT : a.dir < 0 ? IN.LEFT : 0;
  for (let t = 0; t < a.len; t++) {
    let m: InputMask = dirBit;
    for (const j of a.jumps) if (t >= j && t < j + a.jumpHold) m |= IN.JUMP;
    if (a.dash && t >= a.dash.at && t < a.dash.at + 3) {
      m |= IN.DASH;
      m &= ~(IN.LEFT | IN.RIGHT | IN.UP | IN.DOWN);
      if (a.dash.dx > 0) m |= IN.RIGHT; else if (a.dash.dx < 0) m |= IN.LEFT;
      if (a.dash.dy < 0) m |= IN.UP; else if (a.dash.dy > 0) m |= IN.DOWN;
    } else if (a.down) {
      m |= IN.DOWN;
    }
    out[t] = m;
  }
  return out;
}

// ---------------------------------------------------------------- pacing
/** Fraction of the potential range (from the goal) traversed without pauses: the run ends at full tilt. */
const PACE_TAIL = 0.2;
/** Share of the pause budget spent before the first step (a human reads the hint). */
const PACE_START = 0.05;
/** Within its lead an ahead-of-schedule node's progress counts this fraction (being early buys little). */
const PACE_TIEBREAK = 0.05;
/** Past its lead every further tick ahead costs this much potential: the least-early such nodes are kept. */
const PACE_OVERRUN = 0.02;
/** Behind-schedule nodes kept once the ahead-of-schedule part of the beam is this wide (stragglers stop mattering). */
const BEHIND_CAP = 4;
const AHEAD_ENOUGH = 12;
/** Progress smaller than this (world units) does not count as progress. */
const PROGRESS_MIN = TILE * 0.75;
/** An ahead-of-schedule node that spent this many consecutive actions without progress (and is not pausing) was dawdling: dropped. */
const DAWDLE_MAX = 3;
/** Seconds ahead of schedule a node may run before it pauses (the lead shrinks to 0 before the tail): a share of the pause budget, clamped. */
const PACE_LEAD_FRAC = 0.15;
const PACE_LEAD_MIN_SEC = 4;
const PACE_LEAD_MAX_SEC = 8;
/** Beam slots for ahead-of-schedule nodes that are still moving: slack makes breadth cheap to give up. */
const RUNNER_CAP = 8;
/** Of those, slots for nodes past their lead that cannot pause where they are (mid-air, near a foe). */
const AHEAD_QUOTA = 4;
/** Longest single wait macro (ticks); a pause longer than this is several macros. */
const WAIT_CAP = 256;
/** No foe, saw or bolt within this many world units of a pause. */
const SAFE_RADIUS = 200;
/** --no-dash-chain: potential charged per dash (cumulative), in world units. */
export const DASH_PENALTY = TILE * 8;
/** Paced runs: potential credited per shard, in world units. */
export const SHARD_BONUS = TILE * 1.5;
/** Paced runs: potential charged per jump (cumulative) — a human runs on the ground and jumps where the geometry asks. */
export const JUMP_PENALTY = TILE * 0.5;

export interface PaceSpec {
  /** Total ticks (intro included) the run should take. */
  targetTicks: number;
  /** A clear before this tick (intro included) is too fast: the branch is dropped, the run kept only as a fallback. */
  minTicks: number;
  /** Reference route: the tick at which an unpaced clear first brought the potential down to p (non-increasing in p). */
  refTicks: (p: number) => number;
  /** Ticks of the whole reference route. */
  refTotal: number;
  /** Ticks ahead of schedule a node may run before it pauses. */
  leadTicks: number;
}

/**
 * When the paced run should be where. The pause budget W = target − reference
 * is spent PACE_START up front and the rest uniformly over the potential range
 * [pot0, pot0 × PACE_TAIL]; the tail is run at reference speed so the finish
 * lands on the target even though the last stretch to the goal rarely has a
 * place to stand still.
 */
export class Schedule {
  readonly wait: number;
  private readonly pTail: number;
  constructor(private readonly spec: PaceSpec, readonly pot0: number) {
    this.wait = Math.max(0, spec.targetTicks - spec.refTotal);
    this.pTail = pot0 * PACE_TAIL;
  }

  /** Tick at which the schedule has the run at potential p. */
  at(p: number): number {
    const span = this.pot0 - this.pTail;
    const frac = span > 0 ? Math.min(1, Math.max(0, (this.pot0 - p) / span)) : 1;
    return this.wait * (PACE_START + (1 - PACE_START) * frac) + this.spec.refTicks(p);
  }

  /** Potential the schedule has at `tick`; a node below it is ahead. */
  potAt(tick: number): number {
    if (tick <= this.at(this.pot0)) return this.pot0;
    if (tick >= this.at(0)) return 0;
    let lo = 0, hi = this.pot0;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (this.at(mid) > tick) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  /**
   * Ticks a node at potential p may be ahead before it pauses: the full lead
   * over the first 60 % of the route, shrinking to 0 at the tail so the run
   * enters its last stretch on schedule.
   */
  lead(p: number): number {
    if (this.pTail <= 0) return this.spec.leadTicks;
    return this.spec.leadTicks * Math.min(1, Math.max(0, (p - this.pTail) / this.pTail));
  }

  /** Ticks a node is ahead of schedule (negative = behind). */
  ahead(pot: number, tick: number): number { return this.at(pot) - tick; }
}

/**
 * Where a human would stand still: grounded on rock (not a moving platform, a
 * crumble or a one-way ledge), not in water or on a wall, unhurt, no foe or saw
 * within SAFE_RADIUS, no bolt in flight, and never in a tide zone.
 */
export function isSafeSpot(sim: Sim): boolean {
  if (sim.def.tide) return false;
  const st = sim.state;
  const p = st.player;
  if (!p.grounded || p.dead || p.inWater || p.onWall !== 0 || p.dashT > 0 || p.hp < 3 || p.invuln > 0) return false;
  const L = sim.level;
  const feet = p.y + p.h;
  const fy = Math.floor((feet + 0.6) / TILE);
  let rock = false;
  for (const px of [p.x + 1.5, p.x + p.w / 2, p.x + p.w - 1.5]) {
    const ch = L.at(Math.floor(px / TILE), fy);
    if (ch === CRUMBLE || ch === ONE_WAY) return false;
    if (L.solid(Math.floor(px / TILE), fy)) rock = true;
  }
  if (!rock) return false;   // standing on nothing solid → a platform deck
  const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
  for (const e of st.entities) {
    if (e.kind === 'platH' || e.kind === 'platV') {
      if (Math.abs(e.y - feet) < 10 && p.x + p.w > e.x - e.w / 2 - 2 && p.x < e.x + e.w / 2 + 2) return false;
    } else if (e.kind === 'saw' && e.alive) {
      if (Math.hypot(e.x - cx, e.y - cy) < SAFE_RADIUS) return false;
    }
  }
  for (const f of st.foes) {
    if (f.dead) continue;
    if (Math.hypot(f.x - cx, f.y - cy) < SAFE_RADIUS) return false;
  }
  if (st.bolts.length) return false;
  return true;
}

/** The reference route for a PaceSpec: replay `masks` and note when the potential first dropped to each level. */
export function referenceFrom(def: LevelDef, masks: Uint8Array): { refTicks: (p: number) => number; refTotal: number; pot0: number } {
  const sim = new Sim(def, { seed: def.seed });
  const pot = new Potential(sim.level);
  const value = () => { const p = sim.state.player; return pot.value(p.x + p.w / 2, p.y + p.h / 2, sim.state.switchA); };
  const runMin: number[] = [value()];
  let m = runMin[0];
  for (let i = 0; i < masks.length && !sim.finished; i++) {
    sim.step(masks[i]);
    m = Math.min(m, value());
    runMin.push(m);
  }
  const total = runMin.length - 1;
  const refTicks = (p: number): number => {
    if (runMin[0] <= p) return 0;
    if (runMin[total] > p) return total;
    let lo = 0, hi = total;   // first index whose running minimum is ≤ p
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (runMin[mid] <= p) hi = mid; else lo = mid + 1;
    }
    return lo;
  };
  return { refTicks, refTotal: total, pot0: runMin[0] };
}

// ---------------------------------------------------------------- search
interface Node {
  fork: Fork | null;
  parent: Node | null;
  masks: Uint8Array | null;
  tick: number;
  score: number;
  pot: number;
  /** Paced search: this node is in a pause and keeps pausing while ahead of schedule. */
  waiting: boolean;
  /** Lowest potential the lineage has reached. */
  gain: number;
  /** Consecutive actions without progress (no potential gain, no shard, no switch flip); pauses reset it. */
  idle: number;
}

export interface SolveOptions {
  /** Wall-clock budget in seconds. */
  budgetSec: number;
  beam: number;
  /** Extra random actions per expansion. */
  random: number;
  seed: number;
  /** Prune branches that lost hp (a clean run for the goal echo) instead of only penalising them. */
  noHurt?: boolean;
  /** Potential charged per dash, cumulative (--no-dash-chain → DASH_PENALTY). 0 = dashes are free. */
  dashPenalty?: number;
  /** Potential credited per shard collected. */
  shardBonus?: number;
  /** Potential charged per jump (ground, air and wall jumps), cumulative. */
  jumpPenalty?: number;
  /** Paced search (see Schedule); undefined = shortest clear. */
  pace?: PaceSpec;
  log?: (line: string) => void;
}

export interface SolveResult {
  ok: boolean;
  masks: Uint8Array | null;
  reason: string;
  best: PendingEntry['best'];
  elapsedSec: number;
  slices: number;
  /** Paced search: the latest clear that was still too fast (a fallback when no paced clear arrives). */
  early: Uint8Array | null;
}

const HURT_PENALTY = TILE * 12;

function dedupKey(sim: Sim): string {
  const p = sim.state.player;
  const tx = Math.floor((p.x + p.w / 2) / TILE), ty = Math.floor((p.y + p.h / 2) / TILE);
  return `${tx},${ty},${p.grounded ? 1 : 0},${p.onWall},${p.jumps},${p.dashReady ? 1 : 0},${sim.state.switchA ? 1 : 0},${p.hp},${Math.sign(p.vx)},${p.vy < -40 ? -1 : p.vy > 40 ? 1 : 0}`;
}

function collectMasks(node: Node): Uint8Array {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (let n: Node | null = node; n; n = n.parent) if (n.masks) { parts.push(n.masks); total += n.masks.length; }
  const out = new Uint8Array(total);
  let p = 0;
  for (let i = parts.length - 1; i >= 0; i--) { out.set(parts[i], p); p += parts[i].length; }
  return out;
}

/** Wait macros for a node `ahead` ticks ahead of schedule: the whole gap (capped) and half of it. */
function waitActions(ahead: number): Action[] {
  const full = Math.max(SLICE, Math.min(WAIT_CAP, Math.ceil(ahead / SLICE) * SLICE));
  const out = [act(0, full)];
  const half = Math.floor(full / 2 / SLICE) * SLICE;
  if (half >= SLICE && half !== full) out.push(act(0, half));
  return out;
}

/** Search for a death-free clear. Returns the raw masks (trimmed at the finishing tick) when found. */
export function solve(def: LevelDef, opts: SolveOptions): SolveResult {
  const log = opts.log ?? (() => {});
  const t0 = performance.now();
  const deadline = t0 + opts.budgetSec * 1000;
  const root = Fork.fresh(def);
  const pot = new Potential(root.sim.level);
  const fixed = fixedActions();
  const compact = compactActions();
  const rng = makeRng(opts.seed);
  const dashPenalty = opts.dashPenalty ?? 0;
  const shardBonus = opts.shardBonus ?? 0;
  const jumpPenalty = opts.jumpPenalty ?? 0;

  const slices = new Map<number, Node[]>();
  const put = (n: Node) => {
    const k = Math.floor(n.tick / SLICE);
    const list = slices.get(k);
    if (list) list.push(n); else slices.set(k, [n]);
  };
  const p0 = root.sim.state.player;
  const pot0 = pot.value(p0.x + p0.w / 2, p0.y + p0.h / 2, true);
  const sched = opts.pace ? new Schedule(opts.pace, pot0) : null;
  put({ fork: root, parent: null, masks: null, tick: 0, score: pot0, pot: pot0, waiting: false, gain: pot0, idle: 0 });

  let best: SolveResult['best'] = null;
  let bestPot = Number.POSITIVE_INFINITY;
  let lastImprove = 0;
  let sliceIdx = 0;
  let processed = 0;
  let reason = '';
  let early: Node | null = null;
  let earlyCount = 0;
  const maxTick = Math.min(def.par * 1.2 * TICK_HZ + INTRO_TICKS, TICK_HZ * 600);
  // a paced frontier legitimately stands still for most of the run: progress is judged against the schedule instead
  const stuckSlices = 600 + (opts.pace ? Math.ceil(opts.pace.targetTicks / SLICE) : 0);

  for (;;) {
    if (performance.now() > deadline) { reason = `budget of ${opts.budgetSec}s exhausted`; break; }
    if (sliceIdx * SLICE > maxTick) { reason = `no clear within par × 1.2 (${Math.round(maxTick)} ticks)`; break; }
    if (sliceIdx - lastImprove > stuckSlices) { reason = `stuck: no progress for ${(stuckSlices * SLICE) / TICK_HZ} s of sim time`; break; }
    const list = slices.get(sliceIdx);
    slices.delete(sliceIdx);
    sliceIdx++;
    if (!list || list.length === 0) {
      if (slices.size === 0) { reason = earlyCount ? `beam died out (${earlyCount} clears arrived before the window, every other branch was fatal)` : 'beam died out (every branch was fatal)'; break; }
      continue;
    }
    processed++;
    // dedup by coarse state key, keep the best per key, then the beam
    const byKey = new Map<string, Node>();
    for (const n of list) {
      const k = dedupKey(n.fork!.sim);
      const cur = byKey.get(k);
      if (!cur || n.score < cur.score) byKey.set(k, n);
    }
    const ranked = [...byKey.values()].sort((a, b) => a.score - b.score);
    let beam: Node[];
    if (sched) {
      // ahead-of-schedule nodes that are still moving get a few slots (fewer still once past their lead) and, once
      // the ahead part of the beam is wide enough, stragglers behind the schedule get a few as well; pausing nodes
      // are cheap and stay
      beam = [];
      let runners = 0, past = 0, aheadN = 0;
      const behind: Node[] = [];
      for (const n of ranked) {
        if (beam.length >= opts.beam) break;
        const ahead = sched.ahead(n.pot, n.tick);
        if (ahead <= 0) { behind.push(n); continue; }
        aheadN++;
        if (!n.waiting) {
          const late = ahead > sched.lead(n.pot);
          if (runners >= RUNNER_CAP || (late && past >= AHEAD_QUOTA)) continue;
          runners++;
          if (late) past++;
        }
        beam.push(n);
      }
      const room = opts.beam - beam.length;
      beam.push(...behind.slice(0, aheadN >= AHEAD_ENOUGH ? Math.min(room, BEHIND_CAP) : room));
    } else {
      beam = ranked.slice(0, opts.beam);
    }
    // a few random survivors keep the search from collapsing onto one ledge
    const rest = [...byKey.values()].filter((n) => !beam.includes(n));
    for (let i = 0; i < (sched ? 2 : 4) && rest.length; i++) beam.push(rest.splice(rng.int(0, rest.length - 1), 1)[0]);
    for (const n of list) if (!beam.includes(n)) n.fork = null;

    if (processed % 25 === 0) {
      const b = beam[0];
      const p = b.fork!.sim.state.player;
      let pace = '';
      if (sched) {
        const pausing = beam.filter((n) => n.waiting).length;
        const behind = beam.filter((n) => sched.ahead(n.pot, n.tick) <= 0).length;
        pace = ` ahead ${((sched.at(b.pot) - b.tick) / TICK_HZ).toFixed(1)}s${b.waiting ? ' (pausing)' : ''} · ${pausing} pausing, ${beam.length - pausing - behind} running, ${behind} behind`;
      }
      log(`  slice ${sliceIdx} tick ${b.tick} pot ${(b.pot / TILE).toFixed(1)} tiles at (${Math.floor((p.x + p.w / 2) / TILE)},${Math.floor((p.y + p.h / 2) / TILE)}) beam ${beam.length}${pace} · ${((performance.now() - t0) / 1000).toFixed(0)}s`);
    }

    let solved: Node | null = null;
    for (const node of beam) {
      const parentFork = node.fork!;
      // paced: an ahead-of-schedule node at a safe spot may pause — and must, once past its lead or already pausing
      // (a pause lasts until the schedule catches up); the first `waits` actions of the list are pauses
      let actions: Action[];
      let waits = 0;
      let parentAhead = 0;
      const parentShards = parentFork.sim.state.stats.shards;
      const parentSwitch = parentFork.sim.state.switchA;
      if (sched) {
        parentAhead = sched.ahead(node.pot, node.tick);
        const safe = parentAhead > 0 && isSafeSpot(parentFork.sim);
        if (safe && (node.waiting || parentAhead > sched.lead(node.pot))) {
          actions = waitActions(parentAhead);
          waits = actions.length;
        } else if (safe) {
          actions = waitActions(parentAhead);
          waits = actions.length;
          actions.push(...compact);
        } else {
          actions = parentAhead > 0 ? compact.slice() : fixed.slice();
        }
      } else {
        actions = fixed.slice();
      }
      // random actions widen the search where it is needed: behind the schedule (an ahead runner is on a known route)
      if (parentAhead <= 0) for (let i = 0; i < opts.random; i++) actions.push(randomAction(rng));
      for (let ai = 0; ai < actions.length; ai++) {
        const a = actions[ai];
        const waiting = ai < waits;
        const fork = ai === actions.length - 1 ? parentFork : parentFork.clone();
        const sim = fork.sim;
        const masks = masksOf(a);
        let used = a.len;
        let dead = false;
        for (let t = 0; t < a.len; t++) {
          sim.step(masks[t]);
          if (sim.state.stats.deaths > 0 || sim.state.player.dead) { dead = true; break; }
          if (sim.finished) { used = t + 1; break; }
        }
        sim.drainEvents();
        if (dead) continue;
        if (opts.noHurt && sim.state.player.hp < 3) continue;
        const p = sim.state.player;
        const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
        const v = pot.value(cx, cy, sim.state.switchA);
        const tick = node.tick + used;
        const progress = v < node.gain - PROGRESS_MIN || sim.state.stats.shards !== parentShards || sim.state.switchA !== parentSwitch;
        const idle = waiting || progress ? 0 : node.idle + 1;
        // behind schedule: rank by potential as usual. Ahead of it a node either progresses or pauses — one that did
        // neither for DAWDLE_MAX actions was killing time in the air and is dropped; within the lead progress counts
        // a twentieth, past the lead the further ahead the worse (the slots go to nodes that just crossed it)
        let base = v;
        if (sched) {
          const P = sched.potAt(tick);
          if (v < P) {
            if (idle >= DAWDLE_MAX && !sim.finished) continue;
            const over = sched.ahead(v, tick) - sched.lead(v);
            base = over > 0 ? P + PACE_OVERRUN * over : P - PACE_TIEBREAK * (P - v);
          }
        }
        const st = sim.state.stats;
        const score = base + HURT_PENALTY * (3 - p.hp) + dashPenalty * st.dashes + jumpPenalty * (st.jumps + st.wallJumps) - shardBonus * st.shards;
        const child: Node = {
          fork, parent: node, masks: used === a.len ? masks : masks.slice(0, used), tick, score, pot: v, waiting,
          gain: Math.min(node.gain, v), idle,
        };
        if (sim.finished) {
          if (sim.summary().cleared && sim.state.stats.deaths === 0) {
            if (opts.pace && tick < opts.pace.minTicks) {
              // too fast for the window: remember the closest such clear, drop the branch
              earlyCount++;
              if (!early || tick > early.tick) early = child;
              continue;
            }
            solved = child;
            break;
          }
          continue;
        }
        if (v < bestPot) {
          bestPot = v;
          lastImprove = sliceIdx;
          best = { distTiles: Math.round(v / TILE * 10) / 10, tile: [Math.floor(cx / TILE), Math.floor(cy / TILE)], tick: child.tick };
        }
        put(child);
      }
      node.fork = null;
      if (solved) break;
    }
    if (solved) {
      const masks = collectMasks(solved);
      return { ok: true, masks, reason: 'cleared', best, elapsedSec: (performance.now() - t0) / 1000, slices: processed, early: early ? collectMasks(early) : null };
    }
  }
  return { ok: false, masks: null, reason, best, elapsedSec: (performance.now() - t0) / 1000, slices: processed, early: early ? collectMasks(early) : null };
}

// ---------------------------------------------------------------- verification + files
export interface Judged { ok: boolean; why?: string; summary: ReturnType<Sim['summary']>; ratio: number; dashes: number }

/** The only judge: a fresh Sim replays the masks and must clear with 0 deaths inside par × 1.2. */
export function judge(def: LevelDef, masks: Uint8Array): Judged {
  const v = verifyReplay(def, { v: SIM_VERSION, levelId: def.id, seed: def.seed, assist: false, masks });
  const s = v.summary;
  const ratio = s.time / def.par;
  // dashes are not part of the summary; count them on a second fresh run
  const sim = new Sim(def, { seed: def.seed });
  for (let i = 0; i < masks.length && !sim.finished; i++) sim.step(masks[i]);
  const dashes = sim.state.stats.dashes;
  if (!v.ok) return { ok: false, why: v.reason, summary: s, ratio, dashes };
  if (!s.cleared) return { ok: false, why: 'not cleared', summary: s, ratio, dashes };
  if (s.deaths !== 0) return { ok: false, why: `${s.deaths} deaths`, summary: s, ratio, dashes };
  if (s.time > def.par * 1.2) return { ok: false, why: `time ${s.time.toFixed(2)} > par × 1.2`, summary: s, ratio, dashes };
  return { ok: true, summary: s, ratio, dashes };
}

/** A stored solution is current when it targets this sim, this geometry and this seed and still judges ok. */
export function solutionCurrent(def: LevelDef, sol: Solution | null): boolean {
  if (!sol || staleReason(def, sol) !== null) return false;
  try {
    return judge(def, decodeMasks(sol.masks)).ok;
  } catch {
    return false;
  }
}

/** A paced solution is current when it judges ok and its ratio lies inside the window. */
export function pacedSolutionCurrent(def: LevelDef, sol: Solution | null, window: { lo: number; hi: number }): boolean {
  if (!sol || staleReason(def, sol) !== null) return false;
  try {
    const j = judge(def, decodeMasks(sol.masks));
    return j.ok && inPaceWindow(j.ratio, window);
  } catch {
    return false;
  }
}

function solutionOf(def: LevelDef, masks: Uint8Array, j: Judged, now: string): Solution {
  return {
    levelId: def.id, sim: SIM_VERSION, rev: def.rev ?? 0, seed: def.seed, masks: encodeMasks(masks),
    ticks: j.summary.ticks, time: Math.round(j.summary.time * 1000) / 1000, shards: j.summary.shards, deaths: j.summary.deaths,
    recordedAt: now,
  };
}

/** Where a run lands relative to par, for the log. */
function pct(ratio: number): string { return `${(ratio * 100).toFixed(0)}%`; }

interface ZoneCtx {
  /** Corpus directory the files go to. */
  dir: string;
  solved: Set<string>;
  pending: Pending;
  log: (s: string) => void;
}

function solveZone(def: LevelDef, opts: SolveOptions, ctx: ZoneCtx): boolean {
  const { log, pending, solved } = ctx;
  log(`${def.id} ${def.name} — par ${def.par}s, budget ${opts.budgetSec}s, beam ${opts.beam}${opts.dashPenalty ? ', dash penalty on' : ''}`);
  const res = solve(def, { ...opts, log });
  const now = new Date().toISOString();
  if (res.ok && res.masks) {
    const j = judge(def, res.masks);
    if (j.ok) {
      const sol = solutionOf(def, res.masks, j, now);
      writeJson(join(ctx.dir, `${def.id}.json`), sol);
      solved.add(def.id);
      delete pending[def.id];
      log(`  ✓ ${def.id} cleared in ${j.summary.time.toFixed(2)}s (par ${def.par}, ${pct(j.ratio)}), ${j.summary.shards}/${j.summary.totalShards} shards, ${j.dashes} dashes, ${res.masks.length} masks → ${sol.masks.length} chars, ${res.elapsedSec.toFixed(0)}s search`);
      return true;
    }
    res.reason = `search claimed a clear but a fresh replay disagrees: ${j.why}`;
  }
  pending[def.id] = { reason: res.reason, best: res.best, budgetSec: opts.budgetSec, recordedAt: now };
  log(`  ✗ ${def.id}: ${res.reason} (best ${res.best ? `${res.best.distTiles} tiles from the goal at (${res.best.tile.join(',')}) tick ${res.best.tick}` : 'none'}, ${res.elapsedSec.toFixed(0)}s)`);
  return false;
}

export interface PaceOptions {
  /** Target time as a multiple of par. */
  pace: number;
  /** Accepted |ratio − pace|. */
  tolerance: number;
  /** Most paced passes per zone inside the budget. */
  passes: number;
}

interface Candidate { masks: Uint8Array; judged: Judged }

/** Distance of a ratio from the accepted window (0 inside). */
function windowMiss(ratio: number, w: { lo: number; hi: number }): number {
  return ratio < w.lo ? w.lo - ratio : ratio > w.hi ? ratio - w.hi : 0;
}

/**
 * Paced solve: a reference route first (an unpaced no-dash-chain clear, or the
 * fast corpus when the search fails), then up to `passes` paced searches whose
 * target is shifted by each miss. The closest verified clear is written; the
 * zone stays in PENDING.json unless a pass landed inside the window.
 */
function solveZonePaced(def: LevelDef, opts: SolveOptions, pace: PaceOptions, ctx: ZoneCtx): boolean {
  const { log, pending, solved } = ctx;
  const window = { lo: pace.pace - pace.tolerance, hi: pace.pace + pace.tolerance };
  const t0 = performance.now();
  const remaining = () => opts.budgetSec - (performance.now() - t0) / 1000;
  const now = () => new Date().toISOString();
  log(`${def.id} ${def.name} — par ${def.par}s, target ${pct(pace.pace)} (${pct(window.lo)}–${pct(window.hi)}), budget ${opts.budgetSec}s, beam ${opts.beam}`);

  // ---- reference route: how long a run needs from any point. The fast corpus when it is current (free), else a search.
  const candidates: Candidate[] = [];
  let ref: ReturnType<typeof referenceFrom> | null = null;
  let refWhy = '';
  {
    const fast = readSolution(def.id, 'fast');
    if (fast && solutionCurrent(def, fast)) {
      ref = referenceFrom(def, decodeMasks(fast.masks));
      refWhy = `fast corpus (${fast.time.toFixed(2)}s)`;
    } else {
      const budget = Math.min(45, opts.budgetSec * 0.25);
      const res = solve(def, { ...opts, budgetSec: budget, noHurt: true, pace: undefined, log });
      if (res.ok && res.masks) {
        const j = judge(def, res.masks);
        if (j.ok) {
          candidates.push({ masks: res.masks, judged: j });
          ref = referenceFrom(def, res.masks);
          refWhy = `own route (${j.summary.time.toFixed(2)}s, ${j.dashes} dashes)`;
        }
      }
      if (!ref) {
        pending[def.id] = { reason: `no reference route: ${res.reason}`, best: res.best, budgetSec: opts.budgetSec, recordedAt: now() };
        log(`  ✗ ${def.id}: no reference route (${res.reason})`);
        return false;
      }
    }
    log(`  reference: ${refWhy}, ${((performance.now() - t0) / 1000).toFixed(0)}s`);
  }

  // ---- paced passes
  let targetTicks = Math.round(pace.pace * def.par * TICK_HZ) + INTRO_TICKS;
  const maxTarget = Math.round(def.par * 1.18 * TICK_HZ) + INTRO_TICKS;
  let seed = opts.seed;
  let lastReason = '';
  let hit: Candidate | null = null;
  for (let pass = 1; pass <= pace.passes && !hit; pass++) {
    const left = remaining();
    if (left < 10) { lastReason = 'budget exhausted before another pass'; break; }
    // the first pass usually lands inside the window: give it most of the budget (more for a long zone, whose
    // search is proportionally longer), the retargeting passes the rest
    const share = targetTicks / SLICE > 600 ? 0.8 : 0.65;
    const budget = pass === 1 && pace.passes > 1 ? left * share : left;
    const pauseSec = Math.max(0, targetTicks - ref.refTotal) / TICK_HZ;
    const leadSec = Math.min(PACE_LEAD_MAX_SEC, Math.max(PACE_LEAD_MIN_SEC, pauseSec * PACE_LEAD_FRAC));
    const spec: PaceSpec = {
      targetTicks, minTicks: Math.round(window.lo * def.par * TICK_HZ) + INTRO_TICKS,
      refTicks: ref.refTicks, refTotal: ref.refTotal, leadTicks: Math.round(leadSec * TICK_HZ),
    };
    log(`  pass ${pass}: target ${((targetTicks - INTRO_TICKS) / TICK_HZ).toFixed(1)}s, budget ${budget.toFixed(0)}s`);
    const res = solve(def, { ...opts, budgetSec: budget, seed, noHurt: true, shardBonus: opts.shardBonus ?? SHARD_BONUS, jumpPenalty: opts.jumpPenalty ?? JUMP_PENALTY, pace: spec, log });
    if (!res.ok || !res.masks) {
      lastReason = res.reason;
      log(`    ✗ ${res.reason} (${res.elapsedSec.toFixed(0)}s)`);
      if (res.early) {
        const je = judge(def, res.early);
        if (je.ok) {
          candidates.push({ masks: res.early, judged: je });
          log(`    · fallback: the latest too-fast clear, ${je.summary.time.toFixed(2)}s (${pct(je.ratio)} of par)`);
        }
      }
      if (/par × 1\.2/.test(res.reason)) targetTicks = Math.round(targetTicks * 0.92);   // too slow: pull the schedule in
      else seed += 1;                                                                      // died out / stuck: another draw
      continue;
    }
    const j = judge(def, res.masks);
    if (!j.ok) {
      lastReason = `search claimed a clear but a fresh replay disagrees: ${j.why}`;
      log(`    ✗ ${lastReason}`);
      seed += 1;
      continue;
    }
    candidates.push({ masks: res.masks, judged: j });
    const inWindow = inPaceWindow(j.ratio, window);
    log(`    ${inWindow ? '✓' : '·'} cleared in ${j.summary.time.toFixed(2)}s (${pct(j.ratio)} of par), ${j.summary.shards}/${j.summary.totalShards} shards, ${j.dashes} dashes, ${res.elapsedSec.toFixed(0)}s`);
    if (inWindow) { hit = { masks: res.masks, judged: j }; break; }
    // shift the target by the miss (the schedule is linear in the pause budget)
    const miss = pace.pace * def.par - j.summary.time;
    targetTicks = Math.min(maxTarget, Math.max(INTRO_TICKS + ref.refTotal, targetTicks + Math.round(miss * TICK_HZ)));
    lastReason = `closest verified clear at ${pct(j.ratio)} of par, outside ${pct(window.lo)}–${pct(window.hi)}`;
  }

  // ---- write the best verified clear; PENDING unless it is inside the window
  if (!candidates.length) {
    pending[def.id] = { reason: lastReason || 'no verified clear', best: null, budgetSec: opts.budgetSec, recordedAt: now() };
    log(`  ✗ ${def.id}: ${lastReason}`);
    return false;
  }
  const pick = hit ?? candidates.reduce((a, b) => (windowMiss(b.judged.ratio, window) < windowMiss(a.judged.ratio, window) ? b : a));
  const j = pick.judged;
  const sol: Solution = { ...solutionOf(def, pick.masks, j, now()), ratio: Math.round(j.ratio * 1000) / 1000, dashes: j.dashes };
  writeJson(join(ctx.dir, `${def.id}.json`), sol);
  const elapsed = ((performance.now() - t0) / 1000).toFixed(0);
  if (hit) {
    solved.add(def.id);
    delete pending[def.id];
    log(`  ✓ ${def.id} paced clear ${j.summary.time.toFixed(2)}s (${pct(j.ratio)} of par ${def.par}), ${j.summary.shards}/${j.summary.totalShards} shards, ${j.dashes} dashes, ${pick.masks.length} masks → ${sol.masks.length} chars, ${elapsed}s total`);
    return true;
  }
  pending[def.id] = {
    reason: lastReason || `closest verified clear at ${pct(j.ratio)} of par`, best: null, budgetSec: opts.budgetSec, recordedAt: now(),
    ratio: sol.ratio, time: sol.time,
  };
  log(`  ✗ ${def.id}: wrote the closest verified clear (${j.summary.time.toFixed(2)}s, ${pct(j.ratio)} of par) — ${lastReason} (${elapsed}s total)`);
  return false;
}

// ---------------------------------------------------------------- cli
const VALUE_FLAGS = new Set(['budget', 'beam', 'random', 'seed', 'pace', 'pace-tolerance', 'passes', 'out']);
const BOOL_FLAGS = new Set(['nohurt', 'force', 'no-dash-chain']);

/** `--name=value`, `--name value` and boolean `--name`; everything else is a zone id. */
export function parseArgs(argv: string[]): { flags: Map<string, string>; ids: string[] } {
  const flags = new Map<string, string>();
  const ids: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { ids.push(a); continue; }
    const eq = a.indexOf('=');
    const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
    if (!VALUE_FLAGS.has(name) && !BOOL_FLAGS.has(name)) throw new Error(`unknown option '${a}'`);
    if (eq >= 0) { flags.set(name, a.slice(eq + 1)); continue; }
    if (BOOL_FLAGS.has(name)) { flags.set(name, 'true'); continue; }
    const next = argv[i + 1];
    // a value flag takes the next token unless it is another option or a zone id (letters); --pace alone means the default
    if (next !== undefined && !next.startsWith('--') && (name === 'out' || /^[\d.]+$/.test(next))) { flags.set(name, next); i++; }
    else flags.set(name, '');
  }
  return { flags, ids };
}

function main(argv: string[]): number {
  const { flags, ids } = parseArgs(argv);
  const num = (name: string, dflt: number): number => {
    const v = flags.get(name);
    if (v === undefined || v === '') return dflt;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`--${name} needs a number, got '${v}'`);
    return n;
  };
  const force = flags.has('force');
  const paced = flags.has('pace');
  const noDashChain = flags.has('no-dash-chain');
  const pace: PaceOptions | null = paced
    ? { pace: num('pace', (PACE_WINDOW.lo + PACE_WINDOW.hi) / 2), tolerance: num('pace-tolerance', (PACE_WINDOW.hi - PACE_WINDOW.lo) / 2), passes: num('passes', 3) }
    : null;
  const outFlag = flags.get('out');
  const dir = outFlag ? resolve(process.cwd(), outFlag) : paced ? corpusDir('par') : SOLUTIONS_DIR;
  const opts: SolveOptions = {
    budgetSec: num('budget', paced ? 180 : 300),
    beam: num('beam', 40),
    random: num('random', 8),
    noHurt: flags.has('nohurt') || paced,
    dashPenalty: noDashChain ? DASH_PENALTY : 0,
    seed: num('seed', 1),
  };
  const log = (s: string) => process.stdout.write(`${s}\n`);
  const zones = ids.length ? ids.map((id) => {
    const z = ZONES.find((d) => d.id === id);
    if (!z) throw new Error(`unknown zone '${id}'`);
    return z;
  }) : ZONES;
  if (pace) log(`paced corpus → ${dir} (target ${pct(pace.pace)} of par, window ${pct(pace.pace - pace.tolerance)}–${pct(pace.pace + pace.tolerance)}, ${noDashChain ? 'dash penalty on' : 'dashes free'})`);
  const ctx: ZoneCtx = { dir, solved: new Set<string>(), pending: {}, log };
  let failed = 0;
  for (const def of zones) {
    const existing = readSolutionFile(join(dir, `${def.id}.json`));
    const current = pace ? pacedSolutionCurrent(def, existing, { lo: pace.pace - pace.tolerance, hi: pace.pace + pace.tolerance }) : solutionCurrent(def, existing);
    if (!force && current) {
      log(`${def.id}: solution up to date${existing?.ratio !== undefined ? ` (${pct(existing.ratio)} of par)` : ''}, skipping (--force to re-solve)`);
      ctx.solved.add(def.id);
      writePending(dir, ctx.solved, ctx.pending);
      continue;
    }
    const ok = pace ? solveZonePaced(def, opts, pace, ctx) : solveZone(def, opts, ctx);
    if (!ok) failed++;
    writePending(dir, ctx.solved, ctx.pending);
  }
  writePending(dir, ctx.solved, ctx.pending);
  log(`done: ${zones.length - failed}/${zones.length} solved; pending now: ${Object.keys(readPendingFile(pendingPath(dir))).join(', ') || 'none'}`);
  return failed ? 1 : 0;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
