/**
 * P3-12 fleet-shared submit budget: POST /api/runs counts per IP through the
 * repo (`RL#<ip>#<minute>`) so N tasks share one 12/min budget, fails open when
 * the counter is unavailable, and falls back to an in-process window for a
 * repo without a counter.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUNS_PER_IP_PER_MINUTE } from '../../src/server/routes/runs.js';
import { MemoryRepo } from '../../src/server/repo/memory.js';
import type { Repo } from '../../src/server/repo/types.js';
import {
  RL_TTL_SECONDS, RL_WINDOW_SECONDS, SubmitLimiter, counterTtl, minuteOf, secondsToNextWindow,
} from '../../src/server/submitLimit.js';
import type { LogLine } from './fixtures.js';
import { FIXED_NOW, makeApp, postRun, submitBody } from './fixtures.js';

vi.mock('../../src/server/levels.js', async () => ({ resolveLevel: (await import('./levelfix.js')).fakeResolveLevel }));

const T = Date.parse('2026-09-06T12:00:20.000Z');

describe('window arithmetic', () => {
  it('keys by UTC minute, expires two windows later, and asks for a retry at the next minute', () => {
    expect(RL_WINDOW_SECONDS).toBe(60);
    expect(RL_TTL_SECONDS).toBe(120);
    expect(minuteOf(T)).toBe(Math.floor(T / 60_000));
    expect(minuteOf(T + 39_999)).toBe(minuteOf(T));
    expect(minuteOf(T + 40_000)).toBe(minuteOf(T) + 1);
    expect(counterTtl(minuteOf(T))).toBe(Math.floor(T / 60_000) * 60 + 120);
    expect(secondsToNextWindow(T)).toBe(40);
    expect(secondsToNextWindow(T + 39_500)).toBe(1);
    expect(secondsToNextWindow(T - 20_000)).toBe(60);
  });
});

describe('SubmitLimiter', () => {
  it('shares the budget through the repo counter: the (max + 1)th hit in a minute is refused until the window turns', async () => {
    let now = T;
    const repo = new MemoryRepo();
    const lim = new SubmitLimiter(repo, 3, { now: () => now });
    expect(lim.shared).toBe(true);
    for (let i = 0; i < 3; i++) expect(await lim.hit('203.0.113.7')).toEqual({ ok: true });
    expect(await lim.hit('203.0.113.7')).toEqual({ ok: false, retryAfterSec: 40 });
    expect(await lim.hit('198.51.100.9')).toEqual({ ok: true }); // another address, own counter
    now = T + 40_000; // next minute
    expect(await lim.hit('203.0.113.7')).toEqual({ ok: true });
  });

  it('two limiters on the same repo (two tasks) see one budget', async () => {
    const repo = new MemoryRepo();
    const a = new SubmitLimiter(repo, 2, { now: () => T });
    const b = new SubmitLimiter(repo, 2, { now: () => T });
    expect((await a.hit('203.0.113.7')).ok).toBe(true);
    expect((await b.hit('203.0.113.7')).ok).toBe(true);
    expect((await a.hit('203.0.113.7')).ok).toBe(false);
    expect((await b.hit('203.0.113.7')).ok).toBe(false);
  });

  it('passes the minute and a 120 s ttl to the repo', async () => {
    const calls: unknown[][] = [];
    const repo = Object.assign(new MemoryRepo(), {
      hitRateCounter: async (...a: unknown[]) => { calls.push(a); return 1; },
    });
    const lim = new SubmitLimiter(repo, 12, { now: () => T });
    await lim.hit('203.0.113.7');
    expect(calls).toEqual([['203.0.113.7', minuteOf(T), counterTtl(minuteOf(T))]]);
  });

  it('fails open with one warning line when the counter is unavailable', async () => {
    const lines: LogLine[] = [];
    const repo = Object.assign(new MemoryRepo(), {
      hitRateCounter: async () => { throw new Error('ProvisionedThroughputExceededException'); },
    });
    const lim = new SubmitLimiter(repo, 1, { now: () => T, log: (record, msg) => lines.push({ record, msg }) });
    expect(await lim.hit('203.0.113.7')).toEqual({ ok: true });
    expect(await lim.hit('203.0.113.7')).toEqual({ ok: true });
    expect(lines).toHaveLength(2);
    expect(lines[0].msg).toMatch(/unavailable/);
    expect(lines[0].record.err).toBe('ProvisionedThroughputExceededException');
    expect(JSON.stringify(lines)).not.toContain('203.0.113.7');
  });

  it('falls back to an in-process sliding window for a repo without a counter', async () => {
    const bare = new MemoryRepo();
    const plain: Repo = {
      getPlayerBest: (...a) => bare.getPlayerBest(...a),
      saveBest: (...a) => bare.saveBest(...a),
      topRuns: (...a) => bare.topRuns(...a),
      rankOf: (...a) => bare.rankOf(...a),
      getRun: (...a) => bare.getRun(...a),
    };
    let now = T;
    const lim = new SubmitLimiter(plain, 2, { now: () => now });
    expect(lim.shared).toBe(false);
    expect((await lim.hit('203.0.113.7')).ok).toBe(true);
    expect((await lim.hit('203.0.113.7')).ok).toBe(true);
    const refused = await lim.hit('203.0.113.7');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.retryAfterSec).toBe(60);
    now = T + 60_001;
    expect((await lim.hit('203.0.113.7')).ok).toBe(true);
  });
});

describe('POST /api/runs per-IP budget through the app', () => {
  const apps: Awaited<ReturnType<typeof makeApp>>[] = [];
  afterEach(async () => { while (apps.length) await apps.pop()!.app.close(); });

  it(`counts every request against RL#<ip>#<minute> before parsing — even malformed bodies — and answers 429 scope ip-runs after ${RUNS_PER_IP_PER_MINUTE}`, async () => {
    const ctx = await makeApp({ rateLimit: { perIp: 1000, perPlayer: 1000 } });
    apps.push(ctx);
    const ip = { 'x-forwarded-for': '203.0.113.42' };
    for (let i = 0; i < RUNS_PER_IP_PER_MINUTE; i++) {
      expect((await postRun(ctx.app, { nope: i }, ip)).statusCode).toBe(400);
    }
    const blocked = await postRun(ctx.app, submitBody(), ip);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual({ error: 'rate-limited', detail: { scope: 'ip-runs', retryAfter: 60 - FIXED_NOW.getUTCSeconds() } });
    expect(blocked.headers['retry-after']).toBe(String(60 - FIXED_NOW.getUTCSeconds()));
    expect(blocked.headers['cache-control']).toBe('no-store');
    // the counter lives in the repo, so a second app on the same repo is already over budget
    const twin = await makeApp({ repo: ctx.repo, rateLimit: { perIp: 1000, perPlayer: 1000 } });
    apps.push(twin);
    expect((await postRun(twin.app, submitBody(), ip)).statusCode).toBe(429);
    // other routes and other addresses are unaffected
    expect((await ctx.app.inject({ method: 'GET', url: '/api/daily', headers: ip })).statusCode).toBe(200);
    expect((await postRun(ctx.app, submitBody(), { 'x-forwarded-for': '198.51.100.7' })).statusCode).toBe(200);
  });
});
