import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { DailyResponse } from '../../src/shared/protocol.js';
import { dailySeed, isFreshDate, nextUtcMidnight, utcDateStr } from '../../src/server/daily.js';
import { FIXED_NOW, SECRET, TODAY, makeApp } from './fixtures.js';

vi.mock('./sim.js', () => ({ Sim: class {} }));
vi.mock('../../src/server/levels.js', async () => ({ resolveLevel: (await import('./levelfix.js')).fakeResolveLevel }));

describe('dailySeed', () => {
  it('is stable for the same date and secret', () => {
    const a = dailySeed('2026-09-06', 'k');
    const b = dailySeed('2026-09-06', 'k');
    expect(a).toEqual(b);
    expect(a.date).toBe('2026-09-06');
  });

  it('differs across dates and across secrets', () => {
    const a = dailySeed('2026-09-06', 'k').seed;
    expect(dailySeed('2026-09-07', 'k').seed).not.toBe(a);
    expect(dailySeed('2026-09-06', 'other').seed).not.toBe(a);
  });

  it('is a uint32 taken from the first four HMAC-SHA256 bytes', () => {
    const { seed } = dailySeed('2026-09-06', 'k');
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThanOrEqual(0xffffffff);
    // Independently computed: HMAC-SHA256(key='k', msg='2026-09-06') first 4 bytes big-endian.
    const expected = createHmac('sha256', 'k').update('2026-09-06').digest().readUInt32BE(0);
    expect(seed).toBe(expected);
  });

  it('expires at the next UTC midnight after the date', () => {
    expect(dailySeed('2026-09-06', 'k').expiresAt).toBe('2026-09-07T00:00:00.000Z');
    expect(dailySeed('2026-12-31', 'k').expiresAt).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('date helpers', () => {
  it('utcDateStr formats in UTC', () => {
    expect(utcDateStr(new Date('2026-09-06T23:59:59.999Z'))).toBe('2026-09-06');
    expect(utcDateStr(new Date('2026-09-07T00:00:00.000Z'))).toBe('2026-09-07');
  });
  it('nextUtcMidnight rolls the day', () => {
    expect(nextUtcMidnight('2026-02-28').toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });
  it('isFreshDate accepts today and yesterday (UTC) only', () => {
    expect(isFreshDate('2026-09-06', FIXED_NOW)).toBe(true);
    expect(isFreshDate('2026-09-05', FIXED_NOW)).toBe(true);
    expect(isFreshDate('2026-09-04', FIXED_NOW)).toBe(false);
    expect(isFreshDate('2026-09-07', FIXED_NOW)).toBe(false);
    expect(isFreshDate('garbage', FIXED_NOW)).toBe(false);
  });
});

describe('GET /api/daily', () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  beforeAll(async () => { ctx = await makeApp(); });
  afterAll(async () => { await ctx.app.close(); });

  it("returns today's seed for the injected clock", async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/daily' });
    expect(res.statusCode).toBe(200);
    const body = DailyResponse.parse(res.json());
    expect(body.date).toBe(TODAY);
    expect(body.levelId).toBe('daily');
    expect(body.seed).toBe(dailySeed(TODAY, SECRET).seed);
    expect(body.expiresAt).toBe('2026-09-07T00:00:00.000Z');
  });
});
