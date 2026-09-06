/**
 * Corpus self-test — the cross-engine determinism proof.
 *
 * Every JavaScript engine that runs the sim must reach bit-identical state
 * from the same input log: Node's V8 on the server that verifies a record,
 * Blink/V8, WebKit/JavaScriptCore and Gecko/SpiderMonkey in players' hands.
 * If one of them drifted, a run cleared on that device would be refused as
 * 'claim-mismatch' by the server that replays it. This module steps the
 * bundled goal echoes (src/sim/echoes.generated.ts — one paced developer clear
 * per story zone) plus two scripted daily towers through a fresh Sim and
 * reduces every final state to a small digest with an FNV-1a hash of the
 * canonical state JSON.
 *
 *   tools/hash-corpus.ts      writes the Node digests to test/fixtures/corpus-digests.json
 *   ?shot=selftest (shot.ts)  stamps the browser's digests on <html data-shot>
 *   tools/qa/selftest.ts      compares the stamp with the fixture per engine
 *
 * DOM-free on purpose: the same file runs under vitest, tsx and in the browser.
 */
import { Sim } from '../sim/sim.js';
import { decodeMasks } from '../sim/replay.js';
import { GEN_VERSION, IN, SIM_VERSION } from '../sim/types.js';
import type { InputMask, LevelDef } from '../sim/types.js';
import { LEVEL_BY_ID } from '../sim/levels.generated.js';
import { makeDailyLevel } from '../sim/gen/daily.js';
import { GOAL_ECHOES } from '../sim/echoes.generated.js';

/** One entry of the corpus: the outcome and a hash of the final sim state. */
export interface CorpusDigest {
  /** 't1' … 'v3' for story zones, 'daily:<seed>' for the scripted towers. */
  key: string;
  levelId: string;
  seed: number;
  /** Ticks stepped in total (all phases). */
  tick: number;
  /** Play ticks (RunSummary.ticks). */
  ticks: number;
  cleared: boolean;
  shards: number;
  deaths: number;
  /** Player position × 1000, rounded — a coarse drift indicator readable without the hash. */
  x: number;
  y: number;
  /** FNV-1a 32-bit over the canonical JSON of the final SimState, 8 hex digits. */
  hash: string;
}

export interface SelftestReport {
  sim: number;
  gen: number;
  digests: CorpusDigest[];
}

/** The JavaScript engine behind a user agent — what the determinism proof is about. */
export type EngineFamily = 'v8' | 'jsc' | 'spidermonkey' | 'unknown';

/** Seeds of the scripted daily towers in the corpus (fixed: they must match the fixture, not today's seed). */
export const DAILY_SEEDS: readonly number[] = [1, 20260906];
/** Ticks stepped for each daily tower (25 s). */
export const DAILY_TICKS = 3000;
/** The daily script repeats every this many ticks: hold right, then a jump tap. */
export const DAILY_SCRIPT_PERIOD = 64;
/** Ticks of the period during which RIGHT alone is held before the jump tap. */
export const DAILY_SCRIPT_RUN = 60;
/** Ticks the jump tap is held (the sim needs a press edge and a release). */
export const DAILY_SCRIPT_TAP = 3;

// ---------------------------------------------------------------- hashing
/**
 * JSON with object keys sorted recursively, so the hash never depends on the
 * order a state object happened to be assembled in. Numbers, strings, arrays,
 * booleans and null serialise exactly as JSON.stringify does (number formatting
 * is specified by ECMAScript, so it is identical across engines); undefined
 * members are skipped like JSON.stringify skips them.
 */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    const s = JSON.stringify(v);
    return s === undefined ? 'null' : s;
  }
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x)).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

/** FNV-1a, 32-bit, over the UTF-16 code units of `s`; 8 lower-case hex digits. */
export function fnv1a32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Hash of a sim's public state — the quantity the engines must agree on. */
export function stateHash(sim: Sim): string {
  return fnv1a32(canonicalJson(sim.state));
}

// ---------------------------------------------------------------- digests
function digestOf(key: string, sim: Sim): CorpusDigest {
  const s = sim.summary();
  const p = sim.state.player;
  return {
    key,
    levelId: sim.def.id,
    seed: sim.seed,
    tick: sim.state.tick,
    ticks: s.ticks,
    cleared: s.cleared,
    shards: s.shards,
    deaths: s.deaths,
    x: Math.round(p.x * 1000),
    y: Math.round(p.y * 1000),
    hash: stateHash(sim),
  };
}

/** Step `sim` through `masks` (stopping early once the run has finished). */
function stepMasks(sim: Sim, masks: Uint8Array): void {
  for (let i = 0; i < masks.length && !sim.finished; i++) sim.step(masks[i]);
}

/** The digest of one story zone's goal echo replayed from tick 0. Throws when the zone or its echo is unknown. */
export function storyDigest(levelId: string): CorpusDigest {
  const g = GOAL_ECHOES[levelId];
  const def: LevelDef | undefined = LEVEL_BY_ID[levelId];
  if (!g || !def) throw new Error(`selftest: no goal echo for '${levelId}'`);
  const sim = new Sim(def, { seed: g.seed });
  stepMasks(sim, decodeMasks(g.masks));
  return digestOf(levelId, sim);
}

/** Mask of tick `i` (0-based) of the daily script: hold right, tap jump every DAILY_SCRIPT_PERIOD ticks. */
export function dailyScriptMask(i: number): InputMask {
  const t = i % DAILY_SCRIPT_PERIOD;
  const tap = t >= DAILY_SCRIPT_RUN && t < DAILY_SCRIPT_RUN + DAILY_SCRIPT_TAP;
  return IN.RIGHT | (tap ? IN.JUMP : 0);
}

/**
 * The digest of a daily tower generated from `seed` and driven by the fixed
 * script for DAILY_TICKS ticks (fewer when the tide ends the run first). The
 * paced story masks are meaningless on a generated tower, so a script it is.
 */
export function dailyDigest(seed: number, ticks = DAILY_TICKS): CorpusDigest {
  const def = makeDailyLevel(seed >>> 0);
  const sim = new Sim(def, { seed: def.seed });
  for (let i = 0; i < ticks && !sim.finished; i++) sim.step(dailyScriptMask(i));
  return digestOf(`daily:${seed >>> 0}`, sim);
}

/** Keys of the corpus in report order: every zone with a goal echo, then the daily seeds. */
export function corpusKeys(): string[] {
  return [...Object.keys(GOAL_ECHOES), ...DAILY_SEEDS.map((s) => `daily:${s >>> 0}`)];
}

/** Run the whole corpus on this engine. Synchronous; ~70k sim ticks, well under a second on V8. */
export function runCorpusSelftest(): SelftestReport {
  const digests: CorpusDigest[] = [];
  for (const id of Object.keys(GOAL_ECHOES)) digests.push(storyDigest(id));
  for (const seed of DAILY_SEEDS) digests.push(dailyDigest(seed));
  return { sim: SIM_VERSION, gen: GEN_VERSION, digests };
}

// ---------------------------------------------------------------- engine
/**
 * Which JavaScript engine a user agent string implies. Every browser on iOS
 * is WebKit (CriOS, FxiOS, EdgiOS …), so the platform check comes first; Node
 * (>= 21 exposes navigator.userAgent as "Node.js/22") is V8.
 */
export function engineOf(ua: string | null | undefined): EngineFamily {
  const s = ua ?? '';
  if (!s) return 'unknown';
  if (/\b(iPhone|iPad|iPod)\b/.test(s)) return 'jsc';
  if (/\bNode\.js\b/.test(s)) return 'v8';
  if (/\bFirefox\/|\bGecko\/\d/.test(s)) return 'spidermonkey';
  if (/\b(Chrome|Chromium|HeadlessChrome|Edg|OPR|SamsungBrowser)\//.test(s)) return 'v8';
  if (/\bAppleWebKit\//.test(s)) return 'jsc';
  return 'unknown';
}

/** What `?shot=selftest` stamps (merged with the harness' common fields). */
export interface SelftestStamp {
  phase: 'selftest';
  engine: EngineFamily;
  ua: string;
  sim: number;
  gen: number;
  corpus: number;
  selftest: CorpusDigest[];
}

/** Build the stamp for the `?shot=selftest` harness from this engine's run of the corpus. */
export function selftestStamp(ua: string | null | undefined): SelftestStamp {
  const report = runCorpusSelftest();
  return {
    phase: 'selftest',
    engine: engineOf(ua),
    ua: (ua ?? '').slice(0, 200),
    sim: report.sim,
    gen: report.gen,
    corpus: report.digests.length,
    selftest: report.digests,
  };
}
