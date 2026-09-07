/**
 * Fleet-shared per-IP budget for POST /api/runs (P3-12).
 *
 * @fastify/rate-limit counts in one process, so with N Fargate tasks behind
 * one ALB the effective submit budget of an address is N × 12 per minute and
 * grows with every scale-out — exactly when it should not. When the repo can
 * count for the fleet (`RateCounters`, DynamoDB `RL#<ip>#<minute>` items:
 * UpdateItem ADD, TTL 120 s) the budget is shared by every task; a repo
 * without it (a bare Repo in a test) falls back to a sliding window in this
 * process. A counter that cannot be read or written fails open — an abuse
 * brake must never take the API down with the table — and logs one warning
 * line (no address in it).
 */
import { hasRateCounters } from './repo/extras.js';
import type { Repo } from './repo/types.js';
import type { LogSink } from './metrics.js';
import { PlayerLimiter } from './runs.js';

/** Fixed one-minute windows; the counter item lives two of them so a clock skewed by a minute still finds it. */
export const RL_WINDOW_SECONDS = 60;
export const RL_TTL_SECONDS = 120;

/** UTC minute index of a millisecond timestamp — the `<minute>` of `RL#<ip>#<minute>`. */
export function minuteOf(nowMs: number): number {
  return Math.floor(nowMs / (RL_WINDOW_SECONDS * 1000));
}

/** Expiry (unix seconds) of the counter for `minute`. */
export function counterTtl(minute: number): number {
  return minute * RL_WINDOW_SECONDS + RL_TTL_SECONDS;
}

/** Seconds until the current window ends (at least 1) — the Retry-After of a refused submit. */
export function secondsToNextWindow(nowMs: number): number {
  const into = Math.floor(nowMs / 1000) % RL_WINDOW_SECONDS;
  return Math.max(1, RL_WINDOW_SECONDS - into);
}

export type LimitOutcome = { ok: true } | { ok: false; retryAfterSec: number };

export interface SubmitLimiterOptions {
  now?: () => number;
  /** Receives the one warning line when the shared counter is unavailable. */
  log?: LogSink;
}

export class SubmitLimiter {
  private readonly now: () => number;
  private readonly log: LogSink | undefined;
  private readonly local: PlayerLimiter;

  constructor(private readonly repo: Repo, private readonly max: number, opts: SubmitLimiterOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log;
    this.local = new PlayerLimiter(max, RL_WINDOW_SECONDS * 1000, this.now);
  }

  /** True when the budget is counted across the fleet (the repo has a rate counter). */
  get shared(): boolean { return hasRateCounters(this.repo); }

  async hit(ip: string): Promise<LimitOutcome> {
    const now = this.now();
    if (!hasRateCounters(this.repo)) return this.local.hit(ip);
    const minute = minuteOf(now);
    let count: number;
    try {
      count = await this.repo.hitRateCounter(ip, minute, counterTtl(minute));
    } catch (err) {
      this.log?.({ err: err instanceof Error ? err.message : String(err) }, 'submit rate counter unavailable; allowing');
      return { ok: true };
    }
    if (count > this.max) return { ok: false, retryAfterSec: secondsToNextWindow(now) };
    return { ok: true };
  }
}
