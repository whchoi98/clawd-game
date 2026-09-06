/**
 * EMF metrics from the run service: one `VerifyMs` line per verification
 * (namespace ClawdEchoTower, dimension build) through the instance logger —
 * one JSON object per line on stdout in production.
 */
import { describe, expect, it, vi } from 'vitest';
import { METRIC_MSG, METRIC_NAMESPACE, VERIFY_METRIC, dimension, emfRecord, verifyMetric } from '../../src/server/metrics.js';
import { HX_MSG } from '../../src/server/runs.js';
import { FIXED_NOW, captureLog, failVerify, makeApp, postRun, submitBody } from './fixtures.js';

vi.mock('../../src/server/levels.js', async () => ({ resolveLevel: (await import('./levelfix.js')).fakeResolveLevel }));

type Aws = { Timestamp: number; CloudWatchMetrics: Array<{ Namespace: string; Dimensions: string[][]; Metrics: Array<{ Name: string; Unit: string }> }> };

describe('VerifyMs EMF line', () => {
  it('one verification → exactly one metric line { _aws, build, VerifyMs } in the ClawdEchoTower namespace', async () => {
    const { app } = await makeApp();
    try {
      const lines = captureLog(app);
      const res = await postRun(app, submitBody());
      expect(res.statusCode).toBe(200);
      const metrics = lines.filter((l) => l.msg === METRIC_MSG);
      expect(metrics).toHaveLength(1);
      const m = metrics[0].record;
      const aws = m._aws as Aws;
      expect(aws.Timestamp).toBe(FIXED_NOW.getTime());
      expect(aws.CloudWatchMetrics).toEqual([{
        Namespace: METRIC_NAMESPACE,
        Dimensions: [['build']],
        Metrics: [{ Name: 'VerifyMs', Unit: 'Milliseconds' }],
      }]);
      expect(METRIC_NAMESPACE).toBe('ClawdEchoTower');
      expect(VERIFY_METRIC).toBe('VerifyMs');
      expect(m.build).toBe('test');
      expect(typeof m.VerifyMs).toBe('number');
      expect(m.VerifyMs).toBeGreaterThanOrEqual(0);
      // serialises to a single line, as pino will print it
      expect(JSON.stringify(m)).not.toContain('\n');
      // and the accepted personal best produced one hx line
      expect(lines.filter((l) => l.msg === HX_MSG)).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('a verification that fails still emits VerifyMs (and no hx line)', async () => {
    const { app } = await makeApp({ verify: failVerify('claim-mismatch') });
    try {
      const lines = captureLog(app);
      expect((await postRun(app, submitBody())).statusCode).toBe(422);
      expect(lines.filter((l) => l.msg === METRIC_MSG)).toHaveLength(1);
      expect(lines.filter((l) => l.msg === HX_MSG)).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('a submission refused before the verifier (sim-version, assist) emits nothing', async () => {
    const { app } = await makeApp();
    try {
      const lines = captureLog(app);
      expect((await postRun(app, submitBody({ assist: true }))).statusCode).toBe(422);
      expect((await postRun(app, submitBody({ sim: 0 }))).statusCode).toBe(422);
      expect(lines.filter((l) => l.msg === METRIC_MSG)).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('verifyMetric sanitises the build dimension and rounds the value', () => {
    const m = verifyMetric(FIXED_NOW, 'has spaces!', 12.34567);
    expect(m.build).toBe('unknown');
    expect(m.VerifyMs).toBe(12.346);
    expect(verifyMetric(FIXED_NOW, 'b1', -1).VerifyMs).toBe(0);
    expect(dimension('ok-1.2_x', 'f')).toBe('ok-1.2_x');
    expect(dimension('', 'f')).toBe('f');
    expect(dimension(42, 'f')).toBe('f');
    const rec = emfRecord(FIXED_NOW, { a: 'x', b: 'y' }, [{ name: 'N', value: 1, unit: 'Count' }]);
    expect((rec._aws as Aws).CloudWatchMetrics[0].Dimensions).toEqual([['a', 'b']]);
    expect(rec).toMatchObject({ a: 'x', b: 'y', N: 1 });
  });
});
