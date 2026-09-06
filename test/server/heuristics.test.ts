/**
 * Replay heuristics (P3-1): computed from the mask log at verification, stored
 * on the RUN as `hx`, written as one `hx` log line, never used to refuse.
 * The golden corpus (GOAL_ECHOES) is the "human-paced" reference; a synthetic
 * every-tick-edge log is the scripted one.
 *
 * This file does NOT mock the level table: the corpus replays run through the
 * real verifier on the shipped zones.
 */
import { describe, expect, it } from 'vitest';
import { GOAL_ECHOES } from '../../src/sim/echoes.generated.js';
import { LEVEL_BY_ID } from '../../src/sim/levels.generated.js';
import { Sim } from '../../src/sim/sim.js';
import { decodeMasks, encodeMasks, verifyReplayChunked } from '../../src/sim/replay.js';
import { IN, TICK_HZ } from '../../src/sim/types.js';
import type { RunClaim } from '../../src/sim/types.js';
import { PHYS } from '../../src/sim/config.js';
import { DASH_TICKS, replayHeuristics } from '../../src/server/heuristics.js';
import { replayHash, trimIdle } from '../../src/server/hash.js';
import { HX_MSG, asyncVerifier } from '../../src/server/runs.js';
import { METRIC_MSG } from '../../src/server/metrics.js';
import { playerTag } from '../../src/server/players.js';
import { SECRET, captureLog, makeApp, postRun, submitBody } from './fixtures.js';

const T1 = GOAL_ECHOES.t1;

/** The claim a client would compute for a mask log on a zone. */
function claimFor(levelId: string, masks: Uint8Array): RunClaim {
  const def = LEVEL_BY_ID[levelId];
  const sim = new Sim(def, { seed: def.seed });
  for (let i = 0; i < masks.length && !sim.finished; i++) sim.step(masks[i]);
  const s = sim.summary();
  return { ticks: s.ticks, shards: s.shards, deaths: s.deaths, cleared: s.cleared, height: s.height };
}

describe('replayHeuristics', () => {
  it('DASH_TICKS follows the sim dash time', () => {
    expect(DASH_TICKS).toBe(Math.ceil(PHYS.dashTime * TICK_HZ));
    expect(DASH_TICKS).toBe(18);
  });

  it('computes sane numbers for every golden corpus replay (the human-paced reference)', () => {
    const ids = Object.keys(GOAL_ECHOES);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const masks = decodeMasks(GOAL_ECHOES[id].masks);
      const hx = replayHeuristics(masks);
      expect(hx.ticks, id).toBe(masks.length);
      expect(hx.edges, id).toBeGreaterThan(0);
      expect(hx.edgesPerSec, id).toBeGreaterThan(0);
      expect(hx.edgesPerSec, id).toBeLessThan(TICK_HZ);
      expect(hx.presses, id).toBeGreaterThan(0);
      expect(hx.press1, id).toBeGreaterThanOrEqual(0);
      expect(hx.press1, id).toBeLessThanOrEqual(1);
      expect(hx.frameAligned, id).toBeGreaterThanOrEqual(0.5);
      expect(hx.frameAligned, id).toBeLessThanOrEqual(1);
      expect(hx.dashJumpPerfect, id).toBeLessThanOrEqual(hx.dashJumps);
      for (const v of Object.values(hx)) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('a synthetic every-tick-edge replay sits at frameAligned 0.5 (< 0.6) with press1 = 1 and 120 edges/s', () => {
    const masks = new Uint8Array(1200);
    for (let i = 0; i < masks.length; i++) masks[i] = i % 2 === 0 ? IN.RIGHT | IN.JUMP : 0;
    const hx = replayHeuristics(masks);
    expect(hx.edges).toBe(1200);
    expect(hx.edgesPerSec).toBe(TICK_HZ);
    expect(hx.frameAligned).toBe(0.5);
    expect(hx.frameAligned).toBeLessThan(0.6);
    expect(hx.press1).toBe(1);
    expect(hx.presses).toBe(600);
  });

  it('a 60 Hz-shaped log (edges only on even ticks, ≥ 2-tick holds) is fully frame-aligned with press1 = 0', () => {
    const masks = new Uint8Array(1200);
    // 10-tick holds of RIGHT|JUMP starting on even ticks, released for 10 ticks
    for (let i = 0; i < masks.length; i++) masks[i] = Math.floor(i / 10) % 2 === 0 ? IN.RIGHT | IN.JUMP : 0;
    const hx = replayHeuristics(masks);
    expect(hx.frameAligned).toBe(1);
    expect(hx.press1).toBe(0);
    expect(hx.edgesPerSec).toBe(12);
  });

  it('counts dash-jumps inside the dash window and the frame-perfect ones on the next tick', () => {
    const masks = new Uint8Array(400);
    masks[10] = IN.DASH; masks[11] = IN.JUMP;                 // perfect: jump one tick after the dash
    masks[100] = IN.DASH; masks[100 + 5] = IN.JUMP;           // inside the window, not perfect
    masks[200] = IN.DASH; masks[200 + DASH_TICKS] = IN.JUMP;  // last tick of the window
    masks[300] = IN.DASH; masks[300 + DASH_TICKS + 1] = IN.JUMP; // too late
    masks[350] = IN.DASH | IN.JUMP;                           // same tick: not a follow-up
    const hx = replayHeuristics(masks);
    expect(hx.dashJumps).toBe(3);
    expect(hx.dashJumpPerfect).toBe(1);
    expect(hx.presses).toBe(5 + 5);
    expect(hx.press1).toBe(1);
  });

  it('an empty or idle log is harmless', () => {
    expect(replayHeuristics(new Uint8Array(0))).toEqual({ ticks: 0, edges: 0, edgesPerSec: 0, presses: 0, press1: 0, frameAligned: 1, dashJumps: 0, dashJumpPerfect: 0 });
    expect(replayHeuristics(new Uint8Array(240)).edges).toBe(0);
  });
});

describe('replayHash', () => {
  it('is sha256 hex over level, seed and the idle-trimmed masks; encoding and trailing idle ticks do not matter', () => {
    const a = new Uint8Array([2, 2, 2, 18, 18, 0, 0, 0]);
    const b = new Uint8Array([2, 2, 2, 18, 18]);
    expect(trimIdle(a)).toEqual(b);
    expect(trimIdle(b)).toBe(b);
    const h = replayHash(a, 't1', 5);
    expect(h).toMatch(/^[a-f0-9]{64}$/);
    expect(replayHash(b, 't1', 5)).toBe(h);
    expect(replayHash(decodeMasks(encodeMasks(a)), 't1', 5)).toBe(h);
    expect(replayHash(a, 't2', 5)).not.toBe(h);
    expect(replayHash(a, 't1', 6)).not.toBe(h);
    expect(replayHash(new Uint8Array([2, 2, 2, 18, 18, 2]), 't1', 5)).not.toBe(h);
  });
});

describe('a corpus replay through the real verifier', () => {
  it('stores hx on the run and writes one hx log line (playerTag, never the id) plus the VerifyMs metric; a copy by another player is a duplicate', async () => {
    if (!T1) return;
    const masks = decodeMasks(T1.masks);
    const claim = claimFor('t1', masks);
    expect(claim.cleared).toBe(true);
    const { app, repo } = await makeApp({ verify: asyncVerifier(verifyReplayChunked) });
    try {
      const lines = captureLog(app);
      const res = await postRun(app, submitBody({ masks: T1.masks, claim }));
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.accepted).toBe(true);
      expect(body.personalBest).toBe(true);

      const stored = (await repo.getRun(body.runId))!;
      expect(stored.hx).toEqual(replayHeuristics(masks));
      expect(stored.hash).toBe(replayHash(masks, 't1', LEVEL_BY_ID.t1.seed));

      const hx = lines.filter((l) => l.msg === HX_MSG);
      expect(hx).toHaveLength(1);
      expect(hx[0].record).toMatchObject({
        evt: 'hx', runId: body.runId, playerTag: playerTag('player-0001', SECRET), mode: 'story', board: 't1', levelId: 't1', ...replayHeuristics(masks),
      });
      expect(hx[0].record).not.toHaveProperty('playerId');
      expect(hx[0].record).not.toHaveProperty('name');
      expect(JSON.stringify(hx[0].record)).not.toContain('player-0001');

      const metrics = lines.filter((l) => l.msg === METRIC_MSG);
      expect(metrics).toHaveLength(1);
      expect(metrics[0].record.VerifyMs).toBeGreaterThan(0);

      // the same log from another player is refused, and leaves no trace on the board
      const copy = await postRun(app, submitBody({ masks: T1.masks, claim, player: { id: 'copycat-0001', name: '복사' } }));
      expect(copy.statusCode).toBe(422);
      expect(copy.json()).toMatchObject({ accepted: false, reason: 'duplicate' });
      expect((await repo.topRuns('story', 't1', 10)).map((r) => r.playerId)).toEqual(['player-0001']);
      expect(lines.filter((l) => l.msg === HX_MSG)).toHaveLength(1);
      expect(lines.filter((l) => l.msg === METRIC_MSG)).toHaveLength(2);
    } finally {
      await app.close();
    }
  });
});
