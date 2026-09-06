/**
 * POST /api/runs — submit a replay. Body ≤ 96 KB (64 KB of base64 masks plus
 * metadata). 400 on schema failure, 429 when the player is over budget,
 * 422 with a reason when the run is not eligible or does not verify.
 */
import type { FastifyInstance } from 'fastify';
import { RunSubmit } from '../../shared/protocol.js';
import { PlayerLimiter, submitRun } from '../runs.js';
import type { AppDeps } from '../types.js';
import { badRequest } from './parse.js';

export const RUN_BODY_LIMIT = 96 * 1024;

export function runsRoute(app: FastifyInstance, deps: AppDeps, limiter: PlayerLimiter): void {
  app.post('/runs', { bodyLimit: RUN_BODY_LIMIT }, async (req, reply) => {
    const parsed = RunSubmit.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);

    const budget = limiter.hit(parsed.data.player.id);
    if (!budget.ok) {
      return reply
        .code(429)
        .header('retry-after', String(budget.retryAfterSec))
        .send({ error: 'rate-limited', detail: { scope: 'player', retryAfter: budget.retryAfterSec } });
    }

    const out = await submitRun(deps, parsed.data);
    if (out.status !== 200) {
      req.log.info({ playerId: parsed.data.player.id, mode: parsed.data.mode, levelId: parsed.data.levelId, reason: out.body.accepted ? undefined : out.body.reason }, 'run rejected');
    }
    return reply.code(out.status).send(out.body);
  });
}
