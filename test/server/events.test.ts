/**
 * POST /api/events — anonymous telemetry intake. The route validates the
 * EventBatch schema, caps the body at 4 KB, rate-limits per viewer address and
 * writes one structured log line per event that carries no ip, player id or
 * name — even when a client tries to smuggle them through `d`.
 */
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBatch, MAX_EVENTS_PER_BATCH, MAX_EVENT_BODY_BYTES, type TelemetryEvent } from '../../src/shared/protocol.js';
import {
  EVENTS_BODY_LIMIT, EVENTS_PER_IP_PER_MINUTE, EVENT_MSG, METRIC_MSG, METRIC_NAMESPACE, type LogRecord,
  eventFields, eventsRoute, metricFields,
} from '../../src/server/routes/events.js';
import { MemoryRepo } from '../../src/server/repo/memory.js';
import type { AppDeps } from '../../src/server/types.js';
import { FIXED_NOW, SECRET, echoVerify, makeApp } from './fixtures.js';

vi.mock('../../src/server/levels.js', async () => ({ resolveLevel: (await import('./levelfix.js')).fakeResolveLevel }));

const SESSION = '0123456789abcdef';

function batch(events: TelemetryEvent[], over: Partial<EventBatch> = {}): EventBatch {
  return { s: SESSION, build: 'b-test', sim: 2, events, ...over };
}

type Line = { record: LogRecord; msg: string };

/** A recording logger standing in for `app.log`: every info line is captured as pino would receive it. */
function recorder(lines: Line[]) {
  const noop = () => {};
  const logger = {
    info: (record: LogRecord, msg: string) => { lines.push({ record, msg }); },
    warn: noop, error: noop, debug: noop, trace: noop, fatal: noop, silent: noop,
    level: 'info',
    child() { return logger; },
  };
  return logger;
}

const post = (app: Awaited<ReturnType<typeof makeApp>>['app'], body: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/api/events', payload: body as object, headers: { 'content-type': 'application/json', ...headers } });

describe('POST /api/events', () => {
  const apps: Awaited<ReturnType<typeof makeApp>>[] = [];
  const up = async (...args: Parameters<typeof makeApp>) => {
    const ctx = await makeApp(...args);
    apps.push(ctx);
    return ctx;
  };
  afterEach(async () => { while (apps.length) await apps.pop()!.app.close(); });

  it('answers 204 with an empty body for a valid batch', async () => {
    const { app } = await up();
    const res = await post(app, batch([{ t: 'boot', at: 0, d: { build: 'b', daysSinceFirstSeen: '0' } }, { t: 'zone_start', at: 1200, d: { levelId: 't1' } }]));
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
  });

  it('accepts the JSON as text/plain (navigator.sendBeacon with a string body)', async () => {
    const { app } = await up();
    const res = await app.inject({
      method: 'POST', url: '/api/events', payload: JSON.stringify(batch([{ t: 'quit', at: 5000 }])),
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
    });
    expect(res.statusCode).toBe(204);
  });

  it('answers 400 { error: bad-request, detail } on schema violations', async () => {
    const { app } = await up();
    const cases: unknown[] = [
      batch([{ t: 'boot', at: 0 }], { s: 'short' }),                                   // session id shape
      batch([{ t: 'teleport' as never, at: 0 }]),                                       // unknown event name
      batch([{ t: 'boot', at: -1 }]),                                                   // negative offset
      batch([]),                                                                         // empty batch
      batch(Array.from({ length: MAX_EVENTS_PER_BATCH + 1 }, () => ({ t: 'retry' as const, at: 1 }))), // 21 events
      { ...batch([{ t: 'boot', at: 0 }]), sim: undefined },                              // missing sim
      batch([{ t: 'boot', at: 0, d: { nested: { deep: true } as never } }]),             // non-scalar value
      'not json at all',
    ];
    for (const body of cases) {
      const res = await post(app, body);
      expect(res.statusCode, JSON.stringify(body).slice(0, 60)).toBe(400);
      expect(res.json().error).toBe('bad-request');
      expect(res.json().detail).toBeDefined();
    }
  });

  it(`answers 413 { error: too-large } over ${MAX_EVENT_BODY_BYTES} bytes`, async () => {
    expect(EVENTS_BODY_LIMIT).toBe(MAX_EVENT_BODY_BYTES);
    const { app } = await up();
    const big = batch([{ t: 'js_error', at: 1, d: { message: 'x'.repeat(200), stack: 'y'.repeat(200) } }]);
    const payload = JSON.stringify({ ...big, pad: 'z'.repeat(MAX_EVENT_BODY_BYTES) });
    expect(Buffer.byteLength(payload)).toBeGreaterThan(MAX_EVENT_BODY_BYTES);
    const res = await app.inject({ method: 'POST', url: '/api/events', payload, headers: { 'content-type': 'application/json' } });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe('too-large');
  });

  it(`answers 429 on the ${EVENTS_PER_IP_PER_MINUTE + 1}th batch from one address within a minute, independently of the global budget`, async () => {
    const { app } = await up({ rateLimit: { perIp: 10_000, perPlayer: 10_000 } });
    const ip = { 'x-forwarded-for': '203.0.113.50' };
    for (let i = 0; i < EVENTS_PER_IP_PER_MINUTE; i++) {
      expect((await post(app, batch([{ t: 'retry', at: i }]), ip)).statusCode).toBe(204);
    }
    const blocked = await post(app, batch([{ t: 'retry', at: 99 }]), ip);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toBe('rate-limited');
    expect(blocked.json().detail.scope).toBe('ip-events');
    expect(blocked.headers['retry-after']).toBeDefined();
    // other routes and other addresses keep their own budgets
    expect((await app.inject({ method: 'GET', url: '/api/health', headers: ip })).statusCode).toBe(200);
    expect((await post(app, batch([{ t: 'retry', at: 1 }]), { 'x-forwarded-for': '198.51.100.20' })).statusCode).toBe(204);
  });

  it('is not served outside /api', async () => {
    const { app } = await up();
    const res = await app.inject({ method: 'POST', url: '/events', payload: batch([{ t: 'boot', at: 0 }]) });
    expect(res.statusCode).toBe(404);
  });

  describe('log lines', () => {
    async function capture(events: TelemetryEvent[], headers: Record<string, string> = {}, over: Partial<EventBatch> = {}) {
      const ctx = await up();
      const lines: Line[] = [];
      // The route logs through the instance logger; the api child inherits it from the root.
      (ctx.app as unknown as { log: unknown }).log = recorder(lines);
      const res = await post(ctx.app, batch(events, over), headers);
      expect(res.statusCode).toBe(204);
      return lines;
    }

    it('writes one info line per event with { evt, at, s, build, sim, ...d } and the message "evt"', async () => {
      const lines = await capture([
        { t: 'boot', at: 0, d: { uaFamily: 'chrome', dpr: 2, daysSinceFirstSeen: '1' } },
        { t: 'death', at: 4200, d: { levelId: 't1', cause: 'pit', tx: 15, ty: 14, checkpointIdx: 0 } },
      ]);
      expect(lines.filter((l) => l.msg === EVENT_MSG)).toHaveLength(2);
      expect(lines[0].record).toEqual({ evt: 'boot', at: 0, s: SESSION, build: 'b-test', sim: 2, uaFamily: 'chrome', dpr: 2, daysSinceFirstSeen: '1' });
      expect(lines[1].record).toEqual({ evt: 'death', at: 4200, s: SESSION, build: 'b-test', sim: 2, levelId: 't1', cause: 'pit', tx: 15, ty: 14, checkpointIdx: 0 });
    });

    it('never serialises an ip, playerId or name — not from headers, not from a client that puts them in d', async () => {
      const lines = await capture(
        [
          { t: 'boot', at: 0, d: { ip: '203.0.113.9', playerId: 'player-0001', name: '클로드', player: 'x', playerTag: 'abcdef012345', email: 'a@b.c', ok: 'kept' } },
          { t: 'submit_result', at: 10, d: { accepted: false, reason: 'sim-version' } },
        ],
        { 'x-forwarded-for': '203.0.113.9', 'cloudfront-viewer-address': '203.0.113.9:443' },
      );
      expect(lines.length).toBeGreaterThanOrEqual(3);
      for (const { record } of lines) {
        const json = JSON.stringify(record);
        for (const key of ['ip', 'playerId', 'name', 'player', 'playerTag', 'email']) expect(record).not.toHaveProperty(key);
        expect(json).not.toContain('203.0.113.9');
        expect(json).not.toContain('player-0001');
        expect(json).not.toContain('클로드');
        expect(json).not.toMatch(/"(ip|playerId|name)":/);
      }
      expect(lines[0].record.ok).toBe('kept');
    });

    it('a d key cannot overwrite the line fields', async () => {
      const lines = await capture([{ t: 'boot', at: 7, d: { evt: 'forged', s: 'ffffffffffffffff', sim: 99, level: 60, msg: 'x', time: 1 } }]);
      expect(lines[0].record).toEqual({ evt: 'boot', at: 7, s: SESSION, build: 'b-test', sim: 2 });
    });

    it('emits an EMF metric line for js_error, submit_result and fps_sample only', async () => {
      const lines = await capture([
        { t: 'boot', at: 0 },
        { t: 'js_error', at: 1, d: { message: 'boom' } },
        { t: 'submit_result', at: 2, d: { accepted: true } },
        { t: 'submit_result', at: 3, d: { accepted: false, reason: 'claim-mismatch' } },
        { t: 'submit_result', at: 4, d: { accepted: false, reason: 'weird <thing>' } },
        { t: 'fps_sample', at: 5, d: { p50: 8.2, p95: 21.5, tier: 'high' } },
        { t: 'fps_sample', at: 6, d: { tier: 'low' } },
      ]);
      const metrics = lines.filter((l) => l.msg === METRIC_MSG).map((l) => l.record);
      expect(lines.filter((l) => l.msg === EVENT_MSG)).toHaveLength(7);
      expect(metrics).toHaveLength(5);
      const aws = (m: LogRecord) => m._aws as { Timestamp: number; CloudWatchMetrics: Array<{ Namespace: string; Dimensions: string[][]; Metrics: Array<{ Name: string; Unit: string }> }> };
      for (const m of metrics) {
        expect(aws(m).Timestamp).toBe(FIXED_NOW.getTime());
        expect(aws(m).CloudWatchMetrics[0].Namespace).toBe(METRIC_NAMESPACE);
      }
      expect(metrics[0]).toMatchObject({ JsErrorCount: 1, build: 'b-test' });
      expect(aws(metrics[0]).CloudWatchMetrics[0].Dimensions).toEqual([['build']]);
      expect(metrics[1]).toMatchObject({ SubmitAccepted: 1, build: 'b-test' });
      expect(metrics[2]).toMatchObject({ SubmitRejected: 1, reason: 'claim-mismatch' });
      expect(aws(metrics[2]).CloudWatchMetrics[0].Dimensions).toEqual([['build', 'reason']]);
      expect(metrics[3]).toMatchObject({ SubmitRejected: 1, reason: 'other' });
      expect(metrics[4]).toMatchObject({ FrameMsP95: 21.5, FrameMsP50: 8.2, tier: 'high' });
      expect(aws(metrics[4]).CloudWatchMetrics[0].Metrics).toEqual([
        { Name: 'FrameMsP95', Unit: 'Milliseconds' }, { Name: 'FrameMsP50', Unit: 'Milliseconds' },
      ]);
    });
  });

  describe('standalone registration with an injected sink', () => {
    it('works on a bare Fastify instance with only @fastify/rate-limit registered', async () => {
      const lines: Line[] = [];
      const deps: AppDeps = { repo: new MemoryRepo(), now: () => FIXED_NOW, dailySecret: SECRET, verify: echoVerify(), version: 't' };
      const app = Fastify({ logger: false, trustProxy: true });
      await app.register(async (api) => {
        await api.register(rateLimit, { global: false });
        eventsRoute(api, deps, { sink: (record, msg) => { lines.push({ record, msg }); } });
      }, { prefix: '/api' });
      try {
        const res = await post(app, batch([{ t: 'clear', at: 90_000, d: { levelId: 't1', ticks: 5400, deaths: 2, shards: 12 } }]));
        expect(res.statusCode).toBe(204);
        expect(lines).toEqual([{ record: { evt: 'clear', at: 90_000, s: SESSION, build: 'b-test', sim: 2, levelId: 't1', ticks: 5400, deaths: 2, shards: 12 }, msg: EVENT_MSG }]);
      } finally {
        await app.close();
      }
    });
  });
});

describe('record builders', () => {
  const b = { s: SESSION, build: 'b1', sim: 2 };

  it('eventFields spreads d after the fixed fields and drops forbidden and reserved keys', () => {
    expect(eventFields(b, { t: 'screen', at: 3, d: { screen: 'title', name: 'x', ip: 'y', evt: 'z' } })).toEqual({ evt: 'screen', at: 3, s: SESSION, build: 'b1', sim: 2, screen: 'title' });
    expect(eventFields(b, { t: 'retry', at: 3 })).toEqual({ evt: 'retry', at: 3, s: SESSION, build: 'b1', sim: 2 });
  });

  it('metricFields sanitises dimensions and returns null when there is nothing to measure', () => {
    expect(metricFields(b, { t: 'boot', at: 0 }, FIXED_NOW)).toBeNull();
    expect(metricFields(b, { t: 'fps_sample', at: 0, d: { p95: 'fast' } }, FIXED_NOW)).toBeNull();
    const weird = metricFields({ ...b, build: 'has spaces!' }, { t: 'js_error', at: 0 }, FIXED_NOW)!;
    expect(weird.build).toBe('unknown');
    const tier = metricFields(b, { t: 'fps_sample', at: 0, d: { p95: 30, tier: 'a b' } }, FIXED_NOW)!;
    expect(tier.tier).toBe('unknown');
    expect(tier.FrameMsP95).toBe(30);
    expect(tier).not.toHaveProperty('FrameMsP50');
  });
});
