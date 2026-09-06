/**
 * Fastify composition. `buildApp(deps)` wires routes, rate limiting, static
 * serving and the uniform `{ error, detail }` error shape; deps are injected so
 * tests run against MemoryRepo, a fixed clock and a stub verifier.
 *
 * Layout:
 *   /healthz          root context — no rate limit, no request log
 *   /api/*            encapsulated context with @fastify/rate-limit (per IP;
 *                     POST /runs carries its own tighter budget), @fastify/compress
 *                     (br/gzip over 1 KB — CloudFront does not compress under
 *                     CachingDisabled), Cache-Control: no-store on every response
 *   /* (static)       root context, only when deps.staticDir is set
 */
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import compress from '@fastify/compress';
import { API_PREFIX, type ErrorResponse } from '../shared/protocol.js';
import type { AppDeps, BuildApp } from './types.js';
import { clientIp } from './ip.js';
import { PlayerLimiter } from './runs.js';
import { registerStatic } from './static.js';
import { apiHealthRoute, healthzRoute } from './routes/health.js';
import { dailyRoute } from './routes/daily.js';
import { RUN_BODY_LIMIT, runsRoute } from './routes/runs.js';
import { leaderboardRoute } from './routes/leaderboard.js';
import { ghostRoute } from './routes/ghost.js';

export { clientIp } from './ip.js';

export const DEFAULT_RATE_LIMIT = { perIp: 120, perPlayer: 10 } as const;
/** Responses at or above this size are compressed when the client accepts it. */
export const COMPRESS_THRESHOLD = 1024;
const WINDOW_MS = 60_000;

function errorName(status: number): string {
  if (status === 404) return 'not-found';
  if (status === 413) return 'too-large';
  if (status === 415) return 'unsupported-media-type';
  if (status === 429) return 'rate-limited';
  if (status >= 500) return 'internal';
  return 'bad-request';
}

export const buildApp: BuildApp = async (deps: AppDeps): Promise<FastifyInstance> => {
  const limits = deps.rateLimit ?? DEFAULT_RATE_LIMIT;
  const app = Fastify({
    logger: deps.logger ?? false,
    trustProxy: true,
    bodyLimit: RUN_BODY_LIMIT,
    requestIdHeader: 'x-amzn-trace-id',
  });

  app.setErrorHandler((err, req, reply) => {
    const raw = (err as { statusCode?: number }).statusCode;
    const status = typeof raw === 'number' && raw >= 400 && raw < 600 ? raw : 500;
    if (status >= 500) req.log.error({ err }, 'unhandled error');
    const body: ErrorResponse = { error: errorName(status) };
    if (status < 500) {
      const detail = (err as { detail?: unknown }).detail ?? (err as { message?: string }).message;
      if (detail !== undefined) body.detail = detail;
    }
    reply.code(status).send(body);
  });

  app.setNotFoundHandler((_req, reply) => {
    const body: ErrorResponse = { error: 'not-found' };
    reply.code(404).send(body);
  });

  healthzRoute(app);

  const playerLimiter = new PlayerLimiter(limits.perPlayer, WINDOW_MS);
  await app.register(async (api) => {
    await api.register(rateLimit, {
      global: true,
      max: limits.perIp,
      timeWindow: WINDOW_MS,
      keyGenerator: clientIp,
      errorResponseBuilder: (_req, ctx) => ({
        statusCode: ctx.statusCode,
        message: 'rate-limited',
        detail: { scope: 'ip', retryAfter: Math.ceil(ctx.ttl / 1000) },
      }),
    });
    await api.register(compress, { global: true, threshold: COMPRESS_THRESHOLD, encodings: ['br', 'gzip'] });
    api.addHook('onSend', async (_req, reply) => {
      reply.header('cache-control', 'no-store');
    });
    apiHealthRoute(api, deps);
    dailyRoute(api, deps);
    runsRoute(api, deps, playerLimiter);
    leaderboardRoute(api, deps);
    ghostRoute(api, deps);
  }, { prefix: API_PREFIX });

  if (deps.staticDir) await registerStatic(app, deps.staticDir);

  return app;
};
