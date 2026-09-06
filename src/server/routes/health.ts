/**
 * GET /healthz      — ALB target health check: plain "ok", not rate limited, not request-logged.
 * GET /api/health   — HealthResponse for humans and the post-deploy smoke test;
 *                     carries the sim / generator versions this build verifies
 *                     against so clients can tell they are stale.
 */
import type { FastifyInstance } from 'fastify';
import type { HealthResponse } from '../../shared/protocol.js';
import { GEN_VERSION, SIM_VERSION } from '../../sim/types.js';
import type { AppDeps } from '../types.js';

export function healthzRoute(app: FastifyInstance): void {
  app.get('/healthz', { logLevel: 'warn', config: { rateLimit: false } }, async (_req, reply) => {
    return reply.type('text/plain; charset=utf-8').send('ok');
  });
}

export function apiHealthRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get('/health', async () => {
    const body: HealthResponse = {
      ok: true,
      version: deps.version,
      uptime: Math.round(process.uptime() * 1000) / 1000,
      simVersion: SIM_VERSION,
      genVersion: GEN_VERSION,
    };
    const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
    if (region) body.region = region;
    return body;
  });
}
