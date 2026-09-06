import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { GhostResponse } from '../../src/shared/protocol.js';
import { GHOSTS_PER_IP_PER_MINUTE } from '../../src/server/routes/ghost.js';
import { FIX_T1, MASKS_B64, makeApp, postRun, submitBody, uniqueMasks } from './fixtures.js';

vi.mock('../../src/server/levels.js', async () => ({ resolveLevel: (await import('./levelfix.js')).fakeResolveLevel }));

describe('GET /api/ghost/:runId', () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  beforeAll(async () => { ctx = await makeApp(); });
  afterAll(async () => { await ctx.app.close(); });

  it('answers 404 { error: not-found } for an unknown run', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/ghost/00000000-0000-4000-8000-000000000000' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not-found' });
  });

  it('rejects malformed ids with 400', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `/api/ghost/${encodeURIComponent('<script>')}` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad-request');
  });

  it('returns the stored replay of an accepted run', async () => {
    const accepted = (await postRun(ctx.app, submitBody())).json();
    expect(accepted.accepted).toBe(true);
    const res = await ctx.app.inject({ method: 'GET', url: `/api/ghost/${accepted.runId}` });
    expect(res.statusCode).toBe(200);
    const body = GhostResponse.parse(res.json());
    expect(body).toEqual({
      runId: accepted.runId, mode: 'story', board: 't1', levelId: 't1', seed: FIX_T1.seed,
      assist: false, masks: MASKS_B64, name: '클로드', ticks: 720,
    });
  });

  it('a delisted (flagged) run answers 404 like an unknown one', async () => {
    const accepted = (await postRun(ctx.app, submitBody({ player: { id: 'flagged-player-1', name: '깃발' }, masks: uniqueMasks() }))).json();
    expect(accepted.accepted).toBe(true);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/ghost/${accepted.runId}` })).statusCode).toBe(200);
    expect(await ctx.repo.delistRun(accepted.runId)).toBe(true);
    const res = await ctx.app.inject({ method: 'GET', url: `/api/ghost/${accepted.runId}` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not-found' });
  });
});

describe('GET /api/ghost rate limit', () => {
  const apps: Awaited<ReturnType<typeof makeApp>>[] = [];
  afterEach(async () => { while (apps.length) await apps.pop()!.app.close(); });

  it(`answers 429 ip-ghost after ${GHOSTS_PER_IP_PER_MINUTE} lookups per minute from one address, independently of the global budget`, async () => {
    const c = await makeApp({ rateLimit: { perIp: 10_000, perPlayer: 10_000 } });
    apps.push(c);
    const ip = { 'x-forwarded-for': '203.0.113.90' };
    const accepted = (await postRun(c.app, submitBody())).json();
    for (let i = 0; i < GHOSTS_PER_IP_PER_MINUTE; i++) {
      expect((await c.app.inject({ method: 'GET', url: `/api/ghost/${accepted.runId}`, headers: ip })).statusCode).toBe(200);
    }
    const blocked = await c.app.inject({ method: 'GET', url: `/api/ghost/${accepted.runId}`, headers: ip });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toBe('rate-limited');
    expect(blocked.json().detail.scope).toBe('ip-ghost');
    expect(blocked.headers['retry-after']).toBeDefined();
    // other routes from the same address, and other addresses, keep their budgets
    expect((await c.app.inject({ method: 'GET', url: '/api/leaderboard?mode=story&board=t1', headers: ip })).statusCode).toBe(200);
    expect((await c.app.inject({ method: 'GET', url: `/api/ghost/${accepted.runId}`, headers: { 'x-forwarded-for': '198.51.100.44' } })).statusCode).toBe(200);
  });
});
