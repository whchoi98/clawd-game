/**
 * Offline submission queue: persistence, FIFO flushing, verdict handling and
 * the cap — all against a fake storage and a fake API.
 */
import { describe, expect, it } from 'vitest';
import type { RunResponse, RunSubmit } from '../../src/shared/protocol.js';
import { Api, ApiError } from '../../src/client/net/api.js';
import { QUEUE_KEY, QUEUE_MAX, SubmitQueue, type FlushEvent } from '../../src/client/net/queue.js';
import type { StorageLike } from '../../src/client/save.js';

class MemStorage implements StorageLike {
  readonly map = new Map<string, string>();
  getItem(k: string): string | null { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string): void { this.map.set(k, v); }
  removeItem(k: string): void { this.map.delete(k); }
}

function body(masks: string, mode: 'story' | 'daily' = 'story'): RunSubmit {
  return {
    player: { id: 'abcdefgh-1234', name: '클로드' },
    mode,
    levelId: mode === 'daily' ? 'daily' : 't1',
    ...(mode === 'daily' ? { date: '2026-09-06', seed: 12345 } : {}),
    assist: false,
    masks,
    claim: { ticks: 100, shards: 1, deaths: 0, cleared: true, height: 0 },
    client: { build: 'test' },
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

describe('SubmitQueue', () => {
  it('skips live held entries while sending other runs, and holds never survive reload', async () => {
    const storage = new MemStorage();
    const q = new SubmitQueue({ storage });
    const live = q.enqueue(body('LIVE'), { mode: 'story', board: 't1', levelId: 't1' });
    expect(typeof q.hold).toBe('function');
    expect(q.hold(live)).toBe(true);
    q.enqueue(body('OLD-A'), { mode: 'story', board: 't2', levelId: 't2' });
    q.enqueue(body('OLD-B'), { mode: 'story', board: 't3', levelId: 't3' });
    const api = scriptedApi([]);
    expect(await q.flush(api)).toEqual({ sent: 2, dropped: 0, kept: 1 });
    expect(api.sent.map((run) => run.masks)).toEqual(['OLD-A', 'OLD-B']);
    expect(new SubmitQueue({ storage }).list()[0].body.masks).toBe('LIVE');
    // A new process has no live POST; it must retry this serialized entry.
    const reloaded = new SubmitQueue({ storage });
    const afterReload = scriptedApi([]);
    expect(await reloaded.flush(afterReload)).toEqual({ sent: 1, dropped: 0, kept: 0 });
    expect(afterReload.sent[0].masks).toBe('LIVE');
    // Releasing in the original process also makes it eligible on the next pass.
    q.release(live);
    expect(await q.flush(api)).toEqual({ sent: 1, dropped: 0, kept: 0 });
    expect(api.sent.map((run) => run.masks)).toEqual(['OLD-A', 'OLD-B', 'LIVE']);
  });

  it('an active flush skips a not-yet-sent entry held while its earlier request is pending', async () => {
    const q = new SubmitQueue({ storage: null });
    const first = q.enqueue(body('FIRST'), { mode: 'story', board: 't1', levelId: 't1' });
    const live = q.enqueue(body('LIVE'), { mode: 'story', board: 't2', levelId: 't2' });
    let finish!: (response: RunResponse) => void;
    const gate = new Promise<RunResponse>((resolve) => { finish = resolve; });
    const sent: string[] = [];
    const api = { submitRun: async (run: RunSubmit) => { sent.push(run.masks); return gate; } };
    const pass = q.flush(api);
    expect(typeof q.hold).toBe('function');
    expect(q.hold(first)).toBe(false); // Already dispatched: ownership cannot be taken back.
    expect(q.hold(live)).toBe(true);
    expect(q.flush(api)).toBe(pass);
    finish(accepted('first-run'));
    expect(await pass).toEqual({ sent: 1, dropped: 0, kept: 1 });
    expect(sent).toEqual(['FIRST']);
    q.release(live);
    expect(await q.flush(api)).toEqual({ sent: 1, dropped: 0, kept: 0 });
    expect(sent).toEqual(['FIRST', 'LIVE']);
  });

  it('holding a new write-ahead entry during a flush leaves it pending, and acknowledgement clears the hold', async () => {
    const q = new SubmitQueue({ storage: null });
    q.enqueue(body('OLD'), { mode: 'story', board: 't1', levelId: 't1' });
    let finish!: (response: RunResponse) => void;
    const pass = q.flush({ submitRun: () => new Promise((resolve) => { finish = resolve; }) });
    const live = q.enqueue(body('LIVE'), { mode: 'story', board: 't2', levelId: 't2' });
    expect(typeof q.hold).toBe('function');
    expect(q.hold(live)).toBe(true);
    finish(accepted('old-run'));
    expect(await pass).toEqual({ sent: 1, dropped: 0, kept: 1 });
    expect(q.acknowledge(live)).toBe(true);
    q.release(live); // The direct request's finally is harmless after acknowledgement.
    expect(q.hold(live)).toBe(false);
    const cleared = q.enqueue(body('CLEARED'), { mode: 'story', board: 't3', levelId: 't3' });
    q.hold(cleared);
    q.clear();
    expect(q.hold(cleared)).toBe(false);
    const next = q.enqueue(body('CLEARED'), { mode: 'story', board: 't3', levelId: 't3' });
    const api = scriptedApi([]);
    await q.flush(api);
    expect(api.sent).toEqual([next.body]);
  });

  it('retains an interrupted 200 through the real API and resubmits the same body', async () => {
    const storage = new MemStorage();
    const q = new SubmitQueue({ storage });
    q.enqueue(body('AAA'), { mode: 'story', board: 't1', levelId: 't1' });
    const broken = new Api({ fetch: async () => new Response('{"accepted":true,', { status: 200 }) });
    expect(await q.flush(broken)).toEqual({ sent: 0, dropped: 0, kept: 1 });
    const reloaded = new SubmitQueue({ storage });
    expect(reloaded.list()[0].body).toEqual(body('AAA'));
    const online = scriptedApi([]);
    expect(await reloaded.flush(online)).toEqual({ sent: 1, dropped: 0, kept: 0 });
    expect(online.sent[0]).toEqual(body('AAA'));
  });

  it.each([400, 413, 422])('drops an authoritative HTTP %i with a malformed body', async (status) => {
    const q = new SubmitQueue({ storage: null });
    q.enqueue(body('AAA'), { mode: 'story', board: 't1', levelId: 't1' });
    const api = new Api({ fetch: async () => new Response('{', { status }) });
    expect(await q.flush(api)).toEqual({ sent: 0, dropped: 1, kept: 0 });
  });

  it('acknowledges only the enqueue handle, persistently and idempotently', () => {
    const storage = new MemStorage();
    const q = new SubmitQueue({ storage });
    const first = q.enqueue(body('SAME'), { mode: 'story', board: 't1', levelId: 't1' });
    const other = q.enqueue(body('SAME', 'daily'), { mode: 'daily', board: '2026-09-06', levelId: 'daily' });
    expect(typeof q.acknowledge).toBe('function');
    expect(q.acknowledge(first)).toBe(true);
    expect(q.acknowledge(first)).toBe(false);
    expect(q.acknowledge({ ...other })).toBe(false);
    expect(new SubmitQueue({ storage }).list()).toEqual([other]);
    expect(q.acknowledge(other)).toBe(true);
    expect(storage.getItem(QUEUE_KEY)).toBeNull();
  });

  it('does not send an acknowledged waiting entry or report an already acknowledged in-flight result', async () => {
    const q = new SubmitQueue({ storage: null });
    const first = q.enqueue(body('AAA'), { mode: 'story', board: 't1', levelId: 't1' });
    const second = q.enqueue(body('BBB'), { mode: 'story', board: 't2', levelId: 't2' });
    let release!: (value: RunResponse) => void;
    const gate = new Promise<RunResponse>((resolve) => { release = resolve; });
    const sent: string[] = [], events: FlushEvent[] = [];
    const pass = q.flush({ submitRun: async (b) => { sent.push(b.masks); return gate; } }, (ev) => events.push(ev));
    expect(typeof q.acknowledge).toBe('function');
    q.acknowledge(first);
    q.acknowledge(second);
    release(accepted('run-1'));
    expect(await pass).toEqual({ sent: 0, dropped: 0, kept: 0 });
    expect(sent).toEqual(['AAA']);
    expect(events).toEqual([]);
  });

  it('persists queued bodies with their meta and reloads them in order', () => {
    const storage = new MemStorage();
    let t = 1000;
    const q = new SubmitQueue({ storage, now: () => t++ });
    q.enqueue(body('AAA'), { mode: 'story', board: 't1', levelId: 't1' });
    q.enqueue(body('BBB', 'daily'), { mode: 'daily', board: '2026-09-06', levelId: 'daily' });
    expect(q.size()).toBe(2);
    const raw = JSON.parse(storage.getItem(QUEUE_KEY)!) as { body: RunSubmit; mode: string; board: string; levelId: string; createdAt: number }[];
    expect(raw).toHaveLength(2);
    expect(raw[0]).toMatchObject({ mode: 'story', board: 't1', levelId: 't1', createdAt: 1000 });
    expect(raw[0].body.masks).toBe('AAA');
    expect(raw[1]).toMatchObject({ mode: 'daily', board: '2026-09-06', levelId: 'daily', createdAt: 1001 });

    const again = new SubmitQueue({ storage });
    expect(again.size()).toBe(2);
    expect(again.list().map((i) => i.body.masks)).toEqual(['AAA', 'BBB']);
  });

  it('ignores corrupt or foreign storage content', () => {
    const storage = new MemStorage();
    storage.setItem(QUEUE_KEY, '{not json');
    expect(new SubmitQueue({ storage }).size()).toBe(0);
    storage.setItem(QUEUE_KEY, JSON.stringify([{ mode: 'story' }, 7, { body: { masks: 'X' }, mode: 'nope', board: 'b', levelId: 'l' }]));
    expect(new SubmitQueue({ storage }).size()).toBe(0);
    storage.setItem(QUEUE_KEY, JSON.stringify([{ body: body('OK'), mode: 'story', board: 't1', levelId: 't1' }]));
    const q = new SubmitQueue({ storage });
    expect(q.size()).toBe(1);
    expect(q.list()[0].createdAt).toBe(0);
  });

  it('flushes oldest first, reports each verdict and empties the storage', async () => {
    const storage = new MemStorage();
    const q = new SubmitQueue({ storage });
    q.enqueue(body('AAA'), { mode: 'story', board: 't1', levelId: 't1' });
    q.enqueue(body('BBB'), { mode: 'story', board: 't2', levelId: 't2' });
    q.enqueue(body('CCC'), { mode: 'story', board: 't3', levelId: 't3' });
    const api = scriptedApi([]);
    const events: FlushEvent[] = [];
    const r = await q.flush(api, (ev) => events.push(ev));
    expect(api.sent.map((b) => b.masks)).toEqual(['AAA', 'BBB', 'CCC']);
    expect(r).toEqual({ sent: 3, dropped: 0, kept: 0 });
    expect(events.map((e) => e.kind)).toEqual(['sent', 'sent', 'sent']);
    expect(events[1].item.board).toBe('t2');
    expect((events[2] as { response: RunResponse }).response).toMatchObject({ accepted: true, runId: 'run-3' });
    expect(q.size()).toBe(0);
    expect(storage.getItem(QUEUE_KEY)).toBeNull();
  });

  it('drops a run the server rejected with 422 and reports the rejection', async () => {
    const q = new SubmitQueue({ storage: new MemStorage() });
    q.enqueue(body('OLD', 'daily'), { mode: 'daily', board: '2026-09-05', levelId: 'daily' });
    q.enqueue(body('NEW'), { mode: 'story', board: 't1', levelId: 't1' });
    const api = scriptedApi([{ accepted: false, reason: 'stale-date' }]);
    const events: FlushEvent[] = [];
    const r = await q.flush(api, (ev) => events.push(ev));
    expect(r).toEqual({ sent: 2, dropped: 0, kept: 0 });
    expect(events[0]).toMatchObject({ kind: 'sent', response: { accepted: false, reason: 'stale-date' } });
    expect(events[1]).toMatchObject({ kind: 'sent', response: { accepted: true } });
    expect(q.size()).toBe(0);
  });

  it('keeps everything and stops at the first network failure, 5xx or 429', async () => {
    const storage = new MemStorage();
    const q = new SubmitQueue({ storage });
    q.enqueue(body('AAA'), { mode: 'story', board: 't1', levelId: 't1' });
    q.enqueue(body('BBB'), { mode: 'story', board: 't2', levelId: 't2' });

    let api = scriptedApi([new ApiError('network error', 0, 'network')]);
    let r = await q.flush(api);
    expect(r).toEqual({ sent: 0, dropped: 0, kept: 2 });
    expect(api.sent).toHaveLength(1);
    expect(q.list().map((i) => i.body.masks)).toEqual(['AAA', 'BBB']);
    expect(JSON.parse(storage.getItem(QUEUE_KEY)!)).toHaveLength(2);

    api = scriptedApi([new TypeError('fetch failed')]);
    r = await q.flush(api);
    expect(r.kept).toBe(2);

    api = scriptedApi([new ApiError('HTTP 503', 503, 'server-error')]);
    r = await q.flush(api);
    expect(r.kept).toBe(2);

    api = scriptedApi([new ApiError('HTTP 429', 429, 'rate-limited')]);
    r = await q.flush(api);
    expect(r.kept).toBe(2);

    // the server is back: both go, in order
    api = scriptedApi([]);
    r = await q.flush(api);
    expect(r).toEqual({ sent: 2, dropped: 0, kept: 0 });
    expect(api.sent.map((b) => b.masks)).toEqual(['AAA', 'BBB']);
  });

  it('drops a run the server refuses with another 4xx and carries on', async () => {
    const q = new SubmitQueue({ storage: new MemStorage() });
    q.enqueue(body('BAD'), { mode: 'story', board: 't1', levelId: 't1' });
    q.enqueue(body('GOOD'), { mode: 'story', board: 't2', levelId: 't2' });
    const api = scriptedApi([new ApiError('HTTP 413', 413, 'too-long')]);
    const events: FlushEvent[] = [];
    const r = await q.flush(api, (ev) => events.push(ev));
    expect(r).toEqual({ sent: 1, dropped: 1, kept: 0 });
    expect(events[0]).toMatchObject({ kind: 'dropped', reason: 'too-long' });
    expect(events[0].item.body.masks).toBe('BAD');
    expect(events[1]).toMatchObject({ kind: 'sent' });
  });

  it('caps the queue at QUEUE_MAX, dropping the oldest', () => {
    const storage = new MemStorage();
    const q = new SubmitQueue({ storage });
    for (let i = 0; i < QUEUE_MAX + 5; i++) q.enqueue(body(`M${i}`), { mode: 'story', board: 't1', levelId: 't1' });
    expect(QUEUE_MAX).toBe(20);
    expect(q.size()).toBe(QUEUE_MAX);
    expect(q.list()[0].body.masks).toBe('M5');
    expect(q.list().at(-1)!.body.masks).toBe(`M${QUEUE_MAX + 4}`);
    expect(JSON.parse(storage.getItem(QUEUE_KEY)!)).toHaveLength(QUEUE_MAX);
    // a stored list longer than the cap is trimmed on load too
    storage.setItem(QUEUE_KEY, JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ body: body(`S${i}`), mode: 'story', board: 't1', levelId: 't1', createdAt: i }))));
    const again = new SubmitQueue({ storage });
    expect(again.size()).toBe(QUEUE_MAX);
    expect(again.list()[0].body.masks).toBe('S10');
  });

  it('a second flush while one is running joins it instead of double-sending', async () => {
    const q = new SubmitQueue({ storage: null });
    q.enqueue(body('AAA'), { mode: 'story', board: 't1', levelId: 't1' });
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    const sent: string[] = [];
    const api = {
      async submitRun(b: RunSubmit): Promise<RunResponse> { sent.push(b.masks); await gate; return accepted('run-1'); },
    };
    const p1 = q.flush(api);
    const p2 = q.flush(api);
    expect(p2).toBe(p1);
    release!();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual({ sent: 1, dropped: 0, kept: 0 });
    expect(r2).toBe(r1);
    expect(sent).toEqual(['AAA']);
    expect(q.size()).toBe(0);
    // and a flush after that is a fresh pass
    const r3 = await q.flush(api);
    expect(r3).toEqual({ sent: 0, dropped: 0, kept: 0 });
  });

  it('works without any storage (private mode)', async () => {
    const q = new SubmitQueue({ storage: null });
    q.enqueue(body('AAA'), { mode: 'story', board: 't1', levelId: 't1' });
    expect(q.size()).toBe(1);
    const api = scriptedApi([]);
    await q.flush(api);
    expect(api.sent).toHaveLength(1);
    expect(q.size()).toBe(0);
  });
});
