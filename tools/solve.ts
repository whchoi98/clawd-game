/**
 * Golden replay solver — finds a death-free clear of a story zone on the real
 * Sim and writes it to levels/solutions/<zoneId>.json.
 *
 *   npx tsx tools/solve.ts [zoneId...] [--budget=300] [--beam=40] [--random=8] [--seed=1] [--nohurt] [--force]
 *
 * Without zone ids every zone in tower order is attempted (tidepool → storm →
 * void). Zones that already have a valid solution are skipped unless --force.
 * A zone the solver cannot clear within its budget is recorded in
 * levels/solutions/PENDING.json with the reason and the best progress reached;
 * a solution file is written only when a fresh Sim replays the masks to a
 * clear with zero deaths inside par × 1.2 (verifyReplay is the judge, never
 * the search state).
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
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Sim } from '../src/sim/sim.js';
import type { Level } from '../src/sim/level.js';
import { makeRng } from '../src/sim/rng.js';
import type { Rng } from '../src/sim/rng.js';
import { decodeMasks, encodeMasks, verifyReplay } from '../src/sim/replay.js';
import { IN, SIM_VERSION, TILE } from '../src/sim/types.js';
import type { InputMask, LevelDef } from '../src/sim/types.js';
import { CRUMBLE, SPIKES, SWITCH_A, SWITCH_B, WATER_BODY, WATER_SURFACE } from '../src/sim/legend.js';
import { ZONES } from '../levels/build.js';
import { PENDING_PATH, readPending, readSolution, solutionPath, staleReason } from '../levels/solutions.js';
import type { Pending, PendingEntry, Solution } from '../levels/solutions.js';

// ---------------------------------------------------------------- files
function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Merge this process's verdicts into PENDING.json: zones it solved leave the
 * file, zones it gave up on are recorded, everything else (another solver run
 * in parallel) is kept as found on disk.
 */
function writePending(solved: Set<string>, given: Pending): void {
  const merged = readPending();
  for (const id of solved) delete merged[id];
  Object.assign(merged, given);
  const sorted: Pending = {};
  for (const id of Object.keys(merged).sort()) sorted[id] = merged[id];
  writeJson(PENDING_PATH, sorted);
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

// ---------------------------------------------------------------- search
interface Node {
  fork: Fork | null;
  parent: Node | null;
  masks: Uint8Array | null;
  tick: number;
  score: number;
  pot: number;
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
  log?: (line: string) => void;
}

export interface SolveResult {
  ok: boolean;
  masks: Uint8Array | null;
  reason: string;
  best: PendingEntry['best'];
  elapsedSec: number;
  slices: number;
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

/** Search for a death-free clear. Returns the raw masks (trimmed at the finishing tick) when found. */
export function solve(def: LevelDef, opts: SolveOptions): SolveResult {
  const log = opts.log ?? (() => {});
  const t0 = performance.now();
  const deadline = t0 + opts.budgetSec * 1000;
  const root = Fork.fresh(def);
  const pot = new Potential(root.sim.level);
  const fixed = fixedActions();
  const rng = makeRng(opts.seed);

  const slices = new Map<number, Node[]>();
  const put = (n: Node) => {
    const k = Math.floor(n.tick / SLICE);
    const list = slices.get(k);
    if (list) list.push(n); else slices.set(k, [n]);
  };
  const p0 = root.sim.state.player;
  const pot0 = pot.value(p0.x + p0.w / 2, p0.y + p0.h / 2, true);
  put({ fork: root, parent: null, masks: null, tick: 0, score: pot0, pot: pot0 });

  let best: SolveResult['best'] = null;
  let bestPot = Number.POSITIVE_INFINITY;
  let lastImprove = 0;
  let sliceIdx = 0;
  let processed = 0;
  let reason = '';
  const maxTick = Math.min(def.par * 1.2 * 120, 120 * 600);

  for (;;) {
    if (performance.now() > deadline) { reason = `budget of ${opts.budgetSec}s exhausted`; break; }
    if (sliceIdx * SLICE > maxTick) { reason = `no clear within par × 1.2 (${Math.round(maxTick)} ticks)`; break; }
    if (sliceIdx - lastImprove > 600) { reason = `stuck: no progress for ${(600 * SLICE) / 120} s of sim time`; break; }
    const list = slices.get(sliceIdx);
    slices.delete(sliceIdx);
    sliceIdx++;
    if (!list || list.length === 0) {
      if (slices.size === 0) { reason = 'beam died out (every branch was fatal)'; break; }
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
    const beam = [...byKey.values()].sort((a, b) => a.score - b.score).slice(0, opts.beam);
    // a few random survivors keep the search from collapsing onto one ledge
    const rest = [...byKey.values()].filter((n) => !beam.includes(n));
    for (let i = 0; i < 4 && rest.length; i++) beam.push(rest.splice(rng.int(0, rest.length - 1), 1)[0]);
    for (const n of list) if (!beam.includes(n)) n.fork = null;

    if (processed % 25 === 0) {
      const b = beam[0];
      const p = b.fork!.sim.state.player;
      log(`  slice ${sliceIdx} tick ${b.tick} pot ${(b.pot / TILE).toFixed(1)} tiles at (${Math.floor((p.x + p.w / 2) / TILE)},${Math.floor((p.y + p.h / 2) / TILE)}) beam ${beam.length} · ${((performance.now() - t0) / 1000).toFixed(0)}s`);
    }

    let solved: Node | null = null;
    for (const node of beam) {
      const parentFork = node.fork!;
      const actions = fixed.slice();
      for (let i = 0; i < opts.random; i++) actions.push(randomAction(rng));
      for (let ai = 0; ai < actions.length; ai++) {
        const a = actions[ai];
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
        const score = v + HURT_PENALTY * (3 - p.hp);
        const child: Node = { fork, parent: node, masks: used === a.len ? masks : masks.slice(0, used), tick: node.tick + used, score, pot: v };
        if (sim.finished) {
          if (sim.summary().cleared && sim.state.stats.deaths === 0) { solved = child; break; }
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
      return { ok: true, masks, reason: 'cleared', best, elapsedSec: (performance.now() - t0) / 1000, slices: processed };
    }
  }
  return { ok: false, masks: null, reason, best, elapsedSec: (performance.now() - t0) / 1000, slices: processed };
}

// ---------------------------------------------------------------- verification + files
export interface Judged { ok: boolean; why?: string; summary: ReturnType<Sim['summary']> }

/** The only judge: a fresh Sim replays the masks and must clear with 0 deaths inside par × 1.2. */
export function judge(def: LevelDef, masks: Uint8Array): Judged {
  const v = verifyReplay(def, { v: SIM_VERSION, levelId: def.id, seed: def.seed, assist: false, masks });
  if (!v.ok) return { ok: false, why: v.reason, summary: v.summary };
  const s = v.summary;
  if (!s.cleared) return { ok: false, why: 'not cleared', summary: s };
  if (s.deaths !== 0) return { ok: false, why: `${s.deaths} deaths`, summary: s };
  if (s.time > def.par * 1.2) return { ok: false, why: `time ${s.time.toFixed(2)} > par × 1.2`, summary: s };
  return { ok: true, summary: s };
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

function solveZone(def: LevelDef, opts: SolveOptions, solved: Set<string>, pending: Pending, log: (s: string) => void): boolean {
  log(`${def.id} ${def.name} — par ${def.par}s, budget ${opts.budgetSec}s, beam ${opts.beam}`);
  const res = solve(def, { ...opts, log });
  const now = new Date().toISOString();
  if (res.ok && res.masks) {
    const j = judge(def, res.masks);
    if (j.ok) {
      const sol: Solution = {
        levelId: def.id, sim: SIM_VERSION, rev: def.rev ?? 0, seed: def.seed, masks: encodeMasks(res.masks),
        ticks: j.summary.ticks, time: Math.round(j.summary.time * 1000) / 1000, shards: j.summary.shards, deaths: j.summary.deaths,
        recordedAt: now,
      };
      writeJson(solutionPath(def.id), sol);
      solved.add(def.id);
      delete pending[def.id];
      log(`  ✓ ${def.id} cleared in ${j.summary.time.toFixed(2)}s (par ${def.par}, ${(j.summary.time / def.par * 100).toFixed(0)}%), ${j.summary.shards}/${j.summary.totalShards} shards, ${res.masks.length} masks → ${sol.masks.length} chars, ${res.elapsedSec.toFixed(0)}s search`);
      return true;
    }
    res.reason = `search claimed a clear but a fresh replay disagrees: ${j.why}`;
  }
  pending[def.id] = { reason: res.reason, best: res.best, budgetSec: opts.budgetSec, recordedAt: now };
  log(`  ✗ ${def.id}: ${res.reason} (best ${res.best ? `${res.best.distTiles} tiles from the goal at (${res.best.tile.join(',')}) tick ${res.best.tick}` : 'none'}, ${res.elapsedSec.toFixed(0)}s)`);
  return false;
}

function main(argv: string[]): number {
  const flag = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };
  const ids = argv.filter((a) => !a.startsWith('--'));
  const force = argv.includes('--force');
  const opts: SolveOptions = {
    budgetSec: Number(flag('budget') ?? 300),
    beam: Number(flag('beam') ?? 40),
    random: Number(flag('random') ?? 8),
    noHurt: argv.includes('--nohurt'),
    seed: Number(flag('seed') ?? 1),
  };
  const log = (s: string) => process.stdout.write(`${s}\n`);
  const zones = ids.length ? ids.map((id) => {
    const z = ZONES.find((d) => d.id === id);
    if (!z) throw new Error(`unknown zone '${id}'`);
    return z;
  }) : ZONES;
  const pending: Pending = {};
  const solved = new Set<string>();
  let failed = 0;
  for (const def of zones) {
    if (!force && solutionCurrent(def, readSolution(def.id))) {
      log(`${def.id}: solution up to date, skipping (--force to re-solve)`);
      solved.add(def.id);
      writePending(solved, pending);
      continue;
    }
    if (!solveZone(def, opts, solved, pending, log)) failed++;
    writePending(solved, pending);
  }
  writePending(solved, pending);
  log(`done: ${zones.length - failed}/${zones.length} solved; pending now: ${Object.keys(readPending()).join(', ') || 'none'}`);
  return failed ? 1 : 0;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
