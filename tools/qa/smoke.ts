/**
 * Playwright smoke test against a running server (default http://127.0.0.1:8099).
 *
 *   npx tsx tools/qa/smoke.ts [--no-shots]      BASE_URL=... to point elsewhere
 *
 * Checks, in order: the title screen appears with zero console/page errors and
 * the world canvas is actually painted; Enter opens zone select; Enter again
 * starts a zone (#scr-play); then every story zone is rendered through the
 * deterministic `?shot=` harness and screenshotted. Screenshots land in
 * tools/qa/out/. Exit code 1 on any console error, page error or failed step.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';

const BASE_URL = (process.env.BASE_URL ?? 'http://127.0.0.1:8099').replace(/\/+$/, '');
const NO_SHOTS = process.argv.includes('--no-shots');
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'out');
const ZONES = ['t1', 't2', 't3', 's1', 's2', 's3', 'v1', 'v2', 'v3'] as const;
const STEP_TIMEOUT_MS = 30_000;
/** Distinct colours required among the 48 sampled canvas pixels. */
const MIN_DISTINCT_COLOURS = 4;

interface Row { step: string; ok: boolean; ms: number; note: string }
interface Issue { step: string; kind: 'console' | 'pageerror' | 'http' | 'assert'; text: string }

type CanvasSample = { w: number; h: number; unique: number; transparent: number } | { error: string };

/** Runs inside the page: sample a grid of pixels from canvas#world. */
function sampleCanvas(): CanvasSample {
  const c = document.querySelector<HTMLCanvasElement>('canvas#world');
  if (!c) return { error: 'canvas#world not found' };
  if (c.width === 0 || c.height === 0) return { error: `canvas#world is ${c.width}x${c.height}` };
  const ctx = c.getContext('2d');
  if (!ctx) return { error: 'canvas#world has no 2d context' };
  const seen = new Set<string>();
  let transparent = 0;
  const cols = 8;
  const rows = 6;
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const x = Math.floor(((gx + 0.5) / cols) * c.width);
      const y = Math.floor(((gy + 0.5) / rows) * c.height);
      const d = ctx.getImageData(x, y, 1, 1).data;
      seen.add(`${d[0]},${d[1]},${d[2]},${d[3]}`);
      if (d[3] === 0) transparent++;
    }
  }
  return { w: c.width, h: c.height, unique: seen.size, transparent };
}

function assertPainted(s: CanvasSample): asserts s is Exclude<CanvasSample, { error: string }> {
  if ('error' in s) throw new Error(s.error);
  if (s.unique < MIN_DISTINCT_COLOURS) {
    throw new Error(`canvas looks blank: ${s.unique} distinct colour(s) in 48 samples (${s.w}x${s.h})`);
  }
  if (s.transparent === 48) throw new Error('canvas is fully transparent');
}

function sameOrigin(url: string): boolean {
  try {
    return new URL(url).origin === new URL(BASE_URL).origin;
  } catch {
    return false;
  }
}

/** Condense the JSON the `?shot=` harness stamps on <html data-shot> to one line. */
function describeShot(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw.length > 60 ? `${raw.slice(0, 57)}...` : raw;
  }
  if (typeof parsed !== 'object' || parsed === null) return String(parsed);
  const o = parsed as Record<string, unknown>;
  if (typeof o.error === 'string') throw new Error(`harness reported: ${o.error}`);
  const parts: string[] = [];
  for (const k of ['phase', 'player', 'deaths', 'shards', 'cleared', 'cam', 'q']) {
    if (k in o) parts.push(`${k}=${JSON.stringify(o[k])}`);
  }
  return parts.length ? parts.join(' ') : `${Object.keys(o).length} keys`;
}

function table(rows: Row[]): string {
  const head = ['step', 'result', 'ms', 'note'];
  const cells = rows.map((r) => [r.step, r.ok ? 'PASS' : 'FAIL', String(r.ms), r.note]);
  const widths = head.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const line = (c: string[]) => c.map((v, i) => (i === 2 ? v.padStart(widths[i]) : v.padEnd(widths[i]))).join('  ').trimEnd();
  return [line(head), widths.map((w) => '-'.repeat(w)).join('  '), ...cells.map(line)].join('\n');
}

async function run(browser: Browser): Promise<number> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    locale: 'ko-KR',
  });
  const page: Page = await context.newPage();
  page.setDefaultTimeout(STEP_TIMEOUT_MS);

  const rows: Row[] = [];
  const issues: Issue[] = [];
  const warnings: string[] = [];
  let current = 'boot';

  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const url = msg.location().url;
    if (url && !sameOrigin(url)) {
      warnings.push(`[${current}] off-origin console error ignored: ${msg.text()} (${url})`);
      return;
    }
    issues.push({ step: current, kind: 'console', text: msg.text() });
  });
  page.on('pageerror', (err) => issues.push({ step: current, kind: 'pageerror', text: err.message }));
  page.on('response', (res) => {
    if (!sameOrigin(res.url())) return;
    if (res.status() >= 500) issues.push({ step: current, kind: 'http', text: `${res.status()} ${res.url()}` });
    else if (res.status() >= 400) warnings.push(`[${current}] ${res.status()} ${res.url()}`);
  });

  async function step(name: string, fn: () => Promise<string | void>): Promise<boolean> {
    current = name;
    const t0 = Date.now();
    try {
      const note = await fn();
      rows.push({ step: name, ok: true, ms: Date.now() - t0, note: note ?? '' });
      return true;
    } catch (err) {
      const text = (err instanceof Error ? err.message : String(err)).split('\n')[0];
      rows.push({ step: name, ok: false, ms: Date.now() - t0, note: text });
      issues.push({ step: name, kind: 'assert', text });
      return false;
    }
  }

  const titleOk = await step('title', async () => {
    await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
    await page.locator('#scr-title').waitFor({ state: 'visible' });
    // Let the screen transition and a few frames of the title backdrop run.
    await page.waitForTimeout(500);
    const sample = await page.evaluate(sampleCanvas);
    assertPainted(sample);
    await page.screenshot({ path: join(OUT_DIR, '01-title.png') });
    return `canvas ${sample.w}x${sample.h}, ${sample.unique} colours`;
  });

  if (titleOk) {
    const selectOk = await step('select', async () => {
      await page.keyboard.press('Enter');
      await page.locator('#scr-select').waitFor({ state: 'visible' });
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(OUT_DIR, '02-select.png') });
      const zones = await page.locator('#sel-tiers button').count();
      return zones ? `${zones} zone buttons` : '';
    });
    if (selectOk) {
      await step('play', async () => {
        await page.keyboard.press('Enter');
        await page.locator('#scr-play').waitFor({ state: 'visible' });
        await page.waitForTimeout(700);
        const sample = await page.evaluate(sampleCanvas);
        assertPainted(sample);
        await page.screenshot({ path: join(OUT_DIR, '03-play.png') });
        const level = (await page.locator('#hud-level').textContent())?.trim() ?? '';
        return `${sample.unique} colours${level ? `, level "${level}"` : ''}`;
      });
    }
  }

  if (!NO_SHOTS) {
    for (const id of ZONES) {
      await step(`shot:${id}`, async () => {
        await page.goto(`${BASE_URL}/?shot=${id}&frames=240&hold=right&pulse=jump:26`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.documentElement.dataset.shot !== undefined);
        const raw = await page.evaluate(() => document.documentElement.dataset.shot ?? '');
        const sample = await page.evaluate(sampleCanvas);
        assertPainted(sample);
        await page.screenshot({ path: join(OUT_DIR, `shot-${id}.png`) });
        return describeShot(raw);
      });
    }
  }

  await context.close();

  const failed = rows.filter((r) => !r.ok).length;
  const out: string[] = [];
  out.push(`smoke ${BASE_URL}${NO_SHOTS ? ' (--no-shots)' : ''}`, '', table(rows), '');
  if (issues.length) {
    out.push(`issues (${issues.length}):`);
    for (const i of issues) out.push(`  [${i.step}] ${i.kind}: ${i.text}`);
    out.push('');
  }
  if (warnings.length) {
    out.push(`warnings (${warnings.length}, not fatal):`);
    for (const w of warnings) out.push(`  ${w}`);
    out.push('');
  }
  out.push(`${rows.length - failed}/${rows.length} steps passed, ${issues.length} issue(s); screenshots in ${OUT_DIR}`);
  process.stdout.write(`${out.join('\n')}\n`);
  return failed || issues.length ? 1 : 0;
}

async function main(): Promise<number> {
  mkdirSync(OUT_DIR, { recursive: true });
  const args = ['--disable-dev-shm-usage'];
  if (typeof process.getuid === 'function' && process.getuid() === 0) args.push('--no-sandbox');
  // CHROME=/path/to/chrome uses a system browser instead of Playwright's download.
  const browser = await chromium.launch({ headless: true, args, executablePath: process.env.CHROME || undefined });
  try {
    return await run(browser);
  } finally {
    await browser.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`smoke crashed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  },
);
