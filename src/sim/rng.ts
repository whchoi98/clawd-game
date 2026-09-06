/** mulberry32 — small, fast, and identical on every JS engine. */
export interface Rng {
  (): number;
  int(lo: number, hi: number): number;      // inclusive
  chance(p: number): boolean;
  pick<T>(arr: readonly T[]): T;
  range(lo: number, hi: number): number;    // float in [lo, hi)
}

export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (() => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }) as Rng;
  next.int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
  next.chance = (p) => next() < p;
  next.pick = (arr) => arr[Math.floor(next() * arr.length)];
  next.range = (lo, hi) => lo + next() * (hi - lo);
  return next;
}

/** 32-bit FNV-1a of a string — used to derive seeds from ids and dates. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
