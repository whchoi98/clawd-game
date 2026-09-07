import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LeaderboardResponse, MeResponse } from '../../src/shared/protocol.js';
import { playerTag } from '../../src/server/players.js';
import { DynamoRepo } from '../../src/server/repo/dynamo.js';
import { MemoryRepo } from '../../src/server/repo/memory.js';
import type { Repo } from '../../src/server/repo/types.js';
import { boardTotal, hasBoardTotals, hasRankBounded, hasRateCounters, rankBounded } from '../../src/server/repo/extras.js';
import {
  LEADERBOARD_CACHE_CONTROL, LEADERBOARD_S_MAXAGE, LEADERBOARD_STALE_WHILE_REVALIDATE, competitionRanks,
} from '../../src/server/routes/leaderboard.js';
import { RANK_CAP } from '../../src/server/routes/me.js';
import { FakeClient } from './fakeDynamo.js';
import { SECRET, makeApp, postRun, submitBody, uniqueMasks } from './fixtures.js';

vi.mock('../../src/server/levels.js', async () => ({ resolveLevel: (await import('./levelfix.js')).fakeResolveLevel }));

describe('GET /api/leaderboard (public, edge-cacheable)', () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  const players = [['p-alpha-000', 700], ['p-bravo-000', 500], ['p-charlie-0', 900], ['p-delta-000', 600]] as const;
  beforeAll(async () => {
    ctx = await makeApp();
    for (const [id, ticks] of players) {
      const res = await postRun(ctx.app, submitBody({ player: { id, name: id.slice(2, 7) }, claim: { ticks }, masks: uniqueMasks() }));
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

  it(`is cacheable at the edge: Cache-Control public, s-maxage=${LEADERBOARD_S_MAXAGE}, stale-while-revalidate=${LEADERBOARD_STALE_WHILE_REVALIDATE}`, async () => {
    expect(LEADERBOARD_CACHE_CONTROL).toBe('public, s-maxage=5, stale-while-revalidate=30');
    const res = await ctx.app.inject({ method: 'GET', url: '/api/leaderboard?mode=story&board=t1' });
    expect(res.headers['cache-control']).toBe(LEADERBOARD_CACHE_CONTROL);
    // the API-wide no-store default still covers every other route
    expect((await ctx.app.inject({ method: 'GET', url: '/api/daily' })).headers['cache-control']).toBe('no-store');
    expect((await ctx.app.inject({ method: 'GET', url: '/api/health' })).headers['cache-control']).toBe('no-store');
    // a bad request on the route is not cacheable either
    expect((await ctx.app.inject({ method: 'GET', url: '/api/leaderboard?mode=turbo&board=t1' })).headers['cache-control']).toBe('no-store');
  });

  it('never exposes a player id: entries carry a 12-hex HMAC tag', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/leaderboard?mode=story&board=t1' });
    const raw = res.body;
    for (const [id] of players) expect(raw).not.toContain(id);
    expect(raw).not.toContain('playerId');
    const body = LeaderboardResponse.parse(res.json());
    for (const e of body.entries) {
      expect(e.playerTag).toMatch(/^[a-f0-9]{12}$/);
      expect(e).not.toHaveProperty('playerId');
    }
    // the tag is a keyed HMAC: stable per player, different under another secret
    expect(body.entries[3].playerTag).toBe(playerTag('p-charlie-0', SECRET));
    expect(playerTag('p-charlie-0', 'other-secret')).not.toBe(body.entries[3].playerTag);
    expect(playerTag('p-charlie-0', SECRET)).not.toBe(playerTag('p-charlie-1', SECRET));
  });

  it('carries nothing personal even when a playerId is passed (the page is shared by every viewer): no yours, you always false', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/leaderboard?mode=story&board=t1&playerId=p-charlie-0' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe(LEADERBOARD_CACHE_CONTROL);
    const body = LeaderboardResponse.parse(res.json());
    expect(body.yours).toBeUndefined();
    expect(body.entries.every((e) => e.you === false)).toBe(true);
    expect(res.body).not.toContain('"yours"');
    // byte-identical to the anonymous page, which is what makes it cacheable
    const anon = await ctx.app.inject({ method: 'GET', url: '/api/leaderboard?mode=story&board=t1' });
    expect(res.body).toBe(anon.body);
  });

  it('honours limit while reporting the full total', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/leaderboard?mode=story&board=t1&limit=2' });
    const body = LeaderboardResponse.parse(res.json());
    expect(body.entries).toHaveLength(2);
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

describe('GET /api/me (personal, never cached)', () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  const players = [['p-alpha-000', 700], ['p-bravo-000', 500], ['p-charlie-0', 900], ['p-delta-000', 600]] as const;
  beforeAll(async () => {
    ctx = await makeApp();
    for (const [id, ticks] of players) {
      expect((await postRun(ctx.app, submitBody({ player: { id, name: id.slice(2, 7) }, claim: { ticks }, masks: uniqueMasks() }))).statusCode).toBe(200);
    }
  });
  afterAll(async () => { await ctx.app.close(); });

  it('answers the caller\'s best with its competition rank, you: true, the board total and Cache-Control: no-store', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/me?mode=story&board=t1&playerId=p-charlie-0' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = MeResponse.parse(res.json());
    expect(body).toMatchObject({ mode: 'story', board: 't1', total: 4, rankCapped: false });
    expect(body.yours).toBeDefined();
    expect(body.yours!.rank).toBe(4);
    expect(body.yours!.ticks).toBe(900);
    expect(body.yours!.you).toBe(true);
    expect(body.yours!.playerTag).toBe(playerTag('p-charlie-0', SECRET));
    expect(res.body).not.toContain('p-charlie-0');
    expect(res.body).not.toContain('playerId');
  });

  it('leaves yours undefined (and rankCapped unset) for an unknown player, still reporting the total', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/me?mode=story&board=t1&playerId=nobody-here' });
    expect(res.statusCode).toBe(200);
    const body = MeResponse.parse(res.json());
    expect(body.yours).toBeUndefined();
    expect(body.rankCapped).toBeUndefined();
    expect(body.total).toBe(4);
  });

  it('requires playerId (400) and validates the rest of the query like the leaderboard', async () => {
    const missing = await ctx.app.inject({ method: 'GET', url: '/api/me?mode=story&board=t1' });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toBe('bad-request');
    expect(JSON.stringify(missing.json().detail)).toContain('playerId');
    expect((await ctx.app.inject({ method: 'GET', url: '/api/me?mode=turbo&board=t1&playerId=p-alpha-000' })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/me?mode=story&board=t1&playerId=short' })).statusCode).toBe(400);
  });

  it(`caps the rank at ${RANK_CAP} strictly-better entries and says so with rankCapped`, async () => {
    // A repo whose rank query stops at the cap (the MemoryRepo answer for a board of 1000+ better runs).
    const repo = new MemoryRepo();
    const capped = Object.assign(repo, {
      rankBounded: async (_m: unknown, _b: unknown, _s: number, cap: number) => ({ better: cap, capped: true }),
      boardTotal: async () => 12_345,
    });
    const c = await makeApp({ repo: capped });
    try {
      expect((await postRun(c.app, submitBody({ player: { id: 'p-slow-00000', name: '느림' } }))).statusCode).toBe(200);
      const res = await c.app.inject({ method: 'GET', url: '/api/me?mode=story&board=t1&playerId=p-slow-00000' });
      const body = MeResponse.parse(res.json());
      expect(body.rankCapped).toBe(true);
      expect(body.yours!.rank).toBe(RANK_CAP + 1);
      expect(body.total).toBe(12_345);
    } finally {
      await c.app.close();
    }
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
      expect((await postRun(ctx.app, submitBody({ player: { id, name: id.slice(4, 9) }, claim: { ticks, shards }, masks: uniqueMasks() }))).statusCode).toBe(200);
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

  it('/api/me reports the same competition rank the list shows', async () => {
    for (const [id, rank] of [['tie-charlie', 1], ['tie-echo-000', 4]] as const) {
      const res = await ctx.app.inject({ method: 'GET', url: `/api/me?mode=story&board=t1&playerId=${id}` });
      const body = MeResponse.parse(res.json());
      expect(body.yours!.rank).toBe(rank);
      expect(body.yours!.you).toBe(true);
    }
  });
});

describe('read budget against DynamoDB (fake client: one send = one request)', () => {
  const TABLE = 'clawd-table';
  const lbItem = (runId: string, playerId: string, score: number) => ({
    pk: 'LB#story#t1#s2r0', sk: `${String(score).padStart(12, '0')}#99997#${runId}`, runId, mode: 'story', board: 't1', levelId: 't1', seed: 1001,
    assist: false, playerId, name: playerId.slice(0, 5), score, ticks: score, shards: 2, deaths: 0, cleared: true, height: 0, createdAt: '2026-09-06T11:00:00.000Z',
  });

  async function appOn(client: FakeClient) {
    return makeApp({ repo: new DynamoRepo(client, TABLE) as unknown as MemoryRepo });
  }

  it('GET /api/leaderboard costs at most 2 reads: the top-N query and the BOARD counter', async () => {
    const client = new FakeClient();
    client.responses.push(
      { Items: [lbItem('a', 'player-aaaa', 500), lbItem('b', 'player-bbbb', 600)] }, // topRuns
      { Item: { pk: 'BOARD#story#t1#s2r0', sk: 'META', n: 2 } },                    // boardTotal
    );
    const ctx = await appOn(client);
    try {
      const res = await ctx.app.inject({ method: 'GET', url: '/api/leaderboard?mode=story&board=t1&limit=20&playerId=player-aaaa' });
      expect(res.statusCode).toBe(200);
      const body = LeaderboardResponse.parse(res.json());
      expect(body.total).toBe(2);
      expect(body.entries.map((e) => e.rank)).toEqual([1, 2]);
      expect(body.yours).toBeUndefined();
      expect(client.sent.map((s) => s.name)).toEqual(['QueryCommand', 'GetCommand']);
      expect(client.sent.length).toBeLessThanOrEqual(2);
    } finally {
      await ctx.app.close();
    }
  });

  it('GET /api/me costs at most 3 reads: player best, one bounded COUNT, the BOARD counter', async () => {
    const client = new FakeClient();
    client.responses.push(
      { Item: { ...lbItem('b', 'player-bbbb', 600), pk: 'PLAYER#player-bbbb', sk: 'BEST#story#t1#s2r0' } }, // getPlayerBest
      { Count: 1 },                                                                                      // rankBounded
      { Item: { pk: 'BOARD#story#t1#s2r0', sk: 'META', n: 2 } },                                        // boardTotal
    );
    const ctx = await appOn(client);
    try {
      const res = await ctx.app.inject({ method: 'GET', url: '/api/me?mode=story&board=t1&playerId=player-bbbb' });
      expect(res.statusCode).toBe(200);
      const body = MeResponse.parse(res.json());
      expect(body.yours!.rank).toBe(2);
      expect(body.total).toBe(2);
      expect(body.rankCapped).toBe(false);
      expect(client.sent.map((s) => s.name)).toEqual(['GetCommand', 'QueryCommand', 'GetCommand']);
      expect(client.sent[1].input.Limit).toBe(RANK_CAP);
      expect(client.sent.length).toBeLessThanOrEqual(3);
    } finally {
      await ctx.app.close();
    }
  });

  it('a repo without the extras falls back to rankOf (still correct, just costlier)', async () => {
    const bare = new MemoryRepo();
    const plain: Repo = {
      getPlayerBest: (...a) => bare.getPlayerBest(...a),
      saveBest: (...a) => bare.saveBest(...a),
      topRuns: (...a) => bare.topRuns(...a),
      rankOf: (...a) => bare.rankOf(...a),
      getRun: (...a) => bare.getRun(...a),
    };
    expect(hasBoardTotals(plain)).toBe(false);
    expect(hasRankBounded(plain)).toBe(false);
    expect(hasRateCounters(plain)).toBe(false);
    expect(hasBoardTotals(bare) && hasRankBounded(bare) && hasRateCounters(bare)).toBe(true);
    const ctx = await makeApp({ repo: plain as MemoryRepo });
    try {
      for (const [id, ticks] of [['plain-a-0000', 500], ['plain-b-0000', 700]] as const) {
        expect((await postRun(ctx.app, submitBody({ player: { id, name: 'x' }, claim: { ticks }, masks: uniqueMasks() }))).statusCode).toBe(200);
      }
      expect(await boardTotal(plain, 'story', 't1')).toBe(2);
      expect(await rankBounded(plain, 'story', 't1', 700, 1000)).toEqual({ better: 1, capped: false });
      expect(await rankBounded(plain, 'story', 't1', 700, 0)).toEqual({ better: 0, capped: true });
      const lb = LeaderboardResponse.parse((await ctx.app.inject({ method: 'GET', url: '/api/leaderboard?mode=story&board=t1' })).json());
      expect(lb.total).toBe(2);
      const me = MeResponse.parse((await ctx.app.inject({ method: 'GET', url: '/api/me?mode=story&board=t1&playerId=plain-b-0000' })).json());
      expect(me.yours!.rank).toBe(2);
      expect(me.total).toBe(2);
    } finally {
      await ctx.app.close();
    }
  });
});
