/**
 * Replays: the input mask log of a run plus the parameters needed to reproduce it.
 *
 * Wire format for `masks`: run-length pairs (mask, count) with count in 1..255,
 * serialised as bytes and base64-encoded. Platformer input is mostly long
 * holds, so this is ~20× smaller than the raw log.
 */
import { Sim } from './sim.js';
import { MAX_TICKS } from './types.js';
import type { LevelDef, Replay, RunClaim, VerifyResult } from './types.js';

export function rleEncode(masks: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < masks.length) {
    const m = masks[i];
    let n = 1;
    while (i + n < masks.length && masks[i + n] === m && n < 255) n++;
    out.push(m & 0x3f, n);
    i += n;
  }
  return Uint8Array.from(out);
}

export function rleDecode(bytes: Uint8Array, maxTicks = MAX_TICKS): Uint8Array {
  if (bytes.length % 2 !== 0) throw new Error('bad-rle');
  let total = 0;
  for (let i = 1; i < bytes.length; i += 2) {
    if (bytes[i] === 0) throw new Error('bad-rle');
    total += bytes[i];
    if (total > maxTicks) throw new Error('too-long');
  }
  const out = new Uint8Array(total);
  let p = 0;
  for (let i = 0; i < bytes.length; i += 2) {
    const m = bytes[i] & 0x3f, n = bytes[i + 1];
    out.fill(m, p, p + n);
    p += n;
  }
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_REV: Record<string, number> = {};
for (let i = 0; i < 64; i++) B64_REV[B64[i]] = i;

/** Base64 without depending on Buffer or atob so the sim stays environment-free. */
export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    s += b === undefined ? '=' : B64[(n >> 6) & 63];
    s += c === undefined ? '=' : B64[n & 63];
  }
  return s;
}

export function fromBase64(s: string): Uint8Array {
  if (s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new Error('bad-base64');
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((s.length / 4) * 3 - pad);
  let p = 0;
  for (let i = 0; i < s.length; i += 4) {
    const n = (B64_REV[s[i]] << 18) | (B64_REV[s[i + 1]] << 12) | ((B64_REV[s[i + 2]] ?? 0) << 6) | (B64_REV[s[i + 3]] ?? 0);
    out[p++] = (n >> 16) & 255;
    if (p < out.length) out[p++] = (n >> 8) & 255;
    if (p < out.length) out[p++] = n & 255;
  }
  return out;
}

export function encodeMasks(masks: Uint8Array): string { return toBase64(rleEncode(masks)); }
/** Throws Error('bad-base64' | 'bad-rle' | 'too-long'). */
export function decodeMasks(s: string, maxTicks = MAX_TICKS): Uint8Array { return rleDecode(fromBase64(s), maxTicks); }

/**
 * Default cooperative-yield: hand the event loop one turn between chunks.
 * `setImmediate` is looked up on `globalThis` so this module keeps no Node
 * import (type-level or otherwise); browsers fall back to a zero timeout.
 */
function yieldToLoop(): Promise<void> {
  const g = globalThis as { setImmediate?: (cb: () => void) => unknown; setTimeout: (cb: () => void, ms: number) => unknown };
  return new Promise<void>((resolve) => {
    if (typeof g.setImmediate === 'function') g.setImmediate(resolve);
    else g.setTimeout(resolve, 0);
  });
}

/** Ticks stepped between yields by `verifyReplayChunked` (20 s of play). */
export const VERIFY_CHUNK_TICKS = 2400;

/**
 * The single decision procedure behind `verifyReplay` and `verifyReplayChunked`:
 * both drive this object, so the sync and the cooperative verifier cannot
 * drift. Construction performs the pre-checks; `advance` steps the sim;
 * `result` decides once `pending` is false.
 *
 * While stepping, the monotone counters of the running summary (play ticks,
 * deaths) are compared with the claim every 64 ticks: once either exceeds what
 * was claimed the final summary can no longer match, so the verifier stops
 * early with 'claim-mismatch' instead of spending the rest of the log.
 */
class ReplayVerifier {
  private readonly sim: Sim;
  private pos = 0;
  private early?: string;

  constructor(def: LevelDef, private readonly replay: Replay, private readonly claim?: RunClaim) {
    this.sim = new Sim(def, { seed: replay.seed, assist: replay.assist });
    if (replay.levelId !== def.id) this.early = 'bad-level';
    else if (replay.masks.length > MAX_TICKS) this.early = 'too-long';
  }

  /** True while there are masks left to step and no decision has been reached. */
  get pending(): boolean {
    return this.early === undefined && this.pos < this.replay.masks.length && !this.sim.finished;
  }

  /** Step at most `n` ticks (fewer when the log ends, the run finishes or the claim is already unreachable). */
  advance(n: number): void {
    const masks = this.replay.masks;
    const end = Math.min(masks.length, this.pos + n);
    const claim = this.claim;
    while (this.pos < end && !this.sim.finished) {
      this.sim.step(masks[this.pos++]);
      if (claim && (this.pos & 63) === 0 && this.claimUnreachable(claim)) {
        this.early = 'claim-mismatch';
        return;
      }
    }
  }

  result(): VerifyResult {
    const s = this.sim.summary();
    if (this.early !== undefined) return { ok: false, reason: this.early, summary: s };
    if (!this.sim.finished) return { ok: false, reason: 'not-finished', summary: s };
    const claim = this.claim;
    if (claim) {
      if (claim.ticks !== s.ticks || claim.shards !== s.shards || claim.deaths !== s.deaths ||
          claim.cleared !== s.cleared || Math.floor(claim.height) !== Math.floor(s.height)) {
        return { ok: false, reason: 'claim-mismatch', summary: s };
      }
    }
    return { ok: true, summary: s };
  }

  private claimUnreachable(claim: RunClaim): boolean {
    const s = this.sim.summary();
    return s.ticks > claim.ticks || s.deaths > claim.deaths;
  }
}

/**
 * Replay a run to completion with the same simulation the client shipped and
 * compare the outcome with what the client claimed. The client uses this to
 * sanity-check its own recording before submitting; the server prefers the
 * cooperative `verifyReplayChunked`.
 *
 * The replay must finish (goal reached or tide over) within its own masks; a
 * run that is still going when the log ends is 'not-finished'.
 */
export function verifyReplay(def: LevelDef, replay: Replay, claim?: RunClaim): VerifyResult {
  const v = new ReplayVerifier(def, replay, claim);
  while (v.pending) v.advance(replay.masks.length);
  return v.result();
}

export interface VerifyChunkedOptions {
  /** Ticks per chunk (default VERIFY_CHUNK_TICKS). */
  chunk?: number;
  /** Awaited between chunks (default: one event-loop turn). */
  yield?: () => Promise<void>;
}

/**
 * `verifyReplay` in slices: identical decisions, but the event loop gets a turn
 * every `chunk` ticks so a long replay cannot stall other requests on the
 * server. Never yields for a log that ends within the first chunk.
 */
export async function verifyReplayChunked(
  def: LevelDef, replay: Replay, claim?: RunClaim, opts: VerifyChunkedOptions = {},
): Promise<VerifyResult> {
  const chunk = Math.max(1, Math.floor(opts.chunk ?? VERIFY_CHUNK_TICKS));
  const pause = opts.yield ?? yieldToLoop;
  const v = new ReplayVerifier(def, replay, claim);
  while (v.pending) {
    v.advance(chunk);
    if (v.pending) await pause();
  }
  return v.result();
}
