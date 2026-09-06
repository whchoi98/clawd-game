/**
 * Echo — a translucent ghost of a recorded run. A second `Sim` is constructed
 * with the same level, seed and assist flag as the recording and fed the
 * recorded masks one per tick, in lockstep with the live sim (the shell calls
 * `step()` once per live tick). Because the simulation is deterministic, the
 * echo reproduces the original run exactly.
 *
 * Echoes never emit audio or particles: their events are drained here and
 * handed back to the caller only for bookkeeping (checkpoint splits), and the
 * renderer draws `view()` without effects. The tick at which the ghost passes
 * each checkpoint is remembered so the shell can show a live split when the
 * player reaches the same pillar.
 */
import { DT } from '../../sim/types.js';
import type { LevelDef, SimEvent } from '../../sim/types.js';
import { Sim } from '../../sim/sim.js';
import type { GhostView } from '../contracts.js';

export const ECHO_ALPHA = 0.4;
/** Seconds the echo lingers after its recording finished before it disappears. */
export const ECHO_FADE = 0.6;

const NO_EVENTS: readonly SimEvent[] = [];

/** Map key of a checkpoint pillar: the position the sim reports in its 'checkpoint' event. */
export function checkpointKey(x: number, y: number): string {
  return `${x},${y}`;
}

export class Echo {
  readonly sim: Sim;
  readonly masks: Uint8Array;
  readonly color: string;
  readonly label: string | undefined;

  private i = 0;
  private n = 0;
  private fadeT = ECHO_FADE;
  /** Tick (see `tick`) at which the ghost passed each checkpoint, by `checkpointKey`. */
  private readonly cps = new Map<string, number>();

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
  /** Checkpoints the ghost has passed so far. */
  get checkpointsPassed(): number { return this.cps.size; }

  private get exhausted(): boolean { return this.sim.finished || this.i >= this.masks.length; }

  /**
   * Advance one tick in lockstep with the live sim. Returns the ghost's sim
   * events for this tick (never routed to audio or particles — the shell reads
   * them only for checkpoint bookkeeping); empty once the recording is spent.
   */
  step(): readonly SimEvent[] {
    this.n++;
    if (this.exhausted) {
      this.fadeT = Math.max(0, this.fadeT - DT);
      return NO_EVENTS;
    }
    this.sim.step(this.masks[this.i++]);
    const events = this.sim.drainEvents();   // ghosts are silent
    for (const ev of events) {
      if (ev.type === 'checkpoint') {
        const k = checkpointKey(ev.x, ev.y);
        if (!this.cps.has(k)) this.cps.set(k, this.n);
      }
    }
    return events;
  }

  /** Catch up to a live tick after loading late. */
  syncTo(tick: number): void {
    while (this.n < tick) this.step();
  }

  /** The tick at which the ghost passed the checkpoint at (x, y), or null while it has not. */
  checkpointTick(x: number, y: number): number | null {
    return this.cps.get(checkpointKey(x, y)) ?? null;
  }

  view(): GhostView | null {
    if (this.done) return null;
    const alpha = this.exhausted ? ECHO_ALPHA * (this.fadeT / ECHO_FADE) : ECHO_ALPHA;
    return { player: this.sim.state.player, color: this.color, alpha, label: this.label };
  }
}
