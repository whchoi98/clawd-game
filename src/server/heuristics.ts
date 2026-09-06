/**
 * Replay heuristics (P3-1). Computed from the decoded mask log at verification
 * time, stored on the RUN item as `hx` and written as one structured log line
 * — never used to refuse a run. A 120 Hz display, a gamepad or a very good
 * player can look like a bot on any single number; the point is that a
 * reviewer can sort a board by them (tools/admin.mjs export-board) and decide.
 *
 *   press1          share of JUMP / DASH presses held for exactly one tick
 *   edgesPerSec     input changes per second of log
 *   frameAligned    share of edges on the dominant tick parity — a 60 Hz client
 *                   latches input on the first tick of each 2-tick frame, so a
 *                   human there sits near 1.0; per-tick scripting sits at 0.5
 *   dashJumps       JUMP pressed inside the dash window after a DASH press
 *   dashJumpPerfect …of which on the very next tick (frame-perfect at 120 Hz)
 */
import { IN, TICK_HZ } from '../sim/types.js';
import { PHYS } from '../sim/config.js';

export interface Heuristics {
  ticks: number;
  edges: number;
  edgesPerSec: number;
  presses: number;
  press1: number;
  frameAligned: number;
  dashJumps: number;
  dashJumpPerfect: number;
}

/** Ticks a dash lasts — the window in which a JUMP press counts as a dash-jump. */
export const DASH_TICKS = Math.ceil(PHYS.dashTime * TICK_HZ);
const PRESS_BITS = [IN.JUMP, IN.DASH] as const;

const round3 = (x: number): number => Math.round(x * 1000) / 1000;

export function replayHeuristics(masks: Uint8Array): Heuristics {
  const n = masks.length;
  let edges = 0;
  let even = 0;
  let presses = 0;
  let press1 = 0;
  let dashJumps = 0;
  let dashJumpPerfect = 0;
  let lastDash = -1;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const m = masks[i];
    if (m !== prev) {
      edges++;
      if ((i & 1) === 0) even++;
      const pressed = m & ~prev;
      for (const bit of PRESS_BITS) {
        if (pressed & bit) {
          presses++;
          if (i + 1 >= n || (masks[i + 1] & bit) === 0) press1++;
        }
      }
      if (pressed & IN.DASH) lastDash = i;
      if ((pressed & IN.JUMP) && lastDash >= 0 && i - lastDash >= 1 && i - lastDash <= DASH_TICKS) {
        dashJumps++;
        if (i - lastDash === 1) dashJumpPerfect++;
        lastDash = -1;
      }
    }
    prev = m;
  }
  const seconds = n / TICK_HZ;
  return {
    ticks: n,
    edges,
    edgesPerSec: seconds > 0 ? round3(edges / seconds) : 0,
    presses,
    press1: presses > 0 ? round3(press1 / presses) : 0,
    frameAligned: edges > 0 ? round3(Math.max(even, edges - even) / edges) : 1,
    dashJumps,
    dashJumpPerfect,
  };
}
