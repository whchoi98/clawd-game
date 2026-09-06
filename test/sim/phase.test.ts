import { describe, it, expect } from 'vitest';
import { Sim } from '../../src/sim/sim.js';
import { DT, IN } from '../../src/sim/types.js';
import { flatRoom, openRoom, pitRoom } from '../fixtures/levels.js';
import { INTRO_TICKS, J, R, collect, playing, run, stepUntil } from './helpers.js';

describe('phase machine', () => {
  it('starts in intro, moves to play after 0.45 s and only then advances time', () => {
    const sim = new Sim(openRoom());
    expect(sim.state.phase).toBe('intro');
    expect(sim.finished).toBe(false);
    run(sim, 30);
    expect(sim.state.phase).toBe('intro');
    expect(sim.state.time).toBe(0);
    run(sim, 30);
    expect(sim.state.phase).toBe('play');
    const ev = sim.drainEvents();
    expect(ev.some((e) => e.type === 'phase' && e.phase === 'play')).toBe(true);
    const t0 = sim.state.time;
    run(sim, 120);
    expect(sim.state.time).toBeCloseTo(t0 + 1, 5);
    expect(sim.state.tick).toBe(INTRO_TICKS + 120);
    expect(sim.summary().ticks).toBeLessThan(sim.state.tick);
  });

  it('counts the intro→play transition tick: a JUMP pressed on it either acts and is counted, or does not act', () => {
    const sim = new Sim(openRoom());
    // step until the tick that flips the phase
    let n = 0;
    while (sim.state.phase === 'intro') {
      sim.step(0);
      n++;
      if (sim.state.phase !== 'intro') break;
    }
    // rebuild and stop one tick short, so the next step is the transition tick
    const t = new Sim(openRoom());
    run(t, n - 1);
    expect(t.state.phase).toBe('intro');
    t.drainEvents();
    t.step(J);
    expect(t.state.phase).toBe('play');
    const jumped = t.drainEvents().some((e) => e.type === 'jump');
    if (jumped) {
      expect(t.summary().ticks).toBe(1);
      expect(t.state.time).toBeCloseTo(DT, 9);
    } else {
      expect(t.state.stats.jumps).toBe(0);
    }
    // from here on every tick is a play tick: ticks and time move together
    run(t, 120);
    expect(t.summary().ticks).toBe(1 + 120);
    expect(t.state.time).toBeCloseTo(121 * DT, 9);
  });

  it('derives press edges from the previous mask: a held JUMP through the intro does not jump', () => {
    const sim = new Sim(openRoom());
    run(sim, 200, J);
    expect(sim.state.player.grounded).toBe(true);
    expect(sim.state.stats.jumps).toBe(0);
  });

  it('touching the goal clears the run, freezes the timer and finishes', () => {
    const sim = playing(flatRoom());
    const n = stepUntil(sim, (s) => s.state.phase === 'clear', 2400, R);
    expect(n).toBeGreaterThan(0);
    expect(sim.finished).toBe(true);
    const ticks = sim.summary().ticks;
    const ev = sim.drainEvents();
    const goal = ev.find((e) => e.type === 'goal');
    expect(goal && goal.type === 'goal' && goal.summary.cleared).toBe(true);
    run(sim, 100, R);
    expect(sim.summary().ticks).toBe(ticks);
    expect(sim.summary().time).toBeCloseTo(ticks * DT, 9);
    expect(['S', 'A', 'B', 'C']).toContain(sim.summary().rank);
  });

  it('falling into a pit kills, then respawns at the checkpoint after the death animation', () => {
    const sim = playing(pitRoom());
    const start = { ...sim.state.player };
    const n = stepUntil(sim, (s) => s.state.phase === 'dying', 2400, R);
    expect(n).toBeGreaterThan(0);
    const ev = sim.drainEvents();
    const death = ev.find((e) => e.type === 'death');
    expect(death && death.type === 'death' && death.cause).toBe('pit');
    expect(sim.state.stats.deaths).toBe(1);
    expect(sim.state.player.dead).toBe(true);
    expect(sim.finished).toBe(false);
    // 1.05 s later we are back in intro at the spawn point with full hp
    const m = stepUntil(sim, (s) => s.state.phase === 'intro', 400);
    expect(m).toBeGreaterThan(100);
    expect(m).toBeLessThan(140);
    expect(sim.drainEvents().some((e) => e.type === 'respawn')).toBe(true);
    expect(sim.state.player.x).toBeCloseTo(start.x, 3);
    expect(sim.state.player.y).toBeCloseTo(start.y, 0);
    expect(sim.state.player.hp).toBe(3);
    expect(sim.state.player.dead).toBe(false);
  });

  it('assist mode grants a third jump and is recorded on the sim', () => {
    const a = playing(openRoom(), { assist: true });
    const b = playing(openRoom());
    expect(a.assist).toBe(true);
    for (const sim of [a, b]) {
      // three taps spaced 15 ticks apart
      for (let k = 0; k < 3; k++) { sim.step(J); run(sim, 14); }
    }
    expect(a.state.stats.jumps).toBe(3);
    expect(b.state.stats.jumps).toBe(2);
  });

  it('events drain once', () => {
    const sim = new Sim(openRoom());
    const ev = collect(sim, INTRO_TICKS);
    expect(ev.length).toBeGreaterThan(0);
    expect(sim.drainEvents()).toEqual([]);
  });

  it('exposes the input bit layout', () => {
    expect(IN.LEFT | IN.RIGHT | IN.UP | IN.DOWN | IN.JUMP | IN.DASH).toBe(63);
  });
});
