/**
 * GET /api/me?mode&board&playerId — the caller's own board row (P3-12).
 *
 * /api/leaderboard is public and cached at the edge for a few seconds, so it
 * can no longer carry anything personal. This route answers the personal half
 * — the player's best with its competition rank and the board total — and is
 * never cached (`Cache-Control: no-store`, the API default).
 *
 * Reads: GetItem (player best) + one bounded COUNT (strictly better, at most
 * RANK_CAP) + GetItem (board counter). A rank the count could not finish is
 * reported as `rankCapped: true` with `rank = RANK_CAP + 1`; the UI shows it
 * as "1000위 밖". `playerId` is required here (400 without it).
 */
import type { FastifyInstance } from 'fastify';
import { LeaderboardQuery, type MeResponse } from '../../shared/protocol.js';
import { tagSecretFor } from '../players.js';
import { boardTotal, rankBounded } from '../repo/extras.js';
import type { AppDeps } from '../types.js';
import { toEntry } from './leaderboard.js';
import { badRequest } from './parse.js';

/** Strictly-better entries counted before the rank is reported as capped. */
export const RANK_CAP = 1000;

export function meRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get('/me', async (req, reply) => {
    const parsed = LeaderboardQuery.safeParse(req.query);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);
    const { mode, board, playerId } = parsed.data;
    if (!playerId) return badRequest(reply, [{ path: ['playerId'], message: 'Required' }]);
    const secret = tagSecretFor(deps.dailySecret);

    const best = await deps.repo.getPlayerBest(playerId, mode, board);
    const body: MeResponse = { mode, board, total: 0 };
    if (best) {
      const rank = await rankBounded(deps.repo, mode, board, best.score, RANK_CAP);
      body.yours = toEntry(best, rank.better + 1, secret, playerId);
      body.rankCapped = rank.capped;
    }
    body.total = await boardTotal(deps.repo, mode, board);
    // Personal: never shared between viewers, never kept by the edge.
    reply.header('cache-control', 'no-store');
    return body;
  });
}
