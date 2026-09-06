import { describe, it, expect } from 'vitest';
import { Sim } from '../../src/sim/sim.js';
import { Level } from '../../src/sim/level.js';
import { makeDailyLevel, bandBiome } from '../../src/sim/gen/daily.js';
import {
  MAX_STEP_GAP, MAX_STEP_RISE, MAX_STUB_RISE, SUMMIT_ROW, effectiveClimb, makeEndlessLevel, standableColumns, towerSteps,
} from '../../src/sim/gen/endless.js';
import type { TowerStep } from '../../src/sim/gen/endless.js';
import type { LevelDef } from '../../src/sim/types.js';
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

  /** Height of a stub column standing at `x` on the row of `s` (0 when there is none). */
  function stubHeight(def: LevelDef, s: TowerStep, x: number): number {
    const rows = def.rows;
    if (x <= 1 || x >= rows[0].length - 2) return 0;      // the tower's side walls
    if (rows[s.y][x] !== '#' || rows[s.y][x - 1] === '#' && rows[s.y][x + 1] === '#') return 0;
    if (rows[s.y + 1]?.[x] === '#') return 0;              // a column rising from a lower platform, not this one's stub
    let n = 0;
    while (s.y - n >= 0 && rows[s.y - n][x] === '#') n++;
    return n;
  }

  it('grid-level contract over 40 seeds × both generators: the effective climb between consecutive steps never exceeds 4 rows', () => {
    const worst: string[] = [];
    for (let seed = 1; seed <= 40; seed++) {
      for (const def of [makeDailyLevel(seed), makeEndlessLevel(seed)]) {
        const steps = towerSteps(def);
        const deck = steps[steps.length - 1];
        expect(deck.y).toBe(SUMMIT_ROW);
        // the final platform keeps at least two open rows under the deck (never buried)
        expect(steps[steps.length - 2].y - SUMMIT_ROW).toBeGreaterThanOrEqual(3);
        for (let i = 1; i < steps.length; i++) {
          const a = steps[i - 1], b = steps[i];
          // every platform can be stood on somewhere (surface + two rows of headroom)
          expect(standableColumns(def.rows, b).length, `${def.id} seed ${seed} step ${i} is buried`).toBeGreaterThan(0);
          const rise = effectiveClimb(def.rows, a, b);
          if (rise > MAX_STEP_RISE) worst.push(`${def.id} seed ${seed} step ${i} (rows ${a.y}→${b.y}): effective climb ${rise}`);
          const gap = Math.max(0, b.x0 - a.x1 - 1, a.x0 - b.x1 - 1);
          expect(gap).toBeLessThanOrEqual(MAX_STEP_GAP);
          // stub columns: at most MAX_STUB_RISE rows above their platform, never on the side facing the next step
          for (const x of [a.x0 - 2, a.x1 + 2]) {
            const n = stubHeight(def, a, x);
            if (n === 0) continue;
            expect(n - 1, `${def.id} seed ${seed} stub at (${x},${a.y}) is ${n} tall`).toBeLessThanOrEqual(MAX_STUB_RISE);
            const facing = x > a.x1 ? b.x0 > a.x1 : b.x1 < a.x0;
            expect(facing, `${def.id} seed ${seed} stub at (${x},${a.y}) faces the next step`).toBe(false);
          }
        }
      }
    }
    expect(worst).toEqual([]);
  });

  it('effectiveClimb reads the grid: a stub in the gap and a deck over the landing raise the climb, a one-way ledge is passed from below', () => {
    const rows = (lines: string[]): string[] => lines;
    const a = { y: 8, x0: 2, x1: 5 }, b = { y: 5, x0: 9, x1: 12 };
    const clean = rows([
      '..............', '..............', '..............', '..............', '..............',
      '.........####.', '..............', '..............', '..####........', '..............',
    ]);
    expect(effectiveClimb(clean, a, b)).toBe(3);
    const stub = clean.map((r, y) => (y >= 3 && y <= 8 ? r.slice(0, 7) + '#' + r.slice(8) : r));
    expect(effectiveClimb(stub, a, b)).toBe(5);
    const buried = clean.map((r, y) => (y === 4 ? '.........####.' : r));
    expect(effectiveClimb(buried, a, b)).toBe(Infinity);
    const over = { y: 5, x0: 2, x1: 5 };
    const solidOver = clean.map((r, y) => (y === 5 ? '..####........' : r));
    expect(effectiveClimb(solidOver, a, over)).toBe(3);
    const oneWayOver = clean.map((r, y) => (y === 5 ? '..====........' : r));
    expect(effectiveClimb(oneWayOver, a, over)).toBe(3);
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
