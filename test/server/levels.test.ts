import { describe, expect, it } from 'vitest';
import { resolveLevel } from '../../src/server/levels.js';

/** Runs against the shipped level table and the real daily generator. */
describe('resolveLevel', () => {
  it('resolves story zones by id', () => {
    const def = resolveLevel('story', 't1', 0);
    expect(def?.id).toBe('t1');
  });
  it('returns null for unknown story ids and for tower ids in story mode', () => {
    expect(resolveLevel('story', 'zz9', 0)).toBeNull();
    expect(resolveLevel('story', 'daily', 0)).toBeNull();
  });
  it('generates the daily tower from the seed', () => {
    const def = resolveLevel('daily', 'daily', 12345);
    expect(def?.id).toBe('daily');
    expect(def?.rows.length).toBeGreaterThan(0);
  });
  it('returns null for daily mode with a non-daily level id', () => {
    expect(resolveLevel('daily', 't1', 12345)).toBeNull();
  });
});
