import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LeaderboardResponse } from '../../src/shared/protocol.js';
import { playerTag } from '../../src/server/players.js';
import { competitionRanks } from '../../src/server/routes/leaderboard.js';
import { SECRET, makeApp, postRun, submitBody } from './fixtures.js';

vi.mock('../../src/server/levels.js', async () => ({ resolveLevel: (await import('./levelfix.js')).fakeResolveLevel }));

describe('GET /api/leaderboard', () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  const players = [['p-alpha-000', 700], ['p-bravo-000', 500], ['p-charlie-0', 900], ['p-delta-000', 600]] as const;
  beforeAll(async () => {
    ctx = await makeApp();
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
    expect(body.entries[0].playerTag).toBe(playerTag('p-bravo-000', SECRET));
    expect(body.entries[0].name).toBe('bravo');
    expect(body.yours).toBeUndefined();
  });

  it('never exposes a player id: entries carry a 12-hex HMAC tag and `you`', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/leaderboard?mode=story&board=t1&playerId=p-charlie-0' });
    const raw = res.body;
    for (const [id] of players) expect(raw).not.toContain(id);
    expect(raw).not.toContain('playerId');
    const body = LeaderboardResponse.parse(res.json());
    for (const e of [...body.entries, body.yours!]) {
      expect(e.playerTag).toMatch(/^[a-f0-9]{12}$/);
      expect(e).not.toHaveProperty('playerId');
    }
    expect(body.entries.map((e) => e.you)).toEqual([false, false, false, true]);
    expect(body.yours!.you).toBe(true);
    // the tag is a keyed HMAC: stable per player, different under another secret
    expect(body.yours!.playerTag).toBe(playerTag('p-charlie-0', SECRET));
    expect(playerTag('p-charlie-0', 'other-secret')).not.toBe(body.yours!.playerTag);
    expect(playerTag('p-charlie-0', SECRET)).not.toBe(playerTag('p-charlie-1', SECRET));
  });

  it('marks nobody as `you` without a playerId', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/leaderboard?mode=story&board=t1' });
    const body = LeaderboardResponse.parse(res.json());
    expect(body.entries.every((e) => e.you === false)).toBe(true);
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
    expect(body.yours!.playerTag).toBe(playerTag('p-charlie-0', SECRET));
    expect(body.yours!.you).toBe(true);
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

describe('ties', () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  beforeAll(async () => {
    ctx = await makeApp();
    const runs = [
      ['tie-alpha-00', 500, 3], ['tie-bravo-00', 500, 7], ['tie-charlie', 500, 3], ['tie-delta-00', 700, 9], ['tie-echo-000', 700, 1],
    ] as const;
    for (const [id, ticks, shards] of runs) {
      expect((await postRun(ctx.app, submitBody({ player: { id, name: id.slice(4, 9) }, claim: { ticks, shards } }))).statusCode).toBe(200);
    }
  });
  afterAll(async () => { await ctx.app.close(); });

  it('competitionRanks: equal scores share a rank and the next distinct score skips ahead', () => {
    expect(competitionRanks([])).toEqual([]);
    expect(competitionRanks([{ score: 1 }, { score: 2 }, { score: 3 }])).toEqual([1, 2, 3]);
    expect(competitionRanks([{ score: 5 }, { score: 5 }, { score: 5 }, { score: 9 }, { score: 9 }, { score: 12 }])).toEqual([1, 1, 1, 4, 4, 6]);
  });

  it('lists tied scores with the same rank, more shards first', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/leaderboard?mode=story&board=t1' });
    const body = LeaderboardResponse.parse(res.json());
    expect(body.entries.map((e) => e.rank)).toEqual([1, 1, 1, 4, 4]);
    expect(body.entries.map((e) => e.ticks)).toEqual([500, 500, 500, 700, 700]);
    expect(body.entries[0].shards).toBe(7);
    expect(body.entries[3].shards).toBe(9);
  });

  it('yours.rank is the same competition rank the list shows', async () => {
    for (const [id, rank] of [['tie-charlie', 1], ['tie-echo-000', 4]] as const) {
      const res = await ctx.app.inject({ method: 'GET', url: `/api/leaderboard?mode=story&board=t1&limit=1&playerId=${id}` });
      const body = LeaderboardResponse.parse(res.json());
      expect(body.yours!.rank).toBe(rank);
      expect(body.yours!.you).toBe(true);
    }
  });
});
