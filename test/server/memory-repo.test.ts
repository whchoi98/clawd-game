import { describe, expect, it } from 'vitest';
import { MemoryRepo } from '../../src/server/repo/memory.js';
import type { StoredRun } from '../../src/server/repo/types.js';

function run(over: Partial<StoredRun>): StoredRun {
  return {
    runId: 'r1', mode: 'story', board: 't1', levelId: 't1', seed: 1, assist: false, masks: 'AAA=',
    playerId: 'p1', name: 'P1', score: 100, ticks: 100, shards: 0, deaths: 0, cleared: true, height: 0,
    createdAt: '2026-09-06T00:00:00.000Z', ...over,
  };
}

describe('MemoryRepo', () => {
  it('starts empty', async () => {
    const repo = new MemoryRepo();
    expect(await repo.getRun('nope')).toBeNull();
    expect(await repo.getPlayerBest('p1', 'story', 't1')).toBeNull();
    expect(await repo.topRuns('story', 't1', 10)).toEqual([]);
    expect(await repo.rankOf('story', 't1', 50)).toEqual({ better: 0, total: 0 });
  });

  it('saveBest stores the run, the board entry and the player best', async () => {
    const repo = new MemoryRepo();
    await repo.saveBest(run({ runId: 'a', score: 100 }));
    expect((await repo.getRun('a'))?.score).toBe(100);
    expect((await repo.getPlayerBest('p1', 'story', 't1'))?.runId).toBe('a');
    expect((await repo.topRuns('story', 't1', 10)).map((r) => r.runId)).toEqual(['a']);
  });

  it('saveBest with previousRunId replaces the board entry but keeps the old run readable', async () => {
    const repo = new MemoryRepo();
    await repo.saveBest(run({ runId: 'a', score: 100 }));
    await repo.saveBest(run({ runId: 'b', score: 80 }), 'a');
    expect((await repo.topRuns('story', 't1', 10)).map((r) => r.runId)).toEqual(['b']);
    expect((await repo.getPlayerBest('p1', 'story', 't1'))?.runId).toBe('b');
    expect(await repo.getRun('a')).not.toBeNull();
  });

  it('topRuns sorts by score ascending, then more shards, then earlier createdAt; limit applies', async () => {
    const repo = new MemoryRepo();
    await repo.saveBest(run({ runId: 'a', playerId: 'p1', score: 300 }));
    await repo.saveBest(run({ runId: 'b', playerId: 'p2', score: 100, shards: 2, createdAt: '2026-09-06T00:00:02.000Z' }));
    await repo.saveBest(run({ runId: 'c', playerId: 'p3', score: 100, shards: 5 }));
    await repo.saveBest(run({ runId: 'd', playerId: 'p4', score: 100, shards: 2, createdAt: '2026-09-06T00:00:01.000Z' }));
    await repo.saveBest(run({ runId: 'e', playerId: 'p5', score: 200 }));
    expect((await repo.topRuns('story', 't1', 10)).map((r) => r.runId)).toEqual(['c', 'd', 'b', 'e', 'a']);
    expect((await repo.topRuns('story', 't1', 2)).map((r) => r.runId)).toEqual(['c', 'd']);
  });

  it('rankOf counts strictly better scores and the board total', async () => {
    const repo = new MemoryRepo();
    await repo.saveBest(run({ runId: 'a', playerId: 'p1', score: 100 }));
    await repo.saveBest(run({ runId: 'b', playerId: 'p2', score: 200 }));
    await repo.saveBest(run({ runId: 'c', playerId: 'p3', score: 200 }));
    expect(await repo.rankOf('story', 't1', 200)).toEqual({ better: 1, total: 3 });
    expect(await repo.rankOf('story', 't1', 100)).toEqual({ better: 0, total: 3 });
    expect(await repo.rankOf('story', 't1', 999)).toEqual({ better: 3, total: 3 });
  });

  it('keeps boards and modes apart', async () => {
    const repo = new MemoryRepo();
    await repo.saveBest(run({ runId: 'a', board: 't1' }));
    await repo.saveBest(run({ runId: 'b', board: 't2', levelId: 't2' }));
    await repo.saveBest(run({ runId: 'c', mode: 'daily', board: '2026-09-06', levelId: 'daily' }));
    expect((await repo.topRuns('story', 't1', 10)).map((r) => r.runId)).toEqual(['a']);
    expect((await repo.topRuns('story', 't2', 10)).map((r) => r.runId)).toEqual(['b']);
    expect((await repo.topRuns('daily', '2026-09-06', 10)).map((r) => r.runId)).toEqual(['c']);
    expect((await repo.getPlayerBest('p1', 'daily', '2026-09-06'))?.runId).toBe('c');
  });
});
