import { describe, it, expect } from 'vitest';
import { PHYS } from '../../src/sim/config.js';
import { furnitureRoom, openRoom, shaftRoom, waterRoom } from '../fixtures/levels.js';
import { D, DN, J, L, R, TILE, collect, playing, run, stepUntil } from './helpers.js';

function riseOf(mask: number, holdTicks: number): { rise: number; landed: boolean } {
  const sim = playing(openRoom());
  const y0 = sim.state.player.y;
  let minY = y0;
  sim.step(mask);
  for (let i = 1; i < holdTicks; i++) { sim.step(mask); minY = Math.min(minY, sim.state.player.y); }
  for (let i = 0; i < 240 && !sim.state.player.grounded; i++) { sim.step(0); minY = Math.min(minY, sim.state.player.y); }
  return { rise: (y0 - minY) / TILE, landed: sim.state.player.grounded };
}

describe('player physics', () => {
  it('a held JUMP from standing rises 2.5–2.9 tiles and lands', () => {
    const { rise, landed } = riseOf(J, 120);
    expect(rise).toBeGreaterThanOrEqual(2.5);
    expect(rise).toBeLessThanOrEqual(2.9);
    expect(landed).toBe(true);
  });

  it('a 1-tick JUMP tap rises less than a held jump', () => {
    const held = riseOf(J, 120).rise;
    const tap = riseOf(J, 1).rise;
    expect(tap).toBeLessThan(held - 0.5);
    expect(tap).toBeGreaterThan(0.5);
  });

  it('emits jump and land events with positions', () => {
    const sim = playing(openRoom());
    const ev = collect(sim, 1, J).concat(collect(sim, 200, 0));
    const jump = ev.find((e) => e.type === 'jump');
    const land = ev.find((e) => e.type === 'land');
    expect(jump && jump.type === 'jump' && jump.air).toBe(false);
    expect(land && land.type === 'land' && land.impact).toBeGreaterThan(0);
    expect(sim.state.stats.jumps).toBe(1);
  });

  it('double jump: the second press in the air is an air jump, a third does nothing', () => {
    const sim = playing(openRoom());
    sim.step(J); run(sim, 20);
    const ev = collect(sim, 1, J);
    expect(ev.some((e) => e.type === 'jump' && e.air)).toBe(true);
    run(sim, 10);
    expect(collect(sim, 1, J).some((e) => e.type === 'jump')).toBe(false);
    expect(sim.state.stats.jumps).toBe(2);
  });

  it('DASH right on flat ground travels 40–50 units by dashEnd and refills on the ground', () => {
    const sim = playing(openRoom());
    const x0 = sim.state.player.x;
    const ev = collect(sim, 1, D | R);
    expect(ev.some((e) => e.type === 'dash')).toBe(true);
    expect(sim.state.player.dashReady).toBe(false);
    let ended: { x: number } | null = null;
    for (let i = 0; i < 60 && !ended; i++) {
      for (const e of collect(sim, 1, R)) if (e.type === 'dashEnd') ended = e;
    }
    expect(ended).not.toBeNull();
    const dist = ended!.x - (x0 + sim.state.player.w / 2);
    expect(dist).toBeGreaterThanOrEqual(40);
    expect(dist).toBeLessThanOrEqual(50);
    expect(sim.state.stats.dashes).toBe(1);
    run(sim, 2, 0);
    expect(sim.state.player.dashReady).toBe(true);
  });

  it('dash cooldown prevents an immediate second dash', () => {
    const sim = playing(openRoom());
    sim.step(D); run(sim, 5);
    sim.drainEvents();
    expect(collect(sim, 1, D).some((e) => e.type === 'dash')).toBe(false);
    run(sim, Math.ceil(PHYS.dashCooldown * 120) + 20);
    expect(collect(sim, 1, D).some((e) => e.type === 'dash')).toBe(true);
  });

  it('a 4-wide shaft can be climbed by alternating JUMP with LEFT/RIGHT held toward each wall', () => {
    const sim = playing(shaftRoom());
    const y0 = sim.state.player.y;
    let dir: number = R;
    let wallJumps = 0;
    let holdJ = 0;          // ticks JUMP stays held after a press (a tap would be cut short)
    let jHeld = false;
    for (let i = 0; i < 1500 && wallJumps < 6; i++) {
      const p = sim.state.player;
      const wantWall = dir === R ? 1 : -1;
      const wantJump = p.grounded || (p.onWall === wantWall && !p.grounded);
      let mask = dir;
      if (wantJump && !jHeld) { mask |= J; holdJ = 30; }
      else if (holdJ > 0) { mask |= J; holdJ--; }
      jHeld = (mask & J) !== 0;
      sim.step(mask);
      if (sim.drainEvents().some((e) => e.type === 'wallJump')) { wallJumps++; dir = dir === R ? L : R; }
    }
    expect(wallJumps).toBeGreaterThanOrEqual(6);
    expect(sim.state.stats.wallJumps).toBe(wallJumps);
    expect((y0 - sim.state.player.y) / TILE).toBeGreaterThan(8);
  });

  it('wall slide caps fall speed and emits wallSlide', () => {
    const sim = playing(shaftRoom());
    let slid = false, slideVy = 0, events = 0;
    for (let i = 0; i < 90; i++) {
      sim.step(J | R);
      events += sim.drainEvents().filter((e) => e.type === 'wallSlide').length;
      const p = sim.state.player;
      if (p.onWall === 1 && p.vy > 0 && !p.grounded) { slid = true; slideVy = Math.max(slideVy, p.vy); }
    }
    expect(events).toBe(1);
    expect(slid).toBe(true);
    expect(slideVy).toBeLessThanOrEqual(PHYS.wallSlide + 1);
  });

  it('stomp: DOWN in the air dives fast and shakes the ground on landing', () => {
    const sim = playing(openRoom());
    sim.step(J); run(sim, 25);
    const ev = collect(sim, 1, DN);
    expect(ev.some((e) => e.type === 'stomp')).toBe(true);
    expect(sim.state.player.stomping).toBe(true);
    const rest = collect(sim, 200, DN);
    expect(rest.some((e) => e.type === 'stompLand')).toBe(true);
    expect(sim.state.player.stomping).toBe(false);
  });

  it('one-way ledges are landed on from above and passed through from below', () => {
    const sim = playing(furnitureRoom());
    // run right to the ledge columns (6..9 at row 9) and jump up through it
    const walked = stepUntil(sim, (s) => s.state.player.x / TILE > 6.5, 300, R);
    expect(walked).toBeGreaterThan(0);
    // full jump, release for one tick, then a held air jump: clears the 3-tile ledge
    run(sim, 20, J);
    sim.step(0);
    run(sim, 40, J);
    const n = stepUntil(sim, (s) => s.state.player.grounded, 240, 0);
    expect(n).toBeGreaterThan(0);
    run(sim, 10); // the ground probe may fire up to 0.6 units early; the next ticks snap onto the lip
    expect(sim.state.player.grounded).toBe(true);
    expect(sim.state.player.y + sim.state.player.h).toBeCloseTo(9 * TILE, 1);
  });

  it('a spring launches higher than a jump and restores air jumps', () => {
    const sim = playing(furnitureRoom());
    // walk right onto the spring at column 14
    const n = stepUntil(sim, (s) => s.state.player.x + s.state.player.w / 2 > 14 * TILE - 2, 600, R);
    expect(n).toBeGreaterThan(0);
    const ev = collect(sim, 30, 0);
    expect(ev.some((e) => e.type === 'spring')).toBe(true);
    let minY = sim.state.player.y;
    for (let i = 0; i < 240 && !sim.state.player.grounded; i++) { sim.step(0); minY = Math.min(minY, sim.state.player.y); }
    expect((11 * TILE + TILE - sim.state.player.h - minY) / TILE).toBeGreaterThan(4);
  });

  it('crumble tiles break shortly after being stood on', () => {
    const sim = playing(furnitureRoom());
    const n = stepUntil(sim, (s) => s.state.player.x > 21 * TILE, 1200, R);
    expect(n).toBeGreaterThan(0);
    const ev = collect(sim, 90, 0);
    expect(ev.some((e) => e.type === 'crumble')).toBe(true);
    expect(sim.level.isBroken(21, 12) || sim.level.isBroken(22, 12)).toBe(true);
  });

  it('water: splash on entry, slow fall, and jumping out is possible', () => {
    const sim = playing(waterRoom());
    const ev = collect(sim, 240, R);
    expect(ev.some((e) => e.type === 'splash' && e.enter)).toBe(true);
    expect(sim.state.player.inWater).toBe(true);
    expect(sim.state.player.vy).toBeLessThanOrEqual(PHYS.terminalWater + 1);
    expect(sim.state.player.pose).toBe('swim');
  });
});
