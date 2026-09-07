/**
 * P3-12 verification backpressure: the semaphore in front of the verifier,
 * the 503 { error: 'busy' } + Retry-After the route answers over capacity,
 * and the worker thread that runs the sim off the request thread. The
 * semaphore tests drive a gated fake verifier (no CPU involved); the worker
 * tests bundle src/server/verifyPool.ts with esbuild into the scratchpad the
 * way tools/build.mjs bundles the server, because a Worker cannot load
 * TypeScript source and the production worker *is* the server bundle.
 */
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { encodeMasks, verifyReplay } from '../../src/sim/replay.js';
import { IN, MAX_TICKS, SIM_VERSION } from '../../src/sim/types.js';
import type { VerifyResult } from '../../src/sim/types.js';
import { INTRO_TICKS } from '../../src/server/runs.js';
import {
  Semaphore, VERIFY_BUSY_RETRY_AFTER_SEC, VERIFY_CONCURRENCY, VERIFY_QUEUE, VerifyBusyError, createVerifyPool, isVerifyBusy,
} from '../../src/server/verifyPool.js';
import type { LogLine } from './fixtures.js';
import { BASE_SUMMARY, FIX_T1, makeApp, postRun, submitBody, uniqueMasks } from './fixtures.js';

vi.mock('../../src/server/levels.js', async () => ({ resolveLevel: (await import('./levelfix.js')).fakeResolveLevel }));

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const SCRATCH = '/tmp/claude-1000/-home-ec2-user-my-project-clawd-game/f8aa643c-bc48-400a-8c09-d71da38a73d7/scratchpad';

/** A verifier whose calls block until the test releases them, in order. */
function gatedVerifier() {
  const waiting: Array<() => void> = [];
  let calls = 0;
  const run = (def: { id: string }) => {
    calls++;
    return new Promise<VerifyResult>((resolveResult) => {
      waiting.push(() => resolveResult({ ok: true, summary: { ...BASE_SUMMARY, levelId: def.id, ticks: 720, time: 6 } }));
    });
  };
  const release = (n = 1) => { for (let i = 0; i < n; i++) waiting.shift()?.(); };
  const settle = () => new Promise<void>((r) => setImmediate(r));
  /** Poll until `n` calls reached the verifier (a request crosses several async hops before it does). */
  const reached = async (n: number) => {
    const deadline = Date.now() + 2000;
    while (calls < n && Date.now() < deadline) await settle();
    return calls;
  };
  /** Release everything that arrives until `total` calls have been made and answered (queued ones arrive as slots free). */
  const drain = async (total: number) => {
    const deadline = Date.now() + 5000;
    do {
      release(waiting.length);
      await settle();
    } while ((calls < total || waiting.length > 0) && Date.now() < deadline);
    return calls;
  };
  return { run, release, settle, reached, drain, get calls() { return calls; }, get blocked() { return waiting.length; } };
}

describe('Semaphore', () => {
  it('hands out `concurrent` slots at once, queues up to `queue` waiters, refuses beyond', async () => {
    const sem = new Semaphore(2, 1);
    const a = sem.acquire(); const b = sem.acquire();
    expect(a).not.toBeNull(); expect(b).not.toBeNull();
    expect(sem.running).toBe(2);
    const c = sem.acquire();               // queued
    expect(c).not.toBeNull();
    expect(sem.waiting).toBe(1);
    expect(sem.acquire()).toBeNull();      // queue full
    let cGot = false;
    void c!.then(() => { cGot = true; });
    await new Promise((r) => setImmediate(r));
    expect(cGot).toBe(false);
    (await a!)();                          // a releases → c gets the slot
    await new Promise((r) => setImmediate(r));
    expect(cGot).toBe(true);
    expect(sem.running).toBe(2);
    expect(sem.waiting).toBe(0);
    (await b!)(); (await c!)();
    expect(sem.running).toBe(0);
  });

  it('a release function works once', async () => {
    const sem = new Semaphore(1, 0);
    const release = await sem.acquire()!;
    release(); release();
    expect(sem.running).toBe(0);
    expect(sem.acquire()).not.toBeNull();
    expect(sem.acquire()).toBeNull();
  });

  it('validates its arguments and exposes the production defaults', () => {
    expect(() => new Semaphore(0, 4)).toThrow(/concurrent/);
    expect(() => new Semaphore(2, -1)).toThrow(/queue/);
    expect(VERIFY_CONCURRENCY).toBe(4);
    expect(VERIFY_QUEUE).toBe(16);
    expect(VERIFY_BUSY_RETRY_AFTER_SEC).toBe(3);
  });
});

describe('createVerifyPool with an injected verifier', () => {
  it('runs at most `concurrent` at once, parks `queue` more, and refuses the rest with VerifyBusyError', async () => {
    const gate = gatedVerifier();
    const pool = createVerifyPool({ concurrent: 2, queue: 1, run: gate.run });
    const replay = { v: SIM_VERSION, levelId: 't1', seed: 1, assist: false, masks: new Uint8Array(1) };
    const p1 = pool.verify(FIX_T1, replay); const p2 = pool.verify(FIX_T1, replay); const p3 = pool.verify(FIX_T1, replay);
    const p4 = pool.verify(FIX_T1, replay).catch((e: unknown) => e);
    await gate.settle();
    expect(gate.calls).toBe(2);
    expect(pool.stats).toMatchObject({ running: 2, waiting: 1, refused: 1, completed: 0 });
    const refused = await p4;
    expect(isVerifyBusy(refused)).toBe(true);
    expect(refused).toBeInstanceOf(VerifyBusyError);
    expect((refused as VerifyBusyError).retryAfterSec).toBe(VERIFY_BUSY_RETRY_AFTER_SEC);
    expect((refused as VerifyBusyError).reason).toBe('capacity');
    gate.release(1);
    await gate.settle();
    expect(gate.calls).toBe(3);                 // the parked one started when a slot freed
    expect((await p1).ok).toBe(true);
    gate.release(2);
    expect((await p2).ok).toBe(true);
    expect((await p3).ok).toBe(true);
    expect(pool.stats).toMatchObject({ running: 0, waiting: 0, refused: 1, completed: 3 });
    expect(pool.workerAlive).toBe(false);
    await pool.close();
  });

  it('releases the slot when the verifier throws', async () => {
    const pool = createVerifyPool({ concurrent: 1, queue: 0, run: async () => { throw new Error('sim blew up'); } });
    const replay = { v: SIM_VERSION, levelId: 't1', seed: 1, assist: false, masks: new Uint8Array(1) };
    await expect(pool.verify(FIX_T1, replay)).rejects.toThrow('sim blew up');
    expect(pool.stats.running).toBe(0);
    await expect(pool.verify(FIX_T1, replay)).rejects.toThrow('sim blew up');
  });
});

describe('POST /api/runs under backpressure', () => {
  const apps: Awaited<ReturnType<typeof makeApp>>[] = [];
  afterEach(async () => { while (apps.length) await apps.pop()!.app.close(); });

  const body = (i: number) => submitBody({ player: { id: `burst-player-${i}`, name: `주자${i}` }, masks: uniqueMasks() });
  /** Each submission from its own address: the per-IP budget (12/min) is not what these tests measure. */
  const from = (i: number) => ({ 'x-forwarded-for': `203.0.${Math.floor(i / 250)}.${(i % 250) + 1}` });

  it('5 concurrent submissions on a pool of 4 with no queue: four proceed (200), the fifth is 503 busy with Retry-After 3', async () => {
    const gate = gatedVerifier();
    const lines: LogLine[] = [];
    const pool = createVerifyPool({ concurrent: 4, queue: 0, run: gate.run, log: (record, msg) => lines.push({ record, msg }) });
    const ctx = await makeApp({ verify: pool.verify });
    apps.push(ctx);
    const pending = [0, 1, 2, 3, 4].map((i) => postRun(ctx.app, body(i), from(i)));
    expect(await gate.reached(4)).toBe(4);
    // the refused one has already answered while the four are still verifying
    const settled = await Promise.race([pending[4], new Promise<null>((r) => setTimeout(() => r(null), 500))]);
    expect(settled).not.toBeNull();
    expect(settled!.statusCode).toBe(503);
    expect(settled!.json()).toMatchObject({ error: 'busy', detail: { retryAfter: 3 } });
    expect(settled!.headers['retry-after']).toBe('3');
    expect(settled!.headers['cache-control']).toBe('no-store');
    expect(lines.filter((l) => l.msg === 'verify busy')).toHaveLength(1);
    gate.release(4);
    const four = await Promise.all(pending.slice(0, 4));
    expect(four.map((r) => r.statusCode)).toEqual([200, 200, 200, 200]);
    expect(pool.stats).toMatchObject({ refused: 1, completed: 4 });
  });

  it('with a queue the fifth waits for a slot instead of failing, and is accepted once one frees', async () => {
    const gate = gatedVerifier();
    const pool = createVerifyPool({ concurrent: 4, queue: 16, run: gate.run });
    const ctx = await makeApp({ verify: pool.verify });
    apps.push(ctx);
    const pending = [0, 1, 2, 3, 4].map((i) => postRun(ctx.app, body(i), from(i)));
    expect(await gate.reached(4)).toBe(4);
    // the fifth is parked in the queue (give its request the same chance to arrive)
    const deadline = Date.now() + 2000;
    while (pool.stats.waiting < 1 && Date.now() < deadline) await gate.settle();
    expect(pool.stats).toMatchObject({ running: 4, waiting: 1, refused: 0 });
    expect(gate.calls).toBe(4);
    gate.release(1);
    expect(await gate.reached(5)).toBe(5);
    gate.release(4);
    const all = await Promise.all(pending);
    expect(all.map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 200]);
  });

  it('a busy pool does not swallow cheap rejections: version, assist and schema failures answer before the verifier', async () => {
    const gate = gatedVerifier();
    const pool = createVerifyPool({ concurrent: 1, queue: 0, run: gate.run });
    const ctx = await makeApp({ verify: pool.verify });
    apps.push(ctx);
    const held = postRun(ctx.app, body(0), from(0));
    expect(await gate.reached(1)).toBe(1);
    expect((await postRun(ctx.app, submitBody({ sim: SIM_VERSION + 1 }), from(1))).statusCode).toBe(422);
    expect((await postRun(ctx.app, submitBody({ assist: true }), from(2))).statusCode).toBe(422);
    expect((await postRun(ctx.app, { nope: 1 }, from(3))).statusCode).toBe(400);
    expect((await postRun(ctx.app, body(1), from(4))).statusCode).toBe(503);
    gate.release(1);
    expect((await held).statusCode).toBe(200);
  });

  it('/healthz stays instant while the pool is saturated', async () => {
    const gate = gatedVerifier();
    const pool = createVerifyPool({ concurrent: 4, queue: 16, run: gate.run });
    const ctx = await makeApp({ verify: pool.verify });
    apps.push(ctx);
    const pending = Array.from({ length: 20 }, (_, i) => postRun(ctx.app, body(i), from(i)));
    expect(await gate.reached(4)).toBe(4);
    const deadline = Date.now() + 2000;
    while (pool.stats.waiting < 16 && Date.now() < deadline) await gate.settle();
    expect(pool.stats).toMatchObject({ running: 4, waiting: 16 });
    const t0 = performance.now();
    const health = await ctx.app.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);
    expect(performance.now() - t0).toBeLessThan(50);
    expect((await postRun(ctx.app, body(99), from(99))).statusCode).toBe(503);
    expect(await gate.drain(20)).toBe(20);
    expect((await Promise.all(pending)).every((r) => r.statusCode === 200)).toBe(true);
    expect(pool.stats).toMatchObject({ running: 0, waiting: 0, refused: 1, completed: 20 });
  });
});

describe('worker-thread verifier (bundled like the server)', () => {
  let dir: string;
  let workerUrl: URL;

  beforeAll(async () => {
    mkdirSync(SCRATCH, { recursive: true });
    dir = mkdtempSync(join(SCRATCH, 'verify-worker-'));
    const outfile = join(dir, 'verifyPool.bundle.mjs');
    // The same shape tools/lib.mjs serverOptions gives the server bundle (ESM, node, everything bundled).
    await build({
      absWorkingDir: ROOT,
      entryPoints: [join(ROOT, 'src', 'server', 'verifyPool.ts')],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      packages: 'bundle',
      logLevel: 'silent',
    });
    workerUrl = pathToFileURL(outfile);
  }, 60_000);
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  /** RIGHT held: on the fixture floor the goal is nine tiles to the right. */
  const RIGHT = (() => { const m = new Uint8Array(900); m.fill(IN.RIGHT); return m; })();

  it('verifies a real replay in the worker with the same result as the in-process sim', async () => {
    const pool = createVerifyPool({ workerUrl });
    try {
      const replay = { v: SIM_VERSION, levelId: FIX_T1.id, seed: FIX_T1.seed, assist: false, masks: RIGHT };
      const local = verifyReplay(FIX_T1, replay);
      expect(local.ok).toBe(true);
      expect(local.summary.cleared).toBe(true);
      const remote = await pool.verify(FIX_T1, replay);
      expect(remote).toEqual(local);
      expect(pool.workerAlive).toBe(true);
      // a claim travels too and is checked inside the worker
      const claim = { ticks: local.summary.ticks, shards: local.summary.shards, deaths: 0, cleared: true, height: 0 };
      expect((await pool.verify(FIX_T1, replay, claim)).ok).toBe(true);
      const bad = await pool.verify(FIX_T1, replay, { ...claim, ticks: claim.ticks + 1 });
      expect(bad).toMatchObject({ ok: false, reason: 'claim-mismatch' });
    } finally {
      await pool.close();
    }
    expect(pool.workerAlive).toBe(false);
  });

  it('accepts a submission end to end through the app with the worker verifier (200) and refuses a forged claim (422)', async () => {
    const pool = createVerifyPool({ workerUrl });
    const ctx = await makeApp({ verify: pool.verify });
    try {
      const local = verifyReplay(FIX_T1, { v: SIM_VERSION, levelId: FIX_T1.id, seed: FIX_T1.seed, assist: false, masks: RIGHT });
      const claim = { ticks: local.summary.ticks, shards: local.summary.shards, deaths: local.summary.deaths, cleared: true, height: 0 };
      // A real client stops recording at the goal; a log padded far past it is refused as too-long before verifying.
      const masks = encodeMasks(RIGHT.subarray(0, local.summary.ticks + INTRO_TICKS + 60));
      const ok = await postRun(ctx.app, submitBody({ masks, claim }));
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ accepted: true, rank: 1, total: 1, personalBest: true });
      const forged = await postRun(ctx.app, submitBody({ player: { id: 'forger-000001', name: '위조' }, masks, claim: { ...claim, shards: claim.shards + 1 } }));
      expect(forged.statusCode).toBe(422);
      expect(forged.json().reason).toBe('claim-mismatch');
    } finally {
      await ctx.app.close();
      await pool.close();
    }
  });

  it('keeps the main thread free: /healthz answers in < 50 ms while a 72000-tick replay verifies in the worker', async () => {
    const pool = createVerifyPool({ workerUrl, warm: true });
    const ctx = await makeApp({ verify: pool.verify });
    try {
      await ctx.app.inject({ method: 'GET', url: '/healthz' }); // warm-up
      const idle = new Uint8Array(MAX_TICKS); // standing still never reaches the goal: every tick is stepped
      const pending = postRun(ctx.app, submitBody({ masks: encodeMasks(idle), claim: { ticks: MAX_TICKS, deaths: 0, shards: 0 } }));
      const t0 = performance.now();
      const health = await ctx.app.inject({ method: 'GET', url: '/healthz' });
      const healthMs = performance.now() - t0;
      const res = await pending;
      expect(health.statusCode).toBe(200);
      expect(healthMs).toBeLessThan(50);
      expect(res.statusCode).toBe(422);
      expect(res.json().reason).toBe('not-finished');
    } finally {
      await ctx.app.close();
      await pool.close();
    }
  });

  it('a wedged worker is replaced: jobs past the timeout fail as busy, the next verification spawns a fresh worker', async () => {
    const pool = createVerifyPool({ workerUrl, timeoutMs: 1 });
    const replay = { v: SIM_VERSION, levelId: FIX_T1.id, seed: FIX_T1.seed, assist: false, masks: new Uint8Array(MAX_TICKS) };
    try {
      const err = await pool.verify(FIX_T1, replay).catch((e: unknown) => e);
      expect(isVerifyBusy(err)).toBe(true);
      expect((err as VerifyBusyError).reason).toBe('timeout');
      expect(pool.workerAlive).toBe(false);
    } finally {
      await pool.close();
    }
    const healthy = createVerifyPool({ workerUrl });
    try {
      expect((await healthy.verify(FIX_T1, { ...replay, masks: RIGHT })).ok).toBe(true);
    } finally {
      await healthy.close();
    }
  });
});
