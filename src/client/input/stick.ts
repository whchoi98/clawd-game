/**
 * Virtual stick → direction bits (P3-7). Pure.
 *
 * The 8-way dash aim rule: the sim aims a dash along the LEFT / RIGHT / UP /
 * DOWN bits held on the tick the DASH edge lands, else along the facing
 * direction (src/sim/player.ts startDash). For a thumb stick that means the
 * deflection must snap cleanly to one of eight sectors — a thumb pushed
 * "up-right" has to read as exactly RIGHT | UP, never as RIGHT alone because
 * the vertical happened to fall a hair short of a per-axis threshold.
 *
 *   1. Radial dead zone: a deflection shorter than STICK_DEADZONE is neutral.
 *   2. Sector snap: the angle is rounded to the nearest multiple of 45°
 *      (±22.5° per sector) → one of the eight (dx, dy) pairs.
 *   3. Vertical guard: a sector with a vertical component only keeps it when
 *      |y| ≥ STICK_Y_DEADZONE — running with a slightly raised thumb must not
 *      look up, and a slightly lowered one must never stomp. Below the guard
 *      the sector collapses to the horizontal (which still needs |x| ≥ the
 *      dead zone), so a weak diagonal reads as a run, and a weak near-vertical
 *      push reads as nothing rather than as a sideways run.
 *
 * Direction lock: the sim samples the bits once at the dash edge and keeps the
 * direction for the whole dash, so moving the thumb mid-dash never bends it.
 */
import { IN, type InputMask } from '../../sim/types.js';
import { TOUCH_THRESHOLD } from './binds.js';

/** Deflection (fraction of the stick radius) below which the stick is neutral. */
export const STICK_DEADZONE = TOUCH_THRESHOLD;
/** The vertical component counts only past this fraction of the radius (look-up and stomp are deliberate). */
export const STICK_Y_DEADZONE = 0.45;
/** Sector width: eight directions, ±22.5° each. */
export const STICK_SECTOR_RAD = Math.PI / 4;

export type StickDir = -1 | 0 | 1;
export interface StickSnap { dx: StickDir; dy: StickDir }

/** Sector index (0 = right, counter-clockwise on screen: 2 = down, 4 = left, 6 = up) → (dx, dy). */
const SECTORS: readonly StickSnap[] = [
  { dx: 1, dy: 0 }, { dx: 1, dy: 1 }, { dx: 0, dy: 1 }, { dx: -1, dy: 1 },
  { dx: -1, dy: 0 }, { dx: -1, dy: -1 }, { dx: 0, dy: -1 }, { dx: 1, dy: -1 },
];

/** Snap a stick deflection (screen coordinates, y down, -1..1 each) to one of eight directions or neutral. */
export function snapStick(x: number, y: number): StickSnap {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { dx: 0, dy: 0 };
  const r = Math.hypot(x, y);
  if (r < STICK_DEADZONE) return { dx: 0, dy: 0 };
  const sector = ((Math.round(Math.atan2(y, x) / STICK_SECTOR_RAD) % 8) + 8) % 8;
  const s = SECTORS[sector];
  if (s.dy !== 0 && Math.abs(y) < STICK_Y_DEADZONE) {
    // Too shallow for a deliberate up / down: the horizontal alone, if there is one.
    return { dx: Math.abs(x) >= STICK_DEADZONE ? (x > 0 ? 1 : -1) : 0, dy: 0 };
  }
  return { dx: s.dx, dy: s.dy };
}

/** The four direction bits for a stick deflection. */
export function stickMask(x: number, y: number): InputMask {
  const { dx, dy } = snapStick(x, y);
  let m: InputMask = 0;
  if (dx < 0) m |= IN.LEFT; else if (dx > 0) m |= IN.RIGHT;
  if (dy < 0) m |= IN.UP; else if (dy > 0) m |= IN.DOWN;
  return m;
}
