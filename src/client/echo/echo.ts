/**
 * Echo — a translucent ghost of a recorded run. A second `Sim` is constructed
 * with the same level, seed and assist flag as the recording and fed the
 * recorded masks one per tick, in lockstep with the live sim (the shell calls
 * `step()` once per live tick). Because the simulation is deterministic, the
 * echo reproduces the original run exactly.
 *
 * Echoes never emit audio or particles: their events are drained and dropped
 * here, and the renderer draws `view()` without effects.
 */
import { DT } from '../../sim/types.js';
import type { LevelDef } from '../../sim/types.js';
import { Sim } from '../../sim/sim.js';
import type { GhostView } from '../contracts.js';

export const ECHO_ALPHA = 0.4;
/** Seconds the echo lingers after its recording finished before it disappears. */
export const ECHO_FADE = 0.6;

export class Echo {
  readonly sim: Sim;
  readonly masks: Uint8Array;
  readonly color: string;
  readonly label: string | undefined;

  private i = 0;
  private n = 0;
  private fadeT = ECHO_FADE;

  constructor(def: LevelDef, masks: Uint8Array, seed: number, assist: boolean, color: string, label?: string) {
    this.sim = new Sim(def, { seed, assist });
    this.masks = masks;
    this.color = color;
    this.label = label;
  }

  /** Ticks stepped so far (counts calls, so it keeps advancing after the ghost sim goes inert). */
  get tick(): number { return this.n; }
  /** The recording ended and the ghost has faded out. */
  get done(): boolean { return this.exhausted && this.fadeT <= 0; }

  private get exhausted(): boolean { return this.sim.finished || this.i >= this.masks.length; }

  /** Advance one tick in lockstep with the live sim. */
  step(): void {
    this.n++;
    if (this.exhausted) {
      this.fadeT = Math.max(0, this.fadeT - DT);
      return;
    }
    this.sim.step(this.masks[this.i++]);
    this.sim.drainEvents();   // ghosts are silent
  }

  /** Catch up to a live tick after loading late. */
  syncTo(tick: number): void {
    while (this.n < tick) this.step();
  }

  view(): GhostView | null {
    if (this.done) return null;
    const alpha = this.exhausted ? ECHO_ALPHA * (this.fadeT / ECHO_FADE) : ECHO_ALPHA;
    return { player: this.sim.state.player, color: this.color, alpha, label: this.label };
  }
}
