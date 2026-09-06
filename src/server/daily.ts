/**
 * Daily Tower seeds. The seed for a UTC date is HMAC-SHA256(secret, date)
 * truncated to its first four bytes (big-endian uint32), so every player gets
 * the same tower for 24 hours and nobody can predict tomorrow's without the
 * secret. Shared by GET /api/daily and by run verification.
 */
import { createHmac } from 'node:crypto';
import type { DailySeed } from './types.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` of a Date in UTC. */
export function utcDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The UTC midnight that ends `date` (i.e. the start of the following day). */
export function nextUtcMidnight(date: string): Date {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + DAY_MS);
}

/** Today's and yesterday's UTC date strings for `now`. */
export function freshDates(now: Date): [today: string, yesterday: string] {
  return [utcDateStr(now), utcDateStr(new Date(now.getTime() - DAY_MS))];
}

/** A daily board stays open for late submissions until the end of the following UTC day. */
export function isFreshDate(date: string, now: Date): boolean {
  if (!DATE_RE.test(date)) return false;
  const [today, yesterday] = freshDates(now);
  return date === today || date === yesterday;
}

export function dailySeed(date: string, secret: string): DailySeed {
  const digest = createHmac('sha256', secret).update(date).digest();
  return {
    date,
    seed: digest.readUInt32BE(0),
    expiresAt: nextUtcMidnight(date).toISOString(),
  };
}
