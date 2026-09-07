/**
 * In-process Repo for tests and local development (no AWS credentials).
 * Mirrors the DynamoRepo semantics: one board entry per player, replaced by
 * `saveBest`, which is refused with the same conflict error when the caller's
 * `previousRunId` is not the current best; the same replay hash may appear on
 * a board once (DuplicateReplayError names the run that holds it); runs stay
 * readable by id even after they leave the board. Transfer snapshots, admin
 * delist / rename and the 90-day ttl of a replaced story run are mirrored too,
 * as are the P3-12 extras: `boardTotal` (the board length), `rankBounded`
 * (a capped strictly-better count) and `hitRateCounter` — which here is the
 * in-process limiter a single task always had.
 */
import type { Mode } from '../../shared/protocol.js';
import { boardKey as storedBoard } from '../boards.js';
import { DuplicateReplayError, SaveConflictError } from './errors.js';
import type { BoardTotals, BoundedRank, RankBounded, RateCounters } from './extras.js';
import { replacedRunTtl } from './ttl.js';
import type { Repo, StoredRun } from './types.js';

/** Same partitioning as DynamoRepo: story boards carry the sim version and zone revision. */
const boardKey = (mode: Mode, board: string) => `${mode}#${storedBoard(mode, board)}`;
const bestKey = (playerId: string, mode: Mode, board: string) => `${playerId}#${mode}#${storedBoard(mode, board)}`;
const hashKey = (mode: Mode, board: string, hash: string) => `${boardKey(mode, board)}#${hash}`;

/** The LB sort-key order of DynamoRepo: score ascending, then more shards, then run id. */
export function compareRuns(a: StoredRun, b: StoredRun): number {
  if (a.score !== b.score) return a.score - b.score;
  if (a.shards !== b.shards) return b.shards - a.shards;
  return a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0;
}

export interface MemoryRepoOptions {
  /** Clock for ttl checks (ms epoch); default Date.now. */
  now?: () => number;
}

export class MemoryRepo implements Repo, BoardTotals, RankBounded, RateCounters {
  private readonly runs = new Map<string, StoredRun>();
  private readonly boards = new Map<string, StoredRun[]>();
  private readonly bests = new Map<string, StoredRun>();
  private readonly hashes = new Map<string, { runId: string; playerId: string }>();
  private readonly snapshots = new Map<string, { code: string; blob: string; ttl: number }>();
  private readonly codes = new Map<string, { playerId: string; ttl: number }>();
  private readonly rateCounters = new Map<string, { n: number; ttl: number }>();
  private readonly now: () => number;

  constructor(opts: MemoryRepoOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  async getPlayerBest(playerId: string, mode: Mode, board: string): Promise<StoredRun | null> {
    return this.bests.get(bestKey(playerId, mode, board)) ?? null;
  }

  async saveBest(run: StoredRun, previousRunId?: string): Promise<void> {
    const bKey = bestKey(run.playerId, run.mode, run.board);
    const current = this.bests.get(bKey);
    const expected = previousRunId ? current?.runId === previousRunId : current === undefined;
    if (!expected) throw new SaveConflictError();
    const hKey = run.hash ? hashKey(run.mode, run.board, run.hash) : undefined;
    if (hKey) {
      const owner = this.hashes.get(hKey);
      if (owner) throw new DuplicateReplayError(owner.runId, owner.playerId);
    }

    this.runs.set(run.runId, run);
    const key = boardKey(run.mode, run.board);
    const entries = (this.boards.get(key) ?? []).filter(
      (r) => r.runId !== previousRunId && r.playerId !== run.playerId,
    );
    entries.push(run);
    entries.sort(compareRuns);
    this.boards.set(key, entries);
    this.bests.set(bKey, run);
    if (hKey) this.hashes.set(hKey, { runId: run.runId, playerId: run.playerId });
    if (previousRunId && previousRunId !== run.runId && run.mode === 'story') {
      const old = this.runs.get(previousRunId);
      if (old && old.ttl === undefined) old.ttl = replacedRunTtl(run.createdAt);
    }
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

  // ---------------------------------------------------------------- P3-12 extras
  async boardTotal(mode: Mode, board: string): Promise<number> {
    return (this.boards.get(boardKey(mode, board)) ?? []).length;
  }

  async rankBounded(mode: Mode, board: string, score: number, cap: number): Promise<BoundedRank> {
    const { better } = await this.rankOf(mode, board, score);
    return better > cap ? { better: cap, capped: true } : { better, capped: false };
  }

  /**
   * Per-process counter with the same fixed-minute semantics as the DynamoDB
   * item. Expiry follows the caller's clock (the minute it passes), not this
   * repo's, so a limiter on an injected clock sees consistent counts.
   */
  async hitRateCounter(ip: string, minute: number, ttl: number): Promise<number> {
    const nowSec = minute * 60;
    for (const [k, v] of this.rateCounters) if (v.ttl <= nowSec) this.rateCounters.delete(k);
    const key = `${ip}#${minute}`;
    const cur = this.rateCounters.get(key);
    const n = (cur?.n ?? 0) + 1;
    this.rateCounters.set(key, { n, ttl: cur?.ttl ?? ttl });
    return n;
  }

  /** Seed a board that has no entries yet; false (and nothing written) when it already has any. */
  async putIfBoardEmpty(run: StoredRun): Promise<boolean> {
    if ((this.boards.get(boardKey(run.mode, run.board)) ?? []).length > 0) return false;
    await this.saveBest(run);
    return true;
  }

  // ---------------------------------------------------------------- transfer snapshots
  async putSnapshot(playerId: string, code: string, blob: string, ttl: number): Promise<void> {
    const old = this.snapshots.get(playerId);
    if (old && old.code !== code) this.codes.delete(old.code);
    this.snapshots.set(playerId, { code, blob, ttl });
    this.codes.set(code, { playerId, ttl });
  }

  async takeSnapshot(code: string): Promise<{ playerId: string; blob: string } | null> {
    const meta = this.codes.get(code);
    if (!meta) return null;
    this.codes.delete(code);
    if (this.expired(meta.ttl)) return null;
    const snap = this.snapshots.get(meta.playerId);
    if (!snap || snap.code !== code || this.expired(snap.ttl)) return null;
    this.snapshots.delete(meta.playerId);
    return { playerId: meta.playerId, blob: snap.blob };
  }

  // ---------------------------------------------------------------- admin
  /** Mark the run flagged and take it off its board (and off the player's best when it is that). */
  async delistRun(runId: string): Promise<boolean> {
    const run = this.runs.get(runId);
    if (!run) return false;
    run.flagged = true;
    const key = boardKey(run.mode, run.board);
    this.boards.set(key, (this.boards.get(key) ?? []).filter((r) => r.runId !== runId));
    const bKey = bestKey(run.playerId, run.mode, run.board);
    if (this.bests.get(bKey)?.runId === runId) this.bests.delete(bKey);
    return true;
  }

  /** Change the display name on the run and its board projections. */
  async renameRun(runId: string, name: string): Promise<boolean> {
    const run = this.runs.get(runId);
    if (!run) return false;
    run.name = name;
    for (const entries of this.boards.values()) for (const r of entries) if (r.runId === runId) r.name = name;
    for (const best of this.bests.values()) if (best.runId === runId) best.name = name;
    return true;
  }

  private expired(ttl: number): boolean {
    return ttl * 1000 <= this.now();
  }

  /** Test helper. */
  clear(): void {
    this.runs.clear();
    this.boards.clear();
    this.bests.clear();
    this.hashes.clear();
    this.snapshots.clear();
    this.codes.clear();
    this.rateCounters.clear();
  }
}
