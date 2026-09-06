/**
 * GET /api/ghost/:runId — the stored replay of a verified run, for echo
 * playback. Replays are the largest thing the API hands out, so the route has
 * its own per-IP budget (GHOSTS_PER_IP_PER_MINUTE). A run the admin CLI has
 * delisted (`flagged`) is gone from here too: 404.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { GhostResponse } from '../../shared/protocol.js';
import { clientIp } from '../ip.js';
import type { AppDeps } from '../types.js';
import { badRequest } from './parse.js';

const Params = z.object({ runId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) });

/** Replays one viewer address may fetch per minute. */
export const GHOSTS_PER_IP_PER_MINUTE = 60;
const WINDOW_MS = 60_000;

export function ghostRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get('/ghost/:runId', {
    config: {
      rateLimit: {
        max: GHOSTS_PER_IP_PER_MINUTE,
        timeWindow: WINDOW_MS,
        keyGenerator: clientIp,
        errorResponseBuilder: (_req, ctx) => ({
          statusCode: ctx.statusCode,
          message: 'rate-limited',
          detail: { scope: 'ip-ghost', retryAfter: Math.ceil(ctx.ttl / 1000) },
        }),
      },
    },
  }, async (req, reply) => {
    const parsed = Params.safeParse(req.params);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);

    const run = await deps.repo.getRun(parsed.data.runId);
    if (!run || run.flagged) return reply.code(404).send({ error: 'not-found' });

    const body: GhostResponse = {
      runId: run.runId,
      mode: run.mode,
      board: run.board,
      levelId: run.levelId,
      seed: run.seed,
      assist: run.assist,
      masks: run.masks,
      name: run.name,
      ticks: run.ticks,
    };
    return body;
  });
}
