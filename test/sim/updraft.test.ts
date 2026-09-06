import { describe, it, expect } from 'vitest';
import { TILE } from '../../src/sim/types.js';
import { updraftRoom } from '../fixtures/levels.js';
import { DN, playing } from './helpers.js';

/** Top of the updraft column in the fixture (row 8) — where a falling centre enters it. */
const COLUMN_TOP = 8 * TILE;

describe('updraft columns', () => {
  it('catches a falling player with no jumps and no dash, and lifts it back above the entry height within 1 s', () => {
    const sim = playing(updraftRoom());
    const p = sim.state.player;
    p.jumps = 2;
    p.dashReady = false;
    const draft = sim.state.entities.find((e) => e.kind === 'updraft')!;
    expect(draft).toBeDefined();
    expect(draft.y - draft.h / 2).toBeCloseTo(COLUMN_TOP, 5);

    let entered = -1, entryY = 0, deepest = -Infinity, rose = -1;
    const bad: string[] = [];
    for (let i = 0; i < 240; i++) {
      sim.step(0);
      for (const e of sim.drainEvents()) if (e.type === 'hurt' || e.type === 'death') bad.push(e.type);
      const cy = p.y + p.h / 2;
      if (entered < 0 && cy >= COLUMN_TOP) { entered = i; entryY = p.y; }
      if (entered >= 0) {
        deepest = Math.max(deepest, p.y + p.h);
        if (rose < 0 && p.y < entryY) rose = i;
      }
    }
    expect(bad).toEqual([]);
    expect(entered).toBeGreaterThan(20);           // it really fell first
    expect(rose).toBeGreaterThan(entered);
    expect(rose - entered).toBeLessThanOrEqual(120);
    // the catch is immediate: the feet sink less than half a tile past the entry point
    expect(deepest - (entryY + p.h)).toBeLessThan(TILE / 2);
    expect(p.dead).toBe(false);
    expect(p.hp).toBe(3);
  });

  it('cancels a stomp on entry and never lets the stomp reach the spikes', () => {
    const sim = playing(updraftRoom());
    const p = sim.state.player;
    let stomped = false;
    const bad: string[] = [];
    // ticks in a row with the centre inside the column and the stomp still on:
    // the column reads the position from the top of the tick, so one tick of overlap is the latency budget
    let inside = 0, worst = 0;
    for (let i = 0; i < 240; i++) {
      sim.step(DN);
      for (const e of sim.drainEvents()) {
        if (e.type === 'stomp') stomped = true;
        if (e.type === 'hurt' || e.type === 'death') bad.push(e.type);
      }
      const cy = p.y + p.h / 2;
      inside = cy >= COLUMN_TOP && p.stomping ? inside + 1 : 0;
      worst = Math.max(worst, inside);
    }
    expect(stomped).toBe(true);
    expect(worst).toBeLessThanOrEqual(1);
    expect(bad).toEqual([]);
    expect(p.y + p.h).toBeLessThan(20 * TILE - TILE);   // never near the spike row
  });

  it('a dash is not overridden by the column', () => {
    const sim = playing(updraftRoom());
    const p = sim.state.player;
    // fall into the column, then dash straight down through it: the dash owns vy while it lasts
    for (let i = 0; i < 240 && p.y + p.h / 2 < COLUMN_TOP; i++) sim.step(0);
    expect(p.y + p.h / 2).toBeGreaterThanOrEqual(COLUMN_TOP);
    sim.step(32 | DN);
    expect(p.dashT).toBeGreaterThan(0);
    expect(p.vy).toBeGreaterThan(200);
    sim.step(32 | DN);
    expect(p.vy).toBeGreaterThan(200);
  });
});
