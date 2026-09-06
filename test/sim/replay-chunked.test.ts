import { describe, expect, it } from 'vitest';
import { Sim } from '../../src/sim/sim.js';
import { IN, MAX_TICKS, SIM_VERSION } from '../../src/sim/types.js';
import type { LevelDef, Replay, RunClaim, VerifyResult } from '../../src/sim/types.js';
import { VERIFY_CHUNK_TICKS, verifyReplay, verifyReplayChunked } from '../../src/sim/replay.js';

const ROOM: LevelDef = {
  id: 'room', name: '방', en: 'Room', biome: 'tidepool', par: 10, seed: 7,
  rows: [
    '............',
    'P..........G',
    '############',
  ],
};

/** Hold RIGHT until the goal: a short, cleared run and its exact claim. */
function record(): { replay: Replay; claim: RunClaim } {
  const sim = new Sim(ROOM, { seed: ROOM.seed, assist: false });
  const masks: number[] = [];
  while (!sim.finished && masks.length < 5000) {
    masks.push(IN.RIGHT);
    sim.step(IN.RIGHT);
  }
  const s = sim.summary();
  expect(s.cleared).toBe(true);
  return {
    replay: { v: SIM_VERSION, levelId: ROOM.id, seed: ROOM.seed, assist: false, masks: Uint8Array.from(masks) },
    claim: { ticks: s.ticks, shards: s.shards, deaths: s.deaths, cleared: s.cleared, height: s.height },
  };
}

/** Standing still never reaches the goal: every mask is stepped. */
const idle = (n: number): Replay => ({ v: SIM_VERSION, levelId: ROOM.id, seed: ROOM.seed, assist: false, masks: new Uint8Array(n) });

const counting = () => {
  let n = 0;
  return { count: () => n, yield: async () => { n++; } };
};

describe('verifyReplayChunked', () => {
  it('reaches the same decision as verifyReplay for every outcome', async () => {
    const { replay, claim } = record();
    const cases: [Replay, RunClaim | undefined][] = [
      [replay, claim],
      [replay, undefined],
      [replay, { ...claim, ticks: claim.ticks - 1 }],
      [{ ...replay, masks: replay.masks.slice(0, replay.masks.length - 30) }, undefined],
      [{ ...replay, levelId: 'nope' }, claim],
      [idle(MAX_TICKS + 1), undefined],
      [idle(7000), claim],
      [idle(7000), undefined],
      [{ ...replay, v: SIM_VERSION + 1 }, claim],
      [{ ...idle(7000), v: 0 }, undefined],
    ];
    for (const [r, c] of cases) {
      const sync: VerifyResult = verifyReplay(ROOM, r, c);
      const chunked = await verifyReplayChunked(ROOM, r, c, { chunk: 500, yield: async () => {} });
      expect(chunked).toEqual(sync);
    }
    expect(verifyReplay(ROOM, replay, claim).ok).toBe(true);
    expect(verifyReplay(ROOM, { ...replay, masks: replay.masks.slice(0, replay.masks.length - 30) }).reason).toBe('not-finished');
    expect(verifyReplay(ROOM, { ...replay, levelId: 'nope' }).reason).toBe('bad-level');
    expect(verifyReplay(ROOM, idle(MAX_TICKS + 1)).reason).toBe('too-long');
    expect(verifyReplay(ROOM, { ...replay, v: SIM_VERSION + 1 }, claim).reason).toBe('sim-version');
  });

  it('refuses another SIM_VERSION before stepping: no yields, no ticks, even on a maximal log', async () => {
    const y = counting();
    const res = await verifyReplayChunked(ROOM, { ...idle(MAX_TICKS), v: SIM_VERSION + 1 }, undefined, { chunk: 100, yield: y.yield });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('sim-version');
    expect(res.summary.ticks).toBe(0);
    expect(y.count()).toBe(0);
    // the version check precedes the level and length checks
    const wrongLevel = await verifyReplayChunked(ROOM, { ...idle(MAX_TICKS + 1), v: 0, levelId: 'nope' }, undefined, { yield: y.yield });
    expect(wrongLevel.reason).toBe('sim-version');
  });

  it('yields to the event loop every VERIFY_CHUNK_TICKS ticks and not for a log that ends within one chunk', async () => {
    expect(VERIFY_CHUNK_TICKS).toBe(2400);
    const y = counting();
    const res = await verifyReplayChunked(ROOM, idle(MAX_TICKS), { ticks: MAX_TICKS, shards: 0, deaths: 0, cleared: true, height: 0 }, { yield: y.yield });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('not-finished');
    expect(y.count()).toBe(MAX_TICKS / VERIFY_CHUNK_TICKS - 1);

    const short = counting();
    const { replay, claim } = record();
    expect(replay.masks.length).toBeLessThan(VERIFY_CHUNK_TICKS);
    expect((await verifyReplayChunked(ROOM, replay, claim, { yield: short.yield })).ok).toBe(true);
    expect(short.count()).toBe(0);
  });

  it('honours a custom chunk size', async () => {
    const y = counting();
    await verifyReplayChunked(ROOM, idle(1000), undefined, { chunk: 100, yield: y.yield });
    expect(y.count()).toBe(9);
  });

  it('uses a real event-loop turn by default (setImmediate), so other work interleaves', async () => {
    let ticksOfOtherWork = 0;
    const timer = setInterval(() => { ticksOfOtherWork++; }, 0);
    try {
      const res = await verifyReplayChunked(ROOM, idle(MAX_TICKS));
      expect(res.reason).toBe('not-finished');
    } finally {
      clearInterval(timer);
    }
    expect(ticksOfOtherWork).toBeGreaterThan(0);
  });

  it('stops early once the claim can no longer be met (play ticks or deaths already exceed it)', async () => {
    const y = counting();
    // Claiming 600 play ticks against a 72000-tick idle log: the verifier gives up soon after tick ~660.
    const res = await verifyReplayChunked(ROOM, idle(MAX_TICKS), { ticks: 600, shards: 0, deaths: 0, cleared: true, height: 0 }, { chunk: 100, yield: y.yield });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('claim-mismatch');
    expect(y.count()).toBeLessThan(10);
    // ... and the sync verifier decides identically
    expect(verifyReplay(ROOM, idle(MAX_TICKS), { ticks: 600, shards: 0, deaths: 0, cleared: true, height: 0 })).toEqual(res);
  });
});
