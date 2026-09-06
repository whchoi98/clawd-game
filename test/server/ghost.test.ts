import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GhostResponse } from '../../src/shared/protocol.js';
import { FIX_T1, MASKS_B64, makeApp, postRun, submitBody } from './fixtures.js';

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
});
