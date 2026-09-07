/**
 * Camera on vertical zones (P2-10): a level taller than it is wide is a climb,
 * so a grounded player gets CAM_VERTICAL_LEAD more upward lead than on a
 * side-scrolling room — the next ledge, not the one just left, fills the view.
 * The lead is taken on ground contact and held through the jump so the view
 * never bobs mid-air, and a wide level is untouched.
 */
import { describe, expect, it } from 'vitest';
import { CAM_LIFT, CAM_VERTICAL_LEAD, Camera, isVerticalLevel } from '../../src/client/camera.js';
import { LEVEL_BY_ID } from '../../src/sim/levels.generated.js';
import { Level } from '../../src/sim/level.js';
import { TILE } from '../../src/sim/types.js';
import type { PlayerState } from '../../src/sim/types.js';

const player = (x: number, y: number, grounded = true): PlayerState => ({
  x, y, w: 11, h: 15, vx: 0, vy: 0, facing: 1, grounded, onWall: 0, jumps: 0, dashT: 0, dashDirX: 0, dashDirY: 0,
  dashReady: true, dashCd: 0, stomping: false, hp: 3, invuln: 0, dead: false, deadT: 0, inWater: false, pose: 'idle', t: 0,
});

/** A 44 x 72 tower and a 100 x 20 room, in world units. */
const TALL = { pxW: 44 * TILE, pxH: 72 * TILE };
const WIDE = { pxW: 100 * TILE, pxH: 20 * TILE };
const VIEW_W = 512, VIEW_H = 288;

/** Settle the camera on a grounded player standing with their feet at `feet`. */
function settle(cam: Camera, level: { pxW: number; pxH: number }, x: number, feet: number, frames = 300): void {
  for (let i = 0; i < frames; i++) cam.update(1 / 60, player(x, feet - 15), level, VIEW_W, VIEW_H, 1);
}

describe('Camera — vertical zones lead upward (P2-10)', () => {
  it('CAM_VERTICAL_LEAD is 18 world units on top of CAM_LIFT, and a level is vertical when taller than wide', () => {
    expect(CAM_VERTICAL_LEAD).toBe(18);
    expect(CAM_LIFT).toBe(26);
    expect(isVerticalLevel(TALL)).toBe(true);
    expect(isVerticalLevel(WIDE)).toBe(false);
    expect(isVerticalLevel({ pxW: 400, pxH: 400 })).toBe(false);
    // the shipped vertical zones read as vertical through the same Level box the shell passes in
    for (const id of ['t4', 's4', 'v4']) {
      const lv = new Level(LEVEL_BY_ID[id]);
      expect(isVerticalLevel(lv), id).toBe(true);
    }
    for (const id of ['t1', 's2', 'v3']) expect(isVerticalLevel(new Level(LEVEL_BY_ID[id])), id).toBe(false);
  });

  it('on a tall level the view converges to the feet minus CAM_LIFT + 18 while grounded', () => {
    const cam = new Camera();
    const feet = 60 * TILE;                       // standing on the base of the tower, well inside the clamp
    cam.reset(player(300, feet - 15));
    settle(cam, TALL, 300, feet);
    expect(cam.y).toBeCloseTo(feet - CAM_LIFT - CAM_VERTICAL_LEAD, 2);
    expect(cam.lead).toBe(CAM_VERTICAL_LEAD);
  });

  it('on a wide level the view converges to the feet minus CAM_LIFT — unchanged', () => {
    const cam = new Camera();
    const feet = 12 * TILE;
    cam.reset(player(800, feet - 15));
    settle(cam, WIDE, 800, feet);
    expect(cam.y).toBeCloseTo(feet - CAM_LIFT, 2);
    expect(cam.lead).toBe(0);
  });

  it('the lead is held through a jump (no bob) and dropped again on a wide level', () => {
    const cam = new Camera();
    const feet = 60 * TILE;
    cam.reset(player(300, feet - 15));
    settle(cam, TALL, 300, feet);
    const settled = cam.y;
    // a short hop inside the dead zone: the camera stays where it was, lead included
    for (let i = 0; i < 30; i++) cam.update(1 / 60, player(300, feet - 15 - 30, false), TALL, VIEW_W, VIEW_H, 1);
    expect(Math.abs(cam.y - settled)).toBeLessThan(1);
    expect(cam.lead).toBe(CAM_VERTICAL_LEAD);
    // landing on a ledge higher up re-centres on the new feet with the same lead
    const ledge = 40 * TILE;
    settle(cam, TALL, 300, ledge);
    expect(cam.y).toBeCloseTo(ledge - CAM_LIFT - CAM_VERTICAL_LEAD, 2);
    // the same camera on a wide level loses the lead on the first grounded frame
    settle(cam, WIDE, 800, 12 * TILE);
    expect(cam.lead).toBe(0);
    expect(cam.y).toBeCloseTo(12 * TILE - CAM_LIFT, 2);
  });

  it('reset clears the lead; the clamp still keeps the tower inside the view', () => {
    const cam = new Camera();
    settle(cam, TALL, 300, 60 * TILE);
    expect(cam.lead).toBe(CAM_VERTICAL_LEAD);
    cam.reset(player(300, 100));
    expect(cam.lead).toBe(0);
    // standing near the summit the target would be above the top clamp: the view stops at half the view height
    settle(cam, TALL, 300, 6 * TILE);
    expect(cam.y).toBe(VIEW_H / 2);
    // the 44-wide tower is narrower than a widescreen view (819 world units): centred horizontally
    for (let i = 0; i < 60; i++) cam.update(1 / 60, player(100, 60 * TILE - 15), TALL, 819, VIEW_H, 1);
    expect(cam.x).toBe(TALL.pxW / 2);
    // at the 512-wide default view the tower is wider than the view and the clamp holds the left edge
    settle(cam, TALL, 100, 60 * TILE);
    expect(cam.x).toBe(VIEW_W / 2);
  });
});
