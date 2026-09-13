/**
 * API client — the progress-transfer endpoints (P3-5): request shapes, zod
 * parsing of both responses, and the status → ApiError mapping the UI turns
 * into '이미 사용된 코드다' / '코드가 틀렸다' / offline.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_TRANSFER_BYTES, TransferCode } from '../../src/shared/protocol.js';
import type { TransferCreateRequest } from '../../src/shared/protocol.js';
import { Api, ApiError } from '../../src/client/net/api.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The ApiError a call rejects with (the test fails when it resolves). */
async function caught(p: Promise<unknown>): Promise<ApiError> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(ApiError); return e as ApiError; }
  throw new Error('expected a rejection');
}

const REQ: TransferCreateRequest = {
  player: { id: 'abcdefgh-1234', name: '클로드' },
  progress: { v: 1, levels: { t1: { done: true, bestTicks: 5400 } }, daily: {}, endless: { bestHeight: 0, bestShards: 0, runs: 0 } },
};

describe('Api · transfer (P3-5)', () => {
  it('POSTs the snapshot to /api/transfer and parses the code + expiry', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const api = new Api({
      base: 'https://x.test',
      fetch: async (url, init) => {
        calls.push({ url, init });
        return json({ code: 'ABCDEFGH', expiresAt: '2026-09-13T00:00:00.000Z' });
      },
    });
    const res = await api.transferCreate(REQ);
    expect(res).toEqual({ code: 'ABCDEFGH', expiresAt: '2026-09-13T00:00:00.000Z' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://x.test/api/transfer');
    expect(calls[0].init?.method).toBe('POST');
    expect((calls[0].init?.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual(REQ);
    expect(JSON.stringify(REQ).length).toBeLessThan(MAX_TRANSFER_BYTES);
  });

  it('refuses a code outside the wire alphabet from the server (bad-response) and maps 413 / 429 / 5xx on create', async () => {
    const bad = new Api({ fetch: async () => json({ code: 'abcdefgh', expiresAt: 'x' }) });
    expect((await caught(bad.transferCreate(REQ))).reason).toBe('bad-response');

    const big = new Api({ fetch: async () => json({ error: 'too-large' }, 413) });
    expect((await caught(big.transferCreate(REQ))).status).toBe(413);

    const limited = new Api({ fetch: async () => new Response('', { status: 429 }) });
    const e3 = await caught(limited.transferCreate(REQ));
    expect(e3.status).toBe(429);
    expect(e3.reason).toBe('rate-limited');

    const down = new Api({ fetch: async () => new Response('', { status: 503 }) });
    expect((await caught(down.transferCreate(REQ))).offline).toBe(true);
  });

  it('GETs /api/transfer/:code and parses playerId, name and progress', async () => {
    const calls: string[] = [];
    const api = new Api({
      fetch: async (url) => {
        calls.push(url);
        return json({ playerId: 'zyxwvuts-9876', name: '바다', progress: { v: 1, levels: { t1: { done: true } } } });
      },
    });
    const res = await api.transferGet('ABCDEFGH');
    expect(calls).toEqual(['/api/transfer/ABCDEFGH']);
    expect(res.playerId).toBe('zyxwvuts-9876');
    expect(res.name).toBe('바다');
    expect(res.progress).toEqual({ v: 1, levels: { t1: { done: true } } });
  });

  it('410 → ApiError status 410 / gone (used or expired); 400 → status 400; a bad body → bad-response', async () => {
    const gone = new Api({ fetch: async () => json({ error: 'gone' }, 410) });
    const e1 = await caught(gone.transferGet('ABCDEFGH'));
    expect(e1.status).toBe(410);
    expect(e1.reason).toBe('gone');
    expect(e1.offline).toBe(false);

    const bare = new Api({ fetch: async () => new Response('', { status: 410 }) });
    const e2 = await caught(bare.transferGet('ABCDEFGH'));
    expect(e2.status).toBe(410);
    expect(e2.reason).toBe('gone');

    const badReq = new Api({ fetch: async () => json({ error: 'bad-code' }, 400) });
    const e3 = await caught(badReq.transferGet('ABCDEFGH'));
    expect(e3.status).toBe(400);
    expect(e3.reason).toBe('bad-code');

    const garbage = new Api({ fetch: async () => json({ playerId: 'x', name: '', progress: 3 }) });
    expect((await caught(garbage.transferGet('ABCDEFGH'))).reason).toBe('bad-response');
  });

  it('never sends a malformed code: lowercase, I / O / 0 / 1, or the wrong length fail locally with status 400', async () => {
    let calls = 0;
    const api = new Api({ fetch: async () => { calls++; return json({}); } });
    for (const code of ['abcdefgh', 'ABCDEFG', 'ABCDEFGHJ', 'ABCDEFG1', 'ABCDEFGO', 'ABCDEFGI', 'ABCD EFGH', '']) {
      expect(TransferCode.safeParse(code).success, code).toBe(false);
      const err = await caught(api.transferGet(code));
      expect(err.status, code).toBe(400);
      expect(err.reason, code).toBe('bad-code');
    }
    expect(calls).toBe(0);
  });

  it('a network failure surfaces as an offline ApiError', async () => {
    const api = new Api({ fetch: async () => { throw new TypeError('fetch failed'); } });
    const err = await caught(api.transferGet('ABCDEFGH'));
    expect(err.status).toBe(0);
    expect(err.offline).toBe(true);
  });
});

describe('Api · response-body failures and deadlines', () => {
  afterEach(() => vi.useRealTimers());

  it('times out after headers even when the response body never finishes', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    const api = new Api({
      timeoutMs: 20,
      fetch: async (_url, init) => {
        signal = init?.signal;
        return new Response(new ReadableStream(), { status: 200 });
      },
    });
    let failure: unknown;
    void api.health().catch((err: unknown) => { failure = err; });
    await vi.advanceTimersByTimeAsync(21);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 0, reason: 'timeout', offline: true });
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses one deadline for fetching headers and consuming the body', async () => {
    vi.useFakeTimers();
    const api = new Api({
      timeoutMs: 20,
      fetch: () => new Promise((resolve) => {
        setTimeout(() => resolve(new Response(new ReadableStream(), { status: 200 })), 15);
      }),
    });
    let failure: unknown;
    void api.health().catch((err: unknown) => { failure = err; });
    await vi.advanceTimersByTimeAsync(19);
    expect(failure).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2);
    expect(failure).toMatchObject({ status: 0, reason: 'timeout' });
  });

  it.each([
    ['truncated JSON', () => new Response('{"ok":', { status: 200 })],
    ['invalid schema', () => json({ unexpected: true })],
    ['disconnected body', () => new Response(new ReadableStream({
      start(controller) { controller.error(new TypeError('connection reset')); },
    }), { status: 200 })],
  ])('treats %s in a success response as ambiguous instead of a final refusal', async (_label, response) => {
    const api = new Api({ fetch: async () => response() });
    const err = await caught(api.health());
    expect(err.offline || err.retryable).toBe(true);
  });

  it.each([400, 413, 422])('keeps HTTP %i authoritative even if its body stalls', async (status) => {
    vi.useFakeTimers();
    const api = new Api({
      timeoutMs: 20,
      fetch: async () => new Response(new ReadableStream(), { status }),
    });
    let failure: unknown;
    void api.transferCreate(REQ).catch((err: unknown) => { failure = err; });
    await vi.advanceTimersByTimeAsync(21);
    expect(failure).toMatchObject({ status, offline: false, retryable: false });
  });

  it('cancels the deadline after a complete response', async () => {
    vi.useFakeTimers();
    const api = new Api({ fetch: async () => json({ ok: true, version: 'test', uptime: 1 }) });
    await expect(api.health()).resolves.toMatchObject({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
  });
});
