/**
 * Golden replay corpus — one verified, death-free clear per story zone in
 * levels/solutions/<zoneId>.json, produced by tools/solve.ts (or exported by a
 * human from window.__clawd.run.masks after a clear). Consumers:
 *
 *   levels/build.ts             → src/sim/echoes.generated.ts (GOAL_ECHOES)
 *   test/levels/solutions.test.ts  every zone either replays to a clear or is listed in PENDING.json
 *   src/server (boot)           seeds an empty story board with the zone's solution
 *   src/client/echo/goal.ts     shows it as the '목표' echo when the board is empty or offline
 *
 * A solution is bound to the sim version, the zone's geometry revision and its
 * seed; when any of those change it must be re-recorded (README: 골든 리플레이 재녹화).
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { SIM_VERSION } from '../src/sim/types.js';
import type { LevelDef } from '../src/sim/types.js';

export const SOLUTIONS_DIR = fileURLToPath(new URL('./solutions/', import.meta.url));
export const PENDING_PATH = join(SOLUTIONS_DIR, 'PENDING.json');

/** levels/solutions/<zoneId>.json */
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
}

/** levels/solutions/PENDING.json — zones without a solution and why. */
export interface PendingEntry {
  reason: string;
  /** Best progress the search reached: remaining potential in tiles, the tile and tick where it stood. */
  best: { distTiles: number; tile: [number, number]; tick: number } | null;
  budgetSec: number;
  recordedAt: string;
}
export type Pending = Record<string, PendingEntry>;

export function solutionPath(zoneId: string): string { return join(SOLUTIONS_DIR, `${zoneId}.json`); }

export function readSolution(zoneId: string): Solution | null {
  const p = solutionPath(zoneId);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')) as Solution;
}

/** Every solution on disk for the given zones, keyed by zone id. */
export function readSolutions(zoneIds: readonly string[]): Record<string, Solution> {
  const out: Record<string, Solution> = {};
  for (const id of zoneIds) {
    const s = readSolution(id);
    if (s) out[id] = s;
  }
  return out;
}

export function readPending(): Pending {
  if (!existsSync(PENDING_PATH)) return {};
  return JSON.parse(readFileSync(PENDING_PATH, 'utf8')) as Pending;
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
