import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { HealthResponse } from '../../src/shared/protocol.js';
import { GEN_VERSION, SIM_VERSION } from '../../src/sim/types.js';
import { makeApp } from './fixtures.js';

vi.mock('../../src/server/levels.js', async () => ({ resolveLevel: (await import('./levelfix.js')).fakeResolveLevel }));

describe('health routes', () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  beforeAll(async () => { ctx = await makeApp({ version: 'v-test' }); });
  afterAll(async () => { await ctx.app.close(); });

  it('GET /healthz answers 200 text/plain "ok"', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.body).toBe('ok');
  });

  it('GET /api/health satisfies HealthResponse and reports the version', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = HealthResponse.parse(res.json());
    expect(body.ok).toBe(true);
    expect(body.version).toBe('v-test');
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });

  it('GET /api/health reports the sim and generator versions this build verifies against', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/health' });
    const body = HealthResponse.parse(res.json());
    expect(body.simVersion).toBe(SIM_VERSION);
    expect(body.genVersion).toBe(GEN_VERSION);
    expect(body.simVersion).toBe(3);
  });

  it('API responses are marked no-store', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('unknown API paths answer 404 JSON', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not-found' });
  });
});
