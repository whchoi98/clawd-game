/**
 * Progress transfer (P3-5).
 *
 *   POST /api/transfer          TransferCreateRequest → 200 TransferCreateResponse { code, expiresAt }
 *                               400 bad-request (schema) · 400 bad-name · 413 too-large (progress JSON over
 *                               MAX_TRANSFER_BYTES, or the whole body over the route limit) · 429 (5/min per IP)
 *   GET  /api/transfer/:code    200 TransferGetResponse { playerId, name, progress } — once
 *                               400 bad-code (shape or check character; the store is never asked)
 *                               410 gone (unknown, already used, expired) · 429 (5/min per IP)
 *
 * The snapshot is stored as one JSON blob `{ name, progress }` under the
 * player's item with a 7-day ttl; the code item points at it and is consumed
 * by a conditional delete, so a code restores exactly one device. The check
 * character is an HMAC under the tag secret (TAG_SECRET, else DAILY_SECRET).
 * Progress is never trusted for boards — it goes back to a client as-is.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  MAX_TRANSFER_BYTES, TransferCreateRequest, type TransferCreateResponse, type TransferGetResponse,
} from '../../shared/protocol.js';
import { isBadName } from '../../shared/names.js';
import { clientIp } from '../ip.js';
import { tagSecretFor } from '../players.js';
import {
  decodeSnapshot, encodeSnapshot, isValidCode, makeTransferCode, normalizeCode, overSnapshotCap, transferExpiry,
} from '../transfer.js';
import type { AppDeps } from '../types.js';
import { badRequest } from './parse.js';

/** Requests (create or restore) one viewer address may make per minute. */
export const TRANSFER_PER_IP_PER_MINUTE = 5;
/** Progress cap plus the player record and JSON framing. */
export const TRANSFER_BODY_LIMIT = MAX_TRANSFER_BYTES + 2048;
const WINDOW_MS = 60_000;

const Params = z.object({ code: z.string().min(1).max(32) });

const rateLimit = {
  max: TRANSFER_PER_IP_PER_MINUTE,
  timeWindow: WINDOW_MS,
  keyGenerator: clientIp,
  errorResponseBuilder: (_req: unknown, ctx: { statusCode: number; ttl: number }) => ({
    statusCode: ctx.statusCode,
    message: 'rate-limited',
    detail: { scope: 'ip-transfer', retryAfter: Math.ceil(ctx.ttl / 1000) },
  }),
};

export function transferRoute(app: FastifyInstance, deps: AppDeps): void {
  app.post('/transfer', { bodyLimit: TRANSFER_BODY_LIMIT, config: { rateLimit } }, async (req, reply) => {
    const parsed = TransferCreateRequest.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);
    const { player, progress } = parsed.data;
    if (isBadName(player.name)) return reply.code(400).send({ error: 'bad-name' });
    if (overSnapshotCap(progress)) return reply.code(413).send({ error: 'too-large' });
    const put = deps.repo.putSnapshot;
    if (!put) return reply.code(503).send({ error: 'unavailable' });

    const now = deps.now();
    const { ttl, expiresAt } = transferExpiry(now);
    const code = makeTransferCode(tagSecretFor(deps.dailySecret));
    await put.call(deps.repo, player.id, code, encodeSnapshot({ name: player.name, progress }), ttl);
    const body: TransferCreateResponse = { code, expiresAt };
    return body;
  });

  app.get('/transfer/:code', { config: { rateLimit } }, async (req, reply) => {
    const parsed = Params.safeParse(req.params);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);
    const code = normalizeCode(parsed.data.code);
    if (!isValidCode(code, tagSecretFor(deps.dailySecret))) return reply.code(400).send({ error: 'bad-code' });
    const take = deps.repo.takeSnapshot;
    if (!take) return reply.code(503).send({ error: 'unavailable' });

    const snap = await take.call(deps.repo, code);
    const blob = snap ? decodeSnapshot(snap.blob) : null;
    if (!snap || !blob) return reply.code(410).send({ error: 'gone' });
    const body: TransferGetResponse = { playerId: snap.playerId, name: blob.name, progress: blob.progress };
    return body;
  });
}
