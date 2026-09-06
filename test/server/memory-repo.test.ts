import { describe, expect, it } from 'vitest';
import { KEY } from '../../src/server/repo/dynamo.js';
import { isDuplicateReplay, isSaveConflict } from '../../src/server/repo/errors.js';
import { MemoryRepo } from '../../src/server/repo/memory.js';
import { REPLACED_RUN_TTL_SECONDS } from '../../src/server/repo/ttl.js';
import type { StoredRun } from '../../src/server/repo/types.js';

function run(over: Partial<StoredRun>): StoredRun {
  return {
    runId: 'r1', mode: 'story', board: 't1', levelId: 't1', seed: 1, assist: false, masks: 'AAA=',
    playerId: 'p1', name: 'P1', score: 100, ticks: 100, shards: 0, deaths: 0, cleared: true, height: 0,
    createdAt: '2026-09-06T00:00:00.000Z', ...over,
  };
}

const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);

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

  it('topRuns sorts like the DynamoDB LB key: score ascending, then more shards, then run id; limit applies', async () => {
    const repo = new MemoryRepo();
    await repo.saveBest(run({ runId: 'a', playerId: 'p1', score: 300 }));
    await repo.saveBest(run({ runId: 'd', playerId: 'p2', score: 100, shards: 2, createdAt: '2026-09-06T00:00:01.000Z' }));
    await repo.saveBest(run({ runId: 'c', playerId: 'p3', score: 100, shards: 5 }));
    await repo.saveBest(run({ runId: 'b', playerId: 'p4', score: 100, shards: 2, createdAt: '2026-09-06T00:00:02.000Z' }));
    await repo.saveBest(run({ runId: 'e', playerId: 'p5', score: 200 }));
    expect((await repo.topRuns('story', 't1', 10)).map((r) => r.runId)).toEqual(['c', 'b', 'd', 'e', 'a']);
    expect((await repo.topRuns('story', 't1', 2)).map((r) => r.runId)).toEqual(['c', 'b']);
    // parity with the DynamoDB sort key
    const sks = (await repo.topRuns('story', 't1', 10)).map((r) => KEY.lbSk(r.score, r.shards, r.runId));
    expect([...sks].sort()).toEqual(sks);
  });

  it('saveBest refuses a write whose previousRunId is not the current best (mirrors the DynamoDB condition)', async () => {
    const repo = new MemoryRepo();
    await repo.saveBest(run({ runId: 'a', score: 100 }));
    // no previous named, but a best exists
    await expect(repo.saveBest(run({ runId: 'b', score: 90 }))).rejects.toSatisfy(isSaveConflict);
    // a stale previous
    await expect(repo.saveBest(run({ runId: 'b', score: 90 }), 'zzz')).rejects.toSatisfy(isSaveConflict);
    // a previous named while none exists
    await expect(repo.saveBest(run({ runId: 'x', playerId: 'p9', score: 90 }), 'a')).rejects.toSatisfy(isSaveConflict);
    // nothing leaked from the refused writes
    expect((await repo.topRuns('story', 't1', 10)).map((r) => r.runId)).toEqual(['a']);
    expect(await repo.getRun('b')).toBeNull();
    // the right previous goes through
    await repo.saveBest(run({ runId: 'b', score: 90 }), 'a');
    expect((await repo.topRuns('story', 't1', 10)).map((r) => r.runId)).toEqual(['b']);
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

  it('putIfBoardEmpty seeds only an empty board and reports whether it wrote', async () => {
    const repo = new MemoryRepo();
    const seed = run({ runId: 'goal-t1', playerId: 'developer-goal-echo-0001', name: '개발자', score: 857 });
    expect(await repo.putIfBoardEmpty(seed)).toBe(true);
    expect((await repo.topRuns('story', 't1', 10)).map((r) => r.name)).toEqual(['개발자']);
    expect((await repo.getRun('goal-t1'))?.masks).toBe('AAA=');
    // a second seed of the same board (another task booting) writes nothing
    expect(await repo.putIfBoardEmpty(run({ runId: 'goal-t1-b', playerId: 'developer-goal-echo-0001', score: 800 }))).toBe(false);
    expect(await repo.getRun('goal-t1-b')).toBeNull();
    // a board with a real entry is never seeded
    await repo.saveBest(run({ runId: 'p', board: 't2', levelId: 't2', playerId: 'p7', score: 900 }));
    expect(await repo.putIfBoardEmpty(run({ runId: 'goal-t2', board: 't2', levelId: 't2', playerId: 'developer-goal-echo-0001', score: 500 }))).toBe(false);
    expect((await repo.topRuns('story', 't2', 10)).map((r) => r.runId)).toEqual(['p']);
    // the seed is an ordinary entry afterwards: a faster player ranks above it and can be replaced normally
    await repo.saveBest(run({ runId: 'fast', playerId: 'p1', score: 600 }));
    expect((await repo.topRuns('story', 't1', 10)).map((r) => r.runId)).toEqual(['fast', 'goal-t1']);
    expect(await repo.rankOf('story', 't1', 857)).toEqual({ better: 1, total: 2 });
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

  describe('replay hash (duplicate check)', () => {
    it('refuses the same hash from another player with DuplicateReplayError naming the owner, and writes nothing', async () => {
      const repo = new MemoryRepo();
      await repo.saveBest(run({ runId: 'a', playerId: 'p1', hash: H1 }));
      const err = await repo.saveBest(run({ runId: 'b', playerId: 'p2', score: 90, hash: H1 })).catch((e: unknown) => e);
      expect(isDuplicateReplay(err)).toBe(true);
      expect(err).toMatchObject({ runId: 'a', playerId: 'p1' });
      expect((await repo.topRuns('story', 't1', 10)).map((r) => r.runId)).toEqual(['a']);
      expect(await repo.getRun('b')).toBeNull();
      expect(await repo.getPlayerBest('p2', 'story', 't1')).toBeNull();
      // a different hash from p2 is fine; the seeded goal echo's hash is guarded the same way
      await repo.saveBest(run({ runId: 'c', playerId: 'p2', score: 90, hash: H2 }));
      expect((await repo.topRuns('story', 't1', 10)).map((r) => r.runId)).toEqual(['c', 'a']);
    });

    it('scopes hashes per board and keeps them after the run is replaced or delisted', async () => {
      const repo = new MemoryRepo();
      await repo.saveBest(run({ runId: 'a', playerId: 'p1', hash: H1 }));
      // same hash on another board is another replay
      await repo.saveBest(run({ runId: 'x', playerId: 'p2', board: 't2', levelId: 't2', hash: H1 }));
      // p1 improves; the old run's hash still blocks copies
      await repo.saveBest(run({ runId: 'b', playerId: 'p1', score: 50, hash: H2 }), 'a');
      await expect(repo.saveBest(run({ runId: 'thief', playerId: 'p3', score: 60, hash: H1 }))).rejects.toSatisfy(isDuplicateReplay);
      await repo.delistRun('b');
      await expect(repo.saveBest(run({ runId: 'thief2', playerId: 'p3', score: 40, hash: H2 }))).rejects.toSatisfy(isDuplicateReplay);
      // the PLAYER guard is checked before the hash
      await expect(repo.saveBest(run({ runId: 'a2', playerId: 'p2', board: 't2', levelId: 't2', hash: H1 }))).rejects.toSatisfy(isSaveConflict);
    });

    it('runs without a hash (legacy) are unaffected', async () => {
      const repo = new MemoryRepo();
      await repo.saveBest(run({ runId: 'a', playerId: 'p1' }));
      await repo.saveBest(run({ runId: 'b', playerId: 'p2' }));
      expect(await repo.topRuns('story', 't1', 10)).toHaveLength(2);
    });
  });

  it('a replaced story run gets the 90-day ttl from the new best\'s createdAt; daily keeps its own ttl', async () => {
    const repo = new MemoryRepo();
    await repo.saveBest(run({ runId: 'a', score: 100 }));
    await repo.saveBest(run({ runId: 'b', score: 80, createdAt: '2026-09-07T00:00:00.000Z' }), 'a');
    expect((await repo.getRun('a'))!.ttl).toBe(Math.floor(Date.parse('2026-09-07T00:00:00.000Z') / 1000) + REPLACED_RUN_TTL_SECONDS);
    expect((await repo.getRun('b'))!.ttl).toBeUndefined();
    await repo.saveBest(run({ runId: 'd1', mode: 'daily', board: '2026-09-06', levelId: 'daily', ttl: 1_760_000_000 }));
    await repo.saveBest(run({ runId: 'd2', mode: 'daily', board: '2026-09-06', levelId: 'daily', score: 50, ttl: 1_760_000_100 }), 'd1');
    expect((await repo.getRun('d1'))!.ttl).toBe(1_760_000_000);
  });

  describe('transfer snapshots', () => {
    it('putSnapshot / takeSnapshot: one restore per code, then null; a new code retires the old one', async () => {
      const repo = new MemoryRepo({ now: () => 1_000_000 });
      await repo.putSnapshot('p1', 'AAAAAAAA', '{"a":1}', 2_000);
      expect(await repo.takeSnapshot('ZZZZZZZZ')).toBeNull();
      expect(await repo.takeSnapshot('AAAAAAAA')).toEqual({ playerId: 'p1', blob: '{"a":1}' });
      expect(await repo.takeSnapshot('AAAAAAAA')).toBeNull();
      await repo.putSnapshot('p1', 'BBBBBBBB', '{"a":2}', 2_000);
      await repo.putSnapshot('p1', 'CCCCCCCC', '{"a":3}', 2_000);
      expect(await repo.takeSnapshot('BBBBBBBB')).toBeNull();
      expect(await repo.takeSnapshot('CCCCCCCC')).toEqual({ playerId: 'p1', blob: '{"a":3}' });
    });

    it('an expired snapshot is gone (and the code is consumed)', async () => {
      let t = 1_000_000;
      const repo = new MemoryRepo({ now: () => t });
      await repo.putSnapshot('p1', 'AAAAAAAA', '{}', 2_000);
      t = 2_000 * 1000;
      expect(await repo.takeSnapshot('AAAAAAAA')).toBeNull();
      t = 1_000_000;
      expect(await repo.takeSnapshot('AAAAAAAA')).toBeNull();
    });
  });

  describe('admin', () => {
    it('delistRun flags the run, removes the board entry and the player best; unknown → false', async () => {
      const repo = new MemoryRepo();
      await repo.saveBest(run({ runId: 'a', playerId: 'p1', score: 100 }));
      await repo.saveBest(run({ runId: 'b', playerId: 'p2', score: 200 }));
      expect(await repo.delistRun('nope')).toBe(false);
      expect(await repo.delistRun('a')).toBe(true);
      expect((await repo.getRun('a'))).toMatchObject({ runId: 'a', flagged: true });
      expect((await repo.topRuns('story', 't1', 10)).map((r) => r.runId)).toEqual(['b']);
      expect(await repo.getPlayerBest('p1', 'story', 't1')).toBeNull();
      expect(await repo.rankOf('story', 't1', 200)).toEqual({ better: 0, total: 1 });
      // the player can post a new run afterwards
      await repo.saveBest(run({ runId: 'a2', playerId: 'p1', score: 150 }));
      expect((await repo.topRuns('story', 't1', 10)).map((r) => r.runId)).toEqual(['a2', 'b']);
    });

    it('delistRun of a run that is no longer the best flags it without touching the newer best', async () => {
      const repo = new MemoryRepo();
      await repo.saveBest(run({ runId: 'a', playerId: 'p1', score: 100 }));
      await repo.saveBest(run({ runId: 'b', playerId: 'p1', score: 90 }), 'a');
      expect(await repo.delistRun('a')).toBe(true);
      expect((await repo.getRun('a'))!.flagged).toBe(true);
      expect((await repo.getPlayerBest('p1', 'story', 't1'))!.runId).toBe('b');
      expect((await repo.topRuns('story', 't1', 10)).map((r) => r.runId)).toEqual(['b']);
    });

    it('renameRun changes the name on the run, the board entry and the player best', async () => {
      const repo = new MemoryRepo();
      await repo.saveBest(run({ runId: 'a', playerId: 'p1', name: '나쁜이름' }));
      expect(await repo.renameRun('nope', 'x')).toBe(false);
      expect(await repo.renameRun('a', '플레이어')).toBe(true);
      expect((await repo.getRun('a'))!.name).toBe('플레이어');
      expect((await repo.topRuns('story', 't1', 10))[0].name).toBe('플레이어');
      expect((await repo.getPlayerBest('p1', 'story', 't1'))!.name).toBe('플레이어');
    });
  });
});
