/**
 * Boot seeding: buildApp with an empty MemoryRepo puts the developer's goal run
 * (GOAL_ECHOES, from levels/solutions) on every empty story board; a board
 * that already has an entry is left alone; SEED_BOARDS=0 turns it off.
 *
 * The suite runs with SEED_BOARDS=0 (vitest.config.ts) so every other server
 * test sees empty boards; this file opts back in per test.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LeaderboardResponse } from '../../src/shared/protocol.js';
import { LEVELS, LEVEL_BY_ID } from '../../src/sim/levels.generated.js';
import { GOAL_ECHOES } from '../../src/sim/echoes.generated.js';
import { SIM_VERSION } from '../../src/sim/types.js';
import { decodeMasks, verifyReplay } from '../../src/sim/replay.js';
import { boardScore } from '../../src/sim/config.js';
import { MemoryRepo } from '../../src/server/repo/memory.js';
import type { Repo } from '../../src/server/repo/types.js';
import { SEED_PLAYER, seedBoards, seedRunFor, seedRunId, seedingEnabled } from '../../src/server/seed.js';
import { FIXED_NOW, makeApp } from './fixtures.js';

const T1_SOLVED = 't1' in GOAL_ECHOES;

afterEach(() => { vi.unstubAllEnvs(); });

async function board(app: Awaited<ReturnType<typeof makeApp>>['app'], id: string) {
  const res = await app.inject({ method: 'GET', url: `/api/leaderboard?mode=story&board=${id}` });
  expect(res.statusCode).toBe(200);
  return LeaderboardResponse.parse(res.json());
}

describe('board seeding at boot', () => {
  it('buildApp with an empty MemoryRepo → GET /api/leaderboard?mode=story&board=t1 shows the 개발자 goal run', async () => {
    vi.stubEnv('SEED_BOARDS', '1');
    const { app, repo } = await makeApp();
    try {
      const t1 = await board(app, 't1');
      if (!T1_SOLVED) {
        // no solution for t1: nothing to seed, the board stays empty and the request still works
        expect(t1.entries).toEqual([]);
        return;
      }
      expect(t1.entries.length).toBeGreaterThanOrEqual(1);
      expect(t1.entries[0].name).toBe('개발자');
      expect(t1.entries[0].cleared).toBe(true);
      expect(t1.entries[0].deaths).toBe(0);
      expect(t1.entries[0].ticks).toBe(GOAL_ECHOES.t1.ticks);
      expect(t1.entries[0].createdAt).toBe(FIXED_NOW.toISOString());
      // the raw player id never leaves the server
      expect(JSON.stringify(t1)).not.toContain(SEED_PLAYER.id);
      // the ghost of the seed is downloadable like any other run, with the solution's masks
      const ghost = await app.inject({ method: 'GET', url: `/api/ghost/${t1.entries[0].runId}` });
      expect(ghost.statusCode).toBe(200);
      expect(ghost.json()).toMatchObject({ levelId: 't1', seed: LEVEL_BY_ID.t1.seed, masks: GOAL_ECHOES.t1.masks, name: '개발자' });
      // every zone with a goal echo got its board seeded, and nothing else
      for (const def of LEVELS) {
        const top = await repo.topRuns('story', def.id, 5);
        if (def.id in GOAL_ECHOES) {
          expect(top.map((r) => r.name), def.id).toEqual(['개발자']);
          expect(top[0].runId).toBe(seedRunId(def.id));
          expect(top[0].runId).toContain(`s${SIM_VERSION}r${def.rev ?? 0}`);
        } else {
          expect(top, def.id).toEqual([]);
        }
      }
    } finally {
      await app.close();
    }
  });

  it('a board that already has an entry is not seeded, and a second boot seeds nothing more', async () => {
    if (!T1_SOLVED) return;
    vi.stubEnv('SEED_BOARDS', '1');
    const repo = new MemoryRepo();
    await repo.saveBest({
      runId: 'human-1', mode: 'story', board: 't1', levelId: 't1', seed: LEVEL_BY_ID.t1.seed, assist: false, masks: 'AAA=',
      playerId: 'player-0001', name: '사람', score: 5000, ticks: 5000, shards: 1, deaths: 2, cleared: true, height: 0,
      createdAt: '2026-09-06T00:00:00.000Z',
    });
    const first = await makeApp({ repo });
    try {
      const t1 = await board(first.app, 't1');
      expect(t1.entries.map((e) => e.name)).toEqual(['사람']);
      expect(t1.total).toBe(1);
      // other boards were still seeded
      if ('t2' in GOAL_ECHOES) expect((await board(first.app, 't2')).entries.map((e) => e.name)).toEqual(['개발자']);
    } finally {
      await first.app.close();
    }
    const second = await makeApp({ repo });
    try {
      expect((await board(second.app, 't1')).total).toBe(1);
      if ('t2' in GOAL_ECHOES) expect((await board(second.app, 't2')).total).toBe(1);
    } finally {
      await second.app.close();
    }
  });

  it('SEED_BOARDS=0 (the suite default) leaves every board empty, as does a repo without putIfBoardEmpty', async () => {
    expect(process.env.SEED_BOARDS).toBe('0');
    expect(seedingEnabled()).toBe(false);
    expect(seedingEnabled({})).toBe(true);
    expect(seedingEnabled({ SEED_BOARDS: '1' })).toBe(true);
    const { app } = await makeApp();
    try {
      expect((await board(app, 't1')).entries).toEqual([]);
    } finally {
      await app.close();
    }
    vi.stubEnv('SEED_BOARDS', '1');
    const bare = new MemoryRepo();
    const noSeed: Repo = {
      getPlayerBest: (...a) => bare.getPlayerBest(...a),
      saveBest: (...a) => bare.saveBest(...a),
      topRuns: (...a) => bare.topRuns(...a),
      rankOf: (...a) => bare.rankOf(...a),
      getRun: (...a) => bare.getRun(...a),
    };
    const plain = await makeApp({ repo: noSeed as MemoryRepo });
    try {
      expect((await board(plain.app, 't1')).entries).toEqual([]);
    } finally {
      await plain.app.close();
    }
    expect(await seedBoards(noSeed)).toEqual({ seeded: [], occupied: [], skipped: [] });
  });

  it('seedRunFor replays the goal echo and refuses a stale or broken one; the score is boardScore of the verified summary', () => {
    const now = new Date('2026-09-06T12:00:00.000Z');
    for (const def of LEVELS) {
      const echo = GOAL_ECHOES[def.id];
      const made = seedRunFor(def, echo, now);
      if (!echo) {
        expect(made).toEqual({ reason: 'no goal echo' });
        continue;
      }
      expect('run' in made, `${def.id}: ${'reason' in made ? made.reason : ''}`).toBe(true);
      const run = (made as { run: import('../../src/server/repo/types.js').StoredRun }).run;
      const v = verifyReplay(def, { v: SIM_VERSION, levelId: def.id, seed: def.seed, assist: false, masks: decodeMasks(echo.masks) });
      expect(run).toMatchObject({
        runId: seedRunId(def.id), mode: 'story', board: def.id, levelId: def.id, seed: def.seed, assist: false, masks: echo.masks,
        playerId: SEED_PLAYER.id, name: '개발자', score: boardScore(v.summary), ticks: v.summary.ticks, shards: v.summary.shards,
        deaths: 0, cleared: true, height: 0, createdAt: now.toISOString(),
      });
      expect(run.ttl).toBeUndefined();
    }
    if (!T1_SOLVED) return;
    const t1 = LEVEL_BY_ID.t1, echo = GOAL_ECHOES.t1;
    expect(seedRunFor(t1, { ...echo, sim: echo.sim + 1 }, now)).toMatchObject({ reason: /sim v3, this build is v2/ });
    expect(seedRunFor(t1, { ...echo, rev: 9 }, now)).toMatchObject({ reason: /rev 9, the zone is at rev 0/ });
    expect(seedRunFor(t1, { ...echo, seed: echo.seed + 1 }, now)).toMatchObject({ reason: /seed/ });
    expect(seedRunFor(t1, { ...echo, masks: '!!!' }, now)).toMatchObject({ reason: /do not decode/ });
    expect(seedRunFor(t1, { ...echo, masks: 'AgA=' }, now)).toMatchObject({ reason: /does not verify|not a death-free clear/ });
    expect(seedRunFor(t1, undefined, now)).toEqual({ reason: 'no goal echo' });
  });

  it('seedBoards reports seeded / occupied / skipped and logs one line per seeded board', async () => {
    if (!T1_SOLVED) return;
    const repo = new MemoryRepo();
    await repo.saveBest({
      runId: 'h', mode: 'story', board: 't2', levelId: 't2', seed: 13, assist: false, masks: 'AAA=', playerId: 'player-0001', name: '사람',
      score: 1, ticks: 1, shards: 0, deaths: 0, cleared: true, height: 0, createdAt: '2026-09-06T00:00:00.000Z',
    });
    const lines: string[] = [];
    const levels = [LEVEL_BY_ID.t1, LEVEL_BY_ID.t2, LEVEL_BY_ID.t3];
    const echoes = { t1: GOAL_ECHOES.t1, t2: GOAL_ECHOES.t2 ?? GOAL_ECHOES.t1, t3: { ...GOAL_ECHOES.t1, sim: 99 } };
    const report = await seedBoards(repo, { levels, echoes, now: () => FIXED_NOW, log: (l) => lines.push(l) });
    expect(report.seeded).toEqual(['t1']);
    expect(report.occupied).toEqual(['t2']);
    expect(report.skipped).toEqual([{ id: 't3', reason: 'goal echo is for sim v99, this build is v2' }]);
    expect(lines.filter((l) => l.includes('←'))).toHaveLength(1);
    expect(lines[0]).toMatch(/^seed: t1#s2r0 ← 개발자 \d+ ticks/);
    expect(lines.some((l) => l.includes('t3 skipped'))).toBe(true);
  });
});
