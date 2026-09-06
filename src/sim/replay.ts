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
 * Replay a run to completion with the same simulation the client shipped and
 * compare the outcome with what the client claimed. The server calls this;
 * the client uses it to sanity-check its own recording before submitting.
 *
 * The replay must finish (goal reached or tide over) within its own masks; a
 * run that is still going when the log ends is 'not-finished'.
 */
export function verifyReplay(def: LevelDef, replay: Replay, claim?: RunClaim): VerifyResult {
  const sim = new Sim(def, { seed: replay.seed, assist: replay.assist });
  const fail = (reason: string): VerifyResult => ({ ok: false, reason, summary: sim.summary() });
  if (replay.levelId !== def.id) return fail('bad-level');
  if (replay.masks.length > MAX_TICKS) return fail('too-long');
  for (let i = 0; i < replay.masks.length && !sim.finished; i++) sim.step(replay.masks[i]);
  if (!sim.finished) return fail('not-finished');
  const s = sim.summary();
  if (claim) {
    if (claim.ticks !== s.ticks || claim.shards !== s.shards || claim.deaths !== s.deaths ||
        claim.cleared !== s.cleared || Math.floor(claim.height) !== Math.floor(s.height)) {
      return fail('claim-mismatch');
    }
  }
  return { ok: true, summary: s };
}
