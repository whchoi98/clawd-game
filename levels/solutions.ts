/**
 * Golden replay corpora — verified, death-free clears of every story zone,
 * produced by tools/solve.ts (or exported by a human from
 * window.__clawd.run.masks after a clear). Two corpora live side by side:
 *
 *   levels/solutions/<zoneId>.json      the FAST corpus — the solver's shortest
 *                                       clear (dash chains, 8–25 % of par).
 *                                       Regression net only: any physics or
 *                                       level change must keep it replaying.
 *   levels/solutions/par/<zoneId>.json  the PACED corpus — a clear that looks
 *                                       like a competent human: full-speed
 *                                       running, dashes only where the
 *                                       geometry needs them, deliberate pauses
 *                                       at safe spots, 0.95–1.10 × par.
 *
 * Consumers:
 *   levels/build.ts                → src/sim/echoes.generated.ts (GOAL_ECHOES) from the PACED
 *                                    corpus, falling back to the fast corpus with a warning
 *   test/levels/solutions.test.ts    every zone replays to a clear in both corpora (or is
 *                                    listed in the corpus's PENDING.json)
 *   src/server/seed.ts               seeds an empty story board with GOAL_ECHOES ('개발자')
 *   src/client/echo/goal.ts          shows GOAL_ECHOES as the '목표' echo when the board is empty or offline
 *
 * A solution is bound to the sim version, the zone's geometry revision and its
 * seed; when any of those change it must be re-recorded (README: 골든 리플레이 재녹화).
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { SIM_VERSION } from '../src/sim/types.js';
import type { LevelDef } from '../src/sim/types.js';

/** The fast corpus. */
export const SOLUTIONS_DIR = fileURLToPath(new URL('./solutions/', import.meta.url));
/** The paced corpus. */
export const PAR_SOLUTIONS_DIR = join(SOLUTIONS_DIR, 'par/');
export const PENDING_PATH = join(SOLUTIONS_DIR, 'PENDING.json');
export const PAR_PENDING_PATH = join(PAR_SOLUTIONS_DIR, 'PENDING.json');

export type Corpus = 'fast' | 'par';

/** Directory of a corpus. */
export function corpusDir(corpus: Corpus = 'fast'): string {
  return corpus === 'par' ? PAR_SOLUTIONS_DIR : SOLUTIONS_DIR;
}

/**
 * Accepted time / par ratio of a paced solution: slow enough that a stranger
 * can follow the ghost and that the seeded '개발자' entry is beatable, fast
 * enough to still read as a clear worth chasing (roadmap P2-1: 파의 95~110 %).
 */
export const PACE_WINDOW = { lo: 0.95, hi: 1.10 } as const;

/** levels/solutions/<zoneId>.json and levels/solutions/par/<zoneId>.json */
export interface Solution {
  levelId: string;
  /** SIM_VERSION the masks were recorded against. */
  sim: number;
  /** LevelDef.rev at recording time (missing rev = 0). */
  rev: number;
  seed: number;
  /** RLE base64 masks (src/sim/replay.ts encodeMasks). */
  masks: string;
  /** Play ticks of the verified run (RunSummary.ticks). */
  ticks: number;
  time: number;
  shards: number;
  deaths: number;
  recordedAt: string;
  /** time / par at recording time (paced corpus). */
  ratio?: number;
  /** Dashes of the verified run (paced corpus — a human-looking run keeps this low). */
  dashes?: number;
}

/** PENDING.json — zones without a (good enough) solution and why. */
export interface PendingEntry {
  reason: string;
  /** Best progress the search reached: remaining potential in tiles, the tile and tick where it stood. */
  best: { distTiles: number; tile: [number, number]; tick: number } | null;
  budgetSec: number;
  recordedAt: string;
  /** Paced corpus: the closest verified clear was written anyway; this is its time / par. */
  ratio?: number;
  /** Paced corpus: its time in seconds. */
  time?: number;
}
export type Pending = Record<string, PendingEntry>;

export function solutionPath(zoneId: string, corpus: Corpus = 'fast'): string { return join(corpusDir(corpus), `${zoneId}.json`); }
export function pendingPath(dir: string): string { return join(dir, 'PENDING.json'); }

export function readSolutionFile(path: string): Solution | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as Solution;
}

export function readSolution(zoneId: string, corpus: Corpus = 'fast'): Solution | null {
  return readSolutionFile(solutionPath(zoneId, corpus));
}

/** Every solution on disk for the given zones, keyed by zone id. */
export function readSolutions(zoneIds: readonly string[], corpus: Corpus = 'fast'): Record<string, Solution> {
  const out: Record<string, Solution> = {};
  for (const id of zoneIds) {
    const s = readSolution(id, corpus);
    if (s) out[id] = s;
  }
  return out;
}

export function readPendingFile(path: string): Pending {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8')) as Pending;
}

export function readPending(corpus: Corpus = 'fast'): Pending {
  return readPendingFile(pendingPath(corpusDir(corpus)));
}

/**
 * Why a stored solution no longer applies to `def` on this sim, or null when
 * its version triple (sim, rev, seed) still matches. Replaying is the caller's
 * job (build.ts and the tests use verifyReplay).
 */
export function staleReason(def: Pick<LevelDef, 'id' | 'seed' | 'rev'>, sol: Solution): string | null {
  if (sol.levelId !== def.id) return `levelId '${sol.levelId}' is not '${def.id}'`;
  if (sol.sim !== SIM_VERSION) return `recorded on sim v${sol.sim}, this build is v${SIM_VERSION}`;
  if (sol.rev !== (def.rev ?? 0)) return `recorded at rev ${sol.rev}, the zone is at rev ${def.rev ?? 0}`;
  if (sol.seed !== def.seed) return `recorded with seed ${sol.seed}, the zone uses ${def.seed}`;
  return null;
}

/** True when a time / par ratio lies inside PACE_WINDOW. */
export function inPaceWindow(ratio: number, window: { lo: number; hi: number } = PACE_WINDOW): boolean {
  return ratio >= window.lo - 1e-9 && ratio <= window.hi + 1e-9;
}
