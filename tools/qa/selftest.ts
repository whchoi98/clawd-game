/**
 * Cross-engine determinism QA against a running server (default http://127.0.0.1:8099).
 *
 *   npx tsx tools/qa/selftest.ts [--engines=chromium,webkit,firefox] [--require=chromium,webkit]
 *                                 BASE_URL=... to point elsewhere
 *
 * For every engine Playwright can launch here — Chromium (V8), WebKit
 * (JavaScriptCore) and Firefox (SpiderMonkey) — the page is opened with
 * `?shot=selftest`, which steps the bundled goal echoes and two scripted daily
 * towers through the shipped sim and stamps a digest per zone on
 * <html data-shot> (src/client/selftest.ts). Each stamp is compared, field by
 * field, with test/fixtures/corpus-digests.json — the digests Node's V8
 * computed (tools/hash-corpus.ts). Agreement is the proof that a run cleared on
 * an iPhone (JSC) verifies on the server (V8), and vice versa.
 *
 * An engine that is not installed on this host is reported as SKIP unless it
 * is named in --require (CI passes --require=chromium,webkit on ubuntu, where
 * `npx playwright install --with-deps chromium webkit` works). Exit code 1 on
 * any digest mismatch, a required engine that could not run, a same-origin
 * console / page error, a sim / gen version that differs from the fixture, or
 * when no engine ran at all.
 */
import { chromium, firefox, webkit, type Browser, type BrowserType } from 'playwright';
import type { CorpusDigest, EngineFamily } from '../../src/client/selftest.js';
import {
  FIXTURE_NAME, compareDigests, describeMismatches, loadFixture, parseSelftestStamp, type Comparison, type Fixture,
} from './corpus.js';

const BASE_URL = (process.env.BASE_URL ?? 'http://127.0.0.1:8099').replace(/\/+$/, '');
/** JSC steps the corpus a few times slower than V8; leave room for a cold headless start as well. */
const STAMP_TIMEOUT_MS = 120_000;

type EngineName = 'chromium' | 'webkit' | 'firefox';
const ENGINE_ORDER: readonly EngineName[] = ['chromium', 'webkit', 'firefox'];
const LAUNCHERS: Record<EngineName, BrowserType> = { chromium, webkit, firefox };
/** The JavaScript engine each browser must report through engineOf(navigator.userAgent). */
const EXPECTED_FAMILY: Record<EngineName, EngineFamily> = { chromium: 'v8', webkit: 'jsc', firefox: 'spidermonkey' };

interface EngineResult {
  engine: EngineName;
  status: 'PASS' | 'FAIL' | 'SKIP';
  family: EngineFamily | null;
  ms: number;
  note: string;
  rows: Comparison[];
  issues: string[];
}

function parseArgs(argv: readonly string[]): { engines: EngineName[]; require: Set<EngineName> } {
  const isEngine = (s: string): s is EngineName => (ENGINE_ORDER as readonly string[]).includes(s);
  const list = (v: string): EngineName[] => v.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    if (!isEngine(s)) throw new Error(`unknown engine '${s}' (chromium, webkit, firefox)`);
    return s;
  });
  let engines: EngineName[] = [...ENGINE_ORDER];
  let require = new Set<EngineName>();
  for (const a of argv) {
    if (a.startsWith('--engines=')) engines = list(a.slice('--engines='.length));
    else if (a.startsWith('--require=')) require = new Set(list(a.slice('--require='.length)));
    else throw new Error(`unknown argument '${a}'`);
  }
  for (const r of require) if (!engines.includes(r)) engines.push(r);
  return { engines, require };
}

function sameOrigin(url: string): boolean {
  try {
    return new URL(url).origin === new URL(BASE_URL).origin;
  } catch {
    return false;
  }
}

async function launch(engine: EngineName): Promise<Browser> {
  const args: string[] = [];
  if (engine === 'chromium') {
    args.push('--disable-dev-shm-usage');
    if (typeof process.getuid === 'function' && process.getuid() === 0) args.push('--no-sandbox');
  }
  // CHROME=/path/to/chrome uses a system browser for the Chromium run, as the other QA scripts do.
  const executablePath = engine === 'chromium' ? process.env.CHROME || undefined : undefined;
  return LAUNCHERS[engine].launch({ headless: true, args, executablePath });
}

/** Run the corpus on one engine and compare it with the fixture. Never throws: failures land in the result. */
async function runEngine(engine: EngineName, fixture: Fixture): Promise<EngineResult> {
  const t0 = Date.now();
  const issues: string[] = [];
  let browser: Browser;
  try {
    browser = await launch(engine);
  } catch (err) {
    // Playwright wraps the reason in a box-drawing frame after a "browserType.launch:" line; keep the first real sentence.
    const first = (err instanceof Error ? err.message : String(err))
      .replace(/^browserType\.launch:\s*/, '')
      .split('\n')
      .map((l) => l.replace(/[═╔╗╚╝║]/g, '').trim())
      .find((l) => l.length > 0) ?? 'launch failed';
    return { engine, status: 'SKIP', family: null, ms: Date.now() - t0, note: `not runnable here: ${first.slice(0, 110)}`, rows: [], issues };
  }
  try {
    const context = await browser.newContext({ viewport: { width: 800, height: 450 }, locale: 'ko-KR', colorScheme: 'dark' });
    const page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const url = msg.location().url;
      if (url && !sameOrigin(url)) return;
      issues.push(`console: ${msg.text()}`);
    });
    page.on('pageerror', (err) => issues.push(`pageerror: ${err.message}`));
    page.on('response', (res) => {
      if (sameOrigin(res.url()) && res.status() >= 500) issues.push(`http ${res.status()} ${res.url()}`);
    });

    await page.goto(`${BASE_URL}/?shot=selftest`, { waitUntil: 'domcontentloaded', timeout: STAMP_TIMEOUT_MS });
    await page.waitForFunction(() => document.documentElement.dataset.shot !== undefined, undefined, { timeout: STAMP_TIMEOUT_MS });
    const raw = await page.evaluate(() => document.documentElement.dataset.shot ?? '');
    await context.close();

    const stamp = parseSelftestStamp(raw);
    const rows = compareDigests(stamp.digests, fixture.digests);
    if (stamp.sim !== fixture.sim || stamp.gen !== fixture.gen) {
      issues.push(`page runs sim ${stamp.sim} / gen ${stamp.gen}, fixture is sim ${fixture.sim} / gen ${fixture.gen} — rebuild the client or rewrite the fixture`);
    }
    if (stamp.engine !== EXPECTED_FAMILY[engine]) {
      issues.push(`engineOf() said '${stamp.engine}' for a ${engine} user agent (${stamp.ua.slice(0, 80)}); expected '${EXPECTED_FAMILY[engine]}'`);
    }
    issues.push(...describeMismatches(rows));
    const passed = rows.filter((r) => r.ok).length;
    const ok = issues.length === 0 && passed === rows.length && rows.length > 0;
    return {
      engine, status: ok ? 'PASS' : 'FAIL', family: stamp.engine, ms: Date.now() - t0,
      note: `${passed}/${rows.length} digests match ${FIXTURE_NAME}`, rows, issues,
    };
  } catch (err) {
    issues.push(err instanceof Error ? err.message.split('\n')[0] : String(err));
    return { engine, status: 'FAIL', family: null, ms: Date.now() - t0, note: issues[issues.length - 1], rows: [], issues };
  } finally {
    await browser.close();
  }
}

/** engine × zone table: the fixture hash, then each engine's hash ('!' = differs, '-' = missing, SKIP when the engine did not run). */
function table(fixture: Fixture, results: readonly EngineResult[]): string {
  const head = ['zone', `node (${fixture.engine})`, ...results.map((r) => `${r.engine}${r.family ? ` (${r.family})` : ''}`)];
  const cell = (r: EngineResult, key: string): string => {
    if (r.status === 'SKIP') return 'SKIP';
    const row = r.rows.find((c) => c.key === key);
    if (!row) return '?';
    if (!row.actual) return '-';
    return row.ok ? row.actual.hash : `${row.actual.hash} !`;
  };
  const body = fixture.digests.map((d: CorpusDigest) => [d.key, d.hash, ...results.map((r) => cell(r, d.key))]);
  body.push(['result', `${fixture.digests.length} digests`, ...results.map((r) => `${r.status} ${r.ms} ms`)]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((c) => c[i].length)));
  const line = (c: string[]) => c.map((v, i) => v.padEnd(widths[i])).join('  ').trimEnd();
  return [line(head), widths.map((w) => '-'.repeat(w)).join('  '), ...body.map(line)].join('\n');
}

async function main(argv: readonly string[]): Promise<number> {
  const { engines, require } = parseArgs(argv);
  const fixture = loadFixture();
  const results: EngineResult[] = [];
  for (const engine of engines) results.push(await runEngine(engine, fixture));

  const out: string[] = [`selftest ${BASE_URL}  (fixture: ${FIXTURE_NAME}, sim ${fixture.sim} · gen ${fixture.gen})`, '', table(fixture, results), ''];
  let failed = 0;
  for (const r of results) {
    if (r.status === 'FAIL') failed++;
    if (r.status === 'SKIP' && require.has(r.engine)) {
      failed++;
      out.push(`${r.engine}: REQUIRED but ${r.note}`);
    } else if (r.status === 'SKIP') {
      out.push(`${r.engine}: SKIP — ${r.note}`);
    } else {
      out.push(`${r.engine}: ${r.status} — ${r.note}`);
    }
    for (const i of r.issues) out.push(`  ${i}`);
  }
  const ran = results.filter((r) => r.status !== 'SKIP').length;
  if (ran === 0) {
    failed++;
    out.push('no engine ran: install one with `npx playwright install --with-deps chromium`');
  }
  out.push('', `${results.filter((r) => r.status === 'PASS').length} engine(s) agree with Node, ${failed} failure(s)`);
  process.stdout.write(`${out.join('\n')}\n`);
  return failed ? 1 : 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`selftest crashed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  },
);
