/**
 * Playwright phone / tablet layout QA against a running server (default http://127.0.0.1:8099).
 *
 *   npx tsx tools/qa/mobile.ts            BASE_URL=... to point elsewhere
 *
 * Emulated profiles (CSS viewport @ device scale factor, touch):
 *   iphone14-landscape    750x340 @3      Galaxy S9+ landscape   658x320 @4.5
 *   ipad-pro11-landscape 1194x834 @2      iPad Pro 11 portrait   834x1194 @2
 * For each: the title loads with zero console / page errors; the "탑 오르기" and
 * "만든 것들" menu items both lie inside the viewport; a tap opens zone select and
 * a tap on the first open zone starts play; #hud-touch is visible; the HUD hint
 * box does not intersect any DASH / JUMP button; on the upright iPad the rotate
 * prompt stays hidden. A fifth profile, iPhone portrait 390x664 @3, must show
 * the rotate prompt and hide it on "그래도 계속". Screenshots land in
 * tools/qa/out/mobile-*.png. Exit code 1 on any failure.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

const BASE_URL = (process.env.BASE_URL ?? 'http://127.0.0.1:8099').replace(/\/+$/, '');
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'out');
const STEP_TIMEOUT_MS = 30_000;
/** The zone hint appears HINT_DELAY (2 s) after the run starts; allow for a slow headless frame loop. */
const HINT_WAIT_MS = 6_000;
/** Entry animations (fadeUp, staggered up to ~1.3 s) must settle before boxes are measured. */
const SETTLE_MS = 1_500;
/** Sub-pixel slack for bounding-box comparisons. */
const EPS = 0.5;

interface Profile {
  id: string;
  label: string;
  viewport: { width: number; height: number };
  dpr: number;
  /** Upright tablet: playable letterboxed, the rotate prompt must stay away. */
  tabletPortrait?: boolean;
}

const PLAY_PROFILES: Profile[] = [
  { id: 'iphone14-landscape', label: 'iPhone 14 landscape', viewport: { width: 750, height: 340 }, dpr: 3 },
  { id: 'galaxy-s9p-landscape', label: 'Galaxy S9+ landscape', viewport: { width: 658, height: 320 }, dpr: 4.5 },
  { id: 'ipad-pro11-landscape', label: 'iPad Pro 11 landscape', viewport: { width: 1194, height: 834 }, dpr: 2 },
  { id: 'ipad-pro11-portrait', label: 'iPad Pro 11 portrait', viewport: { width: 834, height: 1194 }, dpr: 2, tabletPortrait: true },
];
const PHONE_PORTRAIT: Profile = { id: 'iphone-portrait', label: 'iPhone portrait', viewport: { width: 390, height: 664 }, dpr: 3 };

interface Row { profile: string; step: string; ok: boolean; ms: number; note: string }
interface Issue { profile: string; step: string; kind: 'console' | 'pageerror' | 'http' | 'assert'; text: string }
interface Box { x: number; y: number; width: number; height: number }

function sameOrigin(url: string): boolean {
  try {
    return new URL(url).origin === new URL(BASE_URL).origin;
  } catch {
    return false;
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function fmtBox(b: Box): string {
  return `[${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)}]`;
}

function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.width - EPS && a.x + a.width > b.x + EPS && a.y < b.y + b.height - EPS && a.y + a.height > b.y + EPS;
}

function insideViewport(b: Box, vp: { width: number; height: number }): boolean {
  return b.x >= -EPS && b.y >= -EPS && b.x + b.width <= vp.width + EPS && b.y + b.height <= vp.height + EPS;
}

async function boxOf(page: Page, selector: string): Promise<Box> {
  const b = await page.locator(selector).first().boundingBox();
  check(b !== null, `${selector} has no layout box`);
  return b!;
}

function table(rows: Row[]): string {
  const head = ['profile', 'step', 'result', 'ms', 'note'];
  const cells = rows.map((r) => [r.profile, r.step, r.ok ? 'PASS' : 'FAIL', String(r.ms), r.note]);
  const widths = head.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const line = (c: string[]) => c.map((v, i) => (i === 3 ? v.padStart(widths[i]) : v.padEnd(widths[i]))).join('  ').trimEnd();
  return [line(head), widths.map((w) => '-'.repeat(w)).join('  '), ...cells.map(line)].join('\n');
}

/** A page with the issue collectors wired; `run` drives it and the context is closed afterwards. */
async function withProfile(
  browser: Browser, profile: Profile, rows: Row[], issues: Issue[], warnings: string[],
  run: (page: Page, step: (name: string, fn: () => Promise<string | void>) => Promise<boolean>) => Promise<void>,
): Promise<void> {
  const context: BrowserContext = await browser.newContext({
    viewport: profile.viewport,
    deviceScaleFactor: profile.dpr,
    isMobile: true,
    hasTouch: true,
    colorScheme: 'dark',
    locale: 'ko-KR',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(STEP_TIMEOUT_MS);
  let current = 'load';
  const missing = new Set<string>();

  page.on('response', (res) => {
    if (!sameOrigin(res.url())) return;
    if (res.status() >= 500) issues.push({ profile: profile.id, step: current, kind: 'http', text: `${res.status()} ${res.url()}` });
    else if (res.status() >= 400) {
      missing.add(pathOf(res.url()));
      warnings.push(`[${profile.id}/${current}] ${res.status()} ${res.url()}`);
    }
  });
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    const url = msg.location().url;
    if (url && !sameOrigin(url)) {
      warnings.push(`[${profile.id}/${current}] off-origin console error ignored: ${text} (${url})`);
      return;
    }
    // A PWA resource this build does not ship yet (worker script, manifest) makes
    // the browser complain; that is a 404 warning above, not a page defect.
    const pwaNoise = (missing.has('/sw.js') && /ServiceWorker|sw\.js/i.test(text))
      || (missing.has('/manifest.webmanifest') && /manifest/i.test(text))
      || [...missing].some((p) => text.includes(p));
    if (pwaNoise) {
      warnings.push(`[${profile.id}/${current}] console error for a missing resource ignored: ${text}`);
      return;
    }
    issues.push({ profile: profile.id, step: current, kind: 'console', text });
  });
  page.on('pageerror', (err) => issues.push({ profile: profile.id, step: current, kind: 'pageerror', text: err.message }));

  const step = async (name: string, fn: () => Promise<string | void>): Promise<boolean> => {
    current = name;
    const t0 = Date.now();
    try {
      const note = await fn();
      rows.push({ profile: profile.id, step: name, ok: true, ms: Date.now() - t0, note: note ?? '' });
      return true;
    } catch (err) {
      const text = (err instanceof Error ? err.message : String(err)).split('\n')[0];
      rows.push({ profile: profile.id, step: name, ok: false, ms: Date.now() - t0, note: text });
      issues.push({ profile: profile.id, step: name, kind: 'assert', text });
      return false;
    }
  };

  try {
    await run(page, step);
  } finally {
    await context.close();
  }
}

async function playProfile(browser: Browser, profile: Profile, rows: Row[], issues: Issue[], warnings: string[]): Promise<void> {
  await withProfile(browser, profile, rows, issues, warnings, async (page, step) => {
    const vp = profile.viewport;

    const titleOk = await step('title', async () => {
      await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
      await page.locator('#scr-title').waitFor({ state: 'visible' });
      await page.waitForTimeout(SETTLE_MS);
      const climb = await boxOf(page, '#title-menu [data-act="openSelect"]');
      const credits = await boxOf(page, '#title-menu [data-act="openCredits"]');
      await page.screenshot({ path: join(OUT_DIR, `mobile-${profile.id}-title.png`) });
      check(insideViewport(climb, vp), `탑 오르기 ${fmtBox(climb)} leaves the ${vp.width}x${vp.height} viewport`);
      check(insideViewport(credits, vp), `만든 것들 ${fmtBox(credits)} leaves the ${vp.width}x${vp.height} viewport`);
      const scrollable = await page.evaluate(() => {
        const s = document.getElementById('scr-title');
        return s ? s.scrollHeight - s.clientHeight : 0;
      });
      return `탑 오르기 ${fmtBox(climb)} · 만든 것들 ${fmtBox(credits)}${scrollable > 1 ? ` · title scrolls ${Math.round(scrollable)}px` : ''}`;
    });
    if (!titleOk) return;

    const selectOk = await step('select', async () => {
      await page.locator('#title-menu [data-act="openSelect"]').tap();
      await page.locator('#scr-select').waitFor({ state: 'visible' });
      await page.waitForTimeout(400);
      const open = await page.locator('#sel-tiers .card:not([disabled])').count();
      check(open > 0, 'no open zone card');
      return `${open} open zone(s)`;
    });
    if (!selectOk) return;

    const playOk = await step('play', async () => {
      await page.locator('#sel-tiers .card:not([disabled])').first().tap();
      await page.locator('#scr-play').waitFor({ state: 'visible' });
      await page.waitForTimeout(400);
      const touchVisible = await page.locator('#hud-touch').isVisible();
      check(touchVisible, '#hud-touch is not visible on a touch profile');
      const isTouch = await page.evaluate(() => document.getElementById('ui')?.classList.contains('is-touch') ?? false);
      check(isTouch, '#ui lacks the is-touch class');
      const level = (await page.locator('#hud-level').textContent())?.trim() ?? '';
      return level ? `level "${level}"` : '';
    });
    if (!playOk) return;

    await step('hint', async () => {
      const hint = page.locator('#hud-hint');
      let source = 'zone hint';
      try {
        await hint.waitFor({ state: 'visible', timeout: HINT_WAIT_MS });
      } catch {
        // The zone carried no hint (or it was already seen): measure the box with representative text.
        source = 'sample text';
        await page.evaluate(() => {
          const h = document.getElementById('hud-hint');
          if (!h) return;
          h.textContent = '← → 이동 · 점프 · 공중에서 한 번 더 누르면 2단 점프';
          h.hidden = false;
        });
        await hint.waitFor({ state: 'visible', timeout: 2_000 });
      }
      await page.waitForTimeout(600); // fadeUp
      const hintBox = await boxOf(page, '#hud-hint');
      const buttons = await page.locator('#hud-touch .tbtn').all();
      check(buttons.length >= 2, `expected DASH and JUMP buttons, found ${buttons.length}`);
      const clashes: string[] = [];
      for (const b of buttons) {
        const box = await b.boundingBox();
        const name = (await b.getAttribute('data-touch')) ?? 'tbtn';
        check(box !== null, `${name} has no layout box`);
        if (intersects(hintBox, box!)) clashes.push(`${name} ${fmtBox(box!)}`);
      }
      const pad = await page.locator('#tpad-move').boundingBox();
      if (pad && intersects(hintBox, pad)) warnings.push(`[${profile.id}/hint] hint ${fmtBox(hintBox)} overlaps the stick ${fmtBox(pad)}`);
      check(insideViewport(hintBox, vp), `hint ${fmtBox(hintBox)} leaves the viewport`);
      await page.screenshot({ path: join(OUT_DIR, `mobile-${profile.id}-play.png`) });
      check(clashes.length === 0, `hint ${fmtBox(hintBox)} overlaps ${clashes.join(', ')}`);
      return `${source}: hint ${fmtBox(hintBox)} clear of ${buttons.length} buttons`;
    });

    if (profile.tabletPortrait) {
      await step('no-rotate-nag', async () => {
        const nag = page.locator('#nag-rotate');
        check(!(await nag.isVisible()), 'the rotate prompt is showing on an upright tablet');
        return 'hidden on tablet portrait';
      });
    }
  });
}

async function phonePortrait(browser: Browser, rows: Row[], issues: Issue[], warnings: string[]): Promise<void> {
  await withProfile(browser, PHONE_PORTRAIT, rows, issues, warnings, async (page, step) => {
    await step('rotate-nag', async () => {
      await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
      await page.locator('#scr-title').waitFor({ state: 'visible' });
      // A real finger is what makes a fine-pointer emulation "touch"; the prompt covers the screen.
      await page.touchscreen.tap(PHONE_PORTRAIT.viewport.width / 2, PHONE_PORTRAIT.viewport.height / 2);
      await page.waitForTimeout(300);
      const nag = page.locator('#nag-rotate');
      await page.screenshot({ path: join(OUT_DIR, `mobile-${PHONE_PORTRAIT.id}-nag.png`) });
      check(await nag.isVisible(), 'the rotate prompt did not show on an upright phone');
      const text = (await nag.textContent()) ?? '';
      check(text.includes('기기를 가로로 돌리자'), 'the rotate prompt text is missing');
      await page.locator('#nag-rotate [data-act="dismissNag"]').tap();
      await page.waitForTimeout(200);
      check(!(await nag.isVisible()), '"그래도 계속" did not dismiss the prompt');
      const dismissed = await page.evaluate(() => sessionStorage.getItem('clawd-echo.nag-dismissed'));
      check(dismissed === '1', 'the dismissal was not remembered for the session');
      await page.screenshot({ path: join(OUT_DIR, `mobile-${PHONE_PORTRAIT.id}-title.png`) });
      return 'shown, dismissed, remembered';
    });
  });
}

async function run(browser: Browser): Promise<number> {
  const rows: Row[] = [];
  const issues: Issue[] = [];
  const warnings: string[] = [];

  for (const profile of PLAY_PROFILES) await playProfile(browser, profile, rows, issues, warnings);
  await phonePortrait(browser, rows, issues, warnings);

  const failed = rows.filter((r) => !r.ok).length;
  const out: string[] = [];
  out.push(`mobile ${BASE_URL}`, '', table(rows), '');
  if (issues.length) {
    out.push(`issues (${issues.length}):`);
    for (const i of issues) out.push(`  [${i.profile}/${i.step}] ${i.kind}: ${i.text}`);
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
    process.stderr.write(`mobile QA crashed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  },
);
