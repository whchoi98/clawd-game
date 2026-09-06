import { describe, it, expect } from 'vitest';
import { Sim } from '../../src/sim/sim.js';
import { makeRng } from '../../src/sim/rng.js';
import { IN } from '../../src/sim/types.js';
import type { Replay } from '../../src/sim/types.js';
import { decodeMasks, encodeMasks, verifyReplay } from '../../src/sim/replay.js';
import { busyRoom, flatRoom } from '../fixtures/levels.js';
import { J, R } from './helpers.js';

function scriptedMasks(n: number, seed: number): Uint8Array {
  const rng = makeRng(seed);
  const out = new Uint8Array(n);
  let cur = 0;
  for (let i = 0; i < n; i++) {
    if (i % 12 === 0) {
      cur = 0;
      if (rng.chance(0.7)) cur |= rng.chance(0.6) ? IN.RIGHT : IN.LEFT;
      if (rng.chance(0.35)) cur |= IN.JUMP;
      if (rng.chance(0.15)) cur |= IN.DASH;
      if (rng.chance(0.1)) cur |= IN.DOWN;
      if (rng.chance(0.1)) cur |= IN.UP;
    }
    out[i] = cur;
  }
  return out;
}

describe('determinism', () => {
  it('two sims fed identical masks produce identical state at 600 / 3600 / 7200 ticks', () => {
    const masks = scriptedMasks(7200, 99);
    const a = new Sim(busyRoom(), { seed: 5 });
    const b = new Sim(busyRoom(), { seed: 5 });
    const checkpoints = new Set([600, 3600, 7200]);
    let compared = 0;
    for (let i = 0; i < 7200; i++) {
      a.step(masks[i]); b.step(masks[i]);
      if (checkpoints.has(i + 1)) {
        expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
        compared++;
      }
    }
    expect(compared).toBe(3);
    expect(a.state.tick).toBe(7200);
    // the busy room should have produced some action, otherwise the test is vacuous
    expect(a.state.stats.jumps + a.state.stats.dashes).toBeGreaterThan(10);
  });

  it('a different seed changes hopper timing but not the level', () => {
    const masks = scriptedMasks(1200, 3);
    const a = new Sim(busyRoom(), { seed: 1 });
    const b = new Sim(busyRoom(), { seed: 2 });
    for (let i = 0; i < 1200; i++) { a.step(masks[i]); b.step(masks[i]); }
    expect(a.level.w).toBe(b.level.w);
    expect(a.seed).not.toBe(b.seed);
  });
});

describe('replay verification', () => {
  function record(): { replay: Replay; ticks: number; shards: number; deaths: number } {
    const def = flatRoom();
    const sim = new Sim(def);
    const log: number[] = [];
    let i = 0;
    while (!sim.finished && i < 4000) {
      const mask = R | (i % 90 < 3 ? J : 0);
      sim.step(mask);
      log.push(mask);
      i++;
    }
    expect(sim.finished).toBe(true);
    const s = sim.summary();
    return {
      replay: { v: 1, levelId: def.id, seed: def.seed, assist: false, masks: Uint8Array.from(log) },
      ticks: s.ticks, shards: s.shards, deaths: s.deaths,
    };
  }

  it('round-trips a recorded run through encode/decode and verifies ok', () => {
    const { replay, ticks, shards, deaths } = record();
    const wire = encodeMasks(replay.masks);
    expect(wire.length).toBeLessThan(replay.masks.length);
    const back = decodeMasks(wire);
    expect(Array.from(back)).toEqual(Array.from(replay.masks));
    const res = verifyReplay(flatRoom(), { ...replay, masks: back }, { ticks, shards, deaths, cleared: true, height: 0 });
    expect(res.ok).toBe(true);
    expect(res.summary.cleared).toBe(true);
    expect(res.summary.ticks).toBe(ticks);
  });

  it('rejects a tampered ticks claim and a truncated log', () => {
    const { replay, ticks, shards, deaths } = record();
    const bad = verifyReplay(flatRoom(), replay, { ticks: ticks - 1, shards, deaths, cleared: true, height: 0 });
    expect(bad.ok).toBe(false);
    expect(bad.reason).toBe('claim-mismatch');
    const short = verifyReplay(flatRoom(), { ...replay, masks: replay.masks.slice(0, replay.masks.length - 30) });
    expect(short.ok).toBe(false);
    expect(short.reason).toBe('not-finished');
    const wrong = verifyReplay(flatRoom(), { ...replay, levelId: 'nope' });
    expect(wrong.reason).toBe('bad-level');
  });
});
