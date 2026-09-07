/**
 * GET /api/leaderboard?mode&board&limit — the public top-N of a board.
 *
 * Since P3-12 this response is the same for every viewer and is cached at the
 * edge (`Cache-Control: public, s-maxage=5, stale-while-revalidate=30`, with a
 * dedicated CloudFront behaviour for /api/leaderboard*), so it carries nothing
 * personal: `yours` is gone and `you` is always false. The caller's own row
 * lives at GET /api/me (routes/me.ts, no-store). A `playerId` in the query is
 * still accepted for old clients and ignored — it would only fragment the cache.
 *
 * Ranks are competition ranks (1 + strictly better scores; ties share).
 * Players appear as `playerTag` (HMAC of the id under the tag secret); the raw
 * player id is a credential and never appears in a response. The total comes
 * from the BOARD counter when the repo keeps one (one GetItem), so a page
 * costs two reads: the top-N query and the counter.
 */
import type { FastifyInstance } from 'fastify';
import { LeaderboardQuery, type LeaderboardEntry, type LeaderboardResponse } from '../../shared/protocol.js';
import { playerTag, tagSecretFor } from '../players.js';
import { boardTotal } from '../repo/extras.js';
import type { StoredRun } from '../repo/types.js';
import type { AppDeps } from '../types.js';
import { badRequest } from './parse.js';

/** Seconds a CloudFront edge may serve one leaderboard page before revalidating. */
export const LEADERBOARD_S_MAXAGE = 5;
/** Seconds a stale page may still be served while the edge refreshes it in the background. */
export const LEADERBOARD_STALE_WHILE_REVALIDATE = 30;
export const LEADERBOARD_CACHE_CONTROL =
  `public, s-maxage=${LEADERBOARD_S_MAXAGE}, stale-while-revalidate=${LEADERBOARD_STALE_WHILE_REVALIDATE}`;

/**
 * Competition ranks for a board prefix sorted ascending by score: an entry's
 * rank is 1 + the number of strictly better scores, so equal scores share the
 * rank of the first of them and the next distinct score skips ahead.
 */
export function competitionRanks(top: readonly Pick<StoredRun, 'score'>[]): number[] {
  const ranks: number[] = [];
  for (let i = 0; i < top.length; i++) {
    ranks.push(i > 0 && top[i].score === top[i - 1].score ? ranks[i - 1] : i + 1);
  }
  return ranks;
}

export function toEntry(run: StoredRun, rank: number, secret: string, viewerId?: string): LeaderboardEntry {
  return {
    rank,
    runId: run.runId,
    playerTag: playerTag(run.playerId, secret),
    you: viewerId !== undefined && run.playerId === viewerId,
    name: run.name,
    score: run.score,
    ticks: run.ticks,
    shards: run.shards,
    deaths: run.deaths,
    cleared: run.cleared,
    height: run.height,
    createdAt: run.createdAt,
  };
}

export function leaderboardRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get('/leaderboard', async (req, reply) => {
    const parsed = LeaderboardQuery.safeParse(req.query);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);
    const { mode, board, limit } = parsed.data;
    const secret = tagSecretFor(deps.dailySecret);

    const top = await deps.repo.topRuns(mode, board, limit);
    const ranks = competitionRanks(top);
    // No viewer: `you` is false for everyone, and the page is identical for every caller.
    const entries = top.map((run, i) => toEntry(run, ranks[i], secret));
    const total = await boardTotal(deps.repo, mode, board);

    reply.header('cache-control', LEADERBOARD_CACHE_CONTROL);
    const body: LeaderboardResponse = { mode, board, total, entries };
    return body;
  });
}
