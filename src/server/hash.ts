/**
 * Replay identity for the duplicate check (P3-1). Two submissions with the
 * same decoded mask log on the same level and seed are the same run, however
 * the log was encoded; the hash is stored on the RUN item and guarded by a
 * conditional `HASH#<mode>#<board>#<hash>` item in the saveBest transaction.
 *
 * Trailing idle ticks are trimmed first: verification stops at the finish, so
 * a copy padded with 0-masks would otherwise slip past the check.
 */
import { createHash } from 'node:crypto';

/** The log without its trailing 0-masks (a new view when nothing was trimmed). */
export function trimIdle(masks: Uint8Array): Uint8Array {
  let n = masks.length;
  while (n > 0 && masks[n - 1] === 0) n--;
  return n === masks.length ? masks : masks.subarray(0, n);
}

/** sha256 hex of `levelId \0 seed \0 masks` (masks trimmed of trailing idle ticks). */
export function replayHash(masks: Uint8Array, levelId: string, seed: number): string {
  const h = createHash('sha256');
  h.update(levelId);
  h.update('\0');
  h.update(String(seed >>> 0));
  h.update('\0');
  h.update(trimIdle(masks));
  return h.digest('hex');
}
