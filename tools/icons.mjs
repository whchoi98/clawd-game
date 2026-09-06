#!/usr/bin/env node
/**
 * Render public/icons/icon.svg to the PWA PNGs with Playwright's Chromium:
 *
 *   icon-192.png, icon-512.png   the tile as drawn (rounded navy, transparent corners)
 *   icon-maskable-512.png        full-bleed navy, art scaled into the maskable safe zone
 *   apple-touch-icon.png (180)   full-bleed navy (iOS applies its own mask)
 *
 * `npm run icons` — run once after editing the SVG and commit the PNGs. The
 * Docker build never runs this (Playwright is a dev dependency only).
 * CHROME=/path/to/chrome uses a system browser instead of Playwright's download.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ICONS_DIR = join(ROOT, 'public', 'icons');
const SOURCE = join(ICONS_DIR, 'icon.svg');

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

async function main() {
  const svg = readFileSync(SOURCE, 'utf8');
  mkdirSync(ICONS_DIR, { recursive: true });
  const args = ['--disable-dev-shm-usage'];
  if (typeof process.getuid === 'function' && process.getuid() === 0) args.push('--no-sandbox');
  const browser = await chromium.launch({ headless: true, args, executablePath: process.env.CHROME || undefined });
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

// Only run when executed directly (the test imports pngSize / VARIANTS).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`icons failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
