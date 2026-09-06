/**
 * Progress transfer codes (P3-5). A player without an account moves to a new
 * device by uploading a masks-free Progress snapshot and typing an 8-character
 * code on the other side. Codes come from a 32-letter alphabet without the
 * look-alikes I / O / 0 / 1: seven random characters (35 bits) plus one HMAC
 * check character, so a typo or a guess is refused before the store is asked
 * and only 1 in 32 random codes ever reaches it. Snapshots live seven days.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { MAX_TRANSFER_BYTES, TransferCode } from '../shared/protocol.js';

export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 8;
export const TRANSFER_TTL_SECONDS = 7 * 86_400;

const RANDOM_CHARS = CODE_LENGTH - 1;

/** The check character for a code body: HMAC-SHA256(secret, body), first byte mod 32. */
export function checkChar(body: string, secret: string): string {
  const digest = createHmac('sha256', secret).update(body).digest();
  return CODE_ALPHABET[digest[0] % CODE_ALPHABET.length];
}

/** A fresh code: seven uniformly random alphabet characters and the check character. */
export function makeTransferCode(secret: string, random: (n: number) => Uint8Array = (n) => randomBytes(n)): string {
  const bytes = random(RANDOM_CHARS);
  let body = '';
  // 256 is a multiple of 32, so `byte % 32` is uniform.
  for (let i = 0; i < RANDOM_CHARS; i++) body += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return body + checkChar(body, secret);
}

/** Shape (TransferCode) and check character. Lower case is accepted and normalised by `normalizeCode`. */
export function isValidCode(code: string, secret: string): boolean {
  if (!TransferCode.safeParse(code).success) return false;
  return checkChar(code.slice(0, RANDOM_CHARS), secret) === code[RANDOM_CHARS];
}

/** Upper-cased, whitespace and dashes removed — what a person types. */
export function normalizeCode(raw: string): string {
  return raw.replace(/[\s-]+/g, '').toUpperCase();
}

/** Bytes of the snapshot JSON as stored; the cap is MAX_TRANSFER_BYTES. */
export function snapshotBytes(progress: unknown): number {
  return Buffer.byteLength(JSON.stringify(progress), 'utf8');
}

export function overSnapshotCap(progress: unknown): boolean {
  return snapshotBytes(progress) > MAX_TRANSFER_BYTES;
}

/** Unix-seconds TTL and ISO expiry seven days from `now`. */
export function transferExpiry(now: Date): { ttl: number; expiresAt: string } {
  const ttl = Math.floor(now.getTime() / 1000) + TRANSFER_TTL_SECONDS;
  return { ttl, expiresAt: new Date(ttl * 1000).toISOString() };
}

/** What the snapshot blob holds. */
export interface SnapshotBlob { name: string; progress: Record<string, unknown> }

export function encodeSnapshot(blob: SnapshotBlob): string {
  return JSON.stringify(blob);
}

/** The blob back, or null when it is not ours. */
export function decodeSnapshot(text: string): SnapshotBlob | null {
  try {
    const v: unknown = JSON.parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const { name, progress } = v as { name?: unknown; progress?: unknown };
    if (typeof name !== 'string' || !progress || typeof progress !== 'object' || Array.isArray(progress)) return null;
    return { name, progress: progress as Record<string, unknown> };
  } catch {
    return null;
  }
}
