/**
 * CloudWatch Embedded Metric Format lines. The server prints one JSON line
 * per metric through the pino logger (stdout → the ECS log group), and the log
 * group yields the metrics in the `ClawdEchoTower` namespace without a
 * separate pipeline. Shared by the telemetry route (JsErrorCount,
 * SubmitAccepted / SubmitRejected, FrameMs*) and the run service (VerifyMs).
 */
export const METRIC_NAMESPACE = 'ClawdEchoTower';
/** pino message of a metric line. */
export const METRIC_MSG = 'metric';
/** Milliseconds one replay verification took, dimension `build` (the client build that submitted). */
export const VERIFY_METRIC = 'VerifyMs';

export type LogRecord = Record<string, unknown>;
/** Where structured lines go; the default everywhere is the instance logger at info. */
export type LogSink = (record: LogRecord, msg: string) => void;

export interface Metric { name: string; value: number; unit: 'Count' | 'Milliseconds' }

const DIM_TOKEN = /^[A-Za-z0-9._-]{1,64}$/;
/** EMF dimension values must be short, non-empty strings; anything else collapses to `fallback`. */
export function dimension(v: unknown, fallback: string): string {
  return typeof v === 'string' && DIM_TOKEN.test(v) ? v : fallback;
}

/** One EMF record: the `_aws` envelope plus dimensions and values as root members. */
export function emfRecord(now: Date, dimensions: Record<string, string>, metrics: Metric[]): LogRecord {
  return {
    _aws: {
      Timestamp: now.getTime(),
      CloudWatchMetrics: [{
        Namespace: METRIC_NAMESPACE,
        Dimensions: [Object.keys(dimensions)],
        Metrics: metrics.map(({ name, unit }) => ({ Name: name, Unit: unit })),
      }],
    },
    ...dimensions,
    ...Object.fromEntries(metrics.map((m) => [m.name, m.value])),
  };
}

/** The VerifyMs line for one verification. */
export function verifyMetric(now: Date, build: string, ms: number): LogRecord {
  return emfRecord(now, { build: dimension(build, 'unknown') }, [
    { name: VERIFY_METRIC, value: Math.max(0, Math.round(ms * 1000) / 1000), unit: 'Milliseconds' },
  ]);
}
