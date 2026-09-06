/**
 * Storage key of a leaderboard board.
 *
 * The wire-level `board` stays what the client sends (story → levelId, daily →
 * YYYY-MM-DD). Under the hood every story board is partitioned by the sim
 * version and the zone's geometry revision, so a SIM_VERSION bump or a tile
 * change starts a fresh board instead of mixing runs that no longer replay:
 *
 *   story  t1          → t1#s2r0        (pk LB#story#t1#s2r0, sk BEST#story#t1#s2r0)
 *   daily  2026-09-06  → 2026-09-06     (the date already pins generator + sim)
 *
 * Both repos (DynamoDB and memory) build their keys through `boardKey`, so
 * rankOf / topRuns / saveBest / getPlayerBest can never disagree.
 */
import { SIM_VERSION } from '../sim/types.js';
import { LEVEL_BY_ID } from '../sim/levels.generated.js';
import type { Mode } from '../shared/protocol.js';

/** Geometry revision of a shipped zone; unknown zones and zones without `rev` are 0. */
export function levelRev(levelId: string): number {
  if (!Object.prototype.hasOwnProperty.call(LEVEL_BY_ID, levelId)) return 0;
  return LEVEL_BY_ID[levelId]?.rev ?? 0;
}

/** `s<SIM_VERSION>r<rev>` — the version segment of a story board. */
export function storyBoardSuffix(levelId: string): string {
  return `s${SIM_VERSION}r${levelRev(levelId)}`;
}

/** The stored board id for a (mode, board) pair. */
export function boardKey(mode: Mode, board: string): string {
  return mode === 'story' ? `${board}#${storyBoardSuffix(board)}` : board;
}
