/**
 * Progress transfer (P3-5): POST /api/transfer issues a one-shot 8-character
 * code for a masks-free Progress snapshot; GET /api/transfer/:code restores it
 * once. Codes carry an HMAC check character, snapshots expire after 7 days,
 * both routes are limited to 5/min per address.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_TRANSFER_BYTES, TransferCode, TransferCreateResponse, TransferGetResponse } from '../../src/shared/protocol.js';
import { MemoryRepo } from '../../src/server/repo/memory.js';
import {
  CODE_ALPHABET, CODE_LENGTH, TRANSFER_TTL_SECONDS, checkChar, decodeSnapshot, encodeSnapshot, isValidCode, makeTransferCode,
  normalizeCode, snapshotBytes, transferExpiry,
} from '../../src/server/transfer.js';
import { TRANSFER_BODY_LIMIT, TRANSFER_PER_IP_PER_MINUTE } from '../../src/server/routes/transfer.js';
import { FIXED_NOW, SECRET, makeApp } from './fixtures.js';

vi.mock('../../src/server/levels.js', async () => ({ resolveLevel: (await import('./levelfix.js')).fakeResolveLevel }));

const DAY = 86_400_000;
const PLAYER = { id: 'player-0001', name: '클로드' };
const PROGRESS = {
  v: 1,
  levels: { t1: { done: true, bestTicks: 5400, bestShards: 12, stars: 3, relics: 1, deaths: 4 } },
  endless: { bestHeight: 120, bestShards: 30, runs: 3 },
  daily: {},
  totals: { deaths: 40, shards: 99 },
  seen: { t1: true },
  lastLevel: 't1',
  player: PLAYER,
};

type Ctx = Awaited<ReturnType<typeof makeApp>>;
const create = (app: Ctx['app'], body: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/api/transfer', payload: body as object, headers: { 'content-type': 'application/json', ...headers } });
const restore = (app: Ctx['app'], code: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url: `/api/transfer/${encodeURIComponent(code)}`, headers });

/** An app on a live clock with a repo that shares it. */
async function liveApp() {
  let t = FIXED_NOW.getTime();
  const repo = new MemoryRepo({ now: () => t });
  const ctx = await makeApp({ repo, clock: () => new Date(t), rateLimit: { perIp: 10_000, perPlayer: 10_000 } });
  return { ...ctx, advance(ms: number) { t += ms; } };
}

describe('transfer codes (unit)', () => {
  it('the alphabet has 32 symbols without I O 0 1; codes are 8 characters ending in the HMAC check character', () => {
    expect(CODE_ALPHABET).toHaveLength(32);
    for (const ch of 'IO01') expect(CODE_ALPHABET).not.toContain(ch);
    expect(CODE_LENGTH).toBe(8);
    const code = makeTransferCode(SECRET);
    expect(TransferCode.safeParse(code).success).toBe(true);
    expect(code[7]).toBe(checkChar(code.slice(0, 7), SECRET));
    expect(isValidCode(code, SECRET)).toBe(true);
    expect(isValidCode(code, 'other-secret')).toBe(false);
  });

  it('is deterministic for a fixed random source and uniform over the alphabet', () => {
    const fixed = (n: number) => Uint8Array.from({ length: n }, (_, i) => i * 37);
    const a = makeTransferCode(SECRET, fixed);
    expect(makeTransferCode(SECRET, fixed)).toBe(a);
    expect(a.slice(0, 7)).toBe([0, 37, 74, 111, 148, 185, 222].map((b) => CODE_ALPHABET[b % 32]).join(''));
    // 256 % 32 === 0, so byte % 32 has no bias: every letter is reachable
    const seen = new Set<string>();
    for (let b = 0; b < 256; b++) seen.add(CODE_ALPHABET[b % 32]);
    expect(seen.size).toBe(32);
  });

  it('isValidCode refuses a wrong check character, wrong length and letters outside the alphabet', () => {
    const code = makeTransferCode(SECRET);
    const flipped = code.slice(0, 7) + CODE_ALPHABET[(CODE_ALPHABET.indexOf(code[7]) + 1) % 32];
    expect(isValidCode(flipped, SECRET)).toBe(false);
    expect(isValidCode(code.slice(0, 7), SECRET)).toBe(false);
    expect(isValidCode(`${code}A`, SECRET)).toBe(false);
    expect(isValidCode(`I${code.slice(1)}`, SECRET)).toBe(false);
    expect(isValidCode(code.toLowerCase(), SECRET)).toBe(false); // callers normalise first
    expect(normalizeCode(` ${code.slice(0, 4).toLowerCase()}-${code.slice(4)} `)).toBe(code);
  });

  it('transferExpiry is 7 days; the snapshot blob round-trips and rejects junk', () => {
    expect(TRANSFER_TTL_SECONDS).toBe(7 * 86_400);
    const { ttl, expiresAt } = transferExpiry(FIXED_NOW);
    expect(ttl).toBe(Math.floor(FIXED_NOW.getTime() / 1000) + 7 * 86_400);
    expect(expiresAt).toBe('2026-09-13T12:00:00.000Z');
    const blob = encodeSnapshot({ name: '클로드', progress: PROGRESS });
    expect(decodeSnapshot(blob)).toEqual({ name: '클로드', progress: PROGRESS });
    expect(decodeSnapshot('{ nope')).toBeNull();
    expect(decodeSnapshot('[]')).toBeNull();
    expect(decodeSnapshot(JSON.stringify({ name: 1, progress: {} }))).toBeNull();
    expect(decodeSnapshot(JSON.stringify({ name: 'x', progress: [] }))).toBeNull();
    expect(snapshotBytes({ a: '가' })).toBe(Buffer.byteLength('{"a":"가"}'));
  });
});

describe('POST /api/transfer → GET /api/transfer/:code', () => {
  const apps: Ctx[] = [];
  afterEach(async () => { while (apps.length) await apps.pop()!.app.close(); });

  it('creates a code and restores the snapshot exactly once; the second attempt is 410 gone', async () => {
    const ctx = await makeApp();
    apps.push(ctx);
    const made = await create(ctx.app, { player: PLAYER, progress: PROGRESS });
    expect(made.statusCode).toBe(200);
    const body = TransferCreateResponse.parse(made.json());
    expect(body.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(isValidCode(body.code, SECRET)).toBe(true);
    expect(body.expiresAt).toBe('2026-09-13T12:00:00.000Z');
    expect(made.headers['cache-control']).toBe('no-store');

    const got = await restore(ctx.app, body.code);
    expect(got.statusCode).toBe(200);
    expect(TransferGetResponse.parse(got.json())).toEqual({ playerId: PLAYER.id, name: PLAYER.name, progress: PROGRESS });

    const again = await restore(ctx.app, body.code);
    expect(again.statusCode).toBe(410);
    expect(again.json()).toEqual({ error: 'gone' });
  });

  it('accepts the code typed in lower case or with a dash', async () => {
    const ctx = await makeApp();
    apps.push(ctx);
    const { code } = (await create(ctx.app, { player: PLAYER, progress: PROGRESS })).json();
    const typed = `${code.slice(0, 4).toLowerCase()}-${code.slice(4).toLowerCase()}`;
    expect((await restore(ctx.app, typed)).statusCode).toBe(200);
  });

  it('expires: 8 days later the code is 410', async () => {
    const ctx = await liveApp();
    apps.push(ctx);
    const { code } = (await create(ctx.app, { player: PLAYER, progress: PROGRESS })).json();
    ctx.advance(8 * DAY);
    const res = await restore(ctx.app, code);
    expect(res.statusCode).toBe(410);
    expect(res.json()).toEqual({ error: 'gone' });
  });

  it('is still valid just under 7 days', async () => {
    const ctx = await liveApp();
    apps.push(ctx);
    const { code } = (await create(ctx.app, { player: PLAYER, progress: PROGRESS })).json();
    ctx.advance(7 * DAY - 1000);
    expect((await restore(ctx.app, code)).statusCode).toBe(200);
  });

  it('refuses a wrong check character (and any malformed code) with 400 bad-code without touching the store', async () => {
    const ctx = await makeApp();
    apps.push(ctx);
    const take = vi.spyOn(ctx.repo, 'takeSnapshot');
    const { code } = (await create(ctx.app, { player: PLAYER, progress: PROGRESS })).json();
    const flipped = code.slice(0, 7) + CODE_ALPHABET[(CODE_ALPHABET.indexOf(code[7]) + 1) % 32];
    for (const bad of [flipped, code.slice(0, 7), 'IIIIIIII', '00000000', 'ABCDEFG!']) {
      const res = await restore(ctx.app, bad);
      expect(res.statusCode, bad).toBe(400);
      expect(res.json()).toEqual({ error: 'bad-code' });
    }
    expect(take).not.toHaveBeenCalled();
    // an unknown but well-formed code (valid check character) is 410, not 400 — from another address, the 5/min budget above is spent
    const unknown = makeTransferCode(SECRET);
    if (unknown !== code) {
      expect((await restore(ctx.app, unknown, { 'x-forwarded-for': '198.51.100.99' })).statusCode).toBe(410);
      expect(take).toHaveBeenCalledTimes(1);
    }
  });

  it(`answers 413 too-large when the progress JSON exceeds ${MAX_TRANSFER_BYTES} bytes, and for a body over the route limit`, async () => {
    const ctx = await makeApp();
    apps.push(ctx);
    const big = { ...PROGRESS, pad: 'x'.repeat(MAX_TRANSFER_BYTES) };
    expect(snapshotBytes(big)).toBeGreaterThan(MAX_TRANSFER_BYTES);
    const res = await create(ctx.app, { player: PLAYER, progress: big });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe('too-large');
    const huge = await create(ctx.app, { player: PLAYER, progress: { pad: 'x'.repeat(TRANSFER_BODY_LIMIT) } });
    expect(huge.statusCode).toBe(413);
    expect(huge.json().error).toBe('too-large');
    // just under the cap goes through
    const ok = await create(ctx.app, { player: PLAYER, progress: { pad: 'x'.repeat(MAX_TRANSFER_BYTES - 32) } });
    expect(ok.statusCode).toBe(200);
  });

  it('validates the body (400 bad-request) and refuses a blocklisted name (400 bad-name)', async () => {
    const ctx = await makeApp();
    apps.push(ctx);
    expect((await create(ctx.app, { player: PLAYER })).statusCode).toBe(400);
    expect((await create(ctx.app, { player: { id: 'x', name: '' }, progress: {} })).statusCode).toBe(400);
    expect((await create(ctx.app, { player: PLAYER, progress: [] })).json().error).toBe('bad-request');
    const bad = await create(ctx.app, { player: { id: PLAYER.id, name: '씨발' }, progress: PROGRESS });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: 'bad-name' });
  });

  it('a new code for the same player retires the previous one', async () => {
    const ctx = await makeApp();
    apps.push(ctx);
    const a = (await create(ctx.app, { player: PLAYER, progress: PROGRESS })).json().code;
    const b = (await create(ctx.app, { player: PLAYER, progress: { ...PROGRESS, totals: { deaths: 41, shards: 100 } } })).json().code;
    expect(a).not.toBe(b);
    expect((await restore(ctx.app, a)).statusCode).toBe(410);
    const got = await restore(ctx.app, b);
    expect(got.statusCode).toBe(200);
    expect(got.json().progress.totals).toEqual({ deaths: 41, shards: 100 });
  });

  it('a code restores only its own snapshot: two players, two codes', async () => {
    const ctx = await makeApp();
    apps.push(ctx);
    const other = { id: 'player-0002', name: '다른이' };
    const a = (await create(ctx.app, { player: PLAYER, progress: PROGRESS })).json().code;
    const b = (await create(ctx.app, { player: other, progress: { ...PROGRESS, player: other } })).json().code;
    expect((await restore(ctx.app, b)).json().playerId).toBe(other.id);
    expect((await restore(ctx.app, a)).json().playerId).toBe(PLAYER.id);
  });

  describe('rate limits (5/min per address, separately for create and restore)', () => {
    it(`POST: the ${TRANSFER_PER_IP_PER_MINUTE + 1}th create from one address is 429 ip-transfer`, async () => {
      const ctx = await makeApp({ rateLimit: { perIp: 10_000, perPlayer: 10_000 } });
      apps.push(ctx);
      const ip = { 'x-forwarded-for': '203.0.113.77' };
      for (let i = 0; i < TRANSFER_PER_IP_PER_MINUTE; i++) {
        expect((await create(ctx.app, { player: PLAYER, progress: PROGRESS }, ip)).statusCode).toBe(200);
      }
      const blocked = await create(ctx.app, { player: PLAYER, progress: PROGRESS }, ip);
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().error).toBe('rate-limited');
      expect(blocked.json().detail.scope).toBe('ip-transfer');
      expect(blocked.headers['retry-after']).toBeDefined();
      // another address, and other routes from the same address, are unaffected
      expect((await create(ctx.app, { player: PLAYER, progress: PROGRESS }, { 'x-forwarded-for': '198.51.100.3' })).statusCode).toBe(200);
      expect((await ctx.app.inject({ method: 'GET', url: '/api/health', headers: ip })).statusCode).toBe(200);
    });

    it(`GET: the ${TRANSFER_PER_IP_PER_MINUTE + 1}th lookup from one address is 429 (guesses count too)`, async () => {
      const ctx = await makeApp({ rateLimit: { perIp: 10_000, perPlayer: 10_000 } });
      apps.push(ctx);
      const ip = { 'x-forwarded-for': '203.0.113.78' };
      for (let i = 0; i < TRANSFER_PER_IP_PER_MINUTE; i++) {
        expect((await restore(ctx.app, 'AAAAAAAA', ip)).statusCode).toBeLessThan(429);
      }
      const blocked = await restore(ctx.app, 'AAAAAAAA', ip);
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().detail.scope).toBe('ip-transfer');
    });
  });
});
