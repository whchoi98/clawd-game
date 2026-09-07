import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunResponse } from '../../src/shared/protocol.js';
import { boardScore } from '../../src/sim/config.js';
import { dailySeed } from '../../src/server/daily.js';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { encodeMasks, verifyReplayChunked } from '../../src/sim/replay.js';
import { GEN_VERSION, MAX_TICKS, SIM_VERSION, TICK_HZ } from '../../src/sim/types.js';
import { DYING_T, INTRO_T, RESPAWN_INTRO_T } from '../../src/sim/sim.js';
import { DynamoRepo, KEY } from '../../src/server/repo/dynamo.js';
import { REPLACED_RUN_TTL_SECONDS } from '../../src/server/repo/ttl.js';
import { RUNS_PER_IP_PER_MINUTE } from '../../src/server/routes/runs.js';
import { replayHash } from '../../src/server/hash.js';
import { storyBoardSuffix } from '../../src/server/boards.js';
import {
  DEATH_TICKS, INTRO_TICKS, MASK_SLACK, PlayerLimiter, RESPAWN_INTRO_TICKS, asyncVerifier, maxMasksFor, phaseTicks, submitRun,
  toRejectReason, versionMismatch,
} from '../../src/server/runs.js';
import { FakeClient } from './fakeDynamo.js';
import {
  FIXED_NOW, FIX_T1, MASKS, SECRET, TODAY, YESTERDAY, dailyBody, echoVerify, failVerify, fakeResolveLevel, makeApp, postRun,
  submitBody, type VerifyCall,
} from './fixtures.js';

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
    expect(calls[0].replay).toMatchObject({ v: SIM_VERSION, levelId: 't1', seed: FIX_T1.seed, assist: false });
    expect(Array.from(calls[0].replay.masks)).toEqual(Array.from(MASKS));
    expect(calls[0].claim).toEqual({ ticks: 720, shards: 3, deaths: 0, cleared: true, height: 0 });
    // persisted, with the replay hash and the heuristics
    const stored = await repo.getRun(body.runId);
    expect(stored).not.toBeNull();
    expect(stored!.masks).toBe(submitBody().masks);
    expect(stored!.ttl).toBeUndefined();
    expect(stored!.board).toBe('t1');
    expect(stored!.createdAt).toBe('2026-09-06T12:00:00.000Z');
    expect(stored!.hash).toBe(replayHash(MASKS, 't1', FIX_T1.seed));
    expect(stored!.hx).toMatchObject({ ticks: 720, edges: 2 });
    expect(stored!.flagged).toBeUndefined();
  });

  it('a better second run replaces the first on the board (one entry per player); the old story RUN gets a 90-day ttl', async () => {
    const { app, repo } = await up();
    const first = (await postRun(app, submitBody({ claim: { ticks: 720 } }))).json();
    const res = await postRun(app, submitBody({ claim: { ticks: 600 }, masks: encodeMasks(MASKS.subarray(0, 700)) }));
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
    expect((await repo.getRun(first.runId))!.ttl).toBe(Math.floor(FIXED_NOW.getTime() / 1000) + REPLACED_RUN_TTL_SECONDS);
    expect((await repo.getRun(body.runId))!.ttl).toBeUndefined();
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
    // the fixture log is 720 masks, so claims must stay within maxMasksFor: ≥ 425 ticks.
    // Every player needs their own log: the same masks would be a duplicate.
    expect((await postRun(app, submitBody({ player: { id: 'fast-player-1', name: '빠름' }, claim: { ticks: 500 }, masks: encodeMasks(MASKS.subarray(0, 700)) }))).statusCode).toBe(200);
    expect((await postRun(app, submitBody({ player: { id: 'fast-player-2', name: '더빠름' }, claim: { ticks: 450 }, masks: encodeMasks(MASKS.subarray(0, 680)) }))).statusCode).toBe(200);
    const body = (await postRun(app, submitBody({ claim: { ticks: 700 } }))).json();
    expect(body.rank).toBe(3);
    expect(body.total).toBe(3);
  });

  describe('duplicate replays (P3-1)', () => {
    it("B submitting A's exact masks → 422 duplicate (summary included), B is not on the board", async () => {
      const { app, repo } = await up();
      const a = (await postRun(app, submitBody())).json();
      expect(a.accepted).toBe(true);
      const res = await postRun(app, submitBody({ player: { id: 'player-0002', name: '도둑' } }));
      expect(res.statusCode).toBe(422);
      const body = RunResponse.parse(res.json());
      expect(body.accepted).toBe(false);
      if (body.accepted) return;
      expect(body.reason).toBe('duplicate');
      expect(body.summary?.levelId).toBe('t1');
      const top = await repo.topRuns('story', 't1', 10);
      expect(top.map((r) => r.playerId)).toEqual(['player-0001']);
      expect(await repo.getPlayerBest('player-0002', 'story', 't1')).toBeNull();
      expect(await repo.rankOf('story', 't1', 0)).toEqual({ better: 0, total: 1 });
    });

    it('a re-encoded copy padded with trailing idle ticks is the same replay', async () => {
      const { app } = await up();
      expect((await postRun(app, submitBody())).statusCode).toBe(200);
      const padded = new Uint8Array(MASKS.length + 30);
      padded.set(MASKS);
      const res = await postRun(app, submitBody({ player: { id: 'player-0003', name: '복사' }, masks: encodeMasks(padded) }));
      expect(res.statusCode).toBe(422);
      expect(res.json().reason).toBe('duplicate');
    });

    it('the same player re-submitting their identical replay is a no-op: 200 personalBest:false, same runId, one entry', async () => {
      const { app, repo } = await up();
      const first = (await postRun(app, submitBody())).json();
      const again = await postRun(app, submitBody());
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({ accepted: true, personalBest: false, runId: first.runId, rank: 1, total: 1 });
      expect(await repo.topRuns('story', 't1', 10)).toHaveLength(1);
    });

    it('after a delist the owner re-sending the same replay is still not a duplicate (personalBest:false, the old run id), a stranger is', async () => {
      const { app, repo } = await up();
      const first = (await postRun(app, submitBody())).json();
      expect(await repo.delistRun(first.runId)).toBe(true);
      expect(await repo.getPlayerBest('player-0001', 'story', 't1')).toBeNull();
      const owner = await postRun(app, submitBody());
      expect(owner.statusCode).toBe(200);
      expect(owner.json()).toMatchObject({ accepted: true, personalBest: false, runId: first.runId });
      expect(await repo.topRuns('story', 't1', 10)).toHaveLength(0);
      const stranger = await postRun(app, submitBody({ player: { id: 'player-0004', name: '남' } }));
      expect(stranger.statusCode).toBe(422);
      expect(stranger.json().reason).toBe('duplicate');
    });

    it('a different log from another player is accepted; the same log on another board is another replay', async () => {
      const { app } = await up();
      expect((await postRun(app, submitBody())).statusCode).toBe(200);
      const other = new Uint8Array(MASKS);
      other[300] = 0;
      expect((await postRun(app, submitBody({ player: { id: 'player-0005', name: '남남' }, masks: encodeMasks(other) }))).statusCode).toBe(200);
      const seed = dailySeed(TODAY, SECRET).seed;
      expect((await postRun(app, dailyBody(seed, { player: { id: 'player-0006', name: '데일리' }, claim: { cleared: false, height: 10, ticks: 700 } }))).statusCode).toBe(200);
    });

    it('a blocklisted display name is refused with 400 { error: bad-name } before the verifier runs', async () => {
      const calls: VerifyCall[] = [];
      const { app, repo } = await up({ verify: echoVerify(calls) });
      for (const name of ['씨발이', 'sh!t', 'F U C K']) {
        const res = await postRun(app, submitBody({ player: { id: 'player-0007', name } }));
        expect(res.statusCode, name).toBe(400);
        expect(res.json()).toEqual({ error: 'bad-name' });
      }
      expect(calls).toHaveLength(0);
      expect(await repo.topRuns('story', 't1', 10)).toHaveLength(0);
    });
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

  describe('sim / generator version gate', () => {
    it('refuses sim ≠ SIM_VERSION with 422 { reason: sim-version } before the masks are decoded or verified', async () => {
      const calls: VerifyCall[] = [];
      const { app, repo } = await up({ verify: echoVerify(calls) });
      for (const sim of [SIM_VERSION - 1, SIM_VERSION + 1, 0]) {
        const res = await postRun(app, submitBody({ sim, masks: '!!!!' })); // undecodable masks: the gate comes first
        expect(res.statusCode, `sim=${sim}`).toBe(422);
        expect(RunResponse.parse(res.json())).toEqual({ accepted: false, reason: 'sim-version' });
      }
      expect(calls).toHaveLength(0);
      expect(await repo.topRuns('story', 't1', 10)).toHaveLength(0);
    });

    it('a legacy client that sends no sim field is refused the same way', async () => {
      const calls: VerifyCall[] = [];
      const { app } = await up({ verify: echoVerify(calls) });
      const res = await postRun(app, submitBody({ sim: undefined }));
      expect(res.statusCode).toBe(422);
      expect(res.json().reason).toBe('sim-version');
      expect(calls).toHaveLength(0);
    });

    it('accepts sim = SIM_VERSION and passes replay.v = SIM_VERSION to the verifier', async () => {
      const calls: VerifyCall[] = [];
      const { app } = await up({ verify: echoVerify(calls) });
      expect((await postRun(app, submitBody({ sim: SIM_VERSION }))).statusCode).toBe(200);
      expect(calls[0].replay.v).toBe(SIM_VERSION);
    });

    it('story runs ignore gen; daily runs need gen = GEN_VERSION', async () => {
      const calls: VerifyCall[] = [];
      const { app } = await up({ verify: echoVerify(calls) });
      expect((await postRun(app, submitBody({ gen: GEN_VERSION + 5 }))).statusCode).toBe(200);
      expect((await postRun(app, submitBody({ gen: undefined }))).statusCode).toBe(200);
      const seed = dailySeed(TODAY, SECRET).seed;
      const stale = await postRun(app, dailyBody(seed, { gen: GEN_VERSION + 1 }));
      expect(stale.statusCode).toBe(422);
      expect(stale.json().reason).toBe('sim-version');
      const missing = await postRun(app, dailyBody(seed, { gen: undefined }));
      expect(missing.json().reason).toBe('sim-version');
      expect(calls).toHaveLength(2);
      expect((await postRun(app, dailyBody(seed))).statusCode).toBe(200);
    });

    it('versionMismatch is the single decision behind the gate', () => {
      expect(versionMismatch({ mode: 'story', sim: SIM_VERSION })).toBe(false);
      expect(versionMismatch({ mode: 'story', sim: SIM_VERSION, gen: 0 })).toBe(false);
      expect(versionMismatch({ mode: 'story' })).toBe(true);
      expect(versionMismatch({ mode: 'story', sim: SIM_VERSION + 1 })).toBe(true);
      expect(versionMismatch({ mode: 'daily', sim: SIM_VERSION, gen: GEN_VERSION })).toBe(false);
      expect(versionMismatch({ mode: 'daily', sim: SIM_VERSION })).toBe(true);
      expect(versionMismatch({ mode: 'daily', sim: SIM_VERSION, gen: GEN_VERSION + 1 })).toBe(true);
    });
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

  it('rejects malformed masks with 422 bad-masks (decoder reasons collapse onto the RejectReason enum)', async () => {
    const { app } = await up();
    const bad = await postRun(app, submitBody({ masks: '!!!!' }));
    expect(bad.statusCode).toBe(422);
    expect(RunResponse.parse(bad.json())).toEqual({ accepted: false, reason: 'bad-masks' });
    const odd = await postRun(app, submitBody({ masks: 'AQ==' })); // one byte: odd RLE length
    expect(odd.statusCode).toBe(422);
    expect(RunResponse.parse(odd.json())).toEqual({ accepted: false, reason: 'bad-masks' });
  });

  it('never leaks a reason outside RejectReason, even from a misbehaving verifier', async () => {
    const { app } = await up({ verify: failVerify('something-internal') });
    const res = await postRun(app, submitBody());
    expect(res.statusCode).toBe(422);
    const body = RunResponse.parse(res.json());
    expect(body.accepted).toBe(false);
    if (!body.accepted) expect(body.reason).toBe('claim-mismatch');
  });

  it('gives tied scores the same competition rank and skips the next rank', async () => {
    const { app } = await up();
    expect((await postRun(app, submitBody({ player: { id: 'tied-player-a', name: '가' }, claim: { ticks: 500 }, masks: encodeMasks(MASKS.subarray(0, 700)) }))).json().rank).toBe(1);
    expect((await postRun(app, submitBody({ player: { id: 'tied-player-b', name: '나' }, claim: { ticks: 500 }, masks: encodeMasks(MASKS.subarray(0, 690)) }))).json().rank).toBe(1);
    const third = (await postRun(app, submitBody({ claim: { ticks: 700 } }))).json();
    expect(third.rank).toBe(3);
    expect(third.total).toBe(3);
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
      expect(stored.hash).toBe(replayHash(MASKS, 'daily', seed));
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
      await postRun(app, dailyBody(seed, { player: { id: 'drowned-player', name: '침수' }, claim: { cleared: false, height: 500, ticks: 5000 }, masks: encodeMasks(MASKS.subarray(0, 700)) }));
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
      expect((await postRun(app, submitBody({ player: { id: 'someone-else', name: '다른이' }, masks: encodeMasks(MASKS.subarray(0, 700)) }))).statusCode).toBe(200);
    });

    it('keys the player budget by ip:playerId so a stranger cannot exhaust another player from elsewhere', async () => {
      const { app } = await up({ rateLimit: { perIp: 1000, perPlayer: 1 } });
      const victim = { player: { id: 'victim-player-1', name: '피해자' } };
      // an attacker who knows the id burns their own ip:player key, not the victim's
      expect((await postRun(app, submitBody(victim), { 'x-forwarded-for': '203.0.113.66' })).statusCode).toBe(200);
      expect((await postRun(app, submitBody(victim), { 'x-forwarded-for': '203.0.113.66' })).statusCode).toBe(429);
      expect((await postRun(app, submitBody(victim), { 'x-forwarded-for': '198.51.100.9' })).statusCode).toBe(200);
      expect((await postRun(app, submitBody(victim), { 'x-forwarded-for': '198.51.100.9' })).statusCode).toBe(429);
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
  describe('per-IP verification budget (route-level rate limit)', () => {
    it(`answers 429 { error: rate-limited } after ${RUNS_PER_IP_PER_MINUTE} submissions per minute from one address, independently of the global budget`, async () => {
      const { app } = await up({ rateLimit: { perIp: 1000, perPlayer: 1000 } });
      const ip = { 'x-forwarded-for': '203.0.113.42' };
      for (let i = 0; i < RUNS_PER_IP_PER_MINUTE; i++) {
        expect((await postRun(app, submitBody({ player: { id: `runner-${i}-xx`, name: '주자' }, masks: encodeMasks(MASKS.subarray(0, 700 - i)) }), ip)).statusCode).toBe(200);
      }
      const blocked = await postRun(app, submitBody({ player: { id: 'runner-late-x', name: '늦음' } }), ip);
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().error).toBe('rate-limited');
      expect(blocked.json().detail.scope).toBe('ip-runs');
      expect(blocked.headers['retry-after']).toBeDefined();
      // other routes from the same address keep their own (global) budget
      expect((await app.inject({ method: 'GET', url: '/api/daily', headers: ip })).statusCode).toBe(200);
      // another address is unaffected
      expect((await postRun(app, submitBody(), { 'x-forwarded-for': '198.51.100.7' })).statusCode).toBe(200);
    });
  });

  describe('mask budget (CPU amplification guard)', () => {
    /** RLE + base64 of `n` identical masks — a few hundred bytes for ten minutes of input. */
    const longLog = (n: number, mask = 0) => encodeMasks(new Uint8Array(n).fill(mask));

    it('derives the phase tick constants from the sim exports (INTRO_T 0.45 · RESPAWN_INTRO_T 0.15 · DYING_T 0.45), never from literals', () => {
      // Phase 1 contract values; the server must follow the sim when they move.
      expect(INTRO_T).toBe(0.45);
      expect(RESPAWN_INTRO_T).toBe(0.15);
      expect(DYING_T).toBe(0.45);
      expect(phaseTicks(0.45)).toBe(Math.ceil(0.45 * TICK_HZ) + 1);
      expect(INTRO_TICKS).toBe(phaseTicks(INTRO_T));
      expect(RESPAWN_INTRO_TICKS).toBe(phaseTicks(RESPAWN_INTRO_T));
      expect(DEATH_TICKS).toBe(phaseTicks(DYING_T) + RESPAWN_INTRO_TICKS);
      expect(INTRO_TICKS).toBe(55);
      expect(RESPAWN_INTRO_TICKS).toBe(19);
      expect(DEATH_TICKS).toBe(55 + 19);
    });

    it('maxMasksFor allows one intro, a dying+respawn-intro cycle per death and slack', () => {
      expect(maxMasksFor({ ticks: 600, shards: 0, deaths: 0, cleared: true, height: 0 })).toBe(600 + INTRO_TICKS + MASK_SLACK);
      expect(maxMasksFor({ ticks: 600, shards: 0, deaths: 5, cleared: true, height: 0 })).toBe(600 + INTRO_TICKS + 5 * DEATH_TICKS + MASK_SLACK);
      expect(maxMasksFor({ ticks: MAX_TICKS, shards: 0, deaths: 100_000, cleared: true, height: 0 })).toBe(MAX_TICKS);
    });

    it('a legitimate run with several deaths fits the budget (the sim spends ⌈T·120⌉ ticks in each phase)', () => {
      const deaths = 8;
      const spent = (t: number) => Math.ceil(t * TICK_HZ);
      const needed = spent(INTRO_T) + 600 + deaths * (spent(DYING_T) + spent(RESPAWN_INTRO_T));
      expect(needed).toBeLessThanOrEqual(maxMasksFor({ ticks: 600, shards: 0, deaths, cleared: true, height: 0 }));
    });

    it('rejects a 72000-tick never-finishing log for a 600-tick claim with too-long before the verifier runs (< 20 ms)', async () => {
      const calls: VerifyCall[] = [];
      const { app } = await up({ verify: echoVerify(calls) });
      await app.inject({ method: 'GET', url: '/api/health' }); // warm the route table / JIT
      const t0 = performance.now();
      const res = await postRun(app, submitBody({ masks: longLog(MAX_TICKS), claim: { ticks: 600, deaths: 0 } }));
      const ms = performance.now() - t0;
      expect(res.statusCode).toBe(422);
      expect(RunResponse.parse(res.json())).toEqual({ accepted: false, reason: 'too-long' });
      expect(calls).toHaveLength(0);
      expect(ms).toBeLessThan(20);
    });

    it('a log that just fits the budget reaches the verifier', async () => {
      const calls: VerifyCall[] = [];
      const { app } = await up({ verify: echoVerify(calls) });
      const claim = { ticks: 600, deaths: 2 };
      const n = maxMasksFor({ ...claim, shards: 0, cleared: true, height: 0 });
      expect((await postRun(app, submitBody({ masks: longLog(n), claim }))).statusCode).toBe(200);
      expect((await postRun(app, submitBody({ masks: longLog(n + 1), claim }))).json().reason).toBe('too-long');
      expect(calls).toHaveLength(1);
    });

    it('/healthz answers in < 50 ms while a chunked 72000-tick verification is in flight', async () => {
      let yields = 0;
      const verify = asyncVerifier((def, replay, claim) => verifyReplayChunked(def, replay, claim, {
        yield: () => { yields++; return new Promise<void>((r) => setImmediate(r)); },
      }));
      const { app } = await up({ verify });
      await app.inject({ method: 'GET', url: '/healthz' }); // warm-up
      // Standing still on the fixture floor never reaches the goal: the sim steps every one of the 72000 masks.
      const body = submitBody({ masks: longLog(MAX_TICKS), claim: { ticks: MAX_TICKS, deaths: 0, shards: 0 } });
      const started = performance.now();
      const pending = postRun(app, body);
      const h0 = performance.now();
      const health = await app.inject({ method: 'GET', url: '/healthz' });
      const healthMs = performance.now() - h0;
      const res = await pending;
      const totalMs = performance.now() - started;
      expect(health.statusCode).toBe(200);
      expect(health.body).toBe('ok');
      expect(healthMs).toBeLessThan(50);
      expect(res.statusCode).toBe(422);
      expect(res.json().reason).toBe('not-finished');
      // the verification really was in flight: it yielded many times and outlasted the health check
      expect(yields).toBeGreaterThanOrEqual(Math.floor(MAX_TICKS / 2400) - 1);
      expect(totalMs).toBeGreaterThan(healthMs);
    });
  });

  describe('concurrent submissions of one player (DynamoRepo conditional write)', () => {
    const TABLE = 'clawd-table';
    const cancelled = (reasons?: string[]) => new TransactionCanceledException({
      message: 'Transaction cancelled, please refer cancellation reasons for specific reasons', $metadata: {},
      ...(reasons ? { CancellationReasons: reasons.map((Code) => ({ Code })) } : {}),
    });
    const deps = (client: FakeClient) => ({
      repo: new DynamoRepo(client, TABLE), now: () => FIXED_NOW, dailySecret: SECRET, verify: echoVerify(), resolve: fakeResolveLevel,
    });
    const otherBest = (score: number) => ({ Item: {
      pk: 'PLAYER#player-0001', sk: `BEST#story#${T1_BOARD}`, runId: 'run-other', mode: 'story', board: 't1', levelId: 't1', seed: FIX_T1.seed, assist: false,
      playerId: 'player-0001', name: '클로드', score, ticks: score, shards: 2, deaths: 0, cleared: true, height: 0, createdAt: '2026-09-06T11:59:59.000Z',
    } });
    type Tx = Array<Record<string, Record<string, unknown>>>;
    /** `s<SIM_VERSION>r<rev>` of the real t1 (the board key is derived from the shipped geometry revision). */
    const T1_BOARD = `t1#${storyBoardSuffix('t1')}`;

    it('answers personalBest:false with the winner when the run that landed first is at least as good', async () => {
      const client = new FakeClient();
      client.responses.push(
        {},                 // getPlayerBest → none yet
        cancelled(),        // saveBest (attribute_not_exists) → another submission won the race
        otherBest(600),     // re-read → the other run is better than our 700
        { Count: 0 }, { Count: 1 }, // rankOf(600)
      );
      const out = await submitRun(deps(client), submitBody({ claim: { ticks: 700 } }));
      expect(out.status).toBe(200);
      expect(out.body).toMatchObject({ accepted: true, personalBest: false, runId: 'run-other', rank: 1, total: 1, score: 700 });
      expect(client.sent.map((c) => c.name)).toEqual(['GetCommand', 'TransactWriteCommand', 'GetCommand', 'QueryCommand', 'QueryCommand']);
      const items = client.sent[1].input.TransactItems as Tx;
      expect(items).toHaveLength(5); // RUN, LB, PLAYER, HASH, BOARD counter (+1: a first entry)
      expect(items[4].Update.Key).toEqual({ pk: 'BOARD#story#t1#s4r1', sk: 'META' });
      expect(items[2].Put.ConditionExpression).toBe('attribute_not_exists(runId)');
      // the replay hash rides in the same transaction, guarded by attribute_not_exists
      expect(items[3].Put.ConditionExpression).toBe('attribute_not_exists(pk)');
      expect(items[3].Put.Item).toMatchObject({ pk: `HASH#story#${T1_BOARD}#${replayHash(MASKS, 't1', FIX_T1.seed)}`, sk: 'META', playerId: 'player-0001' });
    });

    it('retries once against the re-read best when this run still beats it (and gives the replaced story RUN its ttl)', async () => {
      const client = new FakeClient();
      client.responses.push(
        {},                 // getPlayerBest → none
        cancelled(),        // first saveBest refused
        otherBest(900),     // re-read → the other run is slower than our 700
        { Item: { ...otherBest(900).Item, pk: 'RUN#run-other', sk: 'META', masks: 'QUJD' } }, // saveBest reads the old RUN for its LB key
        {},                 // second saveBest succeeds
        { Count: 0 }, { Count: 1 },
      );
      const out = await submitRun(deps(client), submitBody({ claim: { ticks: 700, shards: 3 } }));
      expect(out.status).toBe(200);
      expect(out.body).toMatchObject({ accepted: true, personalBest: true, rank: 1, total: 1 });
      if (out.body.accepted) expect(out.body.runId).not.toBe('run-other');
      expect(client.sent.map((c) => c.name)).toEqual([
        'GetCommand', 'TransactWriteCommand', 'GetCommand', 'GetCommand', 'TransactWriteCommand', 'QueryCommand', 'QueryCommand',
      ]);
      const items = client.sent[4].input.TransactItems as Tx;
      expect(items).toHaveLength(6);
      expect(items[2].Put.ConditionExpression).toBe('runId = :prev');
      expect(items[2].Put.ExpressionAttributeValues).toEqual({ ':prev': 'run-other' });
      expect(items[3].Put.Item).toMatchObject({ sk: 'META', runId: (out.body as { runId: string }).runId });
      expect(items[4].Delete.Key).toEqual({ pk: `LB#story#${T1_BOARD}`, sk: KEY.lbSk(900, 2, 'run-other') });
      expect(items[5].Update).toMatchObject({
        Key: { pk: 'RUN#run-other', sk: 'META' },
        UpdateExpression: 'SET #ttl = :ttl',
        ExpressionAttributeValues: { ':ttl': Math.floor(FIXED_NOW.getTime() / 1000) + REPLACED_RUN_TTL_SECONDS },
      });
    });

    it('gives up after the second refusal so the caller sees a 500 rather than a fabricated best', async () => {
      const client = new FakeClient();
      client.responses.push({}, cancelled(), otherBest(900), {}, cancelled());
      await expect(submitRun(deps(client), submitBody({ claim: { ticks: 700 } }))).rejects.toBeInstanceOf(TransactionCanceledException);
    });

    it('rethrows unrelated store errors untouched', async () => {
      const client = new FakeClient();
      client.responses.push({}, new Error('ProvisionedThroughputExceededException'));
      await expect(submitRun(deps(client), submitBody())).rejects.toThrow('ProvisionedThroughputExceededException');
    });

    it("a cancelled HASH condition → the owner is read → another player's replay is 422 duplicate", async () => {
      const client = new FakeClient();
      client.responses.push(
        {},                                                            // getPlayerBest → none
        cancelled(['None', 'None', 'None', 'ConditionalCheckFailed']), // the HASH item exists
        { Item: { pk: 'HASH#x', sk: 'META', runId: 'run-a', playerId: 'player-9999' } },
      );
      const out = await submitRun(deps(client), submitBody());
      expect(out.status).toBe(422);
      expect(out.body).toMatchObject({ accepted: false, reason: 'duplicate' });
      expect(client.sent.map((c) => c.name)).toEqual(['GetCommand', 'TransactWriteCommand', 'GetCommand']);
      expect(client.sent[2].input.Key).toEqual({ pk: `HASH#story#${T1_BOARD}#${replayHash(MASKS, 't1', FIX_T1.seed)}`, sk: 'META' });
    });

    it("a cancelled HASH condition owned by the same player is that player's existing run (200, personalBest:false)", async () => {
      const client = new FakeClient();
      client.responses.push(
        {},
        cancelled(['None', 'None', 'None', 'ConditionalCheckFailed']),
        { Item: { runId: 'run-a', playerId: 'player-0001' } },
        { Count: 0 }, { Count: 1 },
      );
      const out = await submitRun(deps(client), submitBody());
      expect(out.status).toBe(200);
      expect(out.body).toMatchObject({ accepted: true, personalBest: false, runId: 'run-a' });
    });
  });

  describe('toRejectReason', () => {
    it('maps decoder errors and passes enum members through', () => {
      expect(toRejectReason('bad-base64')).toBe('bad-masks');
      expect(toRejectReason('bad-rle')).toBe('bad-masks');
      expect(toRejectReason('too-long')).toBe('too-long');
      expect(toRejectReason('not-finished')).toBe('not-finished');
      expect(toRejectReason('duplicate')).toBe('duplicate');
      expect(toRejectReason('garbage')).toBe('claim-mismatch');
      expect(toRejectReason(undefined, 'bad-masks')).toBe('bad-masks');
    });
  });
});
