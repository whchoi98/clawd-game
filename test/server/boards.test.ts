/**
 * Story boards are partitioned by SIM_VERSION and the zone's geometry revision
 * so a sim bump opens a fresh board; daily boards are keyed by date alone.
 * Both repos must derive every key from the same function.
 */
import { describe, expect, it } from 'vitest';
import { LEVEL_BY_ID } from '../../src/sim/levels.generated.js';
import { SIM_VERSION } from '../../src/sim/types.js';
import { boardKey, levelRev, storyBoardSuffix } from '../../src/server/boards.js';
import { KEY } from '../../src/server/repo/dynamo.js';
import { MemoryRepo } from '../../src/server/repo/memory.js';
import type { StoredRun } from '../../src/server/repo/types.js';

const run = (over: Partial<StoredRun>): StoredRun => ({
  runId: 'r', mode: 'story', board: 't1', levelId: 't1', seed: 1, assist: false, masks: 'AAA=',
  playerId: 'p1', name: 'P', score: 100, ticks: 100, shards: 0, deaths: 0, cleared: true, height: 0,
  createdAt: '2026-09-06T00:00:00.000Z', ...over,
});

describe('boardKey', () => {
  it('suffixes story boards with s<SIM_VERSION>r<rev> and leaves daily boards alone', () => {
    expect(SIM_VERSION).toBe(4);
    expect(levelRev('t1')).toBe(LEVEL_BY_ID.t1.rev ?? 0);
    expect(storyBoardSuffix('t1')).toBe(`s${SIM_VERSION}r${LEVEL_BY_ID.t1.rev ?? 0}`);
    expect(boardKey('story', 't1')).toBe(`t1#s${SIM_VERSION}r${LEVEL_BY_ID.t1.rev ?? 0}`);
    expect(boardKey('daily', '2026-09-06')).toBe('2026-09-06');
  });

  it('treats unknown zones and prototype names as revision 0', () => {
    expect(levelRev('zz9')).toBe(0);
    expect(levelRev('constructor')).toBe(0);
    expect(boardKey('story', 'zz9')).toBe(`zz9#s${SIM_VERSION}r0`);
  });

  it('DynamoDB LB and PLAYER keys carry the same version segment', () => {
    const suffix = storyBoardSuffix('t1');
    expect(KEY.lbPk('story', 't1')).toBe(`LB#story#t1#${suffix}`);
    expect(KEY.bestSk('story', 't1')).toBe(`BEST#story#t1#${suffix}`);
    expect(KEY.lbPk('daily', '2026-09-06')).toBe('LB#daily#2026-09-06');
    expect(KEY.bestSk('daily', '2026-09-06')).toBe('BEST#daily#2026-09-06');
  });

  it('MemoryRepo keeps every read path on the same versioned board', async () => {
    const repo = new MemoryRepo();
    await repo.saveBest(run({ runId: 'a' }));
    expect((await repo.topRuns('story', 't1', 10)).map((r) => r.runId)).toEqual(['a']);
    expect(await repo.rankOf('story', 't1', 200)).toEqual({ better: 1, total: 1 });
    expect((await repo.getPlayerBest('p1', 'story', 't1'))?.runId).toBe('a');
    // the wire-level board stays the level id
    expect((await repo.getRun('a'))?.board).toBe('t1');
  });
});
