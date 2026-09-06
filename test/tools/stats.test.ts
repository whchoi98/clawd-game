/**
 * tools/stats.mjs turns the server's event log lines (NDJSON) into the funnel,
 * the D1 proxy, per-zone deaths / clears and an ASCII death heat-map. The
 * fixture below is what pino writes for four sessions, mixed with the other
 * lines a log group carries (metric lines, request lines, garbage).
 */
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  D1_BUCKET, RAMP, d1Proxy, formatInsights, funnel, heatmap, insightsQueries, parseArgs, parseNdjson, renderHeatmap, report,
  summary, zoneStats,
} from '../../tools/stats.mjs';

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const SCRIPT = join(ROOT, 'tools', 'stats.mjs');

let t = 1_757_160_000_000;
/** One pino line as routes/events.ts produces it. */
function line(evt: string, s: string, d: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ level: 30, time: (t += 1000), pid: 7, hostname: 'task', evt, at: 100, s, build: 'b1', sim: 2, ...d, msg: 'evt', ...extra });
}

const S1 = '1111111111111111', S2 = '2222222222222222', S3 = '3333333333333333', S4 = '4444444444444444';

export const FIXTURE = [
  line('boot', S1, { daysSinceFirstSeen: '0', uaFamily: 'chrome' }),
  line('zone_start', S1, { levelId: 't1' }),
  line('death', S1, { levelId: 't1', cause: 'pit', tx: 15, ty: 14, checkpointIdx: 0 }),
  line('death', S1, { levelId: 't1', cause: 'pit', tx: 15, ty: 14, checkpointIdx: 0 }),
  line('death', S1, { levelId: 't1', cause: 'spike', tx: 40, ty: 12, checkpointIdx: 1 }),
  line('clear', S1, { levelId: 't1', ticks: 6000, deaths: 3, shards: 9 }),
  line('zone_start', S1, { levelId: 't2' }),
  line('death', S1, { levelId: 't2', cause: 'saw', tx: 8, ty: 20 }),
  '',
  line('boot', S2, { daysSinceFirstSeen: '1' }),
  line('zone_start', S2, { levelId: 't1' }),
  line('death', S2, { levelId: 't1', cause: 'pit', tx: 15.7, ty: 14.2 }),
  line('quit', S2, { levelId: 't1' }),
  // a metric line, a request line and garbage share the log group
  JSON.stringify({ level: 30, time: t, _aws: { Timestamp: t }, JsErrorCount: 1, build: 'b1', msg: 'metric' }),
  JSON.stringify({ level: 30, time: t, reqId: 'r1', req: { method: 'GET', url: '/api/health' }, msg: 'incoming request' }),
  '{ not json',
  '[1,2,3]',
  line('boot', S3, { daysSinceFirstSeen: '1' }),
  // a bare record (Logs Insights export) without msg still counts
  JSON.stringify({ evt: 'boot', s: S4, daysSinceFirstSeen: '7+' }),
  line('zone_start', S4, { levelId: 't1' }),
  line('clear', S4, { levelId: 't1', ticks: 5000, deaths: 0, shards: 20 }),
  line('daily_start', S4, { levelId: 'daily' }),
  line('death', S4, { levelId: 'daily', cause: 'tide' }), // no coordinates: counted, not plotted
].join('\n');

const records = parseNdjson(FIXTURE);

describe('tools/stats.mjs', () => {
  it('parseNdjson keeps event lines only (pino "evt" lines and bare records), skipping metric / request / garbage lines', () => {
    expect(records).toHaveLength(18);
    expect(records.every((r) => typeof r.evt === 'string')).toBe(true);
    expect(records.some((r) => r.msg === 'metric' || r.msg === 'incoming request')).toBe(false);
    expect(parseNdjson('')).toEqual([]);
  });

  it('funnel counts distinct sessions per stage and shares relative to boot', () => {
    const f = funnel(records);
    expect(f.sessions).toEqual({ boot: 4, zone_start: 3, clear: 2 });
    expect(f.events).toEqual({ boot: 4, zone_start: 4, clear: 2 });
    expect(f.share.zone_start).toBeCloseTo(0.75);
    expect(f.share.clear).toBeCloseTo(0.5);
    expect(funnel([]).share).toEqual({ zone_start: 0, clear: 0 });
  });

  it('d1Proxy is the share of boots in the "1" bucket, with the bucket histogram', () => {
    expect(D1_BUCKET).toBe('1');
    const d1 = d1Proxy(records);
    expect(d1).toEqual({ boots: 4, d1: 2, share: 0.5, buckets: { '0': 1, '1': 2, '7+': 1 } });
    // numeric buckets are normalised to strings
    expect(d1Proxy([{ evt: 'boot', daysSinceFirstSeen: 1 }, { evt: 'boot' }]).buckets).toEqual({ '1': 1, unknown: 1 });
  });

  it('zoneStats lists starts / deaths / clears per level with the derived ratios', () => {
    const zones = zoneStats(records);
    expect(zones.map((z) => z.levelId)).toEqual(['daily', 't1', 't2']);
    expect(zones[1]).toEqual({ levelId: 't1', starts: 3, deaths: 4, clears: 2, deathsPerClear: 2, clearRate: 2 / 3 });
    expect(zones[2]).toEqual({ levelId: 't2', starts: 1, deaths: 1, clears: 0, deathsPerClear: null, clearRate: 0 });
    expect(zones[0]).toMatchObject({ levelId: 'daily', starts: 1, deaths: 1, clears: 0 });
  });

  it('heatmap bins deaths per tile (floats floored) for one zone and is null for a zone without located deaths', () => {
    const hm = heatmap(records, 't1')!;
    expect(hm).toMatchObject({ levelId: 't1', deaths: 4, minX: 15, maxX: 40, minY: 12, maxY: 14, max: 3 });
    expect(hm.cells.get('15,14')).toBe(3);
    expect(hm.cells.get('40,12')).toBe(1);
    expect(heatmap(records, 'daily')).toBeNull();
    expect(heatmap(records, 'zz9')).toBeNull();
  });

  it('renderHeatmap draws rows by ty and columns by tx with the hottest cell as "@"', () => {
    const text = renderHeatmap(heatmap(records, 't1'));
    const rows = text.split('\n');
    expect(rows[0]).toContain('death heat-map · t1 · 4 deaths · tx 15..40 · ty 12..14 · max 3/cell');
    const row14 = rows.find((r) => r.startsWith('  14 |'))!;
    const row12 = rows.find((r) => r.startsWith('  12 |'))!;
    expect(row14.charAt(6)).toBe('@');                    // tx 15 is the first column
    expect(row12.charAt(6 + 25)).toBe(RAMP[3]);           // one death out of max 3 → low glyph
    expect(row14.length).toBe(6 + 26 + 1);                // 26 columns between the bars
    expect(rows.find((r) => r.startsWith('  13 |'))).toBe(`  13 |${' '.repeat(26)}|`);
    expect(rows.at(-1)).toContain('legend');
    expect(renderHeatmap(null)).toBe('(no located deaths for this zone)');
  });

  it('renderHeatmap bins wide zones so the picture stays under maxWidth columns', () => {
    const wide = [
      { evt: 'death', levelId: 'w', tx: 0, ty: 0 }, { evt: 'death', levelId: 'w', tx: 1, ty: 0 },
      { evt: 'death', levelId: 'w', tx: 250, ty: 5 },
    ];
    const text = renderHeatmap(heatmap(wide, 'w'), { maxWidth: 100 });
    expect(text).toContain('3×3 tiles per cell');
    const row0 = text.split('\n').find((r) => r.startsWith('   0 |'))!;
    expect(row0.length).toBe(6 + Math.ceil(251 / 3) + 1);
    expect(row0.charAt(6)).toBe('@'); // tx 0 and 1 fall into the same cell → 2 deaths = max
  });

  it('report prints every section and summary mirrors it as JSON', () => {
    const text = report(records, { level: 't1' });
    expect(text).toContain('funnel (distinct sessions)');
    expect(text).toContain('boot              4');
    expect(text).toContain('zone_start        3  75.0% of boot');
    expect(text).toContain('clear             2  50.0% of boot');
    expect(text).toContain('D1 proxy: 2/4 boots in bucket "1" = 50.0%');
    expect(text).toContain('daysSinceFirstSeen: 0=1  1=2  7+=1');
    expect(text).toMatch(/t1\s+3\s+4\s+2\s+2\.00\s+66\.7%/);
    expect(text).toMatch(/t2\s+1\s+1\s+0\s+—\s+0\.0%/);
    expect(text).toContain('death heat-map · t1');
    const s = summary(records, { level: 't1' });
    expect(s.lines).toBe(18);
    expect(s.funnel.sessions.boot).toBe(4);
    expect(s.heatmap?.cells).toEqual(expect.arrayContaining([{ tx: 15, ty: 14, deaths: 3 }, { tx: 40, ty: 12, deaths: 1 }]));
    expect(summary([], { level: 't1' }).heatmap).toBeNull();
  });

  it('insightsQueries cover the same numbers (sessions per stage, D1 buckets, zones, heat-map cells for the level)', () => {
    const qs = insightsQueries({ level: 's2' });
    const all = qs.map((q) => q.query).join('\n');
    expect(all).toContain('stats count_distinct(s) as sessions, count(*) as events by evt');
    expect(all).toContain('stats count(*) as boots by daysSinceFirstSeen');
    expect(all).toContain('stats count(*) as n by levelId, evt');
    expect(all).toContain('evt = "death" and levelId = "s2"');
    expect(all).toContain('stats count(*) as deaths by tx, ty');
    expect(qs.every((q) => q.query.includes('msg = "evt"'))).toBe(true);
    const text = formatInsights(qs);
    expect(text).toContain('1. funnel');
    expect(text).toContain('| stats count_distinct(s)');
  });

  it('parseArgs reads the file, --level, --logs-insights and --json', () => {
    expect(parseArgs([])).toMatchObject({ file: undefined, level: 't1', insights: false, json: false, errors: [] });
    expect(parseArgs(['events.ndjson', '--level', 'v3', '--json'])).toMatchObject({ file: 'events.ndjson', level: 'v3', json: true });
    expect(parseArgs(['--logs-insights']).insights).toBe(true);
    expect(parseArgs(['--what']).errors).toEqual(['unknown option: --what']);
    expect(parseArgs(['a', 'b']).errors).toEqual(['unexpected argument: b']);
  });

  describe('command line', () => {
    const runCli = (args: string[], input?: string) =>
      spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8', input, timeout: 30_000 });

    it('reads NDJSON from stdin and prints the report for --level', () => {
      const r = runCli(['--level', 't1'], FIXTURE);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('D1 proxy: 2/4 boots');
      expect(r.stdout).toContain('death heat-map · t1 · 4 deaths');
    });

    it('--json prints the summary as JSON', () => {
      const r = runCli(['--json', '--level', 't2'], FIXTURE);
      expect(r.status).toBe(0);
      const json = JSON.parse(r.stdout);
      expect(json.funnel.sessions).toEqual({ boot: 4, zone_start: 3, clear: 2 });
      expect(json.heatmap).toMatchObject({ levelId: 't2', deaths: 1 });
    });

    it('--logs-insights prints the queries without reading any input', () => {
      const r = runCli(['--logs-insights', '--level', 'v1']);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('CloudWatch Logs Insights');
      expect(r.stdout).toContain('levelId = "v1"');
    });

    it('unknown options exit 2 with the usage', () => {
      const r = runCli(['--bogus'], '');
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('unknown option: --bogus');
      expect(r.stderr).toContain('usage:');
    });
  });
});
