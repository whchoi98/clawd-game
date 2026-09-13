import { describe, expect, it } from 'vitest';
import { goalMasksFor } from '../../src/client/echo/goal.js';
import { ReplayPlayback } from '../../src/client/echo/playback.js';
import { GOAL_ECHOES } from '../../src/sim/echoes.generated.js';
import { LEVELS } from '../../src/sim/levels.generated.js';
import { Sim } from '../../src/sim/sim.js';
import { DT, IN, IN_ALL, MAX_TICKS } from '../../src/sim/types.js';
import type { LevelDef } from '../../src/sim/types.js';
import { busyRoom, openRoom, Room, tideRoom } from '../fixtures/levels.js';

type Options = { seed?: number; assist?: boolean };

/** The authority is a sequential Sim, independent of transport timing or seeking. */
function sequential(def: LevelDef, masks: Uint8Array, tick = masks.length, options: Options = {}): Sim {
  const sim = new Sim(def, options);
  for (let i = 0; i < tick && !sim.finished; i++) {
    sim.step(masks[i]);
    sim.drainEvents();
  }
  return sim;
}

function expectState(playback: ReplayPlayback, expected: Sim): void {
  expect(playback.sim.snapshot()).toEqual(expected.snapshot());
  expect(playback.sim.summary()).toEqual(expected.summary());
  expect(playback.sim.level.switchA).toBe(expected.level.switchA);
}

function goalMasks(def: LevelDef): Uint8Array {
  const masks = goalMasksFor(def);
  expect(masks, `current goal recording for ${def.id}`).not.toBeNull();
  return masks!;
}

describe('ReplayPlayback golden recordings', () => {
  it.each(LEVELS)('reproduces $id exactly after forward/backward seeks, speed changes and a pause', (def) => {
    const masks = goalMasks(def);
    const original = masks.slice();
    const playback = new ReplayPlayback(def, masks);
    expect(playback.playing).toBe(true);
    expect(playback.speed).toBe(1);
    expect(playback.duration).toBe(masks.length);
    expect(playback.cursor).toBe(0);
    expect(playback.mask).toBe(0);
    expectState(playback, new Sim(def));

    const ticks = [Math.floor(masks.length * 0.75), Math.floor(masks.length * 0.25), 53, 54, 0, masks.length - 3];
    for (const tick of ticks) {
      playback.seek(tick);
      expect(playback.cursor).toBe(tick);
      expect(playback.mask).toBe(tick === 0 ? 0 : masks[tick - 1]);
      expectState(playback, sequential(def, masks, tick));
    }

    playback.setSpeed(0.5);
    playback.update(DT);
    expect(playback.cursor).toBe(masks.length - 3);
    playback.toggle();
    const paused = playback.sim.snapshot();
    playback.update(1000);
    expect(playback.sim.snapshot()).toEqual(paused);
    expect(playback.playing).toBe(false);
    playback.toggle();
    playback.update(DT);
    expect(playback.cursor).toBe(masks.length - 2);
    playback.setSpeed(2);
    playback.update(DT);

    const golden = sequential(def, masks);
    expect(playback.cursor).toBe(masks.length);
    expect(playback.playing).toBe(false);
    expect(playback.mask).toBe(masks[masks.length - 1]);
    expect(playback.sim.finished).toBe(true);
    expect(playback.sim.summary()).toMatchObject({ cleared: true, deaths: 0, ticks: GOAL_ECHOES[def.id].ticks });
    expectState(playback, golden);
    playback.update(0.1);
    playback.update(3600);
    expectState(playback, golden);
    expect(masks).toEqual(original);
  });

  it('plays the longest goal from start to finish through irregular frames and pauses', () => {
    const recordings = LEVELS.map((def) => ({ def, masks: goalMasks(def) }));
    const { def, masks } = recordings.reduce((a, b) => a.masks.length > b.masks.length ? a : b);
    const playback = new ReplayPlayback(def, masks);
    const speeds = [0.5, 1, 2] as const;
    const frames = [1 / 240, 1 / 75, 1 / 30, 1 / 144];
    for (let frame = 0; playback.playing && frame < masks.length * 4; frame++) {
      playback.setSpeed(speeds[Math.floor(frame / 37) % speeds.length]);
      if (frame % 113 === 0) {
        const cursor = playback.cursor;
        playback.toggle();
        playback.update(0.1);
        expect(playback.cursor).toBe(cursor);
        playback.toggle();
      }
      playback.update(frames[frame % frames.length]);
    }
    expect(playback.cursor).toBe(masks.length);
    expect(playback.playing).toBe(false);
    expectState(playback, sequential(def, masks));
  });
});

describe('ReplayPlayback transport', () => {
  it.each([
    { speed: 0.5 as const, ticks: 72 },
    { speed: 1 as const, ticks: 144 },
    { speed: 2 as const, ticks: 288 },
  ])('accumulates fractional frames at $speed× into fixed 120 Hz steps', ({ speed, ticks }) => {
    const def = openRoom();
    const masks = new Uint8Array(1000).fill(IN.RIGHT);
    const playback = new ReplayPlayback(def, masks);
    playback.setSpeed(speed);
    for (let frame = 0; frame < 1200; frame++) playback.update(0.001);
    expect(playback.cursor).toBe(ticks);
    expectState(playback, sequential(def, masks, ticks));
  });

  it('shows the last applied input and retains partial ticks across pauses and speed changes', () => {
    const def = openRoom();
    const masks = Uint8Array.of(IN.RIGHT, IN.RIGHT | IN.JUMP, IN.DASH, 0, IN.RETRY, 0);
    const playback = new ReplayPlayback(def, masks);
    playback.update(DT / 2);
    expect(playback.cursor).toBe(0);
    expect(playback.mask).toBe(0);
    playback.toggle();
    playback.update(0.1);
    playback.toggle();
    playback.setSpeed(0.5);
    playback.update(DT);
    expect(playback.cursor).toBe(1);
    expect(playback.mask).toBe(IN.RIGHT);
    playback.setSpeed(1);
    playback.update(DT);
    expect(playback.cursor).toBe(2);
    expect(playback.mask).toBe(IN.RIGHT | IN.JUMP);
    playback.setSpeed(2);
    playback.update(DT);
    expect(playback.cursor).toBe(4);
    expect(playback.mask).toBe(0);
    expectState(playback, sequential(def, masks, 4));
  });

  it('clamps finite seeks, floors fractional ticks and ignores non-finite positions', () => {
    const def = openRoom();
    const masks = new Uint8Array(200).fill(IN.RIGHT);
    const playback = new ReplayPlayback(def, masks);
    playback.seek(84.9);
    expect(playback.cursor).toBe(84);
    expectState(playback, sequential(def, masks, 84));
    for (const tick of [NaN, Infinity, -Infinity]) {
      playback.seek(tick);
      expect(playback.cursor).toBe(84);
      expect(playback.playing).toBe(true);
      expectState(playback, sequential(def, masks, 84));
    }
    playback.seek(-17.5);
    expect(playback.cursor).toBe(0);
    expect(playback.mask).toBe(0);
    expectState(playback, new Sim(def));
    playback.seek(Number.MAX_VALUE);
    expect(playback.cursor).toBe(masks.length);
    expect(playback.playing).toBe(false);
    expectState(playback, sequential(def, masks));
  });

  it('discards fractional carry on seek and keeps a paused seek paused in either direction', () => {
    const def = openRoom();
    const masks = new Uint8Array(300).fill(IN.RIGHT);
    const playback = new ReplayPlayback(def, masks);
    playback.update(DT * 0.75);
    playback.seek(100);
    playback.update(DT * 0.5);
    expect(playback.cursor).toBe(100);
    playback.update(DT * 0.5);
    expect(playback.cursor).toBe(101);
    playback.toggle();
    for (const tick of [40, 180, 0]) {
      playback.seek(tick);
      playback.update(0.1);
      expect(playback.playing).toBe(false);
      expect(playback.cursor).toBe(tick);
      expectState(playback, sequential(def, masks, tick));
    }
  });

  it('restarts playing from zero with the chosen speed and no fractional carry', () => {
    const def = openRoom();
    const masks = new Uint8Array(300).fill(IN.RIGHT);
    const playback = new ReplayPlayback(def, masks);
    playback.seek(120);
    playback.setSpeed(0.5);
    playback.update(DT);
    playback.toggle();
    playback.restart();
    expect(playback.playing).toBe(true);
    expect(playback.speed).toBe(0.5);
    expect(playback.cursor).toBe(0);
    expect(playback.mask).toBe(0);
    expectState(playback, new Sim(def));
    playback.update(DT);
    expect(playback.cursor).toBe(0);
    playback.update(DT);
    expect(playback.cursor).toBe(1);
  });

  it('stops exactly at a truncated recording end and toggles back to the beginning', () => {
    const def = openRoom();
    const masks = Uint8Array.of(IN.RIGHT, IN.JUMP, IN.DASH);
    const playback = new ReplayPlayback(def, masks);
    playback.setSpeed(2);
    playback.update(0.1);
    expect(playback.cursor).toBe(3);
    expect(playback.playing).toBe(false);
    expect(playback.sim.finished).toBe(false);
    expect(playback.mask).toBe(IN.DASH);
    expectState(playback, sequential(def, masks));
    playback.toggle();
    expect(playback.cursor).toBe(0);
    expect(playback.playing).toBe(true);
    expect(playback.speed).toBe(2);
    expect(playback.mask).toBe(0);
    expectState(playback, new Sim(def));
    playback.update(DT);
    expect(playback.cursor).toBe(2);
    playback.update(DT);
    expect(playback.cursor).toBe(3);
    expect(playback.playing).toBe(false);
    playback.seek(1);
    expect(playback.playing).toBe(false);
  });

  it('freezes the authoritative clear state even if the recording has trailing inputs', () => {
    const def = LEVELS[0];
    const goal = goalMasks(def);
    const masks = new Uint8Array(goal.length + 3).fill(IN.RETRY);
    masks.set(goal);
    const playback = new ReplayPlayback(def, masks);
    const golden = sequential(def, goal);
    playback.seek(goal.length);
    playback.update(0.1);
    expect(playback.cursor).toBe(masks.length);
    expect(playback.playing).toBe(false);
    expect(playback.mask).toBe(goal[goal.length - 1]);
    expectState(playback, golden);
    playback.seek(goal.length + 1);
    expect(playback.playing).toBe(false);
    expectState(playback, golden);
  });

  it('reconstructs an over state and its tide height without stepping past the finish', () => {
    const def = tideRoom();
    const masks = new Uint8Array(4000);
    const golden = sequential(def, masks);
    expect(golden.state.phase).toBe('over');
    const playback = new ReplayPlayback(def, masks);
    playback.seek(masks.length);
    expect(playback.playing).toBe(false);
    expectState(playback, golden);
    playback.seek(100);
    expectState(playback, sequential(def, masks, 100));
    playback.toggle();
    for (let frame = 0; playback.playing && frame < 1000; frame++) playback.update(0.1);
    expect(playback.cursor).toBe(masks.length);
    expectState(playback, golden);
  });

  it('caps a tab-resume update to 0.1 seconds before speed scaling and retains no catch-up debt', () => {
    const def = openRoom();
    const masks = new Uint8Array(MAX_TICKS).fill(IN.RIGHT);
    const playback = new ReplayPlayback(def, masks);
    playback.setSpeed(2);
    playback.update(3600);
    expect(playback.cursor).toBe(24);
    for (const dt of [NaN, Infinity, -Infinity, -1, 0]) {
      playback.update(dt);
      expect(playback.cursor).toBe(24);
    }
    playback.update(DT);
    expect(playback.cursor).toBe(26);
    expectState(playback, sequential(def, masks, 26));
  });
});

describe('ReplayPlayback reconstruction and ownership', () => {
  it.each([false, true])('retains an explicit zero seed and assist=%s after backwards seeks', (assist) => {
    const def = busyRoom();
    const masks = Uint8Array.from({ length: 1500 }, (_, i) =>
      IN.RIGHT | (i % 97 < 2 ? IN.JUMP : 0) | (i % 211 < 3 ? IN.DASH : 0) | (i === 700 ? IN.RETRY : 0));
    const options = { seed: 0, assist };
    const playback = new ReplayPlayback(def, masks, options);
    options.seed = 98765;
    options.assist = !assist;
    for (const tick of [900, 120, 750, 0, masks.length - 2]) {
      playback.seek(tick);
      expect(playback.sim.seed).toBe(0);
      expect(playback.sim.assist).toBe(assist);
      expectState(playback, sequential(def, masks, tick, { seed: 0, assist }));
    }
    playback.update(1 / 60);
    expectState(playback, sequential(def, masks, masks.length, { seed: 0, assist }));
  });

  it('indexes only visited checkpoint events at their exact ticks and keeps the list stable across seeks', () => {
    const def = new Room(40, 14).rect(0, 12, 39, 13)
      .set(2, 11, 'P').set(10, 11, 'C').set(30, 11, 'C').def('replay-checkpoints');
    const recorder = new Sim(def);
    const log: number[] = [];
    let checkpointTick = 0;
    const step = (mask: number, count = 1) => {
      for (let i = 0; i < count; i++) {
        log.push(mask);
        recorder.step(mask);
        for (const event of recorder.drainEvents()) {
          if (event.type === 'checkpoint') checkpointTick ||= log.length;
        }
      }
    };
    while (!checkpointTick && log.length < 1200) step(IN.RIGHT);
    expect(checkpointTick).toBeGreaterThan(0);
    step(IN.RIGHT, 20);
    step(IN.RETRY);
    step(0, 100);
    step(IN.LEFT, 120);
    step(IN.RIGHT, 140);
    expect(recorder.state.stats.deaths).toBe(1);
    expect(recorder.state.entities.filter((e) => e.kind === 'checkpoint' && e.state === 1)).toHaveLength(1);

    const masks = Uint8Array.from(log);
    const playback = new ReplayPlayback(def, masks);
    const checkpoints = playback.checkpoints;
    expect(checkpoints).toEqual([{ tick: 0, label: '시작' }, { tick: checkpointTick, label: '체크포인트 1' }]);
    expect(playback.cursor).toBe(0);
    expectState(playback, new Sim(def));
    for (const tick of [masks.length, 0, checkpointTick - 1, checkpointTick, masks.length, checkpointTick, 0]) {
      playback.seek(tick);
      expect(playback.checkpoints).toBe(checkpoints);
      expect(playback.checkpoints).toHaveLength(2);
      expectState(playback, sequential(def, masks, tick));
    }
  });

  it.each(['Uint8Array', 'Buffer'] as const)('owns a copy of a %s view without changing the source buffer', (kind) => {
    const def = LEVELS[0];
    const masks = goalMasks(def);
    const backing = kind === 'Buffer' ? Buffer.alloc(masks.length + 4, 255) : new Uint8Array(masks.length + 4).fill(255);
    backing.set(masks, 2);
    const view = backing.subarray(2, masks.length + 2);
    const original = Uint8Array.from(backing);
    const playback = new ReplayPlayback(def, view);
    playback.seek(masks.length);
    playback.restart();
    expect(Uint8Array.from(backing)).toEqual(original);
    view.fill(IN.RETRY);
    playback.seek(masks.length);
    expectState(playback, sequential(def, masks));
    expect(backing[0]).toBe(255);
    expect(backing[backing.length - 1]).toBe(255);
    expect(Array.from(view).every((mask) => mask === IN.RETRY)).toBe(true);
  });
});

describe('ReplayPlayback constructor input policy', () => {
  it('rejects non-Uint8Array inputs instead of coercing or retaining them', () => {
    for (const masks of [null, undefined, [], [IN.RIGHT], new Uint16Array([IN.RIGHT])]) {
      expect(() => new ReplayPlayback(openRoom(), masks as unknown as Uint8Array)).toThrow(TypeError);
    }
  });

  it('rejects empty and over-limit logs so checkpoint indexing and seeking remain bounded', () => {
    for (const masks of [new Uint8Array(), new Uint8Array(MAX_TICKS + 1)]) {
      expect(() => new ReplayPlayback(openRoom(), masks)).toThrow(RangeError);
    }
  });

  it('rejects unsupported input bits without sanitizing the source and accepts every supported bit', () => {
    for (const mask of [0x80, 0xff]) {
      const masks = Uint8Array.of(IN.RIGHT, mask);
      expect(() => new ReplayPlayback(openRoom(), masks)).toThrow(RangeError);
      expect(Array.from(masks)).toEqual([IN.RIGHT, mask]);
    }
    const playback = new ReplayPlayback(openRoom(), Uint8Array.of(IN_ALL));
    playback.update(DT);
    expect(playback.mask).toBe(IN_ALL);
    expect(playback.cursor).toBe(1);
    expect(playback.playing).toBe(false);
  });
});
