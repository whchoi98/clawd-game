/**
 * Anonymous product telemetry — `class Telemetry`.
 *
 * Events (TelemetryName, protocol.ts) are buffered in memory and posted to
 * POST /api/events as EventBatch documents: every 30 s, on a screen change,
 * when 20 events are pending, and on page hide — that last one through
 * `navigator.sendBeacon` (a string body, which the server reads as JSON) with
 * fetch + keepalive as the fallback. A batch never exceeds 20 events or 4096
 * bytes; a larger buffer is split, in order.
 *
 * Privacy is enforced here as well as on the server: no player id, name or
 * address is ever part of an event (keys that could carry one are dropped
 * before buffering), a per-boot random session id is the only correlation key,
 * the user agent travels only as `ios` / `android` / `desktop`, and a retention
 * signal is a coarse day bucket derived from the local save. The whole class
 * is inert (`enabled: false`) under the `?shot=` capture harness.
 *
 * Every environment handle (fetch, beacon, timers, window / document, clock,
 * randomness) is injectable so the flows run in Node.
 */
import { MAX_EVENTS_PER_BATCH, MAX_EVENT_BODY_BYTES } from '../../shared/protocol.js';
import type { TelemetryEvent, TelemetryName } from '../../shared/protocol.js';

export const EVENTS_URL = '/api/events';
/** Periodic flush interval. */
export const FLUSH_MS = 30_000;
/** Wall time covered by one fps_sample event. */
export const FPS_SAMPLE_MS = 30_000;
/** Longest string value / key the schema accepts. */
export const MAX_STRING = 200;
export const MAX_KEY = 32;
/** `d` keys that must never leave the device, whatever a caller passes. */
export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['ip', 'playerId', 'player', 'playerTag', 'name', 'email']);

export type TelemetryValue = string | number | boolean;
export type TelemetryData = Record<string, TelemetryValue>;
export type FlushReason = 'timer' | 'screen' | 'pagehide' | 'manual' | 'full';
export type UaFamily = 'ios' | 'android' | 'desktop';

/** What the shell needs from a telemetry sink (the class, or a fake in tests). */
export interface TelemetryPort {
  track(t: TelemetryName, d?: TelemetryData): void;
  /** A screen change: records it and flushes right away. */
  screen(name: string): void;
  flush(reason?: FlushReason): void;
}

export interface TelemetryFetchInit {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  keepalive: boolean;
}
export type TelemetryFetch = (url: string, init: TelemetryFetchInit) => Promise<unknown>;
export type TelemetryBeacon = (url: string, body: string) => boolean;

interface TargetLike { addEventListener(type: string, listener: (ev: Event) => void): void }
interface DocLike extends TargetLike { hidden?: boolean }

export interface TelemetryOptions {
  build: string;
  sim: number;
  /** False under the capture harness: nothing is recorded or sent. */
  enabled?: boolean;
  url?: string;
  flushMs?: number;
  /** Defaults to the global fetch / navigator.sendBeacon; `null` disables that transport. */
  fetch?: TelemetryFetch | null;
  beacon?: TelemetryBeacon | null;
  now?: () => number;
  randomBytes?: (n: number) => Uint8Array;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  /** pagehide / visibilitychange sources; default window / document, `null` attaches nothing. */
  win?: TargetLike | null;
  doc?: DocLike | null;
}

// ---------------------------------------------------------------- helpers
/** UTF-8 byte length of a string (what the server's body limit counts). */
export function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

/** ios / android / desktop — the only shape of the user agent that leaves the device. */
export function uaFamily(ua: string | undefined | null): UaFamily {
  const s = ua ?? '';
  if (/iPhone|iPad|iPod/i.test(s)) return 'ios';
  if (/Android/i.test(s)) return 'android';
  return 'desktop';
}

/** js_error payload: a bounded message and the first three stack frames. */
export function errorData(message: string | undefined | null, stack: string | undefined | null): { message: string; stack: string } {
  const msg = (message ?? '').trim() || 'unknown';
  const frames = (stack ?? '').split('\n').map((l) => l.trim()).filter((l) => /^at\s|@/.test(l)).slice(0, 3)
    .map((l) => (l.length > 64 ? l.slice(0, 64) : l));
  return { message: msg.slice(0, MAX_STRING), stack: frames.join(' | ').slice(0, MAX_STRING) };
}

/** Nearest-rank percentile (0 for no samples). */
export function percentile(samples: readonly number[], p: number): number {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank];
}

/** Bound every field to what the schema takes and strip anything that could identify a person. */
export function sanitize(d: TelemetryData | undefined): TelemetryData | undefined {
  if (!d) return undefined;
  const out: TelemetryData = {};
  let n = 0;
  for (const [k0, v] of Object.entries(d)) {
    if (FORBIDDEN_KEYS.has(k0)) continue;
    const k = k0.length > MAX_KEY ? k0.slice(0, MAX_KEY) : k0;
    if (typeof v === 'string') out[k] = v.length > MAX_STRING ? v.slice(0, MAX_STRING) : v;
    else if (typeof v === 'number') { if (Number.isFinite(v)) out[k] = v; else continue; }
    else if (typeof v === 'boolean') out[k] = v;
    else continue;
    n++;
  }
  return n ? out : undefined;
}

/**
 * Serialise `events` into EventBatch bodies of at most MAX_EVENTS_PER_BATCH
 * events and MAX_EVENT_BODY_BYTES bytes each, preserving order. An event that
 * cannot fit a batch on its own is dropped.
 */
export function splitBatches(header: { s: string; build: string; sim: number }, events: readonly TelemetryEvent[]): string[] {
  const prefix = `{"s":${JSON.stringify(header.s)},"build":${JSON.stringify(header.build)},"sim":${header.sim},"events":[`;
  const base = utf8Bytes(prefix) + 2; // + "]}"
  const out: string[] = [];
  let cur: string[] = [];
  let bytes = base;
  const close = (): void => {
    if (cur.length) out.push(`${prefix}${cur.join(',')}]}`);
    cur = [];
    bytes = base;
  };
  for (const ev of events) {
    const json = JSON.stringify(ev);
    const len = utf8Bytes(json);
    if (base + len > MAX_EVENT_BODY_BYTES) continue;
    const sep = cur.length ? 1 : 0;
    if (cur.length >= MAX_EVENTS_PER_BATCH || bytes + sep + len > MAX_EVENT_BODY_BYTES) close();
    bytes += (cur.length ? 1 : 0) + len;
    cur.push(json);
  }
  close();
  return out;
}

function defaultFetch(): TelemetryFetch | null {
  const f = (globalThis as { fetch?: (input: string, init?: RequestInit) => Promise<unknown> }).fetch;
  return typeof f === 'function' ? (url, init) => f(url, init) : null;
}

function defaultBeacon(): TelemetryBeacon | null {
  const nav = (globalThis as { navigator?: { sendBeacon?: (url: string, data: string) => boolean } }).navigator;
  const sb = nav?.sendBeacon;
  return typeof sb === 'function' ? (url, body) => sb.call(nav, url, body) : null;
}

function defaultRandomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < n; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

function hex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

// ---------------------------------------------------------------- class
export class Telemetry implements TelemetryPort {
  /** Random per-boot session id (16 hex chars). */
  readonly session: string;
  readonly enabled: boolean;

  private readonly build: string;
  private readonly sim: number;
  private readonly url: string;
  private readonly flushMs: number;
  private readonly fetchFn: TelemetryFetch | null;
  private readonly beacon: TelemetryBeacon | null;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private readonly start: number;
  private buf: TelemetryEvent[] = [];
  private timer: unknown = null;
  private disposed = false;
  /** Frame-time samples (ms) and the wall time they cover, for fps_sample. */
  private frames: number[] = [];
  private frameMs = 0;

  constructor(opts: TelemetryOptions) {
    this.build = opts.build;
    this.sim = opts.sim;
    this.enabled = opts.enabled ?? true;
    this.url = opts.url ?? EVENTS_URL;
    this.flushMs = opts.flushMs ?? FLUSH_MS;
    this.fetchFn = opts.fetch === undefined ? defaultFetch() : opts.fetch;
    this.beacon = opts.beacon === undefined ? defaultBeacon() : opts.beacon;
    this.now = opts.now ?? (() => Date.now());
    this.schedule = opts.schedule ?? ((fn, ms) => {
      const h = setTimeout(fn, ms);
      (h as unknown as { unref?: () => void }).unref?.();
      return h;
    });
    this.cancel = opts.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.session = hex((opts.randomBytes ?? defaultRandomBytes)(8));
    this.start = this.now();
    if (!this.enabled) return;

    const win = opts.win === undefined ? (typeof window === 'undefined' ? null : window) : opts.win;
    const doc = opts.doc === undefined ? (typeof document === 'undefined' ? null : document) : opts.doc;
    try { win?.addEventListener('pagehide', () => this.flush('pagehide')); } catch { /* no window */ }
    try { doc?.addEventListener('visibilitychange', () => { if (doc.hidden) this.flush('pagehide'); }); } catch { /* no document */ }
    this.arm();
  }

  /** Events waiting for the next flush. */
  get pending(): number { return this.buf.length; }

  track(t: TelemetryName, d?: TelemetryData): void {
    if (!this.enabled || this.disposed) return;
    const at = Math.max(0, Math.min(1e9, Math.round(this.now() - this.start)));
    const clean = sanitize(d);
    this.buf.push(clean ? { t, at, d: clean } : { t, at });
    if (this.buf.length >= MAX_EVENTS_PER_BATCH) this.flush('full');
  }

  screen(name: string): void {
    if (!this.enabled || this.disposed) return;
    this.track('screen', { screen: name });
    this.flush('screen');
  }

  /**
   * One rendered frame of `ms` wall time; every FPS_SAMPLE_MS of frames becomes
   * an fps_sample event with the p50 / p95 frame time and the quality tier.
   */
  frame(ms: number, tier: string): void {
    if (!this.enabled || this.disposed || !(ms > 0)) return;
    this.frames.push(ms);
    this.frameMs += ms;
    if (this.frameMs < FPS_SAMPLE_MS) return;
    const p50 = Math.round(percentile(this.frames, 50) * 10) / 10;
    const p95 = Math.round(percentile(this.frames, 95) * 10) / 10;
    this.track('fps_sample', { p50, p95, tier, n: this.frames.length });
    this.frames = [];
    this.frameMs = 0;
  }

  /** Send everything buffered now. Returns the number of requests started. */
  flush(reason: FlushReason = 'manual'): number {
    if (!this.enabled || this.disposed || !this.buf.length) return 0;
    const events = this.buf;
    this.buf = [];
    const bodies = splitBatches({ s: this.session, build: this.build, sim: this.sim }, events);
    for (const body of bodies) this.send(body, reason === 'pagehide');
    return bodies.length;
  }

  /** Stop the timer and forget the buffer (tests, teardown). */
  dispose(): void {
    this.disposed = true;
    this.buf = [];
    if (this.timer !== null) { this.cancel(this.timer); this.timer = null; }
  }

  // ------------------------------------------------------------ internals
  private arm(): void {
    if (this.disposed || this.flushMs <= 0) return;
    this.timer = this.schedule(() => {
      this.timer = null;
      this.flush('timer');
      this.arm();
    }, this.flushMs);
  }

  /**
   * Page hide prefers sendBeacon (survives the unload); everything else goes
   * through fetch + keepalive, with the beacon as the fallback. Failures are
   * dropped: telemetry never retries and never throws into the game.
   */
  private send(body: string, preferBeacon: boolean): void {
    if (preferBeacon && this.beacon) {
      try { if (this.beacon(this.url, body)) return; } catch { /* fall through */ }
    }
    if (this.fetchFn) {
      try {
        const p = this.fetchFn(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true });
        if (p && typeof (p as Promise<unknown>).catch === 'function') (p as Promise<unknown>).catch(() => undefined);
        return;
      } catch { /* fall through */ }
    }
    if (!preferBeacon && this.beacon) {
      try { this.beacon(this.url, body); } catch { /* nothing left to try */ }
    }
  }
}
