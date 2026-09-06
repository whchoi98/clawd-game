import { describe, expect, it, vi } from 'vitest';

// While Task B / Task A have not yet produced src/sim/levels.generated.ts and
// src/sim/gen/daily.ts, intercept levels.ts's raw import specifiers (see the note
// in fixtures.ts). Once the real modules exist these mocks are inert and the
// assertions below hold against the real data.
vi.mock('../sim/levels.generated.js', async () => {
  const { FIX_T1 } = await import('./levelfix.js');
  return { LEVELS: [FIX_T1], LEVEL_BY_ID: { t1: FIX_T1 }, CHAPTERS: [] };
});
vi.mock('../sim/gen/daily.js', async () => {
  const { fixDaily } = await import('./levelfix.js');
  return { makeDailyLevel: (seed: number) => fixDaily(seed) };
});
vi.mock('./sim.js', () => ({ Sim: class {} }));

import { resolveLevel } from '../../src/server/levels.js';

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
