/**
 * tools/load/submit.mjs — the body builder (valid, verified, distinct
 * submissions from the paced corpus) and the histogram / percentile / report
 * code, driven with a fake fetch so no server is involved.
 */
import { describe, expect, it } from 'vitest';
import { RunSubmit } from '../../src/shared/protocol.js';
import { decodeMasks, verifyReplay } from '../../src/sim/replay.js';
import { IN, SIM_VERSION } from '../../src/sim/types.js';
import { LEVEL_BY_ID } from '../../src/sim/levels.generated.js';
import { readSolution } from '../../levels/solutions.js';
import { replayHash } from '../../src/server/hash.js';
import { maxMasksFor } from '../../src/server/runs.js';
import {
  DEFAULT_MAX_P99_MS, DEFAULT_N, DEFAULT_ZONES, MARKER_MASK, USAGE, buildBodies, exitCode, finishTick, formatReport, histogram, parseArgs,
  percentile, prepareZone, runLoad, serverErrors, variantMasks, type FetchResponseLike, type LoadReport,
} from '../../tools/load/submit.mjs';

const T1 = readSolution('t1', 'par');

describe('parseArgs', () => {
  it('reads the options with their defaults and reports bad values', () => {
    expect(DEFAULT_N).toBe(200);
    expect([...DEFAULT_ZONES]).toEqual(['t1', 't2', 't3', 's1', 's2', 's3', 'v1', 'v2', 'v3']);
    const d = parseArgs([], { BASE_URL: 'http://127.0.0.1:8261/' });
    expect(d).toMatchObject({ baseUrl: 'http://127.0.0.1:8261', n: 200, zones: [...DEFAULT_ZONES], maxP99Ms: DEFAULT_MAX_P99_MS, errors: [] });
    const o = parseArgs(['--n', '50', '--zones', 't1, s2', '--build', 'x', '--healthz-interval', '250', '--max-p99', '80', '--timeout', '5000', '--base-url', 'http://h:1/']);
    expect(o).toMatchObject({ n: 50, zones: ['t1', 's2'], build: 'x', healthzIntervalMs: 250, maxP99Ms: 80, timeoutMs: 5000, baseUrl: 'http://h:1', errors: [] });
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['--n', '0']).errors[0]).toMatch(/--n/);
    expect(parseArgs(['--bogus']).errors[0]).toMatch(/unknown option/);
    expect(parseArgs(['--zones', '']).errors[0]).toMatch(/--zones/);
    expect(USAGE).toContain('tools/load/submit.mjs');
  });
});

describe('body builder (paced corpus through the sim)', () => {
  it('cuts the t1 solution at its finish tick and derives a claim the sim reproduces', () => {
    expect(T1, 'levels/solutions/par/t1.json').not.toBeNull();
    const def = LEVEL_BY_ID.t1;
    const full = decodeMasks(T1!.masks);
    const end = finishTick(def, full);
    expect(end).toBeGreaterThan(0);
    expect(end).toBeLessThanOrEqual(full.length);
    const zone = prepareZone(def, T1!);
    expect(zone.base).toHaveLength(end);
    expect(zone.claim).toMatchObject({ cleared: true, deaths: 0, ticks: T1!.ticks });
    expect(zone.variants).toBeGreaterThanOrEqual(100);
    // the marker sits after the finish tick, so the run is unchanged
    for (const k of [0, 1, zone.variants - 1]) {
      const masks = variantMasks(zone, k);
      expect(masks).toHaveLength(end + k + 1);
      expect(masks[masks.length - 1]).toBe(MARKER_MASK);
      expect(MARKER_MASK).toBe(IN.UP);
      expect(masks.length).toBeLessThanOrEqual(maxMasksFor(zone.claim));
      const v = verifyReplay(def, { v: SIM_VERSION, levelId: 't1', seed: def.seed, assist: false, masks }, zone.claim);
      expect(v.ok, `variant ${k}`).toBe(true);
    }
    expect(() => variantMasks(zone, zone.variants)).toThrow(RangeError);
  });

  it('builds N schema-valid bodies with unique player ids and unique replay hashes, cycling the zones', () => {
    const { bodies, prepared, skipped, tag } = buildBodies(12, { zones: ['t1', 't2'], tag: 'abc123', build: 'test-load' });
    expect(skipped).toEqual([]);
    expect(prepared.map((z) => z.def.id)).toEqual(['t1', 't2']);
    expect(tag).toBe('abc123');
    expect(bodies).toHaveLength(12);
    const ids = new Set<string>();
    const hashes = new Set<string>();
    for (const [j, raw] of bodies.entries()) {
      const body = RunSubmit.parse(raw);
      expect(body.mode).toBe('story');
      expect(body.levelId).toBe(j % 2 === 0 ? 't1' : 't2');
      expect(body.player.id).toBe(`load-abc123-${String(j).padStart(4, '0')}`);
      expect(body.player.name).toBe(`부하-${j}`);
      expect(body.client.build).toBe('test-load');
      expect(body.sim).toBe(SIM_VERSION);
      ids.add(body.player.id);
      const masks = decodeMasks(body.masks);
      expect(masks.length).toBeLessThanOrEqual(maxMasksFor(body.claim));
      hashes.add(replayHash(masks, body.levelId, LEVEL_BY_ID[body.levelId].seed));
      const v = verifyReplay(LEVEL_BY_ID[body.levelId], { v: SIM_VERSION, levelId: body.levelId, seed: LEVEL_BY_ID[body.levelId].seed, assist: false, masks }, body.claim);
      expect(v.ok, `body ${j}`).toBe(true);
    }
    expect(ids.size).toBe(12);
    expect(hashes.size).toBe(12);
    // and none of them is the goal echo itself (which is seeded on the board)
    expect(hashes.has(replayHash(decodeMasks(T1!.masks), 't1', LEVEL_BY_ID.t1.seed))).toBe(false);
  });

  it('skips zones it cannot use and refuses more bodies than distinct replays exist', () => {
    const { bodies, skipped } = buildBodies(3, { zones: ['t1', 'zz', 't2'], tag: 't', solutions: { t1: T1! } });
    expect(bodies.every((b) => b.levelId === 't1')).toBe(true);
    expect(skipped).toEqual([{ id: 'zz', reason: 'unknown zone' }, { id: 't2', reason: 'no paced solution' }]);
    expect(() => buildBodies(100_000, { zones: ['t1'], tag: 't' })).toThrow(/distinct replays/);
    expect(() => buildBodies(1, { zones: ['zz'], tag: 't' })).toThrow(/no usable zone/);
    expect(() => prepareZone(LEVEL_BY_ID.t1, { ...T1!, sim: SIM_VERSION + 1 })).toThrow(/sim v/);
  });
});

describe('statistics and report', () => {
  it('histogram / percentile / serverErrors', () => {
    expect(histogram([200, 503, 200, 422, 500])).toEqual({ 200: 2, 422: 1, 500: 1, 503: 1 });
    expect(histogram(['duplicate', 'too-long', 'duplicate'])).toEqual({ duplicate: 2, 'too-long': 1 });
    expect(histogram([])).toEqual({});
    expect(percentile([5, 1, 3], 50)).toBe(3);
    expect(percentile([5, 1, 3], 99)).toBe(5);
    expect(percentile([5, 1, 3], 0)).toBe(1);
    expect(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 99)).toBe(99);
    expect(Number.isNaN(percentile([], 50))).toBe(true);
    expect(serverErrors([200, 503, 503, 500, 502, 422, 0])).toBe(2);
  });

  it('runLoad fires every body, samples /healthz meanwhile, and reports statuses, 422 reasons, busy and the p99', async () => {
    const seen: string[] = [];
    let n = 0;
    const fetch = async (url: string, init?: Record<string, unknown>): Promise<FetchResponseLike> => {
      seen.push(url);
      if (url.endsWith('/healthz')) {
        await new Promise((r) => setTimeout(r, 2));
        return { status: 200 };
      }
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body)) as { player: { id: string } };
      expect(body.player.id).toMatch(/^load-/);
      const i = n++;
      await new Promise((r) => setTimeout(r, 20));
      if (i === 1) return { status: 503, headers: { get: () => '3' } };
      if (i === 2) return { status: 422, json: async () => ({ accepted: false, reason: 'duplicate' }) };
      if (i === 3) return { status: 500 };
      return { status: 200, json: async () => ({ accepted: true }) };
    };
    const { bodies } = buildBodies(5, { zones: ['t1'], tag: 'zzzz' });
    const report = await runLoad({ baseUrl: 'http://fake', bodies, fetch, healthzIntervalMs: 5 });
    expect(report.n).toBe(5);
    expect(report.statuses).toEqual({ 200: 2, 422: 1, 500: 1, 503: 1 });
    expect(report.reasons).toEqual({ duplicate: 1 });
    expect(report.busy).toBe(1);
    expect(report.serverErrors).toBe(1);
    expect(report.healthz.samples).toBeGreaterThanOrEqual(1);
    expect(report.healthz.failures).toBe(0);
    expect(report.healthz.p99).toBeGreaterThan(0);
    expect(report.submit.p99).toBeGreaterThanOrEqual(report.submit.p50);
    expect(seen.filter((u) => u.endsWith('/api/runs'))).toHaveLength(5);
    expect(seen.some((u) => u.endsWith('/healthz'))).toBe(true);
    expect(exitCode(report)).toBe(1); // the 500
    const text = formatReport(report);
    expect(text).toContain('200×2');
    expect(text).toContain('duplicate×1');
    expect(text).toContain('5xx other than 503: 1 FAIL');
    expect(text).toContain('/healthz');
  });

  it('exitCode: 0 only without non-503 5xx, /healthz failures, or a p99 above the limit', () => {
    const base: LoadReport = {
      n: 1, elapsedMs: 10, statuses: { 200: 1 }, reasons: {}, transportFailures: {}, serverErrors: 0, busy: 0,
      submit: { p50: 1, p99: 1, max: 1 }, healthz: { samples: 10, failures: 0, p50: 5, p99: 40 },
    };
    expect(exitCode(base)).toBe(0);
    expect(exitCode({ ...base, healthz: { ...base.healthz, p99: 150 } })).toBe(1);
    expect(exitCode({ ...base, healthz: { ...base.healthz, p99: 150 } }, 200)).toBe(0);
    expect(exitCode({ ...base, serverErrors: 1 })).toBe(1);
    expect(exitCode({ ...base, healthz: { ...base.healthz, failures: 1 } })).toBe(1);
    expect(exitCode({ ...base, busy: 5, statuses: { 200: 1, 503: 5 } })).toBe(0); // backpressure is not a failure
    expect(formatReport(base)).toContain('ok');
  });
});
