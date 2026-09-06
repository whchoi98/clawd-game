/**
 * Playwright check of the level-author grid overlay against a running server
 * (default http://127.0.0.1:8099):
 *
 *   npx tsx tools/qa/grid.ts            BASE_URL=... to point elsewhere · ZONE=t2 for another zone
 *
 * Opens `?shot=<zone>&grid=1` and asserts that the harness stamped `grid: true`
 * with grid statistics and no error, and that the canvas actually carries the
 * overlay: columns and rows dominated by the grid colour (#FFE600) repeat at a
 * regular spacing (one tile = 16 world units × the stage scale), at least six
 * of each. A screenshot lands in tools/qa/out/grid-<zone>.png. Exit code 1 on
 * any failure or same-origin console error.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const BASE_URL = (process.env.BASE_URL ?? 'http://127.0.0.1:8099').replace(/\/+$/, '');
const ZONE = process.env.ZONE ?? 't1';
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'out');
const TIMEOUT_MS = 30_000;
/** A pixel this yellow is grid; the sky, sand and spikes of every biome stay far from it. */
const MIN_LINES = 6;
/** Share of a column's / row's pixels that must be grid-coloured for it to count as a line. */
const LINE_FRACTION = 0.35;

interface Periodic { positions: number[]; spacing: number; regular: boolean }
interface Scan { w: number; h: number; cols: Periodic; rows: Periodic }

/**
 * Runs inside the page: find grid-coloured columns and rows and check their
 * spacing. Serialised by Playwright, so — like the probes in readability.ts —
 * it defines no named inner functions (tsx's keepNames would wrap them in a
 * `__name` helper that does not exist in the page).
 */
function scanGrid(fraction: number): Scan | { error: string } {
  const c = document.querySelector<HTMLCanvasElement>('canvas#world');
  if (!c) return { error: 'canvas#world not found' };
  const ctx = c.getContext('2d');
  if (!ctx) return { error: 'no 2d context' };
  const w = c.width, h = c.height;
  const d = ctx.getImageData(0, 0, w, h).data;
  const colHits = new Uint32Array(w), rowHits = new Uint32Array(h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (d[i] > 200 && d[i + 1] > 180 && d[i + 2] < 110 && d[i + 3] > 0) { colHits[x]++; rowHits[y]++; }
    }
  }
  const out: Periodic[] = [];
  for (const [hits, span, total] of [[colHits, w, h], [rowHits, h, w]] as [Uint32Array, number, number][]) {
    const positions: number[] = [];
    for (let i = 0; i < span; i++) {
      if (hits[i] / total < fraction) continue;
      // a 2 px major line reads as two adjacent columns: keep the first
      if (positions.length && i - positions[positions.length - 1] <= 2) continue;
      positions.push(i);
    }
    const gaps: number[] = [];
    for (let i = 1; i < positions.length; i++) gaps.push(positions[i] - positions[i - 1]);
    const sorted = gaps.slice().sort((a, b) => a - b);
    const spacing = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
    let regular = gaps.length > 0;
    for (const g of gaps) if (Math.abs(g - spacing) > 2) regular = false;
    out.push({ positions, spacing, regular });
  }
  return { w, h, cols: out[0], rows: out[1] };
}

async function main(): Promise<number> {
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const issues: string[] = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: 'dark', locale: 'ko-KR' });
    const page = await context.newPage();
    page.on('console', (m) => { if (m.type() === 'error' && m.location().url.startsWith(BASE_URL)) issues.push(`console: ${m.text()}`); });
    page.on('pageerror', (e) => issues.push(`pageerror: ${e.message}`));

    const url = `${BASE_URL}/?shot=${ZONE}&grid=1&frames=60`;
    await page.goto(url, { waitUntil: 'load', timeout: TIMEOUT_MS });
    await page.waitForFunction(() => !!document.documentElement.dataset.shot, undefined, { timeout: TIMEOUT_MS });
    const stamp = JSON.parse(await page.evaluate(() => document.documentElement.dataset.shot ?? '{}')) as Record<string, unknown>;
    await page.screenshot({ path: join(OUT_DIR, `grid-${ZONE}.png`) });

    if (typeof stamp.error === 'string') issues.push(`harness error: ${stamp.error}`);
    if (stamp.grid !== true) issues.push(`data-shot.grid is ${JSON.stringify(stamp.grid)}, expected true`);
    const stats = stamp.gridStats as { lines?: number; labels?: number; spawns?: number; segments?: unknown[] } | null;
    if (!stats || typeof stats.lines !== 'number' || stats.lines < MIN_LINES) issues.push(`data-shot.gridStats.lines = ${JSON.stringify(stats?.lines)}, expected ≥ ${MIN_LINES}`);
    if (!stats || !Array.isArray(stats.segments) || stats.segments.length === 0) issues.push('data-shot.gridStats.segments is empty');
    if (!stats || typeof stats.spawns !== 'number' || stats.spawns < 1) issues.push('data-shot.gridStats.spawns < 1 (the P should be in view)');

    const scan = await page.evaluate(scanGrid, LINE_FRACTION);
    if ('error' in scan) {
      issues.push(scan.error);
    } else {
      for (const [name, p] of [['columns', scan.cols], ['rows', scan.rows]] as const) {
        if (p.positions.length < MIN_LINES) issues.push(`${name}: ${p.positions.length} grid-coloured line(s), expected ≥ ${MIN_LINES}`);
        if (!p.regular) issues.push(`${name}: spacing irregular (${p.positions.slice(0, 12).join(',')}…)`);
      }
      // one tile in device px = 16 world units × (canvas px / view units); the harness stamps both
      const tilePx = 16 * (Array.isArray(stamp.cv) && Array.isArray(stamp.view) ? (stamp.cv[0] as number) / (stamp.view[0] as number) : 0);
      const note = `canvas ${scan.w}x${scan.h}: ${scan.cols.positions.length} columns every ${scan.cols.spacing} px, ${scan.rows.positions.length} rows every ${scan.rows.spacing} px` +
        (tilePx ? ` (one tile ≈ ${tilePx.toFixed(1)} px, majors every ${(tilePx * 4).toFixed(0)} px)` : '');
      process.stdout.write(`${note}\n`);
      // the repeat must be the tile pitch (every line) or the major pitch (a very bright frame keeping only the 2 px lines)
      for (const [name, p] of [['column', scan.cols], ['row', scan.rows]] as const) {
        if (tilePx && Math.abs(p.spacing - tilePx) > 2 && Math.abs(p.spacing - tilePx * 4) > 2) {
          issues.push(`${name} spacing ${p.spacing} px is neither one tile (${tilePx.toFixed(1)} px) nor four`);
        }
      }
    }
    process.stdout.write(`stamp: grid=${String(stamp.grid)} lines=${stats?.lines ?? '-'} labels=${stats?.labels ?? '-'} spawns=${stats?.spawns ?? '-'} segments=${stats?.segments?.length ?? '-'}\n`);
  } finally {
    await browser.close();
  }
  if (issues.length) {
    process.stdout.write(`FAIL\n  ${issues.join('\n  ')}\n`);
    return 1;
  }
  process.stdout.write(`PASS grid overlay on ${ZONE} (tools/qa/out/grid-${ZONE}.png)\n`);
  return 0;
}

main().then((code) => { process.exitCode = code; }, (err: unknown) => {
  process.stderr.write(`grid qa crashed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exitCode = 1;
});
