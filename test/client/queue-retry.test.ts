/**
 * Offline submission queue — the busy / 429 retry timer (P3-12 client wiring):
 * a refused pass keeps its items and comes back after Retry-After, doubling on
 * repeats and capped at 30 s; boot / online flushes cancel the timer.
 */
import { describe, expect, it } from 'vitest';
import type { RunResponse, RunSubmit } from '../../src/shared/protocol.js';
import { ApiError } from '../../src/client/net/api.js';
import { RETRY_DEFAULT_S, RETRY_MAX_S, SubmitQueue, retryDelayMs, type FlushEvent } from '../../src/client/net/queue.js';
import type { StorageLike } from '../../src/client/save.js';

class MemStorage implements StorageLike {
  readonly map = new Map<string, string>();
  getItem(k: string): string | null { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string): void { this.map.set(k, v); }
  removeItem(k: string): void { this.map.delete(k); }
}

function body(masks: string): RunSubmit {
  return {
    player: { id: 'abcdefgh-1234', name: '클로드' }, mode: 'story', levelId: 't1', assist: false, masks,
    claim: { ticks: 100, shards: 1, deaths: 0, cleared: true, height: 0 }, client: { build: 'test' },
  };
}

const accepted = (runId: string): RunResponse => ({
  accepted: true, runId, rank: 1, total: 1, score: 100, personalBest: true,
  summary: {
    levelId: 't1', cleared: true, ticks: 100, time: 100 / 120, shards: 1, totalShards: 1, relics: 0, totalRelics: 0,
    deaths: 0, par: 30, rank: 'S', height: 0,
  },
});

/** A scripted API: each call pops the next behaviour; `sent` records the bodies that reached it. */
function scriptedApi(script: (RunResponse | Error)[]) {
  const sent: RunSubmit[] = [];
  return {
    sent,
    async submitRun(b: RunSubmit): Promise<RunResponse> {
      sent.push(b);
      const next = script.shift();
      if (!next) return accepted(`run-${sent.length}`);
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

/** Manual timer queue: the retry timer fires when the test says so. */
function manualTimers() {
  const q: { fn: () => void; ms: number; id: number }[] = [];
  let seq = 1;
  return {
    schedule: (fn: () => void, ms: number): number => { const id = seq++; q.push({ fn, ms, id }); return id; },
    cancel: (id: unknown): void => { const i = q.findIndex((t) => t.id === id); if (i >= 0) q.splice(i, 1); },
    fire: (): void => { const all = q.splice(0); for (const t of all) t.fn(); },
    pending: (): number => q.length,
    delays: (): number[] => q.map((t) => t.ms),
  };
}

const busy = (retryAfter?: number) => new ApiError('HTTP 503', 503, 'busy', { error: 'busy', detail: { retryAfter } }, retryAfter);

describe('SubmitQueue · 503 busy / 429 retry timer', () => {
  it('retryDelayMs: Retry-After (default 3 s) doubled per earlier refusal, capped at 30 s', () => {
    expect(RETRY_DEFAULT_S).toBe(3);
    expect(RETRY_MAX_S).toBe(30);
    expect(retryDelayMs(undefined, 0)).toBe(3000);
    expect(retryDelayMs(undefined, 1)).toBe(6000);
    expect(retryDelayMs(undefined, 3)).toBe(24_000);
    expect(retryDelayMs(undefined, 4)).toBe(30_000);
    expect(retryDelayMs(5, 0)).toBe(5000);
    expect(retryDelayMs(5, 2)).toBe(20_000);
    expect(retryDelayMs(60, 0)).toBe(30_000);
    expect(retryDelayMs(0, 0)).toBe(3000);
    expect(retryDelayMs(Number.NaN, 0)).toBe(3000);
  });

  it('a busy refusal keeps the item, stops the pass and arms a retry after Retry-After; the timer flushes on its own', async () => {
    const timers = manualTimers();
    let now = 1_000_000;
    const q = new SubmitQueue({ storage: new MemStorage(), now: () => now, schedule: timers.schedule, cancel: timers.cancel });
    q.enqueue(body('AAA'), { mode: 'story', board: 't1', levelId: 't1' });
    q.enqueue(body('BBB'), { mode: 'story', board: 't2', levelId: 't2' });
    const api = scriptedApi([busy(3)]);
    const events: FlushEvent[] = [];
    const r = await q.flush(api, (ev) => events.push(ev));
    expect(r).toEqual({ sent: 0, dropped: 0, kept: 2 });
    expect(api.sent).toHaveLength(1);
    expect(events).toEqual([]);
    expect(timers.pending()).toBe(1);
    expect(timers.delays()).toEqual([3000]);
    expect(q.retryAt).toBe(now + 3000);
    expect(q.attempts).toBe(1);
    // the timer fires: the whole queue goes, oldest first, through the same api and listener
    now += 3000;
    timers.fire();
    await q.flush(api);   // joins the flush the timer started
    expect(api.sent.map((b) => b.masks)).toEqual(['AAA', 'AAA', 'BBB']);
    expect(events.map((e) => e.kind)).toEqual(['sent', 'sent']);
    expect(q.size()).toBe(0);
    expect(q.retryAt).toBeNull();
    expect(q.attempts).toBe(0);
    expect(timers.pending()).toBe(0);
  });

  it('repeated refusals back off exponentially (3 → 6 → 12 s), a 429 uses its own Retry-After, a success resets the exponent', async () => {
    const timers = manualTimers();
    const q = new SubmitQueue({ storage: null, now: () => 0, schedule: timers.schedule, cancel: timers.cancel });
    q.enqueue(body('AAA'), { mode: 'story', board: 't1', levelId: 't1' });
    // the timer re-flushes through the api of the refused pass, so one scripted api carries the whole story:
    // three busy answers, a rate limit with its own header (20 s doubled thrice would be 160 s → capped), then acceptance
    const api = scriptedApi([busy(), busy(), busy(), new ApiError('HTTP 429', 429, 'rate-limited', undefined, 20)]);
    await q.flush(api);
    expect(timers.delays()).toEqual([3000]);
    timers.fire();
    await q.flush(api);
    expect(timers.delays()).toEqual([6000]);
    timers.fire();
    await q.flush(api);
    expect(timers.delays()).toEqual([12_000]);
    timers.fire();
    await q.flush(api);
    expect(timers.delays()).toEqual([30_000]);
    expect(q.attempts).toBe(4);
    expect(q.size()).toBe(1);
    timers.fire();
    await q.flush(api);
    expect(api.sent).toHaveLength(5);
    expect(q.size()).toBe(0);
    expect(q.attempts).toBe(0);
    expect(timers.pending()).toBe(0);
  });

  it('retryLater() arms the timer without sending now (the live submit path), and a boot / online flush cancels it', async () => {
    const timers = manualTimers();
    const q = new SubmitQueue({ storage: null, now: () => 5000, schedule: timers.schedule, cancel: timers.cancel });
    q.enqueue(body('AAA'), { mode: 'story', board: 't1', levelId: 't1' });
    const api = scriptedApi([]);
    expect(q.retryLater(api, undefined, 4)).toBe(4000);
    expect(api.sent).toHaveLength(0);
    expect(q.retryAt).toBe(9000);
    expect(timers.pending()).toBe(1);
    // the window came back online first: the flush runs now and drops the timer
    await q.flush(api);
    expect(api.sent).toHaveLength(1);
    expect(timers.pending()).toBe(0);
    expect(q.retryAt).toBeNull();
    // re-arming replaces the earlier timer; clear() drops it
    q.enqueue(body('BBB'), { mode: 'story', board: 't1', levelId: 't1' });
    q.retryLater(api);
    q.retryLater(api);
    expect(timers.pending()).toBe(1);
    q.clear();
    expect(timers.pending()).toBe(0);
    expect(q.attempts).toBe(0);
  });

  it('a plain 5xx / network failure still waits for boot or online: no timer', async () => {
    const timers = manualTimers();
    const q = new SubmitQueue({ storage: null, schedule: timers.schedule, cancel: timers.cancel });
    q.enqueue(body('AAA'), { mode: 'story', board: 't1', levelId: 't1' });
    await q.flush(scriptedApi([new ApiError('HTTP 503', 503, 'server-error')]));
    await q.flush(scriptedApi([new TypeError('fetch failed')]));
    expect(timers.pending()).toBe(0);
    expect(q.retryAt).toBeNull();
    expect(q.size()).toBe(1);
  });
});
