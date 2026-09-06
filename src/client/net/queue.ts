/**
 * Offline submission queue.
 *
 * A finished, leaderboard-eligible run whose submission could not reach the
 * server (no network, timeout, 5xx) is kept in localStorage under QUEUE_KEY
 * and re-sent oldest-first the next time the page boots or the browser fires
 * `online`. The server replays every run it accepts, so a late submission is
 * as trustworthy as a live one; a daily run past its date comes back as a 422
 * `stale-date` and is dropped like any other verdict.
 *
 * Flush semantics per item, in order:
 *   - any RunResponse (accepted, or the 422 rejection the API client returns
 *     as a value)      → removed, reported through `onResult`
 *   - ApiError.offline (status 0 / 5xx) or a non-ApiError failure, or a 429
 *                       → kept, flush stops (the rest waits for the next try)
 *   - any other 4xx     → removed (the server will never take it)
 *
 * The queue holds at most QUEUE_MAX bodies; the oldest is dropped first.
 */
import type { RunResponse, RunSubmit } from '../../shared/protocol.js';
import type { ApiPort } from '../contracts.js';
import type { StorageLike } from '../save.js';
import { ApiError } from './api.js';

export const QUEUE_KEY = 'clawd-echo.queue.v1';
export const QUEUE_MAX = 20;

export interface QueueMeta {
  mode: 'story' | 'daily';
  /** story: the zone id · daily: the UTC date. */
  board: string;
  levelId: string;
}

export interface QueuedRun extends QueueMeta {
  body: RunSubmit;
  /** ms since epoch when the run was queued. */
  createdAt: number;
}

export type FlushEvent =
  | { kind: 'sent'; item: QueuedRun; response: RunResponse }
  | { kind: 'dropped'; item: QueuedRun; reason: string };

export interface FlushResult {
  sent: number;
  dropped: number;
  /** Items still waiting (a network failure stops the flush). */
  kept: number;
}

export interface SubmitQueueOptions {
  /** Defaults to `localStorage` when it exists; `null` keeps the queue in memory only. */
  storage?: StorageLike | null;
  now?: () => number;
  max?: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function defaultStorage(): StorageLike | null {
  try {
    return (globalThis as { localStorage?: StorageLike }).localStorage ?? null;
  } catch {
    return null;
  }
}

/** Accept only entries that still look like what `enqueue` wrote; anything else is skipped. */
function parseItems(raw: string | null): QueuedRun[] {
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const out: QueuedRun[] = [];
  for (const it of parsed) {
    if (!isObj(it) || !isObj(it.body)) continue;
    if (it.mode !== 'story' && it.mode !== 'daily') continue;
    if (typeof it.board !== 'string' || typeof it.levelId !== 'string') continue;
    if (typeof it.body.masks !== 'string') continue;
    out.push({
      body: it.body as unknown as RunSubmit,
      mode: it.mode,
      board: it.board,
      levelId: it.levelId,
      createdAt: typeof it.createdAt === 'number' && Number.isFinite(it.createdAt) ? it.createdAt : 0,
    });
  }
  return out;
}

export class SubmitQueue {
  private items: QueuedRun[];
  private readonly storage: StorageLike | null;
  private readonly now: () => number;
  private readonly max: number;
  private flushing: Promise<FlushResult> | null = null;

  constructor(opts: SubmitQueueOptions = {}) {
    this.storage = opts.storage === undefined ? defaultStorage() : opts.storage;
    this.now = opts.now ?? (() => Date.now());
    this.max = Math.max(1, opts.max ?? QUEUE_MAX);
    this.items = this.read().slice(-this.max);
  }

  size(): number { return this.items.length; }

  /** Oldest first. The array is a copy; the entries are the live objects. */
  list(): QueuedRun[] { return this.items.slice(); }

  /** Append a run; when the cap is exceeded the oldest entries go. Returns the stored entry. */
  enqueue(body: RunSubmit, meta: QueueMeta): QueuedRun {
    const item: QueuedRun = { body, mode: meta.mode, board: meta.board, levelId: meta.levelId, createdAt: this.now() };
    this.items.push(item);
    if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max);
    this.write();
    return item;
  }

  /** Forget everything (tests, progress reset). */
  clear(): void {
    this.items = [];
    this.write();
  }

  /**
   * Send queued runs oldest-first. A second call while one is running joins it
   * instead of racing it. Never throws: transport failures end the pass early.
   */
  flush(api: Pick<ApiPort, 'submitRun'>, onResult?: (ev: FlushEvent) => void): Promise<FlushResult> {
    if (this.flushing) return this.flushing;
    const p = this.flushInner(api, onResult).finally(() => { this.flushing = null; });
    this.flushing = p;
    return p;
  }

  private async flushInner(api: Pick<ApiPort, 'submitRun'>, onResult?: (ev: FlushEvent) => void): Promise<FlushResult> {
    const result: FlushResult = { sent: 0, dropped: 0, kept: 0 };
    for (const item of this.items.slice()) {
      let response: RunResponse;
      try {
        response = await api.submitRun(item.body);
      } catch (err) {
        const transient = !(err instanceof ApiError) || err.offline || err.status === 429;
        if (transient) break;
        this.remove(item);
        result.dropped++;
        this.report(onResult, { kind: 'dropped', item, reason: (err as ApiError).reason });
        continue;
      }
      this.remove(item);
      result.sent++;
      this.report(onResult, { kind: 'sent', item, response });
    }
    result.kept = this.items.length;
    return result;
  }

  private report(cb: ((ev: FlushEvent) => void) | undefined, ev: FlushEvent): void {
    if (!cb) return;
    try { cb(ev); } catch { /* a listener failure must not stall the queue */ }
  }

  private remove(item: QueuedRun): void {
    const i = this.items.indexOf(item);
    if (i >= 0) this.items.splice(i, 1);
    this.write();
  }

  // ------------------------------------------------------------ io
  private read(): QueuedRun[] {
    if (!this.storage) return [];
    try { return parseItems(this.storage.getItem(QUEUE_KEY)); } catch { return []; }
  }

  private write(): void {
    if (!this.storage) return;
    try {
      if (this.items.length) this.storage.setItem(QUEUE_KEY, JSON.stringify(this.items));
      else this.storage.removeItem(QUEUE_KEY);
    } catch { /* private mode / quota: the queue lives on in memory */ }
  }
}
