#!/usr/bin/env node
/**
 * Raster assets rendered with Playwright's Chromium and committed:
 *
 *   node tools/icons.mjs             public/icons/icon.svg → the PWA icon PNGs
 *   node tools/icons.mjs --social    public/og/og.png + public/screenshots/*.png from a running build (P3-4)
 *
 * Icons:
 *   icon-192.png, icon-512.png   the tile as drawn (rounded navy, transparent corners)
 *   icon-maskable-512.png        full-bleed navy, art scaled into the maskable safe zone
 *   apple-touch-icon.png (180)   full-bleed navy (iOS applies its own mask)
 *
 * Social (`--social`): each entry loads the deterministic `?shot=` harness of a
 * built, running server (BASE_URL, default http://127.0.0.1:8099 — the QA
 * scripts' default), screenshots its frames and composites them in an
 * about:blank page. Layouts: `panel` (og.png — a flat brand panel on the left,
 * the frame cropped into the right), `plain` (the frame as shot) and `stack`
 * (the narrow screenshot — the game is landscape, so a portrait store picture
 * stacks two 16:9 frames with captions under a small brand block). Colours are
 * quantised only as far as needed to keep each PNG under its byte cap (the
 * manifest / og tags promise PNG). None of these files is precached by the
 * service worker (tools/lib.mjs precacheList takes /icons/* and the listed
 * roots only).
 *
 *   npm run build && PORT=8099 STATIC_DIR=dist/public node dist/server/index.js &
 *   npm run icons -- --social        (BASE_URL=http://127.0.0.1:8241 to point elsewhere)
 *
 * `npm run icons` — run once after editing the SVG; the social pictures after a
 * visual change worth a new preview. The Docker build never runs this
 * (Playwright is a dev dependency only). CHROME=/path/to/chrome uses a system
 * browser instead of Playwright's download.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT, 'public');
const ICONS_DIR = join(PUBLIC_DIR, 'icons');
const SOURCE = join(ICONS_DIR, 'icon.svg');
const BASE_URL = (process.env.BASE_URL ?? 'http://127.0.0.1:8099').replace(/\/+$/, '');
/** Google Fonts stylesheet the composite page loads (the game's own stack); a stalled fetch falls back to system fonts. */
const FONTS_HREF = 'https://fonts.googleapis.com/css2?family=Outfit:wght@700;800;900&family=Noto+Sans+KR:wght@700;900&display=swap';
const FONTS_TIMEOUT_MS = 6000;
const SHOT_TIMEOUT_MS = 30_000;
/** Colour levels per channel tried in order until the PNG fits its cap (0 = untouched). */
const QUANT_STEPS = [0, 64, 48, 32, 24, 16, 12, 8];
/** og.png: width of the flat brand panel on the left; the frame fills the rest. */
const OG_PANEL_W = 520;
/**
 * Settings seeded into the harness page before it boots (localStorage, the
 * shape src/client/save.ts repairs): film grain is noise that no PNG filter
 * can compress, so the previews are shot without it. `key` must equal
 * save.ts SETTINGS_KEY (a test pins it).
 */
export const SHOT_SETTINGS = { key: 'clawd-echo.settings.v1', doc: { v: 1, grain: false, bloom: true, quality: 'high' } };

/** Fraction of the tile the art may occupy; the rest is padding around it. */
const MASKABLE_ART = 0.66;
const APPLE_ART = 0.86;

/**
 * One PNG per entry. `fullBleed` squares off the #bg tile; `art` scales #art
 * about the centre (1 = as drawn); `transparent` keeps the tile's corners clear.
 */
export const VARIANTS = [
  { file: 'icon-192.png', size: 192, fullBleed: false, art: 1, transparent: true },
  { file: 'icon-512.png', size: 512, fullBleed: false, art: 1, transparent: true },
  { file: 'icon-maskable-512.png', size: 512, fullBleed: true, art: MASKABLE_ART, transparent: false },
  { file: 'apple-touch-icon.png', size: 180, fullBleed: true, art: APPLE_ART, transparent: false },
];

/** The play frame every layout starts from: 새벽 물가 (t1), two seconds in, running right and hopping. */
const PLAY_SHOT = 'shot=t1&frames=240&hold=right&pulse=jump:26';

/**
 * Social pictures (P3-4), paths under public/. Each `shots` entry is a harness
 * query shot at its own viewport (`hideUi` drops the DOM HUD); `layout` says
 * how the frames are composited; `formFactor` is what the manifest declares
 * (null for the og image); `captions` label the frames of a stack.
 */
export const SOCIAL = [
  {
    file: 'og/og.png', width: 1200, height: 630, maxBytes: 300 * 1024, layout: 'panel', formFactor: null,
    shots: [{ query: PLAY_SHOT, width: 1200, height: 630, hideUi: true }],
  },
  {
    file: 'screenshots/wide-play.png', width: 960, height: 540, maxBytes: 400 * 1024, layout: 'plain', formFactor: 'wide',
    shots: [{ query: PLAY_SHOT, width: 960, height: 540, hideUi: false }],
  },
  {
    file: 'screenshots/wide-tower.png', width: 960, height: 540, maxBytes: 400 * 1024, layout: 'plain', formFactor: 'wide',
    shots: [{ query: 'shot=title&ui=select', width: 960, height: 540, hideUi: false }],
  },
  {
    file: 'screenshots/narrow-climb.png', width: 540, height: 960, maxBytes: 400 * 1024, layout: 'stack', formFactor: 'narrow',
    shots: [
      { query: 'shot=endless&frames=240&hold=right&pulse=jump:26&seed=20260906', width: 960, height: 540, hideUi: false },
      { query: 'shot=v1&frames=240&hold=right&pulse=jump:26', width: 960, height: 540, hideUi: false },
    ],
    captions: ['끝없는 등반 · 차오르는 조류를 피해 오른다', '공허의 초 3층 · 공허의 수정'],
  },
];

/** Runs in the page: square off the tile and scale the art about the centre. */
function applyVariant({ fullBleed, art }) {
  const svg = document.querySelector('svg');
  const bg = document.getElementById('bg');
  const group = document.getElementById('art');
  if (!svg || !bg || !group) return 'icon.svg needs <svg>, #bg and #art';
  if (fullBleed) bg.setAttribute('rx', '0');
  if (art !== 1) {
    const box = svg.viewBox.baseVal;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    group.setAttribute('transform', `translate(${cx} ${cy}) scale(${art}) translate(${-cx} ${-cy})`);
  }
  return '';
}

function pageHtml(svg, size) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:transparent;overflow:hidden}
svg{display:block;width:${size}px;height:${size}px}
</style></head><body>${svg}</body></html>`;
}

/** Width and height from a PNG's IHDR chunk. */
export function pngSize(buf) {
  const sig = '89504e470d0a1a0a';
  if (buf.length < 24 || buf.subarray(0, 8).toString('hex') !== sig || buf.subarray(12, 16).toString('latin1') !== 'IHDR') {
    throw new Error('not a PNG');
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// ---------------------------------------------------------------- social composite
const BRAND_CSS = `
.kicker{font-weight:800;letter-spacing:.28em;color:#7FE3D6}
.logo{font-weight:900;letter-spacing:-.02em;line-height:.92;display:flex}
.logo em{font-style:normal;background:linear-gradient(120deg,#FFC7A8,#F28C6A 55%,#E8825C);-webkit-background-clip:text;background-clip:text;color:transparent}
.sub{display:flex;align-items:baseline}
.sub b{font-weight:800;letter-spacing:.34em;color:#FFC7A8}
.sub i{font-style:normal;font-family:"Noto Sans KR","Outfit",system-ui,sans-serif;font-weight:700;letter-spacing:.12em;color:#93A8B3}
.site{font-weight:700;letter-spacing:.08em;color:#7FE3D6}`;

/** Where each frame canvas sits and how big it is, per layout. */
function frameBoxes({ layout, width, height, count }) {
  if (layout === 'panel') return [{ x: OG_PANEL_W, y: 0, w: width - OG_PANEL_W, h: height, radius: 0 }];
  if (layout === 'stack') {
    const pad = 32;
    const w = width - pad * 2;
    const h = Math.round((w * 9) / 16);
    const top = 214;
    const step = h + 78;
    return Array.from({ length: count }, (_, i) => ({ x: pad, y: top + i * step, w, h, radius: 14 }));
  }
  return [{ x: 0, y: 0, w: width, h: height, radius: 0 }];
}

/**
 * The composite page: the frames drawn on canvases (quantised to `quant`
 * levels per channel when > 0) inside the layout's chrome. Flat pixels are
 * what keeps a large PNG small, so the brand areas are plain #050A12. Runs in
 * about:blank (no CSP): inline style and script are fine here.
 */
export function compositeHtml({ frames, width, height, quant, layout, captions = [] }) {
  const boxes = frameBoxes({ layout, width, height, count: frames.length });
  const canvases = boxes.map((b, i) =>
    `<canvas class="frame" id="frame${i}" width="${b.w}" height="${b.h}" style="left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;border-radius:${b.radius}px"></canvas>`).join('');
  let chrome = '';
  if (layout === 'panel') {
    chrome = `
<div class="fade" style="left:${OG_PANEL_W}px"></div>
<div class="brand panel-brand">
  <div class="kicker">A PRECISION PLATFORMER<br>VERIFIED ECHOES</div>
  <div class="logo"><span>CLAWD</span><em>JUMP</em></div>
  <div class="sub"><b>ECHO TOWER</b><i>메아리의 탑</i></div>
  <div class="tag">검증된 리플레이 · 메아리 고스트<br>매일 바뀌는 탑 · 세계 순위</div>
  <div class="site">clawd-game.whchoi.net</div>
</div>`;
  } else if (layout === 'stack') {
    const labels = boxes.map((b, i) => `<div class="cap" style="top:${b.y + b.h + 16}px">${captions[i] ?? ''}</div>`).join('');
    chrome = `
<div class="brand stack-brand">
  <div class="kicker">A PRECISION PLATFORMER · VERIFIED ECHOES</div>
  <div class="logo"><span>CLAWD</span>&nbsp;<em>JUMP</em></div>
  <div class="sub"><b>ECHO TOWER</b><i>메아리의 탑</i></div>
</div>${labels}
<div class="site stack-site">clawd-game.whchoi.net</div>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS_HREF}">
<style>
html,body{margin:0;padding:0;background:#050A12;overflow:hidden}
#card{position:relative;width:${width}px;height:${height}px;overflow:hidden;background:#050A12;font-family:"Outfit","Noto Sans KR",system-ui,sans-serif;color:#F3F6F4}
.frame{position:absolute;display:block}
.fade{position:absolute;top:0;width:110px;height:${height}px;background:linear-gradient(90deg,#050A12,rgba(5,10,18,0))}
.brand{position:absolute}
${BRAND_CSS}
.panel-brand{left:64px;top:64px;width:${OG_PANEL_W - 64}px}
.panel-brand .kicker{font-size:16px;line-height:1.5}
.panel-brand .logo{margin-top:26px;font-size:104px;flex-direction:column}
.panel-brand .sub{margin-top:26px;flex-direction:column;gap:8px}
.panel-brand .sub b{font-size:28px}
.panel-brand .sub i{font-size:24px}
.panel-brand .tag{margin-top:44px;font-family:"Noto Sans KR","Outfit",system-ui,sans-serif;font-size:21px;line-height:1.55;font-weight:700}
.panel-brand .site{margin-top:22px;font-size:20px}
.stack-brand{left:32px;top:44px;width:${width - 64}px}
.stack-brand .kicker{font-size:12px;letter-spacing:.24em}
.stack-brand .logo{margin-top:12px;font-size:56px;line-height:1}
.stack-brand .sub{margin-top:12px;gap:14px}
.stack-brand .sub b{font-size:18px}
.stack-brand .sub i{font-size:16px}
.cap{position:absolute;left:32px;width:${width - 64}px;font-family:"Noto Sans KR","Outfit",system-ui,sans-serif;font-size:18px;font-weight:700;color:#F3F6F4}
.stack-site{position:absolute;left:32px;bottom:36px;font-size:16px}
</style></head><body>
<div id="card">${canvases}${chrome}</div>
<script>
(function () {
  var Q = ${quant};
  var frames = ${JSON.stringify(frames)};
  var pending = frames.length;
  frames.forEach(function (src, i) {
    var img = new Image();
    img.onload = function () {
      var c = document.getElementById('frame' + i);
      var W = c.width, H = c.height;
      var ctx = c.getContext('2d');
      // crop the centre of the frame (the camera keeps the player near the middle) into the canvas
      var sw = Math.min(img.width, Math.round(W * img.height / H));
      var sx = Math.round((img.width - sw) / 2);
      ctx.drawImage(img, sx, 0, sw, img.height, 0, 0, W, H);
      if (Q > 1) {
        var d = ctx.getImageData(0, 0, W, H);
        var px = d.data, step = 255 / (Q - 1);
        for (var k = 0; k < px.length; k += 4) {
          px[k] = Math.round(Math.round(px[k] / step) * step);
          px[k + 1] = Math.round(Math.round(px[k + 1] / step) * step);
          px[k + 2] = Math.round(Math.round(px[k + 2] / step) * step);
          px[k + 3] = 255;
        }
        ctx.putImageData(d, 0, 0);
      }
      if (--pending === 0) document.documentElement.dataset.ready = '1';
    };
    img.src = src;
  });
})();
</script></body></html>`;
}

/** Wait for the webfonts (bounded: an offline machine falls back to system fonts). */
async function settleFonts(page) {
  await Promise.race([
    page.evaluate(() => (document.fonts ? document.fonts.ready.then(() => undefined) : undefined)).catch(() => undefined),
    page.waitForTimeout(FONTS_TIMEOUT_MS),
  ]);
}

/** Screenshot one harness frame at its viewport (PNG bytes). */
async function captureFrame(browser, file, shot) {
  const context = await browser.newContext({ viewport: { width: shot.width, height: shot.height }, deviceScaleFactor: 1, colorScheme: 'dark', locale: 'ko-KR' });
  try {
    await context.addInitScript(({ key, doc }) => {
      try { localStorage.setItem(key, JSON.stringify(doc)); } catch { /* private mode */ }
    }, SHOT_SETTINGS);
    const page = await context.newPage();
    page.setDefaultTimeout(SHOT_TIMEOUT_MS);
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto(`${BASE_URL}/?${shot.query}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!document.documentElement.dataset.shot);
    const stamp = JSON.parse(await page.evaluate(() => document.documentElement.dataset.shot || '{}'));
    if (stamp.error) throw new Error(`${file}: harness error: ${String(stamp.error).split('\n')[0]}`);
    if (errors.length) throw new Error(`${file}: page error: ${errors[0]}`);
    if (shot.hideUi) {
      await page.evaluate(() => { const ui = document.getElementById('ui'); if (ui) ui.style.display = 'none'; });
    } else {
      // the harness never runs the frame loop: fonts arrive late, so let the HUD glyphs settle before the shot
      await settleFonts(page);
      await page.waitForTimeout(150);
    }
    return await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: shot.width, height: shot.height } });
  } finally {
    await context.close();
  }
}

/** Composite (and quantise as far as needed) until the PNG fits `entry.maxBytes`. */
async function composite(browser, entry, frames) {
  const context = await browser.newContext({ viewport: { width: entry.width, height: entry.height }, deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(SHOT_TIMEOUT_MS);
    const dataUris = frames.map((f) => `data:image/png;base64,${f.toString('base64')}`);
    let best = null;
    for (const quant of QUANT_STEPS) {
      const html = compositeHtml({ frames: dataUris, width: entry.width, height: entry.height, quant, layout: entry.layout, captions: entry.captions });
      await page.setContent(html, { waitUntil: 'load' });
      await page.waitForFunction(() => document.documentElement.dataset.ready === '1');
      await settleFonts(page);
      const png = await page.locator('#card').screenshot({ type: 'png' });
      best = { png, quant };
      if (process.env.ICONS_VERBOSE) process.stdout.write(`  ${entry.file}: ${quant || 'full'} levels → ${png.length} B\n`);
      if (png.length <= entry.maxBytes) break;
    }
    return best;
  } finally {
    await context.close();
  }
}

async function launch() {
  const args = ['--disable-dev-shm-usage'];
  if (typeof process.getuid === 'function' && process.getuid() === 0) args.push('--no-sandbox');
  return chromium.launch({ headless: true, args, executablePath: process.env.CHROME || undefined });
}

async function renderIcons() {
  const svg = readFileSync(SOURCE, 'utf8');
  mkdirSync(ICONS_DIR, { recursive: true });
  const browser = await launch();
  try {
    for (const v of VARIANTS) {
      const context = await browser.newContext({ viewport: { width: v.size, height: v.size }, deviceScaleFactor: 1 });
      const page = await context.newPage();
      await page.setContent(pageHtml(svg, v.size), { waitUntil: 'load' });
      const problem = await page.evaluate(applyVariant, { fullBleed: v.fullBleed, art: v.art });
      if (problem) throw new Error(problem);
      const png = await page.locator('svg').screenshot({ type: 'png', omitBackground: v.transparent });
      const { width, height } = pngSize(png);
      if (width !== v.size || height !== v.size) throw new Error(`${v.file}: rendered ${width}x${height}, wanted ${v.size}`);
      writeFileSync(join(ICONS_DIR, v.file), png);
      process.stdout.write(`${v.file.padEnd(24)} ${width}x${height}  ${png.length} B\n`);
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

async function renderSocial() {
  const browser = await launch();
  try {
    for (const entry of SOCIAL) {
      const frames = [];
      for (const shot of entry.shots) frames.push(await captureFrame(browser, entry.file, shot));
      const out = await composite(browser, entry, frames);
      if (!out) throw new Error(`${entry.file}: nothing rendered`);
      const { width, height } = pngSize(out.png);
      if (width !== entry.width || height !== entry.height) throw new Error(`${entry.file}: rendered ${width}x${height}, wanted ${entry.width}x${entry.height}`);
      if (out.png.length > entry.maxBytes) throw new Error(`${entry.file}: ${out.png.length} B exceeds the ${entry.maxBytes} B cap even at ${out.quant} levels`);
      const target = join(PUBLIC_DIR, entry.file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, out.png);
      process.stdout.write(`${entry.file.padEnd(30)} ${width}x${height}  ${out.png.length} B${out.quant ? `  (${out.quant} levels)` : ''}\n`);
    }
  } finally {
    await browser.close();
  }
}

async function main() {
  if (process.argv.includes('--social')) await renderSocial();
  else await renderIcons();
}

// Only run when executed directly (the tests import pngSize / VARIANTS / SOCIAL).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`icons failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
