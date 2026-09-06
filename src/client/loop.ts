/**
 * Fixed-step tick scheduling for the frame loop. Pure and DOM-free so it can
 * be tested without a browser.
 *
 * The sim runs at 120 Hz and consumes one InputMask per tick. A frame at 60 Hz
 * therefore steps two ticks; a frame at 144 Hz sometimes steps none. Press
 * edges are derived inside the sim from the previous tick's mask, so a key that
 * went down and up between two frames has to be made visible to exactly one
 * tick: the input layer latches it and the scheduler ORs the latched bits into
 * the FIRST tick of the frame only. A frame that runs no ticks (hitstop, a very
 * fast display) carries the latched bits over to the next frame instead of
 * dropping them.
 */
import { DT, IN_ALL } from '../sim/types.js';
import type { InputMask } from '../sim/types.js';

/** Frames longer than this are treated as a stall (tab switch, GC pause). */
export const MAX_FRAME_DT = 1 / 20;
/** Never run more ticks than this per frame — a stall must not snowball. */
export const MAX_STEPS_PER_FRAME = 8;

/** Presentation-side time controls the scheduler reads (from the FxBus). */
export interface TimeControl {
  /** Seconds of hitstop remaining; > 0 freezes the sim while the frame still renders. */
  hitstop: number;
  /** 1 = real time; < 1 = slow motion (fewer ticks per wall-clock second). */
  timeScale: number;
}

/**
 * Masks for `n` ticks: tick 0 sees `held | latched`, the rest see `held`.
 * The latched bits appear in one tick only, so a tap gives one press edge.
 */
export function planTicks(held: InputMask, latched: InputMask, n: number): InputMask[] {
  const out = new Array<InputMask>(Math.max(0, n | 0));
  for (let i = 0; i < out.length; i++) out[i] = i === 0 ? (held | latched) & IN_ALL : held & IN_ALL;
  return out;
}

export class TickScheduler {
  /** Unspent simulated time, in seconds. */
  acc = 0;
  private carry: InputMask = 0;

  /**
   * Plan this frame's ticks. `dtWall` is the real frame time; it is clamped to
   * MAX_FRAME_DT and scaled by `ctl.timeScale`. Returns an empty array while in
   * hitstop, remembering any latched press for the next frame that runs.
   */
  plan(dtWall: number, held: InputMask, latched: InputMask, ctl: TimeControl): InputMask[] {
    this.carry |= latched & IN_ALL;
    if (ctl.hitstop > 0) return [];
    const dt = dtWall > MAX_FRAME_DT ? MAX_FRAME_DT : dtWall > 0 ? dtWall : 0;
    const scale = ctl.timeScale > 2 ? 2 : ctl.timeScale > 0 ? ctl.timeScale : 0;
    this.acc += dt * scale;
    // the epsilon absorbs 1/60 + 1/60 landing a hair under 4/120
    let n = Math.floor(this.acc / DT + 1e-6);
    if (n <= 0) return [];
    if (n > MAX_STEPS_PER_FRAME) {
      n = MAX_STEPS_PER_FRAME;
      this.acc = 0;
    } else {
      this.acc -= n * DT;
      if (this.acc < 1e-9) this.acc = 0;
    }
    const l = this.carry;
    this.carry = 0;
    return planTicks(held, l, n);
  }

  reset(): void {
    this.acc = 0;
    this.carry = 0;
  }
}
