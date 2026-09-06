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
}

export type CompositeFx = Partial<FxState> & { fadeColor?: string };

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

  // camera state of the current world transform
  camX = 0; camY = 0; zoom = 1;
  wLeft = 0; wRight = VIEW_W; wTop = 0; wBottom = VIEW_H;

  private fpsAcc = 0; private fpsN = 0; private autoTimer = 0;
  private vg: CanvasGradient | null = null;
  private grainPat: CanvasPattern | null = null;

  constructor(cv: HTMLCanvasElement, opts: StageOptions = {}) {
    const create = opts.createCanvas ?? defaultCreateCanvas;
    this.viewport = opts.viewport ?? defaultViewport;
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

  /** Adaptive quality: sustained low frame-rate steps the renderer down a notch. */
  sampleFps(dt: number): void {
    if (dt > 0) this.fps = damp(this.fps, 1 / dt, 0.4, dt);
    if (this.settings.quality !== 'auto') { this.setQuality(this.settings.quality); return; }
    this.fpsAcc += dt; this.fpsN++;
    this.autoTimer += dt;
    if (this.autoTimer < 2.5) return;
    const avg = this.fpsN / Math.max(1e-6, this.fpsAcc);
    this.fpsAcc = 0; this.fpsN = 0; this.autoTimer = 0;
    if (avg < 42 && this.quality === 'high') this.setQuality('balanced');
    else if (avg < 34 && this.quality === 'balanced') this.setQuality('low');
    else if (avg > 58 && this.quality === 'low') this.setQuality('balanced');
    else if (avg > 58 && this.quality === 'balanced') this.setQuality('high');
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
