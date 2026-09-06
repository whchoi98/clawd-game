/**
 * POST /api/events — anonymous product telemetry (EventBatch, protocol.ts).
 *
 *   204  batch accepted (nothing to say back)
 *   400  schema violation ({ error: 'bad-request', detail: issues })
 *   413  body over MAX_EVENT_BODY_BYTES (4 KB)
 *   429  more than EVENTS_PER_IP_PER_MINUTE batches from one viewer address
 *
 * Every event becomes one structured pino line at info level with the fields
 * `{ evt, at, s, build, sim, ...d }` and the message 'evt'. Nothing that could
 * identify a person is ever written: the route never reads the viewer address
 * for anything but rate limiting, no player id or name exists in the schema,
 * and `d` keys that could smuggle one (`ip`, `playerId`, `name`, …) are
 * dropped before logging. Fastify's automatic request / response lines carry
 * the socket address, so they are suppressed for this route (`logLevel: warn`)
 * and the event lines go to the instance logger without a request id.
 *
 * `js_error`, `submit_result` and `fps_sample` additionally emit a CloudWatch
 * Embedded Metric Format line ('metric', see ../metrics.ts) so the log group
 * yields metrics (JsErrorCount, SubmitAccepted / SubmitRejected by reason,
 * FrameMsP95 / FrameMsP50 by tier) without a separate pipeline.
 *
 * `sendBeacon` may post the JSON as text/plain; a string body is parsed as JSON
 * before validation so page-hide flushes are not lost.
 */
import type { FastifyInstance } from 'fastify';
import {
  EventBatch, MAX_EVENT_BODY_BYTES, RejectReason, type TelemetryEvent,
} from '../../shared/protocol.js';
import { clientIp } from '../ip.js';
import { dimension, emfRecord, type LogRecord, type LogSink, type Metric } from '../metrics.js';
import type { AppDeps } from '../types.js';
import { badRequest } from './parse.js';

export { METRIC_MSG, METRIC_NAMESPACE, emfRecord } from '../metrics.js';
export type { LogRecord } from '../metrics.js';

export const EVENTS_BODY_LIMIT = MAX_EVENT_BODY_BYTES;
/** Telemetry batches one viewer address may post per minute. */
export const EVENTS_PER_IP_PER_MINUTE = 30;
const WINDOW_MS = 60_000;
/** Message of an event line. */
export const EVENT_MSG = 'evt';
const METRIC_LINE_MSG = 'metric';

/** Where the lines go; the default is the instance logger at info. */
export type EventSink = LogSink;

/** `d` keys that must never reach a log line, whatever a client sends. */
export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['ip', 'playerId', 'player', 'playerTag', 'name', 'email']);
/** Fields the line already carries (ours and pino's), which a `d` key may not overwrite. */
export const RESERVED_KEYS: ReadonlySet<string> = new Set([
  'evt', 'at', 's', 'build', 'sim', 'level', 'time', 'pid', 'hostname', 'msg', 'v', '_aws',
]);

type Batch = Pick<EventBatch, 's' | 'build' | 'sim'>;

/** The structured fields of one event line: `{ evt, at, s, build, sim, ...d }` minus forbidden / reserved keys. */
export function eventFields(batch: Batch, ev: TelemetryEvent): LogRecord {
  const out: LogRecord = { evt: ev.t, at: ev.at, s: batch.s, build: batch.build, sim: batch.sim };
  for (const [k, v] of Object.entries(ev.d ?? {})) {
    if (FORBIDDEN_KEYS.has(k) || RESERVED_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

function finiteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * The metric line for an event, or null for events that carry no metric.
 *   js_error       → JsErrorCount 1                       [build]
 *   submit_result  → SubmitAccepted 1 | SubmitRejected 1  [build] / [build, reason]
 *   fps_sample     → FrameMsP95 / FrameMsP50 (ms)         [build, tier]
 */
export function metricFields(batch: Batch, ev: TelemetryEvent, now: Date): LogRecord | null {
  const build = dimension(batch.build, 'unknown');
  const d = ev.d ?? {};
  switch (ev.t) {
    case 'js_error':
      return emfRecord(now, { build }, [{ name: 'JsErrorCount', value: 1, unit: 'Count' }]);
    case 'submit_result': {
      if (d.accepted === true) return emfRecord(now, { build }, [{ name: 'SubmitAccepted', value: 1, unit: 'Count' }]);
      const reason = RejectReason.safeParse(d.reason).success ? String(d.reason) : 'other';
      return emfRecord(now, { build, reason }, [{ name: 'SubmitRejected', value: 1, unit: 'Count' }]);
    }
    case 'fps_sample': {
      const metrics: Metric[] = [];
      const p95 = finiteNumber(d.p95);
      const p50 = finiteNumber(d.p50);
      if (p95 !== null) metrics.push({ name: 'FrameMsP95', value: p95, unit: 'Milliseconds' });
      if (p50 !== null) metrics.push({ name: 'FrameMsP50', value: p50, unit: 'Milliseconds' });
      if (!metrics.length) return null;
      return emfRecord(now, { build, tier: dimension(d.tier, 'unknown') }, metrics);
    }
    default:
      return null;
  }
}

/** A string body (sendBeacon posts text/plain) is parsed as JSON; anything unparsable fails the schema. */
function bodyValue(body: unknown): unknown {
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

export interface EventsRouteOptions {
  /** Overrides the default sink (instance logger, info). */
  sink?: EventSink;
}

export function eventsRoute(app: FastifyInstance, deps: AppDeps, opts: EventsRouteOptions = {}): void {
  const sink: EventSink = opts.sink ?? ((record, msg) => { app.log.info(record, msg); });
  app.post('/events', {
    bodyLimit: EVENTS_BODY_LIMIT,
    logLevel: 'warn',
    config: {
      rateLimit: {
        max: EVENTS_PER_IP_PER_MINUTE,
        timeWindow: WINDOW_MS,
        keyGenerator: clientIp,
        errorResponseBuilder: (_req, ctx) => ({
          statusCode: ctx.statusCode,
          message: 'rate-limited',
          detail: { scope: 'ip-events', retryAfter: Math.ceil(ctx.ttl / 1000) },
        }),
      },
    },
  }, async (req, reply) => {
    const parsed = EventBatch.safeParse(bodyValue(req.body));
    if (!parsed.success) return badRequest(reply, parsed.error.issues);
    const batch = parsed.data;
    const now = deps.now();
    for (const ev of batch.events) {
      sink(eventFields(batch, ev), EVENT_MSG);
      const metric = metricFields(batch, ev, now);
      if (metric) sink(metric, METRIC_LINE_MSG);
    }
    return reply.code(204).send();
  });
}
