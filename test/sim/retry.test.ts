import { describe, it, expect } from 'vitest';
import { DYING_TICKS, RESPAWN_INTRO_TICKS, Sim } from '../../src/sim/sim.js';
import { SIM_VERSION } from '../../src/sim/types.js';
import { decodeMasks, encodeMasks, verifyReplay } from '../../src/sim/replay.js';
import { checkpointRoom, flatRoom, openRoom } from '../fixtures/levels.js';
import { INTRO_TICKS, R, RETRY, playing, run, stepUntil } from './helpers.js';

describe('IN.RETRY — checkpoint retry inside the replay', () => {
  it('a tap during play kills with cause "retry", counts a death and respawns at the last checkpoint', () => {
    const sim = playing(checkpointRoom());
    // run right until the checkpoint pillar lights up
    let cp: { x: number; y: number } | null = null;
    for (let i = 0; i < 1200 && !cp; i++) {
      sim.step(R);
      for (const e of sim.drainEvents()) if (e.type === 'checkpoint') cp = { x: e.x, y: e.y };
    }
    expect(cp).not.toBeNull();
    expect(sim.state.respawn).toEqual(cp);
    run(sim, 30, R);
    sim.drainEvents();
    expect(sim.state.player.x).toBeGreaterThan(cp!.x);

    sim.step(RETRY);
    const ev = sim.drainEvents();
    const death = ev.find((e) => e.type === 'death');
    expect(death).toMatchObject({ type: 'death', cause: 'retry', deaths: 1 });
    expect(sim.state.phase).toBe('dying');
    expect(sim.state.player.dead).toBe(true);
    expect(sim.state.stats.deaths).toBe(1);
    expect(sim.summary().deaths).toBe(1);

    const deathTick = sim.state.tick;
    const m = stepUntil(sim, (s) => s.state.phase === 'play', 200);
    expect(m).toBe(DYING_TICKS + RESPAWN_INTRO_TICKS);
    expect(sim.state.tick - deathTick).toBeLessThanOrEqual(72);
    // centred on the pillar with the feet on its base (the ground probe rests them a hair above the tile)
    const p = sim.state.player;
    expect(p.x + p.w / 2).toBeCloseTo(cp!.x, 3);
    expect(p.y + p.h).toBeCloseTo(cp!.y, 1);
    expect(p.grounded).toBe(true);
    expect(p.dead).toBe(false);
    expect(p.hp).toBe(3);
  });

  it('is edge-triggered: holding RETRY across the respawn costs exactly one death', () => {
    const sim = playing(openRoom());
    run(sim, 600, RETRY); // 5 s held: one death, then dying → intro → play with RETRY still down
    expect(sim.state.stats.deaths).toBe(1);
    expect(sim.state.phase).toBe('play');
    // release and tap again: a fresh edge kills again
    sim.step(0);
    sim.step(RETRY);
    expect(sim.state.stats.deaths).toBe(2);
    expect(sim.state.phase).toBe('dying');
  });

  it('is ignored outside play: first-spawn intro, dying, respawn intro and clear', () => {
    // first-spawn intro: a tap does nothing, and a hold carried into play never edges
    const a = new Sim(openRoom());
    a.step(RETRY);
    a.step(0);
    expect(a.state.stats.deaths).toBe(0);
    expect(a.state.phase).toBe('intro');
    run(a, INTRO_TICKS, RETRY);
    expect(a.state.phase).toBe('play');
    run(a, 10, RETRY);
    expect(a.state.stats.deaths).toBe(0);

    // dying: a second edge while the death plays does not stack
    const b = playing(openRoom());
    b.step(RETRY);
    expect(b.state.phase).toBe('dying');
    b.step(0); b.step(RETRY); b.step(0);
    expect(b.state.stats.deaths).toBe(1);
    // respawn intro: a tap inside the 0.15 s window is ignored too
    const m = stepUntil(b, (s) => s.state.phase === 'intro', 200);
    expect(m).toBeGreaterThan(0);
    b.step(RETRY); b.step(0);
    expect(b.state.phase).toBe('intro');
    expect(b.state.stats.deaths).toBe(1);
    stepUntil(b, (s) => s.state.phase === 'play', 200);
    expect(b.state.stats.deaths).toBe(1);

    // clear: the run is frozen
    const c = playing(flatRoom());
    stepUntil(c, (s) => s.state.phase === 'clear', 2400, R);
    expect(c.state.phase).toBe('clear');
    const deaths = c.state.stats.deaths;
    c.step(0); c.step(RETRY);
    expect(c.state.phase).toBe('clear');
    expect(c.state.stats.deaths).toBe(deaths);
  });

  it('combines with movement bits and ignores bits above IN_ALL', () => {
    const sim = playing(openRoom());
    sim.step(0x80);
    expect(sim.state.stats.deaths).toBe(0);
    sim.step(R | RETRY);
    expect(sim.state.stats.deaths).toBe(1);
    expect(sim.state.phase).toBe('dying');
  });

  it('is part of the mask log: a replay containing a RETRY tap verifies with deaths 1', () => {
    const def = flatRoom();
    const sim = new Sim(def);
    const log: number[] = [];
    let i = 0;
    while (!sim.finished && i < 6000) {
      const mask = i === 200 ? R | RETRY : R;
      sim.step(mask);
      log.push(mask);
      i++;
    }
    expect(sim.finished).toBe(true);
    const s = sim.summary();
    expect(s.deaths).toBe(1);
    const masks = decodeMasks(encodeMasks(Uint8Array.from(log)));
    expect(masks[200]).toBe(R | RETRY);
    const res = verifyReplay(
      def,
      { v: SIM_VERSION, levelId: def.id, seed: def.seed, assist: false, masks },
      { ticks: s.ticks, shards: s.shards, deaths: s.deaths, cleared: true, height: 0 },
    );
    expect(res.ok).toBe(true);
    expect(res.summary.deaths).toBe(1);
    expect(res.summary.ticks).toBe(s.ticks);
  });
});
