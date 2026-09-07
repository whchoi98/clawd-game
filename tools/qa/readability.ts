/**
 * Playwright readability QA against a running server (default http://127.0.0.1:8099).
 *
 *   npx tsx tools/qa/readability.ts            BASE_URL=... to point elsewhere
 *
 * Pixel-level checks of the P1-6 readability pass, through the deterministic
 * `?shot=` harness at 1280x800 @1 (see src/client/shot.ts):
 *
 *   updraft  shot=v2 with the player parked on the start yard, the first updraft
 *            column in view: the mean luma (Rec. 709, 0..255) of the column's
 *            centre pixel column is >= 25 above the background sampled 1.5 tiles
 *            to either side over the same rows (the bottom two tiles, where the
 *            neighbours are pit rock and spikes, are excluded).
 *   spike    shot=v1 from the start: in the tip zone of the spike tile nearest
 *            the screen centre (3 world units wide, 5 tall, from the tallest
 *            blade's tip down) the darkest pixel has a WCAG contrast >= 3:1 with
 *            the biome crust colour — a bright tip can never reach 3:1 against a
 *            crust of luminance 0.62, so the readable edge is the dark outline —
 *            and the brightest pixel is a real highlight (L >= 0.4). On the rim
 *            biomes (SPIKE_RIM_BIOMES: voidreef, summit) the upper part of the
 *            tile also holds a pixel of the accent rim.
 *   beacon   shot=v2 from the start, the goal ~1200 units to the right:
 *            renderer.goalScreen is off screen and a pixel in the biome accent
 *            sits inside the 48 px edge band of the canvas.
 *
 * The P5-3 background pass adds:
 *
 *   backdrop:<zone>  (t1, s1, v1) the sky alone is repainted into the world
 *            canvas (`renderer.sky.draw`, everything it draws sits behind the
 *            playfield) and, in the playfield band — the rows from the highest
 *            crust surface in view down to the bottom of the rendered box — no
 *            pixel column's mean luma may exceed the biome crust's luma. A
 *            backdrop brighter than the ledges would invert the depth cue and
 *            drown the terrain edge.
 *   tier4-*  the updraft / spike / beacon probes once more on the summit zones.
 *            Until the P5-1 zones (m1..m4) merge, SUMMIT_* point at existing
 *            zones so the steps run; the integrator switches them to m1 (spike
 *            bed in view from the start) and m3 (an updraft column, parking
 *            Clawd with `at=`) and drops the "provisional" note.
 *
 * Geometry is read from the live page (`window.__clawd`: entities, level grid,
 * the renderer's stage transform), never re-derived from level sources, so a
 * level edit cannot silently move the probes off target. Screenshots land in
 * tools/qa/out/readability-*.png. Exit code 1 on any failure or console error.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { TILE } from '../../src/sim/types.js';
import { BIOMES } from '../../src/shared/biomes.js';
import { SPIKE_RIM_BIOMES, SPIKE_TIP_INSET } from '../../src/client/render/tiles.js';
import { contrastRatio, lumaHex, relLuminance } from '../../src/client/render/stage.js';

const BASE_URL = (process.env.BASE_URL ?? 'http://127.0.0.1:8099').replace(/\/+$/, '');
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'out');
const STEP_TIMEOUT_MS = 30_000;
/** Column centre must beat the background by this much mean luma (0..255). */
const UPDRAFT_MIN_LUMA_GAIN = 25;
/** Background probes sit this many tiles left and right of the column centre. */
const UPDRAFT_BG_OFFSET_TILES = 1.5;
/** WCAG contrast the spike tip's darkest pixel needs against the crust colour. */
const SPIKE_MIN_CONTRAST = 3;
/** Relative luminance the spike tip's brightest pixel must reach (a highlight exists). */
const SPIKE_MIN_HIGHLIGHT_L = 0.4;
/** Max RGB distance for "this pixel is the accent colour". */
const ACCENT_TOLERANCE = 24;
/** Looser tolerance for the 2 px spike rim, which is stroked at alpha 0.9 over a dark outline. */
const RIM_TOLERANCE = 60;
/** The beacon must sit within this many CSS px of a canvas edge. */
const BEACON_EDGE_BAND_PX = 48;

/** The shots of the three base steps (v2 parks Clawd on the start yard's edge: tile 15.5, feet on row 24). */
const UPDRAFT_SHOT = 'shot=v2&frames=60&at=248,384';
const SPIKE_SHOT = 'shot=v1&frames=60';
const BEACON_SHOT = 'shot=v2&frames=60';
/** Zones whose backdrop the backdrop-band step probes: the first zone of every shipped tier. */
const BACKDROP_ZONES = ['t1', 's1', 'v1'];
/**
 * Tier-4 (summit) shots — PROVISIONAL: the summit zones m1..m4 land with P5-1,
 * so these point at existing zones until the integrator flips them, e.g. to
 * 'shot=m1&frames=60' (spikes), 'shot=m3&frames=60&at=<x>,<y>' (an updraft
 * column in view, nobody inside it) and 'shot=m1&frames=60' (goal off right).
 */
const SUMMIT_SPIKE_SHOT = SPIKE_SHOT;
const SUMMIT_UPDRAFT_SHOT = UPDRAFT_SHOT;
const SUMMIT_BEACON_SHOT = BEACON_SHOT;

interface Row { step: string; ok: boolean; ms: number; note: string }
interface Issue { step: string; kind: 'console' | 'pageerror' | 'http' | 'assert'; text: string }

// ---------------------------------------------------------------- page-side types
/** The slice of the debug handle `main.ts` hangs on `window.__clawd` that these probes read. */
interface DebugEntity { kind: string; x: number; y: number; w: number; h: number }
interface DebugStage { camX: number; camY: number; zoom: number; scale: number; w: number; h: number; ox: number; oy: number; rw: number; rh: number }
interface DebugHandle {
  run: { sim: { state: { entities: DebugEntity[] }; level: { w: number; h: number; at(tx: number, ty: number): string } } } | null;
  /** `Scenes.renderer` is TypeScript-private; at runtime it is a plain property (the concrete Renderer). */
  renderer: { stage: DebugStage; goalScreen: { x: number; y: number; onScreen: boolean } | null; sky: { draw(camX: number, camY: number): void } };
}
interface Rgb { r: number; g: number; b: number }

type UpdraftProbe =
  | { error: string }
  | { column: { x: number; y: number; w: number; h: number }; devX: number; devY0: number; devY1: number; centre: number; left: number; right: number };
type SpikeProbe =
  | { error: string }
  | { tile: [number, number]; window: [number, number, number, number]; minL: number; maxL: number; minRgb: Rgb; maxRgb: Rgb; rimHit: Rgb | null };
type BeaconProbe =
  | { error: string }
  | { goalScreen: { x: number; y: number; onScreen: boolean } | null; canvas: [number, number]; css: [number, number]; hit: { x: number; y: number; rgb: Rgb } | null; scanned: number };
type BackdropProbe =
  | { error: string }
  | { band: [number, number]; surfaceRow: number; columns: number; maxMean: number; maxX: number; meanOfMeans: number };

// ---------------------------------------------------------------- page-side probes
// Each runs inside the page via page.evaluate: self-contained, args only. They
// define NO named inner functions (`const f = () => …`, nested `function f`):
// tsx compiles those with esbuild's keepNames, which wraps them in a `__name`
// helper that does not exist in the page ("ReferenceError: __name is not
// defined"). Anonymous callbacks passed straight to `.map` are safe.

/** Updraft column: mean luma down the centre line vs the background either side. */
function probeUpdraft(args: { tile: number; bgTiles: number }): UpdraftProbe {
  const clawd = (window as unknown as { __clawd?: DebugHandle }).__clawd;
  const run = clawd?.run;
  if (!clawd || !run) return { error: 'window.__clawd.run is not set (shot harness did not start a level)' };
  const st = clawd.renderer.stage;
  const canvas = document.querySelector<HTMLCanvasElement>('canvas#world');
  const ctx = canvas?.getContext('2d');
  if (!canvas || !ctx) return { error: 'canvas#world has no 2d context' };
  const s = st.scale * st.zoom;
  // the updraft whose centre line is nearest the middle of the screen and fully inside it
  let best: DebugEntity | null = null;
  let bestD = Infinity;
  for (const e of run.sim.state.entities) {
    if (e.kind !== 'updraft') continue;
    const dx = (e.x - st.camX) * s + st.w / 2;
    if (dx < st.w * 0.1 || dx > st.w * 0.9) continue;
    const d = Math.abs(dx - st.w / 2);
    if (d < bestD) { bestD = d; best = e; }
  }
  if (!best) return { error: 'no updraft column inside the view' };
  const top = best.y - best.h / 2, bottom = best.y + best.h / 2;
  // skip the bottom two tiles: the column's foot sits in a pit whose walls and spikes are not "background"
  let y0 = top + 4, y1 = bottom - 2 * args.tile;
  if (y1 - y0 < args.tile) { y0 = top + 2; y1 = bottom - 2; }
  const devX = (best.x - st.camX) * s + st.w / 2;
  const devY0 = (y0 - st.camY) * s + st.h / 2;
  const devY1 = (y1 - st.camY) * s + st.h / 2;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data, W = canvas.width, H = canvas.height;
  const off = args.bgTiles * args.tile * s;
  const [centre, left, right] = [devX, devX - off, devX + off].map((x) => {
    const px = Math.round(x);
    let sum = 0, n = 0;
    for (let y = Math.max(0, Math.ceil(devY0)); y < Math.min(H, Math.floor(devY1)); y++) {
      const i = (y * W + px) * 4;
      sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      n++;
    }
    return n ? sum / n : 0;
  });
  return { column: { x: best.x, y: best.y, w: best.w, h: best.h }, devX, devY0, devY1, centre, left, right };
}

/** Spike tip zone: darkest / brightest pixel (WCAG relative luminance) plus an accent-rim hit. */
function probeSpike(args: { tile: number; tipInset: number; rim: Rgb | null; rimTol: number }): SpikeProbe {
  const clawd = (window as unknown as { __clawd?: DebugHandle }).__clawd;
  const run = clawd?.run;
  if (!clawd || !run) return { error: 'window.__clawd.run is not set (shot harness did not start a level)' };
  const st = clawd.renderer.stage;
  const canvas = document.querySelector<HTMLCanvasElement>('canvas#world');
  const ctx = canvas?.getContext('2d');
  if (!canvas || !ctx) return { error: 'canvas#world has no 2d context' };
  const s = st.scale * st.zoom;
  const L = run.sim.level, T = args.tile;
  const tx0 = Math.max(0, Math.floor((st.camX - st.w / (2 * s)) / T)), tx1 = Math.min(L.w - 1, Math.ceil((st.camX + st.w / (2 * s)) / T));
  const ty0 = Math.max(0, Math.floor((st.camY - st.h / (2 * s)) / T)), ty1 = Math.min(L.h - 1, Math.ceil((st.camY + st.h / (2 * s)) / T));
  let tile: [number, number] | null = null;
  let bestD = Infinity;
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      if (L.at(tx, ty) !== '^') continue;
      const dx = (tx * T + T / 2 - st.camX) * s + st.w / 2;
      const dy = (ty * T + T / 2 - st.camY) * s + st.h / 2;
      if (dx < st.w * 0.15 || dx > st.w * 0.85 || dy < st.h * 0.1 || dy > st.h * 0.9) continue;
      const d = Math.hypot(dx - st.w / 2, dy - st.h / 2);
      if (d < bestD) { bestD = d; tile = [tx, ty]; }
    }
  }
  if (!tile) return { error: "no '^' spike tile inside the view" };
  const cx = tile[0] * T + T / 2, tipY = tile[1] * T + args.tipInset;
  const x0 = (cx - 1.5 - st.camX) * s + st.w / 2, x1 = (cx + 1.5 - st.camX) * s + st.w / 2;
  const y0 = (tipY - st.camY) * s + st.h / 2, y1 = (tipY + 5 - st.camY) * s + st.h / 2;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data, W = canvas.width;
  let minL = Infinity, maxL = -Infinity;
  let minRgb: Rgb = { r: 0, g: 0, b: 0 }, maxRgb: Rgb = { r: 0, g: 0, b: 0 };
  for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) {
      const i = (y * W + x) * 4;
      // WCAG relative luminance of the sRGB pixel
      const [lr, lg, lb] = [d[i], d[i + 1], d[i + 2]].map((c) => {
        const v = c / 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      });
      const l = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
      if (l < minL) { minL = l; minRgb = { r: d[i], g: d[i + 1], b: d[i + 2] }; }
      if (l > maxL) { maxL = l; maxRgb = { r: d[i], g: d[i + 1], b: d[i + 2] }; }
    }
  }
  // rim: any pixel in the upper 60 % of the tile close to the accent
  let rimHit: Rgb | null = null;
  if (args.rim) {
    const rx0 = (tile[0] * T - st.camX) * s + st.w / 2, rx1 = (tile[0] * T + T - st.camX) * s + st.w / 2;
    const ry0 = (tile[1] * T - st.camY) * s + st.h / 2, ry1 = (tile[1] * T + T * 0.6 - st.camY) * s + st.h / 2;
    let bestDist = Infinity;
    for (let y = Math.floor(ry0); y <= Math.ceil(ry1); y++) {
      for (let x = Math.floor(rx0); x <= Math.ceil(rx1); x++) {
        const i = (y * W + x) * 4;
        const dist = Math.hypot(d[i] - args.rim.r, d[i + 1] - args.rim.g, d[i + 2] - args.rim.b);
        if (dist <= args.rimTol && dist < bestDist) { bestDist = dist; rimHit = { r: d[i], g: d[i + 1], b: d[i + 2] }; }
      }
    }
  }
  return { tile, window: [x0, y0, x1, y1], minL, maxL, minRgb, maxRgb, rimHit };
}

/** Goal beacon: goalScreen off screen and an accent-coloured pixel in the canvas edge band. */
function probeBeacon(args: { accent: Rgb; tol: number; bandPx: number }): BeaconProbe {
  const clawd = (window as unknown as { __clawd?: DebugHandle }).__clawd;
  if (!clawd?.run) return { error: 'window.__clawd.run is not set (shot harness did not start a level)' };
  const canvas = document.querySelector<HTMLCanvasElement>('canvas#world');
  const ctx = canvas?.getContext('2d');
  if (!canvas || !ctx) return { error: 'canvas#world has no 2d context' };
  const rect = canvas.getBoundingClientRect();
  const dpr = rect.width > 0 ? canvas.width / rect.width : 1;
  const band = Math.round(args.bandPx * dpr);
  const W = canvas.width, H = canvas.height;
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  let hit: { x: number; y: number; rgb: Rgb } | null = null;
  let scanned = 0;
  outer:
  for (let y = 0; y < H; y++) {
    const edgeRow = y < band || y >= H - band;
    for (let x = 0; x < W; x++) {
      if (!edgeRow && x >= band && x < W - band) { x = W - band - 1; continue; }
      scanned++;
      const i = (y * W + x) * 4;
      if (Math.hypot(d[i] - args.accent.r, d[i + 1] - args.accent.g, d[i + 2] - args.accent.b) <= args.tol) {
        hit = { x, y, rgb: { r: d[i], g: d[i + 1], b: d[i + 2] } };
        break outer;
      }
    }
  }
  return { goalScreen: clawd.renderer.goalScreen, canvas: [W, H], css: [rect.width, rect.height], hit, scanned };
}

/**
 * Backdrop band (P5-3): repaint the sky alone into the world canvas, then take
 * the mean luma of every pixel column over the playfield band — from the
 * highest crust surface ('#' with an open tile above) in view to the bottom
 * of the rendered box — and report the brightest column.
 */
function probeBackdrop(args: { tile: number }): BackdropProbe {
  const clawd = (window as unknown as { __clawd?: DebugHandle }).__clawd;
  const run = clawd?.run;
  if (!clawd || !run) return { error: 'window.__clawd.run is not set (shot harness did not start a level)' };
  const r = clawd.renderer;
  const st = r.stage;
  if (!r.sky || typeof r.sky.draw !== 'function') return { error: 'renderer.sky.draw is not exposed' };
  const canvas = document.querySelector<HTMLCanvasElement>('canvas#world');
  const ctx = canvas?.getContext('2d');
  if (!canvas || !ctx) return { error: 'canvas#world has no 2d context' };
  const s = st.scale * st.zoom;
  const L = run.sim.level, T = args.tile;
  const tx0 = Math.max(0, Math.floor((st.camX - st.w / (2 * s)) / T)), tx1 = Math.min(L.w - 1, Math.ceil((st.camX + st.w / (2 * s)) / T));
  const ty0 = Math.max(0, Math.floor((st.camY - st.h / (2 * s)) / T)), ty1 = Math.min(L.h - 1, Math.ceil((st.camY + st.h / (2 * s)) / T));
  let surfaceRow = -1;
  for (let ty = ty0; ty <= ty1 && surfaceRow < 0; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      if (L.at(tx, ty) === '#' && L.at(tx, ty - 1) !== '#') { surfaceRow = ty; break; }
    }
  }
  if (surfaceRow < 0) return { error: 'no crust surface tile inside the view' };
  // the backdrop alone: everything Sky.draw paints sits behind the world transform
  r.sky.draw(st.camX, st.camY);
  const yTop = (surfaceRow * T - st.camY) * s + st.h / 2;
  const y0 = Math.max(st.oy, Math.floor(yTop)), y1 = Math.min(st.oy + st.rh, canvas.height);
  if (y1 - y0 < 4) return { error: `playfield band too thin (${y0}..${y1})` };
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data, W = canvas.width;
  let maxMean = -Infinity, maxX = -1, total = 0, columns = 0;
  for (let x = Math.max(0, st.ox); x < Math.min(W, st.ox + st.rw); x++) {
    let sum = 0;
    for (let y = y0; y < y1; y++) {
      const i = (y * W + x) * 4;
      sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    }
    const mean = sum / (y1 - y0);
    total += mean;
    columns++;
    if (mean > maxMean) { maxMean = mean; maxX = x; }
  }
  return { band: [y0, y1], surfaceRow, columns, maxMean, maxX, meanOfMeans: columns ? total / columns : 0 };
}

// ---------------------------------------------------------------- node side
function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function sameOrigin(url: string): boolean {
  try {
    return new URL(url).origin === new URL(BASE_URL).origin;
  } catch {
    return false;
  }
}

function fmt(n: number, digits = 1): string {
  return Number.isFinite(n) ? n.toFixed(digits) : String(n);
}

function rgb(c: Rgb): string {
  return `(${c.r},${c.g},${c.b})`;
}

function table(rows: Row[]): string {
  const head = ['step', 'result', 'ms', 'note'];
  const cells = rows.map((r) => [r.step, r.ok ? 'PASS' : 'FAIL', String(r.ms), r.note]);
  const widths = head.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const line = (c: string[]) => c.map((v, i) => (i === 2 ? v.padStart(widths[i]) : v.padEnd(widths[i]))).join('  ').trimEnd();
  return [line(head), widths.map((w) => '-'.repeat(w)).join('  '), ...cells.map(line)].join('\n');
}

/** Open a `?shot=` capture and wait for the harness stamp; a stamped error fails the step. */
async function openShot(page: Page, query: string): Promise<Record<string, unknown>> {
  await page.goto(`${BASE_URL}/?${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.documentElement.dataset.shot !== undefined);
  const raw = await page.evaluate(() => document.documentElement.dataset.shot ?? '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`harness stamp is not JSON: ${raw.slice(0, 80)}`);
  }
  const o = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
  if (typeof o.error === 'string') throw new Error(`harness reported: ${o.error.split('\n')[0]}`);
  return o;
}

function biomeOf(shot: Record<string, unknown>) {
  const biomeId = String(shot.biome ?? 'voidreef') as keyof typeof BIOMES;
  return BIOMES[biomeId] ?? BIOMES.voidreef;
}

// ---------------------------------------------------------------- step bodies (shared by the base and the tier-4 steps)
async function updraftStep(page: Page, query: string, shotName: string): Promise<string> {
  await openShot(page, query);
  const r = await page.evaluate(probeUpdraft, { tile: TILE, bgTiles: UPDRAFT_BG_OFFSET_TILES });
  await page.screenshot({ path: join(OUT_DIR, `readability-${shotName}.png`) });
  if ('error' in r) throw new Error(r.error);
  const bg = Math.max(r.left, r.right);
  const gain = r.centre - bg;
  check(gain >= UPDRAFT_MIN_LUMA_GAIN,
    `updraft column centre luma ${fmt(r.centre)} is only ${fmt(gain)} above the background (left ${fmt(r.left)}, right ${fmt(r.right)}); need >= ${UPDRAFT_MIN_LUMA_GAIN}`);
  return `column @(${Math.round(r.column.x)},${Math.round(r.column.y)}) h=${r.column.h}: centre ${fmt(r.centre)} vs bg ${fmt(r.left)}/${fmt(r.right)} (+${fmt(gain)})`;
}

async function spikeStep(page: Page, query: string, shotName: string): Promise<string> {
  const shot = await openShot(page, query);
  const biome = biomeOf(shot);
  const rim = SPIKE_RIM_BIOMES.has(biome.id) ? hexToRgb(biome.accent) : null;
  const r = await page.evaluate(probeSpike, { tile: TILE, tipInset: SPIKE_TIP_INSET, rim, rimTol: RIM_TOLERANCE });
  await page.screenshot({ path: join(OUT_DIR, `readability-${shotName}.png`) });
  if ('error' in r) throw new Error(r.error);
  const crustL = relLuminance(biome.crust);
  const ratio = contrastRatio(r.minL, crustL);
  check(ratio >= SPIKE_MIN_CONTRAST,
    `spike tip zone darkest pixel ${rgb(r.minRgb)} contrasts only ${fmt(ratio, 2)}:1 with crust ${biome.crust}; need >= ${SPIKE_MIN_CONTRAST}:1`);
  check(r.maxL >= SPIKE_MIN_HIGHLIGHT_L,
    `spike tip zone has no highlight: brightest pixel ${rgb(r.maxRgb)} L=${fmt(r.maxL, 2)} < ${SPIKE_MIN_HIGHLIGHT_L}`);
  if (rim) check(r.rimHit !== null, `no accent rim pixel (accent ${biome.accent} ±${RIM_TOLERANCE}) in the upper part of spike tile ${r.tile.join(',')}`);
  return `${biome.id} tile ${r.tile.join(',')}: dark ${rgb(r.minRgb)} ${fmt(ratio, 2)}:1 vs crust, highlight L=${fmt(r.maxL, 2)}${r.rimHit ? `, rim ${rgb(r.rimHit)}` : ''}`;
}

async function beaconStep(page: Page, query: string, shotName: string): Promise<string> {
  const shot = await openShot(page, query);
  const biome = biomeOf(shot);
  const r = await page.evaluate(probeBeacon, { accent: hexToRgb(biome.accent), tol: ACCENT_TOLERANCE, bandPx: BEACON_EDGE_BAND_PX });
  await page.screenshot({ path: join(OUT_DIR, `readability-${shotName}.png`) });
  if ('error' in r) throw new Error(r.error);
  check(r.goalScreen !== null, 'renderer.goalScreen is null after a level draw');
  const gs = r.goalScreen!;
  check(!gs.onScreen, `goalScreen reports the goal on screen at (${fmt(gs.x)},${fmt(gs.y)}) although it lies far right of the view`);
  check(gs.x > r.css[0], `goalScreen.x ${fmt(gs.x)} should exceed the canvas width ${r.css[0]} for a goal to the right`);
  check(r.hit !== null, `no beacon pixel in accent ${biome.accent} (±${ACCENT_TOLERANCE}) within ${BEACON_EDGE_BAND_PX} px of the canvas edge (${r.scanned} px scanned)`);
  return `${biome.id} goal at css (${Math.round(gs.x)},${Math.round(gs.y)}) off screen; beacon pixel ${rgb(r.hit!.rgb)} @(${r.hit!.x},${r.hit!.y}) of ${r.canvas.join('x')}`;
}

async function backdropStep(page: Page, zone: string): Promise<string> {
  const shot = await openShot(page, `shot=${zone}&frames=60`);
  const biome = biomeOf(shot);
  const r = await page.evaluate(probeBackdrop, { tile: TILE });
  // the screenshot shows the backdrop alone: the sky pass repainted over the finished frame
  await page.screenshot({ path: join(OUT_DIR, `readability-backdrop-${zone}.png`) });
  if ('error' in r) throw new Error(r.error);
  const crust = lumaHex(biome.crust);
  check(r.maxMean <= crust,
    `backdrop column x=${r.maxX} has mean luma ${fmt(r.maxMean)} over the playfield band y ${r.band[0]}..${r.band[1]}, brighter than the ${biome.id} crust ${biome.crust} (luma ${fmt(crust)})`);
  return `${biome.id} band y ${r.band[0]}..${r.band[1]} (surface row ${r.surfaceRow}, ${r.columns} cols): brightest column ${fmt(r.maxMean)} @x${r.maxX}, mean ${fmt(r.meanOfMeans)}, crust ${fmt(crust)}`;
}

async function run(browser: Browser): Promise<number> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    locale: 'ko-KR',
  });
  const page = await context.newPage();
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

  // v2: park Clawd on the start yard's edge (tile 15.5, feet on row 24) so the first
  // updraft column (tile 17, rows 13..25) stands in view with nobody inside it.
  await step('updraft', () => updraftStep(page, UPDRAFT_SHOT, 'updraft'));
  // v1: the first spike bed (tiles 13..22, row 19) is in view from the start.
  await step('spike', () => spikeStep(page, SPIKE_SHOT, 'spike'));
  // v2 from the start: the goal is ~1200 units to the right, far off screen.
  await step('beacon', () => beaconStep(page, BEACON_SHOT, 'beacon'));

  // P5-3: the backdrop never outshines the ledges in the playfield band.
  for (const zone of BACKDROP_ZONES) await step(`backdrop:${zone}`, () => backdropStep(page, zone));

  // Tier 4 (summit) — the same three probes on the SUMMIT_* shots (provisional targets, see the header).
  const provisional = SUMMIT_SPIKE_SHOT === SPIKE_SHOT ? ' [provisional target]' : '';
  await step('tier4-updraft', async () => (await updraftStep(page, SUMMIT_UPDRAFT_SHOT, 'tier4-updraft')) + provisional);
  await step('tier4-spike', async () => (await spikeStep(page, SUMMIT_SPIKE_SHOT, 'tier4-spike')) + provisional);
  await step('tier4-beacon', async () => (await beaconStep(page, SUMMIT_BEACON_SHOT, 'tier4-beacon')) + provisional);

  await context.close();

  const failed = rows.filter((r) => !r.ok).length;
  const out: string[] = [];
  out.push(`readability ${BASE_URL}`, '', table(rows), '');
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
    process.stderr.write(`readability QA crashed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  },
);
