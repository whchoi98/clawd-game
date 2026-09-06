/**
 * POST /api/runs — submit a replay. Body ≤ 96 KB (64 KB of base64 masks plus
 * metadata). 400 on schema failure, 429 when the IP or the player is over
 * budget, 422 with a RejectReason when the run is not eligible or does not
 * verify.
 *
 * Verification is the most expensive thing this server does, so the route has
 * its own per-IP budget (RUNS_PER_IP_PER_MINUTE) on top of the global one, and
 * the player budget is keyed by `ip:playerId`.
 */
import type { FastifyInstance } from 'fastify';
import { RunSubmit } from '../../shared/protocol.js';
import { clientIp } from '../ip.js';
import { playerTag } from '../players.js';
import { PlayerLimiter, submitRun } from '../runs.js';
import type { AppDeps } from '../types.js';
import { badRequest } from './parse.js';

export const RUN_BODY_LIMIT = 96 * 1024;
/** Replay verifications one viewer address may request per minute. */
export const RUNS_PER_IP_PER_MINUTE = 12;
const WINDOW_MS = 60_000;

export function runsRoute(app: FastifyInstance, deps: AppDeps, limiter: PlayerLimiter): void {
  app.post('/runs', {
    bodyLimit: RUN_BODY_LIMIT,
    config: {
      rateLimit: {
        max: RUNS_PER_IP_PER_MINUTE,
        timeWindow: WINDOW_MS,
        keyGenerator: clientIp,
        errorResponseBuilder: (_req, ctx) => ({
          statusCode: ctx.statusCode,
          message: 'rate-limited',
          detail: { scope: 'ip-runs', retryAfter: Math.ceil(ctx.ttl / 1000) },
        }),
      },
    },
  }, async (req, reply) => {
    const parsed = RunSubmit.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);
    const { player } = parsed.data;

    const budget = limiter.hit(`${clientIp(req)}:${player.id}`);
    if (!budget.ok) {
      return reply
        .code(429)
        .header('retry-after', String(budget.retryAfterSec))
        .send({ error: 'rate-limited', detail: { scope: 'player', retryAfter: budget.retryAfterSec } });
    }

    const out = await submitRun(deps, parsed.data);
    if (out.status !== 200) {
      req.log.info({
        playerTag: playerTag(player.id, deps.dailySecret),
        mode: parsed.data.mode,
        levelId: parsed.data.levelId,
        reason: out.body.accepted ? undefined : out.body.reason,
      }, 'run rejected');
    }
    return reply.code(out.status).send(out.body);
  });
}
