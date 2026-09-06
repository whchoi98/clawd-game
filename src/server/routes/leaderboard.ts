/**
 * GET /api/leaderboard?mode&board&limit&playerId — top runs plus the caller's
 * own best and rank. Ranks are competition ranks (1 + strictly better scores;
 * ties share). Players appear as `playerTag` (HMAC of the id) and `you`; the
 * raw player id is a credential and never appears in a response.
 */
import type { FastifyInstance } from 'fastify';
import { LeaderboardQuery, type LeaderboardEntry, type LeaderboardResponse } from '../../shared/protocol.js';
import { playerTag } from '../players.js';
import type { StoredRun } from '../repo/types.js';
import type { AppDeps } from '../types.js';
import { badRequest } from './parse.js';

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
    const { mode, board, limit, playerId } = parsed.data;

    const top = await deps.repo.topRuns(mode, board, limit);
    const ranks = competitionRanks(top);
    const entries = top.map((run, i) => toEntry(run, ranks[i], deps.dailySecret, playerId));

    let yours: LeaderboardEntry | undefined;
    let total: number;
    const best = playerId ? await deps.repo.getPlayerBest(playerId, mode, board) : null;
    if (best) {
      const rank = await deps.repo.rankOf(mode, board, best.score);
      yours = toEntry(best, rank.better + 1, deps.dailySecret, playerId);
      total = rank.total;
    } else {
      total = (await deps.repo.rankOf(mode, board, 0)).total;
    }

    const body: LeaderboardResponse = { mode, board, total, entries };
    if (yours) body.yours = yours;
    return body;
  });
}
