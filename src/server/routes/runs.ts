/**
 * POST /api/runs — submit a replay. Body ≤ 96 KB (64 KB of base64 masks plus
 * metadata). 400 on schema failure or a blocklisted display name
 * ({ error: 'bad-name' }), 429 when the IP or the player is over budget, 422
 * with a RejectReason when the run is not eligible, does not verify or is a
 * copy of another player's replay ('duplicate'), 503 { error: 'busy' } with
 * `Retry-After: 3` when the verification pool is at capacity (P3-12).
 *
 * Verification is the most expensive thing this server does, so the route has
 * its own per-IP budget (RUNS_PER_IP_PER_MINUTE) on top of the global one —
 * counted for the whole fleet through the repo (`SubmitLimiter`, DynamoDB
 * `RL#<ip>#<minute>`) and checked in an onRequest hook, before the body is
 * parsed — and the player budget is keyed by `ip:playerId`. The service's
 * structured lines (VerifyMs metric, hx heuristics) go to the instance logger
 * unless a sink is injected.
 */
import type { FastifyInstance } from 'fastify';
import { RunSubmit } from '../../shared/protocol.js';
import { isBadName } from '../../shared/names.js';
import { clientIp } from '../ip.js';
import type { LogSink } from '../metrics.js';
import { playerTag, tagSecretFor } from '../players.js';
import { PlayerLimiter, submitRun } from '../runs.js';
import { SubmitLimiter } from '../submitLimit.js';
import type { AppDeps } from '../types.js';
import { VERIFY_BUSY_RETRY_AFTER_SEC, isVerifyBusy } from '../verifyPool.js';
import { badRequest } from './parse.js';

export const RUN_BODY_LIMIT = 96 * 1024;
/** Replay verifications one viewer address may request per minute — across every task. */
export const RUNS_PER_IP_PER_MINUTE = 12;

export interface RunsRouteOptions {
  /** Overrides the default sink (instance logger, info) for metric / hx lines. */
  sink?: LogSink;
  /** Overrides the per-IP limiter (default: SubmitLimiter over deps.repo, RUNS_PER_IP_PER_MINUTE). */
  ipLimiter?: SubmitLimiter;
}

export function runsRoute(app: FastifyInstance, deps: AppDeps, limiter: PlayerLimiter, opts: RunsRouteOptions = {}): void {
  const sink: LogSink = opts.sink ?? ((record, msg) => { app.log.info(record, msg); });
  const ipLimiter = opts.ipLimiter ?? new SubmitLimiter(deps.repo, RUNS_PER_IP_PER_MINUTE, {
    now: () => deps.now().getTime(),
    log: (record, msg) => { app.log.warn(record, msg); },
  });

  app.post('/runs', {
    bodyLimit: RUN_BODY_LIMIT,
    // Per-IP budget before the body is even parsed: a flood costs one counter increment, not a JSON parse.
    onRequest: async (req, reply) => {
      const budget = await ipLimiter.hit(clientIp(req));
      if (budget.ok) return;
      reply
        .code(429)
        .header('retry-after', String(budget.retryAfterSec))
        .send({ error: 'rate-limited', detail: { scope: 'ip-runs', retryAfter: budget.retryAfterSec } });
      return reply;
    },
  }, async (req, reply) => {
    const parsed = RunSubmit.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);
    const { player } = parsed.data;
    if (isBadName(player.name)) return reply.code(400).send({ error: 'bad-name' });

    const budget = limiter.hit(`${clientIp(req)}:${player.id}`);
    if (!budget.ok) {
      return reply
        .code(429)
        .header('retry-after', String(budget.retryAfterSec))
        .send({ error: 'rate-limited', detail: { scope: 'player', retryAfter: budget.retryAfterSec } });
    }

    let out;
    try {
      out = await submitRun({ ...deps, log: sink }, parsed.data);
    } catch (err) {
      if (!isVerifyBusy(err)) throw err;
      // The verification pool is full (or its worker is restarting): ask for a retry, never queue unboundedly.
      req.log.warn({ reason: err.reason, mode: parsed.data.mode, levelId: parsed.data.levelId }, 'run deferred: verify busy');
      const retryAfter = err.retryAfterSec || VERIFY_BUSY_RETRY_AFTER_SEC;
      return reply
        .code(503)
        .header('retry-after', String(retryAfter))
        .send({ error: 'busy', detail: { retryAfter } });
    }
    if (out.status !== 200) {
      req.log.info({
        playerTag: playerTag(player.id, tagSecretFor(deps.dailySecret)),
        mode: parsed.data.mode,
        levelId: parsed.data.levelId,
        reason: out.body.accepted ? undefined : out.body.reason,
      }, 'run rejected');
    }
    return reply.code(out.status).send(out.body);
  });
}
