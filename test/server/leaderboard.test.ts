import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LeaderboardResponse } from '../../src/shared/protocol.js';
import { makeApp, postRun, submitBody } from './fixtures.js';

vi.mock('./sim.js', () => ({ Sim: class {} }));
vi.mock('../../src/server/levels.js', async () => ({ resolveLevel: (await import('./levelfix.js')).fakeResolveLevel }));

describe('GET /api/leaderboard', () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  beforeAll(async () => {
    ctx = await makeApp();
    const players = [['p-alpha-000', 700], ['p-bravo-000', 500], ['p-charlie-0', 900], ['p-delta-000', 600]] as const;
    for (const [id, ticks] of players) {
      const res = await postRun(ctx.app, submitBody({ player: { id, name: id.slice(2, 7) }, claim: { ticks } }));
      expect(res.statusCode).toBe(200);
    }
  });
  afterAll(async () => { await ctx.app.close(); });

  it('lists entries fastest first with 1-based ranks', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/leaderboard?mode=story&board=t1' });
    expect(res.statusCode).toBe(200);
    const body = LeaderboardResponse.parse(res.json());
    expect(body.mode).toBe('story');
    expect(body.board).toBe('t1');
    expect(body.total).toBe(4);
    expect(body.entries.map((e) => e.rank)).toEqual([1, 2, 3, 4]);
    expect(body.entries.map((e) => e.ticks)).toEqual([500, 600, 700, 900]);
    expect(body.entries[0].playerId).toBe('p-bravo-000');
    expect(body.entries[0].name).toBe('bravo');
    expect(body.yours).toBeUndefined();
  });

  it('honours limit while reporting the full total', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/leaderboard?mode=story&board=t1&limit=2' });
    const body = LeaderboardResponse.parse(res.json());
    expect(body.entries).toHaveLength(2);
    expect(body.total).toBe(4);
  });

  it('populates yours with the rank of the player best when playerId is given', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/leaderboard?mode=story&board=t1&limit=1&playerId=p-charlie-0' });
    const body = LeaderboardResponse.parse(res.json());
    expect(body.entries).toHaveLength(1);
    expect(body.yours).toBeDefined();
    expect(body.yours!.rank).toBe(4);
    expect(body.yours!.ticks).toBe(900);
    expect(body.yours!.playerId).toBe('p-charlie-0');
  });

  it('leaves yours undefined for an unknown player', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/leaderboard?mode=story&board=t1&playerId=nobody-here' });
    const body = LeaderboardResponse.parse(res.json());
    expect(body.yours).toBeUndefined();
    expect(body.total).toBe(4);
  });

  it('returns an empty board with total 0', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/leaderboard?mode=daily&board=2026-09-06' });
    const body = LeaderboardResponse.parse(res.json());
    expect(body.entries).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('rejects a bad query with 400 { error, detail }', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/leaderboard?mode=turbo&board=t1' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad-request');
    expect(res.json().detail).toBeDefined();
    const tooMany = await ctx.app.inject({ method: 'GET', url: '/api/leaderboard?mode=story&board=t1&limit=999' });
    expect(tooMany.statusCode).toBe(400);
  });
});
