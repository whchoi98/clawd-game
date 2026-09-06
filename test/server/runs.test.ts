import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunResponse } from '../../src/shared/protocol.js';
import { boardScore } from '../../src/sim/config.js';
import { dailySeed } from '../../src/server/daily.js';
import { PlayerLimiter } from '../../src/server/runs.js';
import {
  FIX_T1, MASKS, SECRET, TODAY, YESTERDAY, dailyBody, echoVerify, failVerify, makeApp, postRun, submitBody,
  type VerifyCall,
} from './fixtures.js';

vi.mock('./sim.js', () => ({ Sim: class {} }));
vi.mock('../../src/server/levels.js', async () => ({ resolveLevel: (await import('./levelfix.js')).fakeResolveLevel }));

describe('POST /api/runs', () => {
  const apps: Awaited<ReturnType<typeof makeApp>>[] = [];
  const up = async (...args: Parameters<typeof makeApp>) => { const c = await makeApp(...args); apps.push(c); return c; };
  afterEach(async () => { while (apps.length) await apps.pop()!.app.close(); });

  it('accepts a verified story clear: rank 1 of 1, personal best, RunResponse-shaped', async () => {
    const calls: VerifyCall[] = [];
    const { app, repo } = await up({ verify: echoVerify(calls) });
    const res = await postRun(app, submitBody());
    expect(res.statusCode).toBe(200);
    const body = RunResponse.parse(res.json());
    expect(body.accepted).toBe(true);
    if (!body.accepted) return;
    expect(body.rank).toBe(1);
    expect(body.total).toBe(1);
    expect(body.personalBest).toBe(true);
    expect(body.score).toBe(720);
    expect(body.summary.levelId).toBe('t1');
    expect(body.summary.cleared).toBe(true);
    // the verifier saw the decoded masks and the level's own seed, never the claim's word
    expect(calls).toHaveLength(1);
    expect(calls[0].def.id).toBe('t1');
    expect(calls[0].replay).toMatchObject({ v: 1, levelId: 't1', seed: FIX_T1.seed, assist: false });
    expect(Array.from(calls[0].replay.masks)).toEqual(Array.from(MASKS));
    expect(calls[0].claim).toEqual({ ticks: 720, shards: 3, deaths: 0, cleared: true, height: 0 });
    // persisted
    const stored = await repo.getRun(body.runId);
    expect(stored).not.toBeNull();
    expect(stored!.masks).toBe(submitBody().masks);
    expect(stored!.ttl).toBeUndefined();
    expect(stored!.board).toBe('t1');
    expect(stored!.createdAt).toBe('2026-09-06T12:00:00.000Z');
  });

  it('a better second run replaces the first on the board (one entry per player)', async () => {
    const { app, repo } = await up();
    const first = (await postRun(app, submitBody({ claim: { ticks: 720 } }))).json();
    const res = await postRun(app, submitBody({ claim: { ticks: 600 } }));
    const body = res.json();
    expect(res.statusCode).toBe(200);
    expect(body.personalBest).toBe(true);
    expect(body.rank).toBe(1);
    expect(body.total).toBe(1);
    expect(body.runId).not.toBe(first.runId);
    const top = await repo.topRuns('story', 't1', 10);
    expect(top).toHaveLength(1);
    expect(top[0].runId).toBe(body.runId);
    expect(top[0].ticks).toBe(600);
    // the old run is no longer the player's best
    expect((await repo.getPlayerBest('player-0001', 'story', 't1'))!.runId).toBe(body.runId);
  });

  it('a slower run is accepted but not a personal best and does not replace the board entry', async () => {
    const { app, repo } = await up();
    const best = (await postRun(app, submitBody({ claim: { ticks: 600 } }))).json();
    const res = await postRun(app, submitBody({ claim: { ticks: 900 } }));
    const body = RunResponse.parse(res.json());
    expect(res.statusCode).toBe(200);
    expect(body.accepted).toBe(true);
    if (!body.accepted) return;
    expect(body.personalBest).toBe(false);
    expect(body.score).toBe(900);
    expect(body.runId).toBe(best.runId);
    expect(body.rank).toBe(1);
    expect((await repo.topRuns('story', 't1', 10))[0].ticks).toBe(600);
  });

  it('an equal score is not a personal best', async () => {
    const { app } = await up();
    await postRun(app, submitBody({ claim: { ticks: 600 } }));
    const body = (await postRun(app, submitBody({ claim: { ticks: 600 } }))).json();
    expect(body.personalBest).toBe(false);
  });

  it('ranks against other players', async () => {
    const { app } = await up();
    await postRun(app, submitBody({ player: { id: 'fast-player-1', name: '빠름' }, claim: { ticks: 500 } }));
    await postRun(app, submitBody({ player: { id: 'fast-player-2', name: '더빠름' }, claim: { ticks: 400 } }));
    const body = (await postRun(app, submitBody({ claim: { ticks: 700 } }))).json();
    expect(body.rank).toBe(3);
    expect(body.total).toBe(3);
  });

  it('rejects a claim the replay does not reproduce with 422 claim-mismatch (summary included)', async () => {
    const { app, repo } = await up({ verify: failVerify('claim-mismatch') });
    const res = await postRun(app, submitBody());
    expect(res.statusCode).toBe(422);
    const body = RunResponse.parse(res.json());
    expect(body.accepted).toBe(false);
    if (body.accepted) return;
    expect(body.reason).toBe('claim-mismatch');
    expect(body.summary?.levelId).toBe('t1');
    expect(await repo.topRuns('story', 't1', 10)).toHaveLength(0);
  });

  it('passes through the verifier reasons (not-finished, too-long)', async () => {
    for (const reason of ['not-finished', 'too-long', 'bad-level']) {
      const { app } = await up({ verify: failVerify(reason) });
      const res = await postRun(app, submitBody());
      expect(res.statusCode).toBe(422);
      expect(res.json().reason).toBe(reason);
    }
  });

  it('rejects assist runs before verifying', async () => {
    const calls: VerifyCall[] = [];
    const { app } = await up({ verify: echoVerify(calls) });
    const res = await postRun(app, submitBody({ assist: true }));
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ accepted: false, reason: 'assist' });
    expect(calls).toHaveLength(0);
  });

  it('rejects a story run that did not clear the zone with not-finished', async () => {
    const { app } = await up();
    const res = await postRun(app, submitBody({ claim: { cleared: false } }));
    expect(res.statusCode).toBe(422);
    expect(res.json().reason).toBe('not-finished');
  });

  it('rejects unknown story levels with bad-level', async () => {
    const { app } = await up();
    const res = await postRun(app, submitBody({ levelId: 'zz9' }));
    expect(res.statusCode).toBe(422);
    expect(res.json().reason).toBe('bad-level');
  });

  it('rejects malformed masks with 422 and the decoder reason', async () => {
    const { app } = await up();
    const bad = await postRun(app, submitBody({ masks: '!!!!' }));
    expect(bad.statusCode).toBe(422);
    expect(bad.json().reason).toBe('bad-base64');
    const odd = await postRun(app, submitBody({ masks: 'AQ==' })); // one byte: odd RLE length
    expect(odd.statusCode).toBe(422);
    expect(odd.json().reason).toBe('bad-rle');
  });

  it('returns 400 { error, detail } for a body that fails the schema', async () => {
    const { app } = await up();
    const res = await postRun(app, { ...submitBody(), player: { id: 'x', name: '' } });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe('bad-request');
    expect(Array.isArray(body.detail)).toBe(true);
  });

  it('returns 413 { error: too-large } for bodies over the 96 KB cap', async () => {
    const { app } = await up();
    const res = await postRun(app, submitBody({ masks: 'A'.repeat(100 * 1024) }));
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe('too-large');
  });

  it('returns 400 for a body that is not JSON', async () => {
    const { app } = await up();
    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: '{nope', headers: { 'content-type': 'application/json' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad-request');
  });

  describe('daily', () => {
    const seed = dailySeed(TODAY, SECRET).seed;

    it('accepts a daily run for today with the issued seed and stores a 30-day ttl', async () => {
      const calls: VerifyCall[] = [];
      const { app, repo } = await up({ verify: echoVerify(calls) });
      const res = await postRun(app, dailyBody(seed, { claim: { cleared: false, height: 87.5, ticks: 3000 } }));
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.accepted).toBe(true);
      expect(body.score).toBe(boardScore({ cleared: false, ticks: 3000, height: 87.5 }));
      expect(calls[0].def.id).toBe('daily');
      expect(calls[0].def.seed).toBe(seed);
      expect(calls[0].replay.seed).toBe(seed);
      const stored = (await repo.getRun(body.runId))!;
      expect(stored.board).toBe(TODAY);
      expect(stored.mode).toBe('daily');
      expect(stored.ttl).toBe(Math.floor(Date.parse('2026-09-06T12:00:00.000Z') / 1000) + 30 * 86400);
    });

    it("accepts yesterday's date with yesterday's seed", async () => {
      const { app } = await up();
      const ySeed = dailySeed(YESTERDAY, SECRET).seed;
      const res = await postRun(app, dailyBody(ySeed, { date: YESTERDAY }));
      expect(res.statusCode).toBe(200);
      expect(res.json().accepted).toBe(true);
    });

    it('rejects a wrong seed with bad-seed', async () => {
      const { app } = await up();
      const res = await postRun(app, dailyBody(seed ^ 1));
      expect(res.statusCode).toBe(422);
      expect(res.json().reason).toBe('bad-seed');
    });

    it('rejects a missing seed with bad-seed', async () => {
      const { app } = await up();
      const res = await postRun(app, dailyBody(seed, { seed: undefined }));
      expect(res.statusCode).toBe(422);
      expect(res.json().reason).toBe('bad-seed');
    });

    it('rejects stale or missing dates with stale-date', async () => {
      const { app } = await up();
      const stale = await postRun(app, dailyBody(dailySeed('2026-09-04', SECRET).seed, { date: '2026-09-04' }));
      expect(stale.statusCode).toBe(422);
      expect(stale.json().reason).toBe('stale-date');
      const future = await postRun(app, dailyBody(dailySeed('2026-09-07', SECRET).seed, { date: '2026-09-07' }));
      expect(future.json().reason).toBe('stale-date');
      const missing = await postRun(app, dailyBody(seed, { date: undefined }));
      expect(missing.statusCode).toBe(422);
      expect(missing.json().reason).toBe('stale-date');
    });

    it('rejects a daily submission whose levelId is not daily with bad-level', async () => {
      const { app } = await up();
      const res = await postRun(app, dailyBody(seed, { levelId: 't1' }));
      expect(res.statusCode).toBe(422);
      expect(res.json().reason).toBe('bad-level');
    });

    it('a tide-over daily run sorts after every clear', async () => {
      const { app } = await up();
      await postRun(app, dailyBody(seed, { player: { id: 'drowned-player', name: '침수' }, claim: { cleared: false, height: 500, ticks: 5000 } }));
      const body = (await postRun(app, dailyBody(seed, { claim: { cleared: true, ticks: 9000 } }))).json();
      expect(body.rank).toBe(1);
      expect(body.total).toBe(2);
    });
  });

  describe('per-player limiter', () => {
    it('answers 429 once a player exceeds perPlayer submissions per minute', async () => {
      const { app } = await up({ rateLimit: { perIp: 1000, perPlayer: 2 } });
      expect((await postRun(app, submitBody())).statusCode).toBe(200);
      expect((await postRun(app, submitBody())).statusCode).toBe(200);
      const third = await postRun(app, submitBody());
      expect(third.statusCode).toBe(429);
      expect(third.json().error).toBe('rate-limited');
      expect(third.headers['retry-after']).toBeDefined();
      // another player is unaffected
      expect((await postRun(app, submitBody({ player: { id: 'someone-else', name: '다른이' } }))).statusCode).toBe(200);
    });

    it('PlayerLimiter uses a sliding window', () => {
      let t = 0;
      const lim = new PlayerLimiter(2, 60_000, () => t);
      expect(lim.hit('a').ok).toBe(true);
      t = 10_000;
      expect(lim.hit('a').ok).toBe(true);
      t = 20_000;
      const r = lim.hit('a');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.retryAfterSec).toBe(40);
      t = 60_001; // first hit fell out of the window
      expect(lim.hit('a').ok).toBe(true);
      t = 60_002;
      expect(lim.hit('a').ok).toBe(false);
      expect(lim.hit('b').ok).toBe(true);
    });
  });
});
