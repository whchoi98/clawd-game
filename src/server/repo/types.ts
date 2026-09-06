/**
 * Persistence contract. `DynamoRepo` implements it against the single table
 * described in the spec (§2.4); `MemoryRepo` implements it in-process for tests
 * and local development without AWS credentials.
 *
 * Board key: story → levelId · daily → YYYY-MM-DD.
 * One leaderboard item per player per board (their best); `saveBest` replaces it.
 */
import type { Mode } from '../../shared/protocol.js';

export interface StoredRun {
  runId: string;
  mode: Mode;
  board: string;
  levelId: string;
  seed: number;
  assist: boolean;
  /** Encoded masks exactly as submitted. */
  masks: string;
  playerId: string;
  name: string;
  /** boardScore(summary) — lower is better. */
  score: number;
  ticks: number;
  shards: number;
  deaths: number;
  cleared: boolean;
  height: number;
  /** ISO timestamp. */
  createdAt: string;
  /** Unix seconds; daily runs expire after 30 days, story runs never. */
  ttl?: number;
}

export interface Repo {
  /** The player's current best on a board, or null. */
  getPlayerBest(playerId: string, mode: Mode, board: string): Promise<StoredRun | null>;
  /**
   * Persist a new personal best: writes RUN + LB + PLAYER items and removes the
   * previous LB item (if `previousRunId`). Atomic where the store allows it.
   */
  saveBest(run: StoredRun, previousRunId?: string): Promise<void>;
  /** Best runs on a board, ascending score (fastest first), at most `limit`. */
  topRuns(mode: Mode, board: string, limit: number): Promise<StoredRun[]>;
  /** Number of leaderboard items on the board with score strictly lower than `score`, and the board total. */
  rankOf(mode: Mode, board: string, score: number): Promise<{ better: number; total: number }>;
  getRun(runId: string): Promise<StoredRun | null>;
  /**
   * Seed a board that has no leaderboard items yet (developer par runs so a
   * new board never looks dead). Returns true when the run was written; false
   * when the board already had entries. Atomic where the store allows it.
   */
  putIfBoardEmpty?(run: StoredRun): Promise<boolean>;
}
