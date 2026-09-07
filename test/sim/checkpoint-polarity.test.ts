/**
 * SIM_VERSION 3 — a respawn restores the switch polarity the player had when
 * the checkpoint was taken. Before, `respawn()` reset switchA to true, so a
 * checkpoint behind a toggle stranded a respawned player in front of gates
 * that were open when they arrived (s2's C at column 42, every '&' bridge).
 */
import { describe, expect, it } from 'vitest';
import { polarityRoom } from '../fixtures/levels.js';
import { D, L, R, RETRY, TILE, playing, stepUntil } from './helpers.js';

describe('checkpoints remember the switch polarity', () => {
  it('a checkpoint taken in the flipped polarity respawns flipped: level, state and toggle entity agree', () => {
    const sim = playing(polarityRoom());
    expect(sim.state.switchA).toBe(true);
    // dash through the toggle at column 6
    expect(stepUntil(sim, (s) => s.state.player.x > 4 * TILE, 300, R)).toBeGreaterThan(0);
    sim.step(D | R);
    expect(stepUntil(sim, (s) => !s.state.switchA, 60, R)).toBeGreaterThanOrEqual(0);
    expect(sim.level.switchA).toBe(false);
    expect(sim.level.solid(30, 10)).toBe(false);
    expect(sim.level.solid(34, 10)).toBe(true);
    // take the checkpoint at column 12, then walk into the pit
    let checkpoint = false;
    const n = stepUntil(sim, (s) => {
      for (const e of s.drainEvents()) if (e.type === 'checkpoint') checkpoint = true;
      return s.state.phase === 'dying';
    }, 1200, R);
    expect(n).toBeGreaterThan(0);
    expect(checkpoint).toBe(true);
    expect(sim.state.stats.deaths).toBe(1);
    expect(stepUntil(sim, (s) => s.state.phase === 'play', 200)).toBeGreaterThan(0);
    // back at the checkpoint, still flipped
    expect(sim.state.player.x + sim.state.player.w / 2).toBeCloseTo(12 * TILE + TILE / 2, 3);
    expect(sim.state.switchA).toBe(false);
    expect(sim.level.switchA).toBe(false);
    expect(sim.level.solid(30, 10)).toBe(false);
    expect(sim.level.solid(34, 10)).toBe(true);
    expect(sim.state.entities.find((e) => e.kind === 'toggle')!.state).toBe(0);
  });

  it('a checkpoint taken in the start polarity respawns in it, even after a flip on the way to the death', () => {
    const sim = playing(polarityRoom());
    // walk (never dash) past the toggle to the checkpoint, then dash back through the toggle and die in the pit
    expect(stepUntil(sim, (s) => s.state.player.x > 13 * TILE, 1200, R)).toBeGreaterThan(0);
    expect(sim.state.switchA).toBe(true);
    expect(stepUntil(sim, (s) => s.state.player.x < 8 * TILE, 1200, L)).toBeGreaterThan(0);
    sim.step(D | L);
    expect(stepUntil(sim, (s) => !s.state.switchA, 60, L)).toBeGreaterThanOrEqual(0);
    expect(stepUntil(sim, (s) => s.state.phase === 'dying', 2400, R)).toBeGreaterThan(0);
    expect(stepUntil(sim, (s) => s.state.phase === 'play', 200)).toBeGreaterThan(0);
    expect(sim.state.switchA).toBe(true);
    expect(sim.level.switchA).toBe(true);
    expect(sim.state.entities.find((e) => e.kind === 'toggle')!.state).toBe(1);
  });

  it('with no checkpoint taken a respawn is the start polarity (true), whatever the player flipped', () => {
    const sim = playing(polarityRoom());
    expect(stepUntil(sim, (s) => s.state.player.x > 4 * TILE, 300, R)).toBeGreaterThan(0);
    sim.step(D | R);
    expect(stepUntil(sim, (s) => !s.state.switchA, 60, R)).toBeGreaterThanOrEqual(0);
    // die before the checkpoint: RETRY
    sim.step(R | RETRY);
    expect(sim.state.phase).toBe('dying');
    expect(stepUntil(sim, (s) => s.state.phase === 'play', 200)).toBeGreaterThan(0);
    expect(sim.state.switchA).toBe(true);
    expect(sim.level.switchA).toBe(true);
  });
});
