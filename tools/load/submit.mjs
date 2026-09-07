#!/usr/bin/env node
/**
 * Submission load test for CLAWD JUMP: ECHO TOWER (P3-12).
 *
 *   BASE_URL=http://127.0.0.1:8261 npx tsx tools/load/submit.mjs [--n 200] [--zones t1,t2,...]
 *                                   [--build load] [--healthz-interval 100] [--max-p99 100] [--timeout 30000]
 *
 * Fires N *valid* story submissions at once — every one a verified developer
 * clear from levels/solutions/par (replayed through the sim here to derive the
 * claim), each from its own player id and each a distinct replay (so the
 * server's HASH duplicate guard does not collapse them) — and, while they are
 * in flight, samples GET /healthz every `--healthz-interval` ms. The report is
 * the status histogram of the submissions (with the 422 reasons), the 5xx
 * count *excluding* 503 busy (backpressure is expected under load, anything
 * else is a bug), and the /healthz p50 / p99. Exit 1 when a non-503 5xx
 * occurred or the /healthz p99 exceeds `--max-p99` ms (P3-12 acceptance:
 * 200 concurrent → p99 < 100 ms, 5xx other than 503 = 0).
 *
 * Every accepted run lands on the board of its zone under a `부하-N` name, so
 * point BASE_URL at a local build or a scratch stack, never at the live site
 * unless you are ready to `npm run admin -- delist` them (docs/runbooks/scale.md).
 *
 * How the replays are made distinct without changing what the sim does: the
 * verifier stops stepping at the tick the run finishes, so bytes after that
 * tick are never simulated, while the replay hash keeps every non-idle byte.
 * Variant k appends k idle ticks and one UP tick after the finish tick — a
 * different hash, an identical run — and stays inside the mask budget the
 * claim justifies (maxMasksFor). Run through tsx: the sim is TypeScript.
 */
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Sim } from '../../src/sim/sim.ts';
import { decodeMasks, encodeMasks, verifyReplay } from '../../src/sim/replay.ts';
import { GEN_VERSION, IN, SIM_VERSION } from '../../src/sim/types.ts';
import { LEVEL_BY_ID } from '../../src/sim/levels.generated.ts';
import { maxMasksFor } from '../../src/server/runs.ts';
import { readSolutions } from '../../levels/solutions.ts';

export const DEFAULT_N = 200;
export const DEFAULT_ZONES = ['t1', 't2', 't3', 's1', 's2', 's3', 'v1', 'v2', 'v3'];
export const DEFAULT_HEALTHZ_INTERVAL_MS = 100;
export const DEFAULT_MAX_P99_MS = 100;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_BUILD = 'load';
/** The marker byte appended after the finish tick: never stepped, but part of the replay hash. */
export const MARKER_MASK = IN.UP;

export const USAGE = [
  'usage: BASE_URL=http://127.0.0.1:8261 npx tsx tools/load/submit.mjs [options]',
  '',
  `  --n <count>                concurrent submissions (default ${DEFAULT_N})`,
  `  --zones <ids>              comma-separated story zones to cycle through (default all nine)`,
  `  --build <label>            client.build sent with every run (default ${DEFAULT_BUILD})`,
  `  --healthz-interval <ms>    /healthz sampling period while the burst is in flight (default ${DEFAULT_HEALTHZ_INTERVAL_MS})`,
  `  --max-p99 <ms>             fail when the /healthz p99 is above this (default ${DEFAULT_MAX_P99_MS})`,
  `  --timeout <ms>             per-request timeout (default ${DEFAULT_TIMEOUT_MS})`,
  '',
  '  Every accepted run lands on a real board: run against a local build or a scratch stack.',
].join('\n');

// ---------------------------------------------------------------- arguments
export function parseArgs(argv, env = process.env) {
  const opts = {
    baseUrl: (env.BASE_URL ?? 'http://127.0.0.1:8261').replace(/\/+$/, ''),
    n: DEFAULT_N,
    zones: [...DEFAULT_ZONES],
    build: DEFAULT_BUILD,
    healthzIntervalMs: DEFAULT_HEALTHZ_INTERVAL_MS,
    maxP99Ms: DEFAULT_MAX_P99_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    help: false,
    errors: [],
  };
  const num = (name, raw, min) => {
    const n = Number.parseInt(String(raw), 10);
    if (!Number.isFinite(n) || n < min) opts.errors.push(`${name} needs an integer >= ${min}, got ${raw}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--n') opts.n = num('--n', next(), 1);
    else if (a === '--zones') opts.zones = String(next() ?? '').split(',').map((z) => z.trim()).filter(Boolean);
    else if (a === '--build') opts.build = String(next() ?? DEFAULT_BUILD);
    else if (a === '--healthz-interval') opts.healthzIntervalMs = num('--healthz-interval', next(), 10);
    else if (a === '--max-p99') opts.maxP99Ms = num('--max-p99', next(), 1);
    else if (a === '--timeout') opts.timeoutMs = num('--timeout', next(), 100);
    else if (a === '--base-url') opts.baseUrl = String(next() ?? '').replace(/\/+$/, '');
    else opts.errors.push(`unknown option: ${a}`);
  }
  if (!opts.zones.length) opts.errors.push('--zones needs at least one zone id');
  return opts;
}

// ---------------------------------------------------------------- bodies
/** Ticks the sim steps before a replay finishes (intro + play), i.e. the index after which bytes are never simulated. */
export function finishTick(def, masks) {
  const sim = new Sim(def, { seed: def.seed, assist: false });
  let i = 0;
  while (i < masks.length && !sim.finished) sim.step(masks[i++]);
  if (!sim.finished) throw new Error(`${def.id}: the solution does not finish within its masks`);
  return i;
}

/**
 * A prepared zone: the solution's masks cut at the finish tick, the claim the
 * sim derives from it, and how many distinct variants the mask budget allows.
 */
export function prepareZone(def, solution) {
  if (solution.sim !== SIM_VERSION) throw new Error(`${def.id}: solution is for sim v${solution.sim}, this tree is v${SIM_VERSION}`);
  if (solution.seed !== def.seed) throw new Error(`${def.id}: solution seed ${solution.seed} differs from the zone seed ${def.seed}`);
  const full = decodeMasks(solution.masks);
  const end = finishTick(def, full);
  const base = full.subarray(0, end);
  const v = verifyReplay(def, { v: SIM_VERSION, levelId: def.id, seed: def.seed, assist: false, masks: base });
  if (!v.ok || !v.summary.cleared) throw new Error(`${def.id}: solution does not verify (${v.reason ?? 'not cleared'})`);
  const s = v.summary;
  const claim = { ticks: s.ticks, shards: s.shards, deaths: s.deaths, cleared: s.cleared, height: s.height };
  // masks = base + k idle + marker → length end + k + 1 must stay within the budget
  const variants = Math.max(0, maxMasksFor(claim) - end - 1);
  if (variants < 1) throw new Error(`${def.id}: no room in the mask budget for a variant`);
  return { def, base, claim, variants };
}

/** Variant `k` of a prepared zone: the same run, a different replay hash. */
export function variantMasks(zone, k) {
  if (k < 0 || k >= zone.variants) throw new RangeError(`${zone.def.id}: variant ${k} out of ${zone.variants}`);
  const masks = new Uint8Array(zone.base.length + k + 1);
  masks.set(zone.base);
  masks[masks.length - 1] = MARKER_MASK;
  return masks;
}

/** PlayerRef.id-shaped (8–64 of [A-Za-z0-9_-]) and unique per run of the tool. */
export function playerIdFor(tag, i) {
  return `load-${tag}-${String(i).padStart(4, '0')}`;
}

/** One RunSubmit body for variant `k` of `zone`, from player `i`. */
export function buildBody(zone, k, i, { tag, build = DEFAULT_BUILD } = {}) {
  return {
    player: { id: playerIdFor(tag, i), name: `부하-${i}` },
    mode: 'story',
    levelId: zone.def.id,
    assist: false,
    sim: SIM_VERSION,
    gen: GEN_VERSION,
    masks: encodeMasks(variantMasks(zone, k)),
    claim: { ...zone.claim },
    client: { build },
  };
}

/**
 * `n` bodies cycling through the zones (body j → zone j mod zones, variant
 * ⌊j / zones⌋), each distinct on its board. `solutions` and `levels` are
 * injectable for tests; the defaults are the paced corpus and the shipped zones.
 */
export function buildBodies(n, { zones = DEFAULT_ZONES, tag = runTag(), build = DEFAULT_BUILD, solutions, levels = LEVEL_BY_ID } = {}) {
  const sols = solutions ?? readSolutions(zones, 'par');
  const prepared = [];
  const skipped = [];
  for (const id of zones) {
    const def = levels[id];
    const sol = sols[id];
    if (!def) { skipped.push({ id, reason: 'unknown zone' }); continue; }
    if (!sol) { skipped.push({ id, reason: 'no paced solution' }); continue; }
    try {
      prepared.push(prepareZone(def, sol));
    } catch (e) {
      skipped.push({ id, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  if (!prepared.length) throw new Error(`no usable zone (${skipped.map((s) => `${s.id}: ${s.reason}`).join('; ')})`);
  const capacity = prepared.reduce((acc, z) => acc + z.variants, 0);
  if (n > capacity) throw new Error(`only ${capacity} distinct replays are possible over ${prepared.length} zone(s); lower --n or add zones`);
  const bodies = [];
  for (let j = 0; j < n; j++) {
    const zone = prepared[j % prepared.length];
    const k = Math.floor(j / prepared.length);
    bodies.push(buildBody(zone, k, j, { tag, build }));
  }
  return { bodies, prepared, skipped, tag };
}

/** Six base-36 characters from the clock: the run's tag inside every player id. */
export function runTag(now = Date.now()) {
  return now.toString(36).slice(-6);
}

// ---------------------------------------------------------------- statistics
/** Status → count, keys sorted ascending. */
export function histogram(statuses) {
  const counts = new Map();
  for (const s of statuses) counts.set(s, (counts.get(s) ?? 0) + 1);
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => Number(a) - Number(b)));
}

/** Nearest-rank percentile of `values` (p in 0..100); NaN for an empty sample. */
export function percentile(values, p) {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1];
}

/** 5xx responses other than 503 busy — the count that must be zero. */
export function serverErrors(statuses) {
  return statuses.filter((s) => s >= 500 && s !== 503).length;
}

/** 0 when the run met the acceptance bar, 1 otherwise. */
export function exitCode(report, maxP99Ms = DEFAULT_MAX_P99_MS) {
  if (report.serverErrors > 0) return 1;
  if (report.healthz.samples > 0 && report.healthz.p99 > maxP99Ms) return 1;
  if (report.healthz.failures > 0) return 1;
  return 0;
}

// ---------------------------------------------------------------- the run
async function post(fetchFn, url, body, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const t0 = performance.now();
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    let reason;
    if (res.status === 422) {
      try { reason = (await res.json())?.reason; } catch { reason = 'unparsable'; }
    }
    return { status: res.status, ms: performance.now() - t0, reason, retryAfter: res.headers?.get?.('retry-after') ?? undefined };
  } catch (e) {
    return { status: 0, ms: performance.now() - t0, reason: e?.name === 'AbortError' ? 'timeout' : String(e?.cause?.code ?? e?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fire every body at once, sample /healthz until the last answer, and report.
 * `fetch` and `sleep` are injectable so the tool is testable without a server.
 */
export async function runLoad({
  baseUrl, bodies, fetch: fetchFn = globalThis.fetch, healthzIntervalMs = DEFAULT_HEALTHZ_INTERVAL_MS, timeoutMs = DEFAULT_TIMEOUT_MS,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const started = performance.now();
  let inFlight = true;
  const healthz = { samples: [], failures: 0 };
  const sampler = (async () => {
    while (inFlight) {
      const t0 = performance.now();
      try {
        const res = await fetchFn(`${baseUrl}/healthz`);
        if (res.status === 200) healthz.samples.push(performance.now() - t0);
        else healthz.failures++;
      } catch {
        healthz.failures++;
      }
      await sleep(healthzIntervalMs);
    }
  })();
  const results = await Promise.all(bodies.map((b) => post(fetchFn, `${baseUrl}/api/runs`, b, timeoutMs)));
  inFlight = false;
  await sampler;
  const elapsedMs = performance.now() - started;
  const statuses = results.map((r) => r.status);
  const reasons = histogram(results.filter((r) => r.status === 422).map((r) => r.reason ?? 'unknown'));
  const failures = histogram(results.filter((r) => r.status === 0).map((r) => r.reason ?? 'unknown'));
  const latencies = results.map((r) => r.ms);
  return {
    n: bodies.length,
    elapsedMs,
    statuses: histogram(statuses),
    reasons,
    transportFailures: failures,
    serverErrors: serverErrors(statuses),
    busy: statuses.filter((s) => s === 503).length,
    submit: { p50: percentile(latencies, 50), p99: percentile(latencies, 99), max: Math.max(0, ...latencies) },
    healthz: { samples: healthz.samples.length, failures: healthz.failures, p50: percentile(healthz.samples, 50), p99: percentile(healthz.samples, 99) },
  };
}

const ms = (v) => (Number.isFinite(v) ? `${v.toFixed(1)} ms` : 'n/a');

export function formatReport(report, { maxP99Ms = DEFAULT_MAX_P99_MS } = {}) {
  const lines = [
    `submissions ${report.n} in ${(report.elapsedMs / 1000).toFixed(2)} s (${(report.n / (report.elapsedMs / 1000)).toFixed(1)} /s)`,
    `status      ${Object.entries(report.statuses).map(([k, v]) => `${k}×${v}`).join('  ') || '(none)'}`,
  ];
  if (Object.keys(report.reasons).length) lines.push(`422 reasons ${Object.entries(report.reasons).map(([k, v]) => `${k}×${v}`).join('  ')}`);
  if (Object.keys(report.transportFailures).length) lines.push(`no response ${Object.entries(report.transportFailures).map(([k, v]) => `${k}×${v}`).join('  ')}`);
  lines.push(
    `503 busy    ${report.busy}   5xx other than 503: ${report.serverErrors} ${report.serverErrors ? 'FAIL' : 'ok'}`,
    `submit      p50 ${ms(report.submit.p50)}  p99 ${ms(report.submit.p99)}  max ${ms(report.submit.max)}`,
    `/healthz    ${report.healthz.samples} samples  p50 ${ms(report.healthz.p50)}  p99 ${ms(report.healthz.p99)} (limit ${maxP99Ms} ms) ` +
      `${report.healthz.samples && report.healthz.p99 <= maxP99Ms ? 'ok' : 'FAIL'}${report.healthz.failures ? `  ${report.healthz.failures} failed` : ''}`,
  );
  return lines.join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(USAGE); return 0; }
  if (opts.errors.length) {
    for (const e of opts.errors) console.error(`load: ${e}`);
    console.error(`\n${USAGE}`);
    return 2;
  }
  const { bodies, prepared, skipped, tag } = buildBodies(opts.n, { zones: opts.zones, build: opts.build });
  for (const s of skipped) console.error(`load: ${s.id} skipped — ${s.reason}`);
  console.log(`${bodies.length} submissions over ${prepared.map((z) => `${z.def.id}(${z.claim.ticks} ticks, ${z.variants} variants)`).join(', ')} → ${opts.baseUrl}  tag ${tag}`);
  const report = await runLoad({ baseUrl: opts.baseUrl, bodies, healthzIntervalMs: opts.healthzIntervalMs, timeoutMs: opts.timeoutMs });
  console.log(formatReport(report, { maxP99Ms: opts.maxP99Ms }));
  return exitCode(report, opts.maxP99Ms);
}

/** True when run as `tsx tools/load/submit.mjs`, false when imported (tests). */
function isMain() {
  const entry = process.argv[1];
  return typeof entry === 'string' && resolve(entry) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`load: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
