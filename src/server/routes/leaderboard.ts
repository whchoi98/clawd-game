/** GET /api/leaderboard?mode&board&limit&playerId — top runs plus the caller's own best and rank. */
import type { FastifyInstance } from 'fastify';
import { LeaderboardQuery, type LeaderboardEntry, type LeaderboardResponse } from '../../shared/protocol.js';
import type { StoredRun } from '../repo/types.js';
import type { AppDeps } from '../types.js';
import { badRequest } from './parse.js';

export function toEntry(run: StoredRun, rank: number): LeaderboardEntry {
  return {
    rank,
    runId: run.runId,
    playerId: run.playerId,
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
    const entries = top.map((run, i) => toEntry(run, i + 1));

    let yours: LeaderboardEntry | undefined;
    let total: number;
    const best = playerId ? await deps.repo.getPlayerBest(playerId, mode, board) : null;
    if (best) {
      const rank = await deps.repo.rankOf(mode, board, best.score);
      yours = toEntry(best, rank.better + 1);
      total = rank.total;
    } else {
      total = (await deps.repo.rankOf(mode, board, 0)).total;
    }

    const body: LeaderboardResponse = { mode, board, total, entries };
    if (yours) body.yours = yours;
    return body;
  });
}
