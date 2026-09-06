/**
 * In-process Repo for tests and local development (no AWS credentials).
 * Mirrors the DynamoRepo semantics: one board entry per player, replaced by
 * `saveBest`, which is refused with the same conflict error when the caller's
 * `previousRunId` is not the current best; runs stay readable by id even after
 * they leave the board.
 */
import type { Mode } from '../../shared/protocol.js';
import { SaveConflictError } from './errors.js';
import type { Repo, StoredRun } from './types.js';

const boardKey = (mode: Mode, board: string) => `${mode}#${board}`;
const bestKey = (playerId: string, mode: Mode, board: string) => `${playerId}#${mode}#${board}`;

/** The LB sort-key order of DynamoRepo: score ascending, then more shards, then run id. */
export function compareRuns(a: StoredRun, b: StoredRun): number {
  if (a.score !== b.score) return a.score - b.score;
  if (a.shards !== b.shards) return b.shards - a.shards;
  return a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0;
}

export class MemoryRepo implements Repo {
  private readonly runs = new Map<string, StoredRun>();
  private readonly boards = new Map<string, StoredRun[]>();
  private readonly bests = new Map<string, StoredRun>();

  async getPlayerBest(playerId: string, mode: Mode, board: string): Promise<StoredRun | null> {
    return this.bests.get(bestKey(playerId, mode, board)) ?? null;
  }

  async saveBest(run: StoredRun, previousRunId?: string): Promise<void> {
    const bKey = bestKey(run.playerId, run.mode, run.board);
    const current = this.bests.get(bKey);
    const expected = previousRunId ? current?.runId === previousRunId : current === undefined;
    if (!expected) throw new SaveConflictError();

    this.runs.set(run.runId, run);
    const key = boardKey(run.mode, run.board);
    const entries = (this.boards.get(key) ?? []).filter(
      (r) => r.runId !== previousRunId && r.playerId !== run.playerId,
    );
    entries.push(run);
    entries.sort(compareRuns);
    this.boards.set(key, entries);
    this.bests.set(bKey, run);
  }

  async topRuns(mode: Mode, board: string, limit: number): Promise<StoredRun[]> {
    return (this.boards.get(boardKey(mode, board)) ?? []).slice(0, Math.max(0, limit));
  }

  async rankOf(mode: Mode, board: string, score: number): Promise<{ better: number; total: number }> {
    const entries = this.boards.get(boardKey(mode, board)) ?? [];
    let better = 0;
    for (const r of entries) if (r.score < score) better++;
    return { better, total: entries.length };
  }

  async getRun(runId: string): Promise<StoredRun | null> {
    return this.runs.get(runId) ?? null;
  }

  /** Test helper. */
  clear(): void {
    this.runs.clear();
    this.boards.clear();
    this.bests.clear();
  }
}
