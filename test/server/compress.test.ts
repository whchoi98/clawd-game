import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { LeaderboardResponse } from '../../src/shared/protocol.js';
import { COMPRESS_THRESHOLD } from '../../src/server/app.js';
import { makeApp, postRun, submitBody } from './fixtures.js';

vi.mock('../../src/server/levels.js', async () => ({ resolveLevel: (await import('./levelfix.js')).fakeResolveLevel }));

/** CloudFront does not compress under CachingDisabled, so the origin must. */
describe('API compression', () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  const BIG = '/api/leaderboard?mode=story&board=t1&limit=20';
  beforeAll(async () => {
    ctx = await makeApp();
    for (let i = 0; i < 9; i++) {
      const res = await postRun(ctx.app, submitBody({ player: { id: `compress-p-${i}`, name: `주자${i}` }, claim: { ticks: 500 + i } }));
      expect(res.statusCode).toBe(200);
    }
  });
  afterAll(async () => { await ctx.app.close(); });

  it('gzips a large leaderboard for Accept-Encoding: gzip and the payload decodes to the same JSON', async () => {
    const plain = await ctx.app.inject({ method: 'GET', url: BIG });
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.rawPayload.length).toBeGreaterThan(COMPRESS_THRESHOLD);

    const res = await ctx.app.inject({ method: 'GET', url: BIG, headers: { 'accept-encoding': 'gzip' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.rawPayload.length).toBeLessThan(plain.rawPayload.length);
    const body = LeaderboardResponse.parse(JSON.parse(gunzipSync(res.rawPayload).toString('utf8')));
    expect(body).toEqual(plain.json());
    expect(body.entries).toHaveLength(9);
  });

  it('prefers brotli when the client offers it', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: BIG, headers: { 'accept-encoding': 'gzip, deflate, br' } });
    expect(res.headers['content-encoding']).toBe('br');
    expect(JSON.parse(brotliDecompressSync(res.rawPayload).toString('utf8')).entries).toHaveLength(9);
  });

  it('leaves tiny bodies uncompressed even when the client accepts gzip', async () => {
    const health = await ctx.app.inject({ method: 'GET', url: '/api/health', headers: { 'accept-encoding': 'gzip' } });
    expect(health.statusCode).toBe(200);
    expect(health.headers['content-encoding']).toBeUndefined();
    expect(health.json().ok).toBe(true);
    const empty = await ctx.app.inject({ method: 'GET', url: '/api/leaderboard?mode=daily&board=2026-09-06', headers: { 'accept-encoding': 'gzip' } });
    expect(empty.headers['content-encoding']).toBeUndefined();
    expect(empty.json().entries).toEqual([]);
  });

  it('does not touch /healthz (root context)', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/healthz', headers: { 'accept-encoding': 'gzip, br' } });
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body).toBe('ok');
  });
});
