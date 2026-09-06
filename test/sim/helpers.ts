import { Sim } from '../../src/sim/sim.js';
import { IN } from '../../src/sim/types.js';
import type { InputMask, LevelDef, SimEvent, SimOptions } from '../../src/sim/types.js';

export const INTRO_TICKS = 60; // 0.45 s + margin

export function run(sim: Sim, n: number, mask: InputMask = 0): void {
  for (let i = 0; i < n && !sim.finished; i++) sim.step(mask);
}

/** Step with `mask` until `pred` holds; returns the number of ticks used (or -1). */
export function stepUntil(sim: Sim, pred: (s: Sim) => boolean, max = 2400, mask: InputMask = 0): number {
  for (let i = 0; i < max; i++) {
    if (pred(sim)) return i;
    sim.step(mask);
  }
  return pred(sim) ? max : -1;
}

/** A sim that has finished its intro and is standing in 'play'. */
export function playing(def: LevelDef, opts: SimOptions = {}): Sim {
  const sim = new Sim(def, opts);
  run(sim, INTRO_TICKS);
  sim.drainEvents();
  return sim;
}

export function collect(sim: Sim, n: number, mask: InputMask = 0): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < n && !sim.finished; i++) {
    sim.step(mask);
    out.push(...sim.drainEvents());
  }
  return out;
}

export const J = IN.JUMP, R = IN.RIGHT, L = IN.LEFT, D = IN.DASH, DN = IN.DOWN, UP = IN.UP;
export const TILE = 16;
