/**
 * The render target and post-processing chain, plus the small drawing helpers
 * every render module shares (colour strings, noise, easing).
 *
 * Two canvases are drawn every frame:
 *   • main  — opaque world, full resolution
 *   • glow  — emissive-only, quarter resolution, blurred and added back
 *
 * Keeping emission on its own low-res buffer is what makes real bloom
 * affordable in Canvas2D: the blur runs over 1/16th of the pixels, and the
 * bilinear upscale does the wide-radius spreading for free.
 *
 * Scaling strategy is "expand": the design box (VIEW_W x VIEW_H) is always
 * fully visible, and extra viewport aspect reveals *more* world rather than
 * cropping or letterboxing — up to MAX_EXPAND, past which bars appear.
 *
 * The stage never touches `window` or `document` directly except through the
 * injectable `createCanvas` / `viewport` hooks, so it runs under a stub DOM.
 */
import type { FxState } from '../contracts.js';

export const VIEW_W = 512;
export const VIEW_H = 288;
export const UI_FONT = 'Outfit, "Noto Sans KR", system-ui, sans-serif';

/**
 * How much extra world an unusual viewport aspect may reveal before the frame is
 * letterboxed instead. Unbounded expansion gives away most of a level's width
 * on an ultra-wide window and shows empty void above a short level on a phone.
 */
const MAX_EXPAND_W = 1.6;
const MAX_EXPAND_H = 1.35;

export type QualityTier = 'high' | 'balanced' | 'low';

export interface StageSettings {
  bloom: boolean;
  grain: boolean;
  /** Photosensitivity: full-screen flashes are capped when false. */
  flashes: boolean;
  quality: 'auto' | QualityTier;
}

export interface Viewport { w: number; h: number; dpr: number }

export interface StageOptions {
  /** Offscreen buffer factory; defaults to `document.createElement('canvas')`. */
  createCanvas?: () => HTMLCanvasElement;
  /** Viewport probe; defaults to window inner size and devicePixelRatio. */
  viewport?: () => Viewport;
  /** Where the settled auto tier is remembered (AUTOTIER_KEY); defaults to localStorage, `null` = nowhere. */
  storage?: TierStorage | null;
}

/** The subset of the Storage interface the adaptive scaler uses. */
export interface TierStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type CompositeFx = Partial<FxState> & { fadeColor?: string };

// ============================================================ adaptive quality v2 (P3-13)
/** localStorage key of the tier the auto scaler settled on; the next session starts there. */
export const AUTOTIER_KEY = 'clawd-echo.autotier.v1';
/** Seconds of frames per decision window. */
export const FRAME_WINDOW_S = 2;
/** Frame-time histogram: 32 buckets of 1 ms, the last one open-ended (31 ms and slower). */
export const HIST_BUCKETS = 32;
/** Step down when the window's p95 frame interval exceeds this many display periods (24 ms at 60 Hz). */
export const STEP_DOWN_RATIO = 1.44;
/** A window counts as smooth (no dropped frames) when its p95 interval stays inside this many periods. */
export const SMOOTH_RATIO = 1.1;
/** A step up also needs the p95 render cost under this fraction of the period (13 ms at 60 Hz) — when the cost is measured. */
export const STEP_UP_RATIO = 0.78;
/** Seconds of consecutive smooth windows before the single step up of a session. */
export const STEP_UP_AFTER_S = 60;
/** Seconds after a step down during which no step up is considered. */
export const STEP_DOWN_LOCK_S = 60;
/**
 * Fewer samples than this in a window decide nothing. Deliberately tiny: the
 * shell clamps a frame's dt to 0.25 s, so a hidden-tab gap is one sample that
 * cannot move a p95 — while a device crawling at 2 fps must still be judged,
 * and at 2 fps a 2 s window holds exactly four frames.
 */
export const MIN_WINDOW_SAMPLES = 4;
/**
 * Menu backdrops are throttled to 30 fps by the shell, so their intervals say
 * nothing — but their render cost does: a backdrop that alone costs more than
 * this many display periods at p95 cannot carry the (heavier) world at this
 * tier, and the scaler steps down before play starts. Every device used to get
 * this probe by accident (the throttled intervals read as 30 fps); it is now
 * deliberate and cost-based, so a fast device is never punished for the throttle.
 */
export const MENU_COST_RATIO = 1.0;
/** The shell redraws menu backdrops at most this often (Scenes.MENU_FRAME_DT = 1/30 s). */
export const MENU_FRAME_MS = 1000 / 30;
/**
 * The second menu signal: Canvas2D rasterises off the main thread, so a
 * raster-bound device can report a cheap JS draw while its frames crawl. The
 * draw interval cannot hide that — a window whose p95 interval exceeds this
 * many throttle periods (48 ms) cannot even hold the 30 fps backdrop.
 */
export const MENU_SLOW_RATIO = 1.44;
/** Bucket width (ms) of the menu-interval histogram: 0..124 ms, last bucket open. */
export const MENU_BUCKET_MS = 4;
/** Fewer menu frames than this in a window decide nothing (see MIN_WINDOW_SAMPLES for why it is tiny). */
export const MIN_MENU_SAMPLES = 4;
/** Display refresh rates the median rAF interval is snapped to; anything slower reads as a 60 Hz display dropping frames. */
export const REFRESH_RATES: readonly number[] = [60, 72, 75, 90, 120, 144, 165, 240];
const TIERS: readonly QualityTier[] = ['high', 'balanced', 'low'];

/**
 * Fixed-width frame-time histogram (1 ms buckets). Percentiles come back as
 * the upper edge of the bucket that crosses the rank — a conservative read
 * that never under-reports a slow frame — and `meanAt` is exact, which is
 * what the refresh-rate estimate needs (8.33 ms and 6.94 ms share a bucket
 * edge at 1 ms resolution, but their means are far apart).
 */
export class FrameHistogram {
  readonly counts = new Uint32Array(HIST_BUCKETS);
  readonly sums = new Float64Array(HIST_BUCKETS);
  n = 0;

  /** `msPerBucket` widens the grid (4 → 0..124 ms, last bucket open) for slow, throttled menu frames. */
  constructor(readonly msPerBucket = 1) {}

  add(ms: number): void {
    if (!(ms >= 0)) return;
    const b = Math.min(HIST_BUCKETS - 1, Math.floor(ms / this.msPerBucket));
    this.counts[b]++;
    this.sums[b] += ms;
    this.n++;
  }

  reset(): void {
    this.counts.fill(0);
    this.sums.fill(0);
    this.n = 0;
  }

  /** Index of the bucket holding the p-th percentile (0..100), or -1 when empty. */
  bucketOf(p: number): number {
    if (this.n === 0) return -1;
    const rank = Math.max(1, Math.ceil((clamp(p, 0, 100) / 100) * this.n));
    let acc = 0;
    for (let b = 0; b < HIST_BUCKETS; b++) {
      acc += this.counts[b];
      if (acc >= rank) return b;
    }
    return HIST_BUCKETS - 1;
  }

  /** Upper edge (ms) of the bucket holding the p-th percentile; 0 when empty. */
  percentile(p: number): number {
    const b = this.bucketOf(p);
    return b < 0 ? 0 : (b + 1) * this.msPerBucket;
  }

  /** Exact mean of the samples in the bucket holding the p-th percentile; 0 when empty. */
  meanAt(p: number): number {
    const b = this.bucketOf(p);
    return b < 0 || this.counts[b] === 0 ? 0 : this.sums[b] / this.counts[b];
  }
}

/**
 * The display refresh rate a median rAF interval implies, snapped to a known
 * rate — or null when the interval is not within 12% of any of them, which
 * means the loop is not vsync-locked and says nothing about the display.
 */
export function snapRefreshRate(medianMs: number): number | null {
  if (!(medianMs > 0)) return null;
  const hz = 1000 / medianMs;
  let best = REFRESH_RATES[0], err = Infinity;
  for (const r of REFRESH_RATES) {
    const e = Math.abs(r - hz);
    if (e < err) { err = e; best = r; }
  }
  return err <= best * 0.12 ? best : null;
}

/** The tier stored by a previous session, when the document is one of ours. */
export function readStoredTier(storage: TierStorage | null): QualityTier | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(AUTOTIER_KEY);
    if (!raw) return null;
    const doc = JSON.parse(raw) as { v?: unknown; tier?: unknown } | null;
    if (!doc || doc.v !== 1 || typeof doc.tier !== 'string') return null;
    return (TIERS as readonly string[]).includes(doc.tier) ? doc.tier as QualityTier : null;
  } catch {
    return null;
  }
}

function defaultTierStorage(): TierStorage | null {
  try {
    const ls = (globalThis as { localStorage?: TierStorage }).localStorage;
    return ls ?? null;
  } catch {
    return null;
  }
}

/** Frame statistics of the last completed window plus the tier — the ?fps=1 overlay and the shot stamp. */
export interface FpsStats {
  /** Upper-edge ms of the p50 / p95 frame interval of the last window (0 before the first). */
  p50: number;
  p95: number;
  /** p95 of the measured render cost (ms), 0 when nothing was measured. */
  workP95: number;
  /** Estimated display refresh rate. */
  hz: number;
  tier: QualityTier;
}

// ============================================================ helpers
export const TAU = Math.PI * 2;

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const sign = (v: number): number => (v > 0 ? 1 : v < 0 ? -1 : 0);
/** Frame-rate independent exponential smoothing; `half` is the half-life in seconds. */
export const damp = (a: number, b: number, half: number, dt: number): number => b + (a - b) * Math.pow(2, -dt / half);
/** 0→1→0 hump for one-shot pulses. */
export const hump = (t: number): number => Math.sin(clamp01(t) * Math.PI);
export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

/** Cheap tileable value noise — rock texture, ridge silhouettes, wind fields. */
export function noise2(x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const h = (a: number, b: number): number => {
    let n = Math.imul(a, 374761393) + Math.imul(b, 668265263);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  return lerp(lerp(h(xi, yi), h(xi + 1, yi), u), lerp(h(xi, yi + 1), h(xi + 1, yi + 1), u), v);
}

export function fbm(x: number, y: number, oct = 3): number {
  let sum = 0, amp = 0.5, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += noise2(x, y) * amp;
    norm += amp;
    amp *= 0.5; x *= 2.03; y *= 2.01;
  }
  return sum / norm;
}

/** 32-bit FNV-1a — deterministic per-tile variation that never shimmers. */
export function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** `rgba()` from a hex string with alpha — cached because canvas style strings are hot. */
const rgbaCache = new Map<string, string>();
export function alpha(hex: string, a: number): string {
  a = Math.round(clamp01(a) * 1000) / 1000;
  const key = hex + a;
  let v = rgbaCache.get(key);
  if (v) return v;
  const n = parseInt(hex.slice(1), 16);
  v = `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  if (rgbaCache.size < 4096) rgbaCache.set(key, v);
  return v;
}

export function mixHex(a: string, b: string, t: number): string {
  const x = parseInt(a.slice(1), 16), y = parseInt(b.slice(1), 16);
  const r = Math.round(lerp((x >> 16) & 255, (y >> 16) & 255, t));
  const g = Math.round(lerp((x >> 8) & 255, (y >> 8) & 255, t));
  const c = Math.round(lerp(x & 255, y & 255, t));
  return '#' + ((r << 16) | (g << 8) | c).toString(16).padStart(6, '0');
}

/** Rec. 709 luma of a hex colour, 0..255 — what the readability probes compare backdrop columns with. */
export function lumaHex(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x relative luminance (0..1) of a hex colour. */
export function relLuminance(hex: string): number {
  const lin = (v: number): number => { const u = v / 255; return u <= 0.03928 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4); };
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2.x contrast ratio between two relative luminances (>= 1). */
export function contrastRatio(l1: number, l2: number): number {
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** Euclidean RGB distance between two hex colours (the accent-pixel tolerance of the QA probes is in these units). */
export function rgbDistance(a: string, b: string): number {
  const x = hexToRgb(a), y = hexToRgb(b);
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

export function defaultCreateCanvas(): HTMLCanvasElement {
  if (typeof document === 'undefined') throw new Error('render: no document to create a canvas');
  return document.createElement('canvas');
}

export function defaultViewport(): Viewport {
  const g = globalThis as unknown as { innerWidth?: number; innerHeight?: number; devicePixelRatio?: number };
  return { w: g.innerWidth || 960, h: g.innerHeight || 540, dpr: g.devicePixelRatio || 1 };
}

function ctx2d(cv: HTMLCanvasElement, opts?: CanvasRenderingContext2DSettings): CanvasRenderingContext2D {
  const c = cv.getContext('2d', opts) as CanvasRenderingContext2D | null;
  if (!c) throw new Error('render: 2D canvas context unavailable');
  return c;
}

// ============================================================ stage
export class Stage {
  readonly cv: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  /** Quarter-resolution emissive buffer. */
  readonly gcv: HTMLCanvasElement;
  readonly gctx: CanvasRenderingContext2D;
  /** Ping-pong buffer for the blur, at glow resolution. */
  readonly bcv: HTMLCanvasElement;
  readonly bctx: CanvasRenderingContext2D;
  private readonly grainCv: HTMLCanvasElement;
  private readonly viewport: () => Viewport;

  /** Device-pixel canvas size. */
  w = 0; h = 0;
  dpr = 1;
  /** World units → device pixels. */
  scale = 1;
  /** Visible design box in world units after expansion. */
  viewW = VIEW_W; viewH = VIEW_H;
  /** Rendered box in device pixels and its offset (letterbox bars outside). */
  rw = 0; rh = 0; ox = 0; oy = 0;
  glowDiv = 4;
  readonly supportsFilter: boolean;
  quality: QualityTier = 'high';
  settings: StageSettings = { bloom: true, grain: true, flashes: true, quality: 'auto' };
  /** Smoothed frames per second. */
  fps = 60;
  /** Estimated display refresh rate (Hz): the median rAF interval snapped to a known rate, never lowered within a session. */
  hz = 60;
  /** Auto tier changes this session (the overlay and the tests). */
  autoChanges = 0;

  // camera state of the current world transform
  camX = 0; camY = 0; zoom = 1;
  wLeft = 0; wRight = VIEW_W; wTop = 0; wBottom = VIEW_H;

  private readonly hist = new FrameHistogram();
  private readonly workHist = new FrameHistogram();
  private windowT = 0;
  /** Render cost and draw interval of menu backdrop frames (see noteFrame). */
  private readonly menuHist = new FrameHistogram();
  private readonly menuIntHist = new FrameHistogram(MENU_BUCKET_MS);
  private menuT = 0;
  private lastP50 = 0; private lastP95 = 0; private lastWorkP95 = 0;
  /** Consecutive seconds of smooth windows; the single step up of the session fires at STEP_UP_AFTER_S. */
  private smoothS = 0;
  private steppedUp = false;
  /** Seconds left of the post-step-down lock. */
  private lockT = 0;
  private readonly tierStorage: TierStorage | null;
  private vg: CanvasGradient | null = null;
  private grainPat: CanvasPattern | null = null;

  constructor(cv: HTMLCanvasElement, opts: StageOptions = {}) {
    const create = opts.createCanvas ?? defaultCreateCanvas;
    this.viewport = opts.viewport ?? defaultViewport;
    this.tierStorage = opts.storage === undefined ? defaultTierStorage() : opts.storage;
    // Start where the last session's auto scaler settled: the first frame already runs at that tier.
    const stored = readStoredTier(this.tierStorage);
    if (stored) this.quality = stored;
    this.cv = cv;
    this.ctx = ctx2d(cv, { alpha: false, desynchronized: true });
    this.gcv = create(); this.gctx = ctx2d(this.gcv);
    this.bcv = create(); this.bctx = ctx2d(this.bcv);
    this.grainCv = create();
    this.supportsFilter = typeof (this.ctx as { filter?: unknown }).filter === 'string';
    this.buildGrain();
    this.resize();
  }

  private buildGrain(): void {
    const S = 128;
    this.grainCv.width = S; this.grainCv.height = S;
    const g = ctx2d(this.grainCv);
    const img = g.createImageData(S, S);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 118 + Math.random() * 44;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }

  private qualityScale(): number {
    const q = this.quality;
    return q === 'low' ? 0.66 : q === 'balanced' ? 0.85 : 1;
  }

  resize(): void {
    const vp = this.viewport();
    const cw = Math.max(320, vp.w);
    const ch = Math.max(240, vp.h);
    const maxDpr = this.quality === 'low' ? 1 : this.quality === 'balanced' ? 1.5 : 2;
    const dpr = clamp(vp.dpr || 1, 1, maxDpr) * this.qualityScale();

    this.w = Math.round(cw * dpr);
    this.h = Math.round(ch * dpr);
    this.dpr = dpr;
    if (this.cv.width !== this.w) this.cv.width = this.w;
    if (this.cv.height !== this.h) this.cv.height = this.h;

    // The design box always fits; anything past the expansion cap becomes a
    // letterbox bar rather than exposed void.
    this.scale = Math.min(this.w / VIEW_W, this.h / VIEW_H);
    this.viewW = Math.min(this.w / this.scale, VIEW_W * MAX_EXPAND_W);
    this.viewH = Math.min(this.h / this.scale, VIEW_H * MAX_EXPAND_H);
    this.rw = Math.round(this.viewW * this.scale);
    this.rh = Math.round(this.viewH * this.scale);
    this.ox = Math.round((this.w - this.rw) / 2);
    this.oy = Math.round((this.h - this.rh) / 2);

    this.glowDiv = this.quality === 'low' ? 6 : 4;
    this.gcv.width = Math.max(1, Math.round(this.w / this.glowDiv));
    this.gcv.height = Math.max(1, Math.round(this.h / this.glowDiv));
    this.bcv.width = this.gcv.width;
    this.bcv.height = this.gcv.height;
    this.vg = null;
    this.grainPat = null;

    this.ctx.imageSmoothingEnabled = true;
    this.gctx.imageSmoothingEnabled = true;
    this.bctx.imageSmoothingEnabled = true;
  }

  setSettings(s: StageSettings): void {
    this.settings = { ...s };
    if (s.quality !== 'auto') this.setQuality(s.quality);
  }

  setQuality(q: QualityTier): void {
    if (q === this.quality) return;
    this.quality = q;
    this.resize();
  }

  /** Frame statistics of the last completed window (the ?fps=1 overlay and the shot stamp). */
  fpsStats(): FpsStats {
    return { p50: this.lastP50, p95: this.lastP95, workP95: this.lastWorkP95, hz: this.hz, tier: this.quality };
  }

  /**
   * A menu backdrop frame (title vista) — the pre-play capability probe. The
   * shell throttles these to 30 fps, so the interval is judged against that
   * cadence (p95 > MENU_SLOW_RATIO × MENU_FRAME_MS = the device cannot hold
   * even the backdrop) and `workMs`, the measured render cost of the previous
   * backdrop frame, against the display period (p95 > MENU_COST_RATIO
   * periods). Either steps the tier down (and locks step-ups) before the world
   * is ever drawn at it; menu frames never step up.
   */
  noteFrame(dt: number, workMs?: number): void {
    this.smoothFps(dt);
    if (this.settings.quality !== 'auto') { this.resetMenu(); return; }
    if (!(dt > 0) || dt > 0.5) return;
    this.menuIntHist.add(dt * 1000);
    if (typeof workMs === 'number' && workMs >= 0) this.menuHist.add(workMs);
    this.menuT += dt;
    if (this.lockT > 0) this.lockT = Math.max(0, this.lockT - dt);
    if (this.menuT < FRAME_WINDOW_S) return;
    const n = this.menuIntHist.n;
    const intP95 = this.menuIntHist.percentile(95);
    const costP95 = this.menuHist.n > 0 ? this.menuHist.percentile(95) : 0;
    this.resetMenu();
    if (n < MIN_MENU_SAMPLES) return;
    if (intP95 > MENU_SLOW_RATIO * MENU_FRAME_MS || costP95 > MENU_COST_RATIO * (1000 / this.hz)) {
      this.smoothS = 0;
      this.lockT = STEP_DOWN_LOCK_S;
      this.autoStep(-1);
    }
  }

  private resetMenu(): void {
    this.menuHist.reset();
    this.menuIntHist.reset();
    this.menuT = 0;
  }

  /** The smoothed frame rate (HUD / diagnostics only); shared by play and menu frames. */
  private smoothFps(dt: number): void {
    if (dt > 0) this.fps = damp(this.fps, 1 / dt, 0.4, dt);
  }

  /**
   * Adaptive quality v2. `dt` is this frame's rAF interval (seconds), `workMs`
   * the measured render cost when the caller has one. Intervals are binned
   * into a 1 ms histogram over FRAME_WINDOW_S; when a window closes:
   *   • the median interval, snapped to a known refresh rate, estimates the
   *     display Hz (a slower median reads as dropped frames, never as a slow
   *     display), so every threshold below is in display periods;
   *   • p95 interval > STEP_DOWN_RATIO periods → one tier down, and step-ups
   *     are locked for STEP_DOWN_LOCK_S;
   *   • STEP_UP_AFTER_S of consecutive smooth windows (p95 interval within
   *     SMOOTH_RATIO periods and, when measured, p95 render cost under
   *     STEP_UP_RATIO periods) → one tier up, once per session.
   * The tier a change lands on is written to AUTOTIER_KEY for the next boot.
   */
  sampleFps(dt: number, workMs?: number): void {
    this.smoothFps(dt);
    if (this.settings.quality !== 'auto') {
      this.setQuality(this.settings.quality);
      this.hist.reset(); this.workHist.reset(); this.windowT = 0; this.smoothS = 0;
      this.resetMenu();
      return;
    }
    // Back from a menu: its probe window is stale.
    if (this.menuT > 0) this.resetMenu();
    // A hidden tab hands the whole absence to one frame: that is not a sample.
    if (!(dt > 0) || dt > 0.5) return;
    this.hist.add(dt * 1000);
    if (typeof workMs === 'number' && workMs >= 0) this.workHist.add(workMs);
    this.windowT += dt;
    if (this.lockT > 0) this.lockT = Math.max(0, this.lockT - dt);
    if (this.windowT < FRAME_WINDOW_S) return;
    this.closeWindow(this.windowT);
  }

  private closeWindow(seconds: number): void {
    const hist = this.hist, work = this.workHist;
    const n = hist.n;
    this.lastP50 = hist.percentile(50);
    this.lastP95 = hist.percentile(95);
    this.lastWorkP95 = work.n > 0 ? work.percentile(95) : 0;
    const medianMs = hist.meanAt(50);
    const hasWork = work.n > 0;
    hist.reset(); work.reset();
    this.windowT = 0;
    if (n < MIN_WINDOW_SAMPLES) return;

    const snapped = snapRefreshRate(medianMs);
    if (snapped !== null && snapped > this.hz) this.hz = snapped;
    const period = 1000 / this.hz;

    if (this.lastP95 > STEP_DOWN_RATIO * period) {
      this.smoothS = 0;
      this.lockT = STEP_DOWN_LOCK_S;
      this.autoStep(-1);
      return;
    }
    const smooth = this.lastP95 <= SMOOTH_RATIO * period + 1e-9 && (!hasWork || this.lastWorkP95 < STEP_UP_RATIO * period);
    if (!smooth || this.steppedUp || this.lockT > 0 || this.quality === 'high') { this.smoothS = 0; return; }
    this.smoothS += seconds;
    if (this.smoothS >= STEP_UP_AFTER_S) {
      this.smoothS = 0;
      this.steppedUp = true;
      this.autoStep(1);
    }
  }

  /** Move one tier (−1 = lower quality) and remember where the scaler now stands. */
  private autoStep(dir: -1 | 1): void {
    const i = TIERS.indexOf(this.quality);
    const next = TIERS[clamp(i - dir, 0, TIERS.length - 1)];
    if (next === this.quality) return;
    this.setQuality(next);
    this.autoChanges++;
    if (!this.tierStorage) return;
    try { this.tierStorage.setItem(AUTOTIER_KEY, JSON.stringify({ v: 1, tier: next })); } catch { /* private mode / quota */ }
  }

  /** Reset transforms and clear the glow buffer. The sky paints the opaque backdrop. */
  begin(): void {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.gctx.setTransform(1, 0, 0, 1, 0, 0);
    this.gctx.clearRect(0, 0, this.gcv.width, this.gcv.height);
  }

  /** Push the camera transform onto both buffers. Screen-space drawing happens outside this. */
  world(camX: number, camY: number, shakeX = 0, shakeY = 0, zoom = 1, rot = 0): void {
    const s = this.scale * zoom;
    const cx = this.w / 2, cy = this.h / 2;
    const targets: [CanvasRenderingContext2D, number][] = [[this.ctx, 1], [this.gctx, this.glowDiv]];
    for (const [g, div] of targets) {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.scale(1 / div, 1 / div);
      g.translate(cx + shakeX * this.scale, cy + shakeY * this.scale);
      if (rot) g.rotate(rot);
      g.scale(s, s);
      g.translate(-camX, -camY);
    }
    this.camX = camX; this.camY = camY; this.zoom = zoom;
    this.wLeft = camX - this.viewW / (2 * zoom);
    this.wRight = camX + this.viewW / (2 * zoom);
    this.wTop = camY - this.viewH / (2 * zoom);
    this.wBottom = camY + this.viewH / (2 * zoom);
  }

  /** Screen space in world units: origin top-left of the rendered box. */
  screen(): void {
    this.ctx.setTransform(1, 0, 0, 1, this.ox, this.oy);
    this.ctx.scale(this.scale, this.scale);
  }

  /** true if an AABB in world units could be visible (with margin). */
  visible(x: number, y: number, w: number, h: number, m = 24): boolean {
    return x + w > this.wLeft - m && x < this.wRight + m && y + h > this.wTop - m && y < this.wBottom + m;
  }

  /** Composite glow + film effects. Call last. */
  composite(fx: CompositeFx = {}): void {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    if (this.settings.bloom) {
      // Blur at glow resolution (1/16th the pixels), then let the bilinear
      // upscale widen the halo for free. Blurring during the upscale instead
      // would run the kernel over every output pixel — several times the cost.
      const gw = this.gcv.width, gh = this.gcv.height;
      const wide = this.quality !== 'low';
      let src: HTMLCanvasElement = this.gcv;
      if (this.supportsFilter) {
        this.bctx.setTransform(1, 0, 0, 1, 0, 0);
        this.bctx.clearRect(0, 0, gw, gh);
        this.bctx.filter = `blur(${this.quality === 'high' ? 2.2 : 1.6}px)`;
        this.bctx.drawImage(this.gcv, 0, 0);
        this.bctx.filter = 'none';
        src = this.bcv;
      }
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.85;
      ctx.drawImage(src, 0, 0, this.w, this.h);
      if (wide) {
        // second, wider tap: the same buffer scaled up past the frame
        const k = 1.06;
        ctx.globalAlpha = 0.4;
        ctx.drawImage(src, -this.w * (k - 1) / 2, -this.h * (k - 1) / 2, this.w * k, this.h * k);
      }
      ctx.restore();

      // chromatic fringe on impact — subtle, and only while `fx.aberr` is live
      const aberr = fx.aberr ?? 0;
      if (aberr > 0.01 && this.quality === 'high') {
        const o = aberr * 5 * this.dpr;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.13 * aberr;
        ctx.drawImage(src, -o, 0, this.w, this.h);
        ctx.drawImage(src, o, 0, this.w, this.h);
        ctx.restore();
      }
    }

    // vignette (cached: depends only on canvas size)
    if (!this.vg) {
      const vg = ctx.createRadialGradient(this.w / 2, this.h * 0.48, this.h * 0.3, this.w / 2, this.h * 0.5, this.h * 0.95);
      vg.addColorStop(0, 'rgba(0,0,0,0)');
      vg.addColorStop(0.6, 'rgba(2,1,6,0.16)');
      vg.addColorStop(1, 'rgba(2,1,6,0.62)');
      this.vg = vg;
    }
    ctx.fillStyle = this.vg;
    ctx.fillRect(0, 0, this.w, this.h);
    const vignette = fx.vignette ?? 0;
    if (vignette > 0.01) {
      ctx.save();
      ctx.globalAlpha = clamp01(vignette) * 0.5;
      ctx.fillStyle = this.vg;
      ctx.fillRect(0, 0, this.w, this.h);
      ctx.restore();
    }

    if (this.settings.grain && this.quality !== 'low') {
      this.grainPat ||= ctx.createPattern(this.grainCv, 'repeat');
      if (this.grainPat) {
        ctx.save();
        ctx.globalCompositeOperation = 'overlay';
        ctx.globalAlpha = 0.032;
        const s = 128;
        ctx.translate(-Math.random() * s, -Math.random() * s);
        ctx.fillStyle = this.grainPat;
        ctx.fillRect(0, 0, this.w + s, this.h + s);
        ctx.restore();
      }
    }

    const flash = fx.flash ?? 0;
    if (flash > 0.004) {
      ctx.save();
      ctx.globalAlpha = this.settings.flashes ? Math.min(1, flash) : Math.min(0.22, flash * 0.3);
      ctx.fillStyle = fx.flashColor || '#ffffff';
      ctx.fillRect(0, 0, this.w, this.h);
      ctx.restore();
    }
    const fade = fx.fade ?? 0;
    if (fade > 0.001) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, fade);
      ctx.fillStyle = fx.fadeColor || '#07060B';
      ctx.fillRect(0, 0, this.w, this.h);
      ctx.restore();
    }

    // Letterbox last, so it also trims the sky and film passes that paint the whole canvas.
    if (this.ox > 0 || this.oy > 0) {
      ctx.fillStyle = '#07060B';
      if (this.oy > 0) {
        ctx.fillRect(0, 0, this.w, this.oy);
        ctx.fillRect(0, this.oy + this.rh, this.w, this.h - this.oy - this.rh);
      }
      if (this.ox > 0) {
        ctx.fillRect(0, 0, this.ox, this.h);
        ctx.fillRect(this.ox + this.rw, 0, this.w - this.ox - this.rw, this.h);
      }
    }
  }
}
