/** GET /api/ghost/:runId — the stored replay of a verified run, for echo playback. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { GhostResponse } from '../../shared/protocol.js';
import type { AppDeps } from '../types.js';
import { badRequest } from './parse.js';

const Params = z.object({ runId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) });

export function ghostRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get('/ghost/:runId', async (req, reply) => {
    const parsed = Params.safeParse(req.params);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);

    const run = await deps.repo.getRun(parsed.data.runId);
    if (!run) return reply.code(404).send({ error: 'not-found' });

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
