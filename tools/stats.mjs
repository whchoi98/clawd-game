#!/usr/bin/env node
/**
 * Telemetry stats from the server's event log lines (POST /api/events →
 * one pino line per event: `{ msg: "evt", evt, at, s, build, sim, ...d }`).
 *
 *   node tools/stats.mjs events.ndjson [--level t1] [--json]
 *   aws logs filter-log-events … --output text | node tools/stats.mjs --level s1
 *   node tools/stats.mjs --logs-insights [--level t1]     print the CloudWatch Logs
 *                                                          Insights queries for the same numbers
 *
 * Prints the boot → zone_start → clear funnel (distinct sessions per stage),
 * the D1 proxy (share of boot events whose daysSinceFirstSeen bucket is "1"),
 * starts / deaths / clears per zone and an ASCII death heat-map (tx, ty) for
 * one zone. Input is NDJSON: pino lines, bare records, blank and unparsable
 * lines are skipped, as are lines that are not event lines (metric / request).
 *
 * No personal data exists in these lines by construction (see routes/events.ts).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_LEVEL = 't1';
/** Intensity ramp of the heat-map, empty → hottest. */
export const RAMP = ' .:-=+*#%@';
/** Widest heat-map before cells are binned. */
export const MAX_HEATMAP_WIDTH = 100;
/** daysSinceFirstSeen bucket that means "came back the next day". */
export const D1_BUCKET = '1';
export const USAGE = [
  'usage: node tools/stats.mjs [events.ndjson] [--level t1] [--json]',
  '       node tools/stats.mjs --logs-insights [--level t1]',
  '',
  '  Reads NDJSON event lines (file or stdin) and prints the funnel, the D1 proxy,',
  '  per-zone deaths / clears and a death heat-map for --level (default t1).',
  '  --logs-insights prints the CloudWatch Logs Insights queries for the same numbers.',
].join('\n');

// ---------------------------------------------------------------- arguments
export function parseArgs(argv) {
  const opts = { file: undefined, level: DEFAULT_LEVEL, insights: false, json: false, help: false, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--level' && argv[i + 1]) opts.level = argv[++i];
    else if (a === '--logs-insights') opts.insights = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('--')) opts.errors.push(`unknown option: ${a}`);
    else if (opts.file === undefined) opts.file = a;
    else opts.errors.push(`unexpected argument: ${a}`);
  }
  return opts;
}

// ---------------------------------------------------------------- input
/**
 * Event records from NDJSON text. A line counts when it parses to an object with
 * a string `evt` and either no `msg` (bare record) or `msg === "evt"` (pino line).
 */
export function parseNdjson(text) {
  const records = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj) || typeof obj.evt !== 'string') continue;
    if (obj.msg !== undefined && obj.msg !== 'evt') continue;
    records.push(obj);
  }
  return records;
}

// ---------------------------------------------------------------- numbers
const STAGES = ['boot', 'zone_start', 'clear'];

/** Distinct sessions (and raw event counts) per funnel stage; shares are relative to boot sessions. */
export function funnel(records) {
  const sessions = Object.fromEntries(STAGES.map((s) => [s, new Set()]));
  const events = Object.fromEntries(STAGES.map((s) => [s, 0]));
  for (const r of records) {
    if (!STAGES.includes(r.evt)) continue;
    events[r.evt]++;
    if (typeof r.s === 'string') sessions[r.evt].add(r.s);
  }
  const boot = sessions.boot.size;
  const share = (n) => (boot ? n / boot : 0);
  return {
    events,
    sessions: { boot, zone_start: sessions.zone_start.size, clear: sessions.clear.size },
    share: { zone_start: share(sessions.zone_start.size), clear: share(sessions.clear.size) },
  };
}

/** Share of boot events in the "1" bucket of daysSinceFirstSeen, with the full bucket histogram. */
export function d1Proxy(records) {
  const buckets = {};
  let boots = 0;
  let d1 = 0;
  for (const r of records) {
    if (r.evt !== 'boot') continue;
    boots++;
    const bucket = r.daysSinceFirstSeen === undefined || r.daysSinceFirstSeen === null ? 'unknown' : String(r.daysSinceFirstSeen);
    buckets[bucket] = (buckets[bucket] ?? 0) + 1;
    if (bucket === D1_BUCKET) d1++;
  }
  return { boots, d1, share: boots ? d1 / boots : 0, buckets };
}

/** Starts / deaths / clears per levelId (daily_* count for the 'daily' zone), sorted by level id. */
export function zoneStats(records) {
  const zones = new Map();
  const zone = (id) => {
    if (!zones.has(id)) zones.set(id, { levelId: id, starts: 0, deaths: 0, clears: 0 });
    return zones.get(id);
  };
  for (const r of records) {
    if (typeof r.levelId !== 'string') continue;
    if (r.evt === 'zone_start' || r.evt === 'daily_start') zone(r.levelId).starts++;
    else if (r.evt === 'death') zone(r.levelId).deaths++;
    else if (r.evt === 'clear' || r.evt === 'daily_clear') zone(r.levelId).clears++;
  }
  return [...zones.values()]
    .sort((a, b) => (a.levelId < b.levelId ? -1 : a.levelId > b.levelId ? 1 : 0))
    .map((z) => ({
      ...z,
      deathsPerClear: z.clears ? z.deaths / z.clears : null,
      clearRate: z.starts ? z.clears / z.starts : null,
    }));
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** Death counts per (tx, ty) tile for one zone, or null when the zone has no located deaths. */
export function heatmap(records, levelId) {
  const cells = new Map();
  let deaths = 0;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, max = 0;
  for (const r of records) {
    if (r.evt !== 'death' || r.levelId !== levelId || !finite(r.tx) || !finite(r.ty)) continue;
    const x = Math.floor(r.tx), y = Math.floor(r.ty);
    const key = `${x},${y}`;
    const n = (cells.get(key) ?? 0) + 1;
    cells.set(key, n);
    deaths++;
    max = Math.max(max, n);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  if (!deaths) return null;
  return { levelId, deaths, cells, minX, maxX, minY, maxY, max };
}

/** Heat-map as text: one row per ty (top first), one column per tx, binned when wider than maxWidth. */
export function renderHeatmap(hm, { maxWidth = MAX_HEATMAP_WIDTH } = {}) {
  if (!hm) return '(no located deaths for this zone)';
  const w = hm.maxX - hm.minX + 1;
  const h = hm.maxY - hm.minY + 1;
  const f = Math.max(1, Math.ceil(w / Math.max(1, maxWidth)));
  const cols = Math.ceil(w / f);
  const rows = Math.ceil(h / f);
  const grid = Array.from({ length: rows }, () => new Array(cols).fill(0));
  let max = 0;
  for (const [key, n] of hm.cells) {
    const [x, y] = key.split(',').map(Number);
    const cx = Math.floor((x - hm.minX) / f);
    const cy = Math.floor((y - hm.minY) / f);
    grid[cy][cx] += n;
    max = Math.max(max, grid[cy][cx]);
  }
  const glyph = (n) => (n ? RAMP[Math.max(1, Math.min(RAMP.length - 1, Math.round((n / max) * (RAMP.length - 1))))] : RAMP[0]);
  const lines = [
    `death heat-map · ${hm.levelId} · ${hm.deaths} deaths · tx ${hm.minX}..${hm.maxX} · ty ${hm.minY}..${hm.maxY}` +
      `${f > 1 ? ` · ${f}×${f} tiles per cell` : ''} · max ${max}/cell`,
  ];
  const gutter = 5;
  // Ruler: the tens digit at every tile whose tx is a multiple of 10.
  let ruler = '';
  for (let c = 0; c < cols; c++) {
    const tx = hm.minX + c * f;
    ruler += f === 1 && tx % 10 === 0 ? String(Math.floor(tx / 10) % 10) : ' ';
  }
  lines.push(`${''.padStart(gutter)} ${ruler}`);
  for (let r = 0; r < rows; r++) {
    lines.push(`${String(hm.minY + r * f).padStart(gutter - 1)} |${grid[r].map(glyph).join('')}|`);
  }
  lines.push(`legend: '${RAMP.slice(1)}' low → high (rows = ty, columns = tx${f === 1 ? ', ruler = tens of tx' : ''})`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- report
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const ratio = (x) => (x === null ? '—' : x.toFixed(2));

export function report(records, { level = DEFAULT_LEVEL } = {}) {
  const f = funnel(records);
  const d1 = d1Proxy(records);
  const zones = zoneStats(records);
  const out = [];
  out.push(`events: ${records.length} lines`);
  out.push('', 'funnel (distinct sessions)');
  out.push(`  boot        ${String(f.sessions.boot).padStart(7)}`);
  out.push(`  zone_start  ${String(f.sessions.zone_start).padStart(7)}  ${pct(f.share.zone_start)} of boot`);
  out.push(`  clear       ${String(f.sessions.clear).padStart(7)}  ${pct(f.share.clear)} of boot`);
  out.push('', `D1 proxy: ${d1.d1}/${d1.boots} boots in bucket "${D1_BUCKET}" = ${pct(d1.share)}`);
  const bucketKeys = Object.keys(d1.buckets).sort();
  if (bucketKeys.length) out.push(`  daysSinceFirstSeen: ${bucketKeys.map((k) => `${k}=${d1.buckets[k]}`).join('  ')}`);
  out.push('', 'zones');
  out.push('  level    starts  deaths  clears  deaths/clear  clear rate');
  for (const z of zones) {
    out.push(`  ${z.levelId.padEnd(8)} ${String(z.starts).padStart(6)}  ${String(z.deaths).padStart(6)}  ${String(z.clears).padStart(6)}  ${ratio(z.deathsPerClear).padStart(12)}  ${z.clearRate === null ? '—' : pct(z.clearRate)}`);
  }
  if (!zones.length) out.push('  (no zone events)');
  out.push('', renderHeatmap(heatmap(records, level)));
  return out.join('\n');
}

/** A JSON-friendly view of every number the report prints. */
export function summary(records, { level = DEFAULT_LEVEL } = {}) {
  const hm = heatmap(records, level);
  return {
    lines: records.length,
    funnel: funnel(records),
    d1: d1Proxy(records),
    zones: zoneStats(records),
    heatmap: hm && {
      levelId: hm.levelId, deaths: hm.deaths, minX: hm.minX, maxX: hm.maxX, minY: hm.minY, maxY: hm.maxY, max: hm.max,
      cells: [...hm.cells].map(([key, n]) => { const [tx, ty] = key.split(',').map(Number); return { tx, ty, deaths: n }; }),
    },
  };
}

// ---------------------------------------------------------------- Logs Insights
/** The queries to run in the ECS service log group for the same numbers. */
export function insightsQueries({ level = DEFAULT_LEVEL } = {}) {
  return [
    {
      title: 'funnel — distinct sessions per stage (boot → zone_start → clear)',
      query: 'fields evt, s\n| filter msg = "evt" and evt in ["boot", "zone_start", "clear"]\n| stats count_distinct(s) as sessions, count(*) as events by evt\n| sort sessions desc',
    },
    {
      title: `D1 proxy — boots per daysSinceFirstSeen bucket (share of bucket "${D1_BUCKET}")`,
      query: 'filter msg = "evt" and evt = "boot"\n| stats count(*) as boots by daysSinceFirstSeen\n| sort daysSinceFirstSeen asc',
    },
    {
      title: 'per zone — starts / deaths / clears',
      query: 'filter msg = "evt" and evt in ["zone_start", "death", "clear", "daily_start", "daily_clear"]\n| stats count(*) as n by levelId, evt\n| sort levelId asc, evt asc',
    },
    {
      title: 'death causes per zone',
      query: 'filter msg = "evt" and evt = "death"\n| stats count(*) as deaths by levelId, cause\n| sort levelId asc, deaths desc',
    },
    {
      title: `death heat-map cells — ${level} (export as JSON and feed the lines back to this tool)`,
      query: `filter msg = "evt" and evt = "death" and levelId = "${level}"\n| stats count(*) as deaths by tx, ty\n| sort deaths desc\n| limit 1000`,
    },
    {
      title: 'js errors by message',
      query: 'filter msg = "evt" and evt = "js_error"\n| stats count(*) as n by message\n| sort n desc\n| limit 50',
    },
  ];
}

export function formatInsights(queries) {
  const out = ['CloudWatch Logs Insights — run in the ECS service log group (stack ClawdEchoTowerStack, Service log group)', ''];
  queries.forEach((q, i) => {
    out.push(`${i + 1}. ${q.title}`);
    for (const line of q.query.split('\n')) out.push(`   ${line}`);
    out.push('');
  });
  return out.join('\n');
}

// ---------------------------------------------------------------- cli
function readInput(file) {
  if (file) return readFileSync(resolve(process.cwd(), file), 'utf8');
  if (process.stdin.isTTY) return null;
  return readFileSync(0, 'utf8');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  if (opts.errors.length) {
    for (const e of opts.errors) console.error(`stats: ${e}`);
    console.error(`\n${USAGE}`);
    return 2;
  }
  if (opts.insights) {
    console.log(formatInsights(insightsQueries({ level: opts.level })));
    return 0;
  }
  const text = readInput(opts.file);
  if (text === null) {
    console.error('stats: no input (pass a file or pipe NDJSON on stdin)');
    console.error(`\n${USAGE}`);
    return 2;
  }
  const records = parseNdjson(text);
  if (opts.json) console.log(JSON.stringify(summary(records, { level: opts.level }), null, 2));
  else console.log(report(records, { level: opts.level }));
  return 0;
}

/** True when run as `node tools/stats.mjs`, false when imported (tests). */
function isMain() {
  const entry = process.argv[1];
  return typeof entry === 'string' && resolve(entry) === fileURLToPath(import.meta.url);
}

if (isMain()) process.exit(main());
