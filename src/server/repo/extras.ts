/**
 * Optional repo capabilities beyond the frozen `Repo` contract (repo/types.ts).
 * Both shipped repos implement them; callers probe structurally — the way the
 * admin CLI probes `renameRun` — so a bare `Repo` in a test still works through
 * the slower generic path built on `rankOf`.
 *
 *   BoardTotals   the `BOARD#<mode>#<board>` entry counter that `saveBest`
 *                 maintains (one GetItem instead of a COUNT over the board)
 *   RankBounded   a COUNT of strictly better entries that stops at `cap`, so a
 *                 huge board costs a bounded number of read units per /api/me
 *   RateCounters  the fleet-shared `RL#<ip>#<minute>` submit counter behind
 *                 POST /api/runs (DynamoDB UpdateItem ADD; in-process in MemoryRepo)
 */
import type { Mode } from '../../shared/protocol.js';
import type { Repo } from './types.js';

export interface BoardTotals {
  /** Entries on the board: the counter item, or a COUNT (backfilling the counter) when it is absent. */
  boardTotal(mode: Mode, board: string): Promise<number>;
}

export interface BoundedRank {
  /** Strictly better entries, at most `cap`. */
  better: number;
  /** True when the count stopped at the cap — the real rank is at least `cap + 1`. */
  capped: boolean;
}

export interface RankBounded {
  rankBounded(mode: Mode, board: string, score: number, cap: number): Promise<BoundedRank>;
}

export interface RateCounters {
  /**
   * Increment the submit counter of `ip` for UTC `minute` (Math.floor(ms / 60000))
   * and return the new count. The item expires at `ttl` (unix seconds).
   */
  hitRateCounter(ip: string, minute: number, ttl: number): Promise<number>;
}

const has = (repo: Repo, method: string): boolean =>
  typeof (repo as unknown as Record<string, unknown>)[method] === 'function';

export function hasBoardTotals(repo: Repo): repo is Repo & BoardTotals { return has(repo, 'boardTotal'); }
export function hasRankBounded(repo: Repo): repo is Repo & RankBounded { return has(repo, 'rankBounded'); }
export function hasRateCounters(repo: Repo): repo is Repo & RateCounters { return has(repo, 'hitRateCounter'); }

/** Board total through the counter when the repo has one, else the second COUNT of `rankOf`. */
export async function boardTotal(repo: Repo, mode: Mode, board: string): Promise<number> {
  if (hasBoardTotals(repo)) return repo.boardTotal(mode, board);
  return (await repo.rankOf(mode, board, 0)).total;
}

/** Bounded rank through `rankBounded` when the repo has it, else an exact `rankOf` clamped to the cap. */
export async function rankBounded(repo: Repo, mode: Mode, board: string, score: number, cap: number): Promise<BoundedRank> {
  if (hasRankBounded(repo)) return repo.rankBounded(mode, board, score, cap);
  const { better } = await repo.rankOf(mode, board, score);
  return better > cap ? { better: cap, capped: true } : { better, capped: false };
}
