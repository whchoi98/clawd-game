import { describe, it, expect } from 'vitest';
import { Sim } from '../../src/sim/sim.js';
import { Level } from '../../src/sim/level.js';
import { makeDailyLevel, bandBiome } from '../../src/sim/gen/daily.js';
import { makeEndlessLevel, towerSteps } from '../../src/sim/gen/endless.js';
import { tideRoom } from '../fixtures/levels.js';
import { collect, playing, run } from './helpers.js';

describe('tide', () => {
  it('rises, kills on contact and finishes the sim with tideOver', () => {
    const sim = playing(tideRoom());
    expect(sim.state.tide).toBeDefined();
    const y0 = sim.state.tide!.y;
    run(sim, 120);
    expect(sim.state.tide!.y).toBeLessThan(y0);
    const ev = collect(sim, 2400, 0);
    const death = ev.find((e) => e.type === 'death');
    expect(death && death.type === 'death' && death.cause).toBe('tide');
    const over = ev.find((e) => e.type === 'tideOver');
    expect(over).toBeDefined();
    expect(sim.state.phase).toBe('over');
    expect(sim.finished).toBe(true);
    expect(sim.summary().cleared).toBe(false);
    expect(sim.summary().height).toBeLessThan(0.01);
    // further steps are inert
    const t = sim.state.tick;
    run(sim, 10);
    expect(sim.state.tick).toBe(t);
  });
});

describe('generators', () => {
  it('makeDailyLevel: finite tower with P, G at the summit, tide and ~150 rows', () => {
    const def = makeDailyLevel(42);
    expect(def.id).toBe('daily');
    expect(def.tide).toBe(true);
    expect(def.baseY).toBeGreaterThan(100);
    expect(def.rows.length).toBeGreaterThanOrEqual(150);
    expect(def.rows.length).toBeLessThanOrEqual(170);
    const w = def.rows[0].length;
    for (const r of def.rows) expect(r.length).toBe(w);
    const lvl = new Level(def);
    const P = lvl.spawns.filter((s) => s.ch === 'P');
    const G = lvl.spawns.filter((s) => s.ch === 'G');
    expect(P.length).toBe(1);
    expect(G.length).toBe(1);
    expect(G[0].ty).toBeLessThan(10);
    expect(lvl.solid(P[0].tx, P[0].ty)).toBe(false);
    expect(lvl.solid(P[0].tx, P[0].ty + 1)).toBe(true);
    expect(lvl.solid(G[0].tx, G[0].ty)).toBe(false);
    expect(lvl.solid(G[0].tx, G[0].ty + 1)).toBe(true);
    expect(lvl.totalShards).toBeGreaterThan(20);
    expect(def.biome).toBe(bandBiome(def, def.baseY!));
    expect(bandBiome(def, def.baseY! - 51)).not.toBe(def.biome);
    expect(bandBiome(def, def.baseY! - 151)).toBe(def.biome);
  });

  it('same seed → same level, different seed → different level; the sim loads it', () => {
    const a = makeDailyLevel(7), b = makeDailyLevel(7), c = makeDailyLevel(8);
    expect(a.rows).toEqual(b.rows);
    expect(a.rows).not.toEqual(c.rows);
    const sim = new Sim(a);
    run(sim, 200);
    expect(sim.state.phase).toBe('play');
    expect(sim.state.player.dead).toBe(false);
  });

  it('reachability contract: every step rises at most 4 rows and gaps stay under 6 tiles', () => {
    for (const seed of [1, 99, 123456, 0xffffffff]) {
      for (const def of [makeDailyLevel(seed), makeEndlessLevel(seed)]) {
        const steps = towerSteps(def);
        expect(steps.length).toBeGreaterThan(20);
        for (let i = 1; i < steps.length; i++) {
          const a = steps[i - 1], b = steps[i];
          expect(a.y - b.y).toBeGreaterThanOrEqual(1);
          expect(a.y - b.y).toBeLessThanOrEqual(4);
          const gap = Math.max(0, b.x0 - a.x1 - 1, a.x0 - b.x1 - 1);
          expect(gap).toBeLessThanOrEqual(5);
        }
      }
    }
  });

  it('makeEndlessLevel: 560 rows, id endless, tide', () => {
    const def = makeEndlessLevel(3);
    expect(def.id).toBe('endless');
    expect(def.rows.length).toBe(560);
    expect(def.tide).toBe(true);
    expect(def.baseY).toBe(556);
    const lvl = new Level(def);
    expect(lvl.spawns.filter((s) => s.ch === 'P').length).toBe(1);
    expect(lvl.spawns.filter((s) => s.ch === 'G').length).toBe(1);
    const sim = new Sim(def);
    run(sim, 100);
    expect(sim.state.tide!.height).toBeLessThan(0.01);
  });
});
