/** Shared 400 shape for zod failures: `{ error: 'bad-request', detail: issues }`. */
import type { FastifyReply } from 'fastify';
import type { ErrorResponse } from '../../shared/protocol.js';

export function badRequest(reply: FastifyReply, detail: unknown): FastifyReply {
  const body: ErrorResponse = { error: 'bad-request', detail };
  return reply.code(400).send(body);
}
