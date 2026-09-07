/**
 * API client — the P3-12 split of boards into a public page and a personal row
 * (GET /api/me), and the Retry-After a `503 busy` / 429 carries (P3-6 client wiring).
 */
import { describe, expect, it } from 'vitest';
import { MeResponse } from '../../src/shared/protocol.js';
import type { RunSubmit } from '../../src/shared/protocol.js';
import { Api, ApiError, retryAfterOf } from '../../src/client/net/api.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function caught(p: Promise<unknown>): Promise<ApiError> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(ApiError); return e as ApiError; }
  throw new Error('expected a rejection');
}

const RUN: RunSubmit = {
  player: { id: 'abcdefgh-1234', name: '클로드' }, mode: 'story', levelId: 't1', assist: false, masks: 'AAEA',
  claim: { ticks: 100, shards: 1, deaths: 0, cleared: true, height: 0 }, client: { build: 'test' },
};

const entry = {
  rank: 7, runId: 'run-7', playerTag: 'abcdef012345', you: false, name: '클로드', score: 4200, ticks: 4200, shards: 9, deaths: 1,
  cleared: true, height: 0, createdAt: '2026-09-06T00:00:00.000Z',
};

describe('Api · leaderboard is public, /api/me is personal, Retry-After surfaces', () => {
  it('leaderboard() never sends a playerId (the page is shared at the edge), even when the caller passes one', async () => {
    const urls: string[] = [];
    const api = new Api({ fetch: async (url) => { urls.push(url); return json({ mode: 'story', board: 't1', total: 0, entries: [] }); } });
    await api.leaderboard({ mode: 'story', board: 't1', limit: 5, playerId: 'abcdefghij' });
    expect(urls).toEqual(['/api/leaderboard?mode=story&board=t1&limit=5']);
  });

  it('me() GETs /api/me?mode&board&playerId and parses MeResponse (yours and rankCapped optional)', async () => {
    const urls: string[] = [];
    const api = new Api({
      base: 'https://x.test',
      fetch: async (url) => { urls.push(url); return json({ mode: 'story', board: 't1', total: 1234, yours: entry, rankCapped: true }); },
    });
    const me = await api.me({ mode: 'story', board: 't1', limit: 20, playerId: 'abcdefghij' });
    expect(urls).toEqual(['https://x.test/api/me?mode=story&board=t1&playerId=abcdefghij']);
    expect(me).toEqual({ mode: 'story', board: 't1', total: 1234, yours: entry, rankCapped: true });
    expect(MeResponse.safeParse({ mode: 'daily', board: '2026-09-06', total: 0 }).success).toBe(true);
    // no row of ours
    const none = new Api({ fetch: async () => json({ mode: 'daily', board: '2026-09-06', total: 3 }) });
    const r = await none.me({ mode: 'daily', board: '2026-09-06', limit: 20, playerId: 'abcdefghij' });
    expect(r.yours).toBeUndefined();
    expect(r.total).toBe(3);
    // a bad body is bad-response, not a personal row
    const bad = new Api({ fetch: async () => json({ mode: 'story', board: 't1' }) });
    expect((await caught(bad.me({ mode: 'story', board: 't1', limit: 20, playerId: 'abcdefghij' }))).reason).toBe('bad-response');
  });

  it('me() without a playerId is refused locally with 400 / bad-request and no request', async () => {
    let calls = 0;
    const api = new Api({ fetch: async () => { calls++; return json({}); } });
    const err = await caught(api.me({ mode: 'story', board: 't1', limit: 20 }));
    expect(err.status).toBe(400);
    expect(err.reason).toBe('bad-request');
    expect(calls).toBe(0);
  });

  it('503 { error: busy } carries Retry-After (header first, then detail.retryAfter) and is retryable', async () => {
    const withHeader = new Api({
      fetch: async () => new Response(JSON.stringify({ error: 'busy', detail: { retryAfter: 9 } }), {
        status: 503, headers: { 'content-type': 'application/json', 'retry-after': '3' },
      }),
    });
    const e1 = await caught(withHeader.submitRun(RUN));
    expect(e1.status).toBe(503);
    expect(e1.reason).toBe('busy');
    expect(e1.retryAfter).toBe(3);
    expect(e1.retryable).toBe(true);
    expect(e1.offline).toBe(true);
    const bodyOnly = new Api({ fetch: async () => json({ error: 'busy', detail: { retryAfter: 5 } }, 503) });
    const e2 = await caught(bodyOnly.submitRun(RUN));
    expect(e2.retryAfter).toBe(5);
    expect(e2.retryable).toBe(true);
    // a 429 with the header is retryable too; a plain 503 (no busy body) is offline and not retryable
    const limited = new Api({ fetch: async () => new Response('', { status: 429, headers: { 'retry-after': '12' } }) });
    const e3 = await caught(limited.submitRun(RUN));
    expect(e3.retryable).toBe(true);
    expect(e3.retryAfter).toBe(12);
    expect(e3.reason).toBe('rate-limited');
    const down = new Api({ fetch: async () => new Response('', { status: 503 }) });
    const e4 = await caught(down.submitRun(RUN));
    expect(e4.retryable).toBe(false);
    expect(e4.retryAfter).toBeUndefined();
    // helper edge cases: an HTTP-date header is skipped for the body value; negative / junk detail reads as nothing
    expect(retryAfterOf({ get: () => 'Wed, 21 Oct 2026 07:28:00 GMT' }, { detail: { retryAfter: 4 } })).toBe(4);
    expect(retryAfterOf({ get: () => null }, { detail: { retryAfter: -1 } })).toBeUndefined();
    expect(retryAfterOf(null, null)).toBeUndefined();
  });
});
