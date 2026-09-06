/**
 * Anonymous telemetry client (src/client/net/telemetry.ts) against fake
 * transports and timers: events buffer and go out as one EventBatch on the
 * timer / a screen change, page hide flushes through sendBeacon, batches are
 * split at 20 events / 4096 bytes, nothing at all happens when disabled
 * (the `?shot=` harness), and no field can carry an identity.
 */
import { describe, expect, it } from 'vitest';
import { EventBatch, MAX_EVENTS_PER_BATCH, MAX_EVENT_BODY_BYTES } from '../../src/shared/protocol.js';
import {
  FLUSH_MS, FPS_SAMPLE_MS, Telemetry, errorData, percentile, splitBatches, uaFamily, utf8Bytes,
} from '../../src/client/net/telemetry.js';

// ------------------------------------------------------------------ fakes
class FakeTarget extends EventTarget { hidden = false; }

function manualTimers() {
  const q: { fn: () => void; id: number; ms: number }[] = [];
  let seq = 1;
  return {
    schedule: (fn: () => void, ms: number): number => { const id = seq++; q.push({ fn, id, ms }); return id; },
    cancel: (id: unknown): void => { const i = q.findIndex((t) => t.id === id); if (i >= 0) q.splice(i, 1); },
    fire: (): void => { const all = q.splice(0); for (const t of all) t.fn(); },
    pending: (): number => q.length,
    delays: (): number[] => q.map((t) => t.ms),
  };
}

function harness(opts: { enabled?: boolean; beaconOk?: boolean; fetchFails?: boolean } = {}) {
  const timers = manualTimers();
  const win = new FakeTarget();
  const doc = new FakeTarget();
  const fetches: { url: string; body: string; keepalive: boolean; contentType: string }[] = [];
  const beacons: { url: string; body: string }[] = [];
  let t = 1_000_000;
  const seed = Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04]);
  const tele = new Telemetry({
    build: 'testbuild', sim: 2, enabled: opts.enabled ?? true,
    now: () => t,
    randomBytes: (n) => seed.slice(0, n),
    schedule: timers.schedule, cancel: timers.cancel,
    win, doc,
    fetch: (url, init) => {
      fetches.push({ url, body: init.body, keepalive: init.keepalive, contentType: init.headers['content-type'] });
      return opts.fetchFails ? Promise.reject(new TypeError('offline')) : Promise.resolve({ ok: true });
    },
    beacon: (url, body) => { beacons.push({ url, body }); return opts.beaconOk ?? true; },
  });
  return { tele, timers, win, doc, fetches, beacons, advance: (ms: number) => { t += ms; } };
}

const parse = (body: string) => EventBatch.parse(JSON.parse(body));

// ------------------------------------------------------------------ tests
describe('Telemetry · batching', () => {
  it('has a 16-hex session id and batches every event of the first 10 s into one request on the timer', () => {
    const { tele, timers, fetches, advance } = harness();
    expect(tele.session).toMatch(/^[a-f0-9]{16}$/);
    expect(tele.session).toBe('deadbeef01020304');
    tele.track('boot', { uaFamily: 'desktop', dpr: 2 });
    for (let i = 0; i < 6; i++) { advance(1500); tele.track('death', { levelId: 't1', cause: 'pit', tx: 12 + i, ty: 14 }); }
    expect(fetches.length).toBe(0);
    expect(timers.delays()).toEqual([FLUSH_MS]);
    timers.fire();
    expect(fetches.length).toBe(1);
    const batch = parse(fetches[0].body);
    expect(fetches[0].url).toBe('/api/events');
    expect(fetches[0].contentType).toBe('application/json');
    expect(fetches[0].keepalive).toBe(true);
    expect(batch.s).toBe(tele.session);
    expect(batch.build).toBe('testbuild');
    expect(batch.sim).toBe(2);
    expect(batch.events.map((e) => e.t)).toEqual(['boot', 'death', 'death', 'death', 'death', 'death', 'death']);
    expect(batch.events[0].at).toBe(0);
    expect(batch.events[1].at).toBe(1500);
    expect(batch.events[6].at).toBe(9000);
    expect(batch.events[1].d).toEqual({ levelId: 't1', cause: 'pit', tx: 12, ty: 14 });
    // the timer re-arms and an empty buffer sends nothing
    expect(timers.pending()).toBe(1);
    timers.fire();
    expect(fetches.length).toBe(1);
  });

  it('splits more than 20 events into several valid batches and flushes at once when 20 are pending', () => {
    const { tele, fetches } = harness();
    for (let i = 0; i < 19; i++) tele.track('death', { levelId: 't1', cause: 'pit', tx: i, ty: 3 });
    expect(fetches.length).toBe(0);
    tele.track('respawn', { levelId: 't1' });
    expect(fetches.length).toBe(1);
    expect(parse(fetches[0].body).events.length).toBe(MAX_EVENTS_PER_BATCH);
    for (let i = 0; i < 25; i++) tele.track('death', { levelId: 't1', cause: 'spike', tx: i, ty: 3 });
    tele.flush('manual');
    expect(fetches.length).toBe(3);
    const sizes = fetches.slice(1).map((f) => parse(f.body).events.length);
    expect(sizes).toEqual([20, 5]);
    for (const f of fetches) expect(utf8Bytes(f.body)).toBeLessThanOrEqual(MAX_EVENT_BODY_BYTES);
  });

  it('splits by bytes (UTF-8, not characters) so no body exceeds 4096 bytes and every event survives in order', () => {
    const header = { s: 'deadbeef01020304', build: 'testbuild', sim: 2 };
    const events = [];
    for (let i = 0; i < 20; i++) {
      events.push({ t: 'js_error' as const, at: i, d: { message: '오류'.repeat(100), stack: 'x'.repeat(200), i } });
    }
    const bodies = splitBatches(header, events);
    expect(bodies.length).toBeGreaterThan(1);
    let n = 0;
    for (const b of bodies) {
      expect(utf8Bytes(b)).toBeLessThanOrEqual(MAX_EVENT_BODY_BYTES);
      const parsed = parse(b);
      for (const e of parsed.events) expect(e.d?.i).toBe(n++);
    }
    expect(n).toBe(20);
    // an event that cannot fit alone is dropped rather than sent oversize
    const huge = [{ t: 'js_error' as const, at: 0, d: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, 'y'.repeat(200)])) }];
    expect(splitBatches(header, huge)).toEqual([]);
    expect(splitBatches(header, [])).toEqual([]);
  });
});

describe('Telemetry · page lifecycle and transports', () => {
  it('pagehide flushes once through sendBeacon (string body) and never through fetch', () => {
    const { tele, win, fetches, beacons } = harness();
    tele.track('zone_start', { levelId: 't1' });
    tele.track('quit', { levelId: 't1' });
    win.dispatchEvent(new Event('pagehide'));
    expect(beacons.length).toBe(1);
    expect(fetches.length).toBe(0);
    const batch = parse(beacons[0].body);
    expect(batch.events.map((e) => e.t)).toEqual(['zone_start', 'quit']);
    // nothing left: a second pagehide sends nothing
    win.dispatchEvent(new Event('pagehide'));
    expect(beacons.length).toBe(1);
  });

  it('a hidden tab flushes like pagehide; a refused beacon falls back to fetch keepalive', () => {
    const { tele, doc, fetches, beacons } = harness({ beaconOk: false });
    tele.track('screen', { screen: 'title' });
    doc.hidden = true;
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(beacons.length).toBe(1);
    expect(fetches.length).toBe(1);
    expect(fetches[0].keepalive).toBe(true);
    expect(parse(fetches[0].body).events[0].d).toEqual({ screen: 'title' });
  });

  it('a screen change flushes immediately with a screen event', () => {
    const { tele, fetches } = harness();
    tele.track('boot');
    tele.screen('select');
    expect(fetches.length).toBe(1);
    expect(parse(fetches[0].body).events.map((e) => e.t)).toEqual(['boot', 'screen']);
    expect(parse(fetches[0].body).events[1].d).toEqual({ screen: 'select' });
  });

  it('a failing fetch is swallowed and the events are not retried forever', async () => {
    const { tele, fetches } = harness({ fetchFails: true });
    tele.track('boot');
    tele.flush('manual');
    await new Promise((r) => setTimeout(r, 0));
    expect(fetches.length).toBe(1);
    tele.flush('manual');
    expect(fetches.length).toBe(1);
    expect(tele.pending).toBe(0);
  });

  it('is completely inert when disabled (?shot=): no events, no timers, no listeners, no requests', () => {
    const { tele, timers, win, doc, fetches, beacons } = harness({ enabled: false });
    expect(tele.enabled).toBe(false);
    tele.track('boot', { uaFamily: 'desktop' });
    tele.screen('title');
    tele.flush('manual');
    win.dispatchEvent(new Event('pagehide'));
    doc.hidden = true;
    doc.dispatchEvent(new Event('visibilitychange'));
    for (let i = 0; i < 200; i++) tele.frame(16.7, 'high');
    expect(tele.pending).toBe(0);
    expect(timers.pending()).toBe(0);
    expect(fetches.length + beacons.length).toBe(0);
  });

  it('dispose() stops the timer and drops the buffer', () => {
    const { tele, timers, fetches } = harness();
    tele.track('boot');
    tele.dispose();
    expect(timers.pending()).toBe(0);
    timers.fire();
    tele.track('quit');
    tele.flush('manual');
    expect(fetches.length).toBe(0);
  });
});

describe('Telemetry · data hygiene', () => {
  it('truncates strings to 200 chars and keys to 32, drops non-finite numbers and nested values', () => {
    const { tele, fetches } = harness();
    tele.track('js_error', {
      message: 'm'.repeat(500),
      ['k'.repeat(40)]: 1,
      nan: Number.NaN,
      inf: Number.POSITIVE_INFINITY,
      nested: { a: 1 } as unknown as string,
      list: [1, 2] as unknown as string,
      ok: true,
    });
    tele.flush('manual');
    const ev = parse(fetches[0].body).events[0];
    expect(ev.d?.message).toHaveLength(200);
    expect(Object.keys(ev.d ?? {})).toEqual(['message', 'k'.repeat(32), 'ok']);
    expect(ev.d?.ok).toBe(true);
  });

  it('never carries an identity: forbidden keys are stripped client-side too', () => {
    const { tele, fetches } = harness();
    tele.track('boot', { playerId: 'abc', name: '클로드', ip: '1.2.3.4', email: 'a@b.c', player: 'x', playerTag: 'y', dpr: 1 });
    tele.flush('manual');
    const ev = parse(fetches[0].body).events[0];
    expect(ev.d).toEqual({ dpr: 1 });
    expect(fetches[0].body).not.toContain('클로드');
    expect(fetches[0].body).not.toContain('1.2.3.4');
  });

  it('uaFamily reduces the UA string to ios / android / desktop', () => {
    expect(uaFamily('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1')).toBe('ios');
    expect(uaFamily('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15')).toBe('ios');
    expect(uaFamily('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36')).toBe('android');
    expect(uaFamily('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36')).toBe('desktop');
    expect(uaFamily('')).toBe('desktop');
    expect(uaFamily(undefined)).toBe('desktop');
  });

  it('errorData keeps a 200-char message and the first three stack frames', () => {
    const err = new Error('boom '.repeat(60));
    err.stack = `Error: boom\n    at a (https://x.example/assets/app.js:1:10)\n    at b (https://x.example/assets/app.js:2:20)\n    at c (https://x.example/assets/app.js:3:30)\n    at d (https://x.example/assets/app.js:4:40)`;
    const d = errorData(err.message, err.stack);
    expect(d.message.length).toBeLessThanOrEqual(200);
    expect(d.stack).toContain('at a');
    expect(d.stack).toContain('at c');
    expect(d.stack).not.toContain('at d');
    expect(d.stack.length).toBeLessThanOrEqual(200);
    expect(errorData(undefined, undefined)).toEqual({ message: 'unknown', stack: '' });
  });
});

describe('Telemetry · frame statistics', () => {
  it('percentile is a nearest-rank percentile over the samples', () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5);
    expect(percentile([7], 50)).toBe(7);
    expect(percentile([], 50)).toBe(0);
  });

  it('emits one fps_sample every 30 s of frames with p50 <= p95 and the quality tier', () => {
    const { tele, fetches } = harness();
    let ms = 0;
    let i = 0;
    while (ms + 40 < FPS_SAMPLE_MS) { const dt = i++ % 10 === 0 ? 40 : 16; tele.frame(dt, 'balanced'); ms += dt; }
    expect(tele.pending).toBe(0);
    tele.frame(40, 'balanced');
    expect(tele.pending).toBe(1);
    tele.flush('manual');
    const ev = parse(fetches[0].body).events[0];
    expect(ev.t).toBe('fps_sample');
    expect(ev.d?.tier).toBe('balanced');
    expect(ev.d?.p50).toBe(16);
    expect(ev.d?.p95).toBe(40);
    expect(Number(ev.d?.p50)).toBeLessThanOrEqual(Number(ev.d?.p95));
    expect(typeof ev.d?.n).toBe('number');
  });
});
