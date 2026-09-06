/**
 * Ground-locked camera (ported from the reference World#_camera).
 *
 * Horizontal: follows the player's centre, leading by velocity (and dash
 * direction) with damping. Vertical: chases the FEET only while the player is
 * supported; in the air a wide dead zone keeps jumps from bobbing the view, so
 * the ground line — not the arc — is what the eye tracks. Finally the view is
 * clamped hard to the level box, centring when the level is smaller than the
 * viewport (a sliver of void past the last tile reads as a rendering hole).
 */
import { PHYS } from '../sim/config.js';
import type { PlayerState } from '../sim/types.js';
import type { WorldView } from './contracts.js';

const damp = (a: number, b: number, half: number, dt: number): number => b + (a - b) * Math.pow(2, -dt / half);
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Vertical dead zone in world units before the ground line follows an airborne player. */
export const CAM_DEADZONE = 46;
/** How far above the feet the view centre rests. */
export const CAM_LIFT = 26;

export interface LevelBox { pxW: number; pxH: number }

export class Camera {
  x = 0;
  y = 0;
  /** The y the vertical follow is locked to (feet at the last support). */
  groundY = 0;

  /** Snap to the player (new level, respawn, teleport). */
  reset(p: PlayerState): void {
    this.x = p.x + p.w / 2;
    this.y = p.y - 12;
    this.groundY = this.y;
  }

  update(dt: number, p: PlayerState, level: LevelBox, viewW: number, viewH: number, zoom = 1): void {
    const px = p.x + p.w / 2;
    const py = p.y + p.h;

    // horizontal: lead the player by their velocity, damped
    const lead = clamp(p.vx / PHYS.maxRun, -1, 1) * 46 + (p.dashT > 0 ? p.dashDirX * 22 : 0);
    this.x = damp(this.x, px + lead, 0.16, dt);

    // vertical: only chase the feet when supported, else use a wide dead zone
    if (p.grounded || p.dead) this.groundY = py;
    const dz = CAM_DEADZONE;
    if (py < this.groundY - dz) this.groundY = py + dz;
    else if (py > this.groundY + dz * 1.5) this.groundY = py - dz * 1.5;
    const ty = this.groundY - CAM_LIFT + (p.stomping ? 18 : 0);
    this.y = damp(this.y, ty, p.grounded ? 0.2 : 0.34, dt);

    this.clamp(level, viewW, viewH, zoom);
  }

  /** Clamp to the level, centring when the level is smaller than the viewport. */
  clamp(level: LevelBox, viewW: number, viewH: number, zoom = 1): void {
    const z = zoom > 0 ? zoom : 1;
    const halfW = viewW / z / 2;
    const halfH = viewH / z / 2;
    this.x = level.pxW > halfW * 2 ? clamp(this.x, halfW, level.pxW - halfW) : level.pxW / 2;
    this.y = level.pxH > halfH * 2 ? clamp(this.y, halfH, level.pxH - halfH) : level.pxH / 2;
  }

  view(zoom = 1): WorldView {
    return { camX: this.x, camY: this.y, zoom };
  }
}
