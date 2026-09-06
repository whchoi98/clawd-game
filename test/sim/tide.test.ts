import { describe, it, expect } from 'vitest';
import { Sim } from '../../src/sim/sim.js';
import { Level } from '../../src/sim/level.js';
import { DAILY_ROWS, makeDailyLevel, bandBiome } from '../../src/sim/gen/daily.js';
import {
  CHUNK_BAND_ROWS, MAX_STEP_GAP, MAX_STEP_RISE, MAX_STUB_RISE, SUMMIT_ROW, buildTower, chunkBand, effectiveClimb, makeEndlessLevel,
  standableColumns, towerChunks, towerSteps,
} from '../../src/sim/gen/endless.js';
import type { TowerStep } from '../../src/sim/gen/endless.js';
import { CHUNK_W, CHUNK_X0 } from '../../src/sim/gen/chunks.js';
import { CHUNKS } from '../../src/sim/chunks.generated.js';
import { makeRng } from '../../src/sim/rng.js';
import { verifyReplay } from '../../src/sim/replay.js';
import { GEN_VERSION, SIM_VERSION } from '../../src/sim/types.js';
import type { LevelDef } from '../../src/sim/types.js';
import { dailySeed } from '../../src/server/daily.js';
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

/** Pairs of consecutive steps that are the inside of a chunk (entry → exit): the contract is relaxed there on purpose. */
function chunkInteriors(def: LevelDef): Set<string> {
  const out = new Set<string>();
  for (const c of towerChunks(def)) out.add(`${c.entry.y}:${c.exit.y}`);
  return out;
}
/** Rows that are chunk ledges (entry or exit): the generator never decorates them, so the stub checks skip them. */
function chunkLedgeRows(def: LevelDef): Set<number> {
  const out = new Set<number>();
  for (const c of towerChunks(def)) { out.add(c.entry.y); out.add(c.exit.y); }
  return out;
}
/** Chunk-free tower with the daily's shape, for the comparisons below. */
function bareDaily(seed: number): LevelDef {
  return buildTower(seed, { id: 'daily', name: '오늘의 탑', en: 'DAILY TOWER', hint: '', par: 200, rows: DAILY_ROWS, crystals: true });
}

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

  it('reachability contract outside chunks: every step rises at most 4 rows and gaps stay under 6 tiles', () => {
    for (const seed of [1, 99, 123456, 0xffffffff]) {
      for (const def of [makeDailyLevel(seed), makeEndlessLevel(seed)]) {
        const steps = towerSteps(def);
        const inside = chunkInteriors(def);
        expect(steps.length).toBeGreaterThan(20);
        for (let i = 1; i < steps.length; i++) {
          const a = steps[i - 1], b = steps[i];
          if (inside.has(`${a.y}:${b.y}`)) continue;
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

  it('grid-level contract over 40 seeds × both generators: the effective climb between consecutive steps outside chunks never exceeds 4 rows', () => {
    const worst: string[] = [];
    for (let seed = 1; seed <= 40; seed++) {
      for (const def of [makeDailyLevel(seed), makeEndlessLevel(seed)]) {
        const steps = towerSteps(def);
        const inside = chunkInteriors(def);
        const ledges = chunkLedgeRows(def);
        const deck = steps[steps.length - 1];
        expect(deck.y).toBe(SUMMIT_ROW);
        // the final platform keeps at least two open rows under the deck (never buried)
        expect(steps[steps.length - 2].y - SUMMIT_ROW).toBeGreaterThanOrEqual(3);
        for (let i = 1; i < steps.length; i++) {
          const a = steps[i - 1], b = steps[i];
          // every platform can be stood on somewhere (surface + two rows of headroom)
          expect(standableColumns(def.rows, b).length, `${def.id} seed ${seed} step ${i} is buried`).toBeGreaterThan(0);
          if (inside.has(`${a.y}:${b.y}`)) continue;      // a chunk's interior is the authored skill test, not a generated step
          const rise = effectiveClimb(def.rows, a, b);
          if (rise > MAX_STEP_RISE) worst.push(`${def.id} seed ${seed} step ${i} (rows ${a.y}→${b.y}): effective climb ${rise}`);
          const gap = Math.max(0, b.x0 - a.x1 - 1, a.x0 - b.x1 - 1);
          expect(gap).toBeLessThanOrEqual(MAX_STEP_GAP);
          // stub columns: at most MAX_STUB_RISE rows above their platform, never on the side facing the next step
          if (ledges.has(a.y)) continue;                    // chunk ledges carry chunk geometry, never a generated stub
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

// ---------------------------------------------------------------- P2-9 authored chunks
describe('authored chunks in the towers (GEN_VERSION 2)', () => {
  it('GEN_VERSION is 2: the chunk splice changed what a seed generates', () => {
    expect(GEN_VERSION).toBe(2);
    expect(CHUNKS.length).toBeGreaterThanOrEqual(12);
  });

  it('50 seeds × both towers: every full 50-row band holds one or two chunks, none overlap, and each sits verbatim in the grid', () => {
    const byId = new Map(CHUNKS.map((c) => [c.id, c]));
    let placed = 0;
    for (let seed = 1; seed <= 50; seed++) {
      for (const def of [makeDailyLevel(seed), makeEndlessLevel(seed)]) {
        const chunks = towerChunks(def);
        const fullBands = Math.floor((def.baseY! - SUMMIT_ROW) / CHUNK_BAND_ROWS);
        expect(fullBands).toBe(def.id === 'daily' ? 3 : 11);
        const perBand = new Array<number>(fullBands).fill(0);
        let lastBottom = Infinity;
        for (const c of chunks) {
          placed++;
          const src = byId.get(c.id)!;
          expect(src, `${def.id} seed ${seed}: unknown chunk ${c.id}`).toBeDefined();
          expect(c.tags).toEqual(src.tags);
          expect(c.y1 - c.y0 + 1).toBe(src.rows.length);
          // verbatim cells across the interior, the tower's side walls untouched
          for (let r = 0; r < src.rows.length; r++) {
            expect(def.rows[c.y0 + r].slice(CHUNK_X0, CHUNK_X0 + CHUNK_W)).toBe(src.rows[r]);
            expect(def.rows[c.y0 + r].slice(0, 2)).toBe('##');
            expect(def.rows[c.y0 + r].slice(-2)).toBe('##');
          }
          // ledges where the chunk says they are
          expect(c.entry).toEqual({ y: c.y1, x0: CHUNK_X0 + src.entry.x0, x1: CHUNK_X0 + src.entry.x1 });
          expect(c.exit).toEqual({ y: c.y0, x0: CHUNK_X0 + src.exit.x0, x1: CHUNK_X0 + src.exit.x1 });
          // bottom first, never overlapping, never buried by the summit deck
          expect(c.y1).toBeLessThan(lastBottom);
          lastBottom = c.y0;
          expect(c.y0).toBeGreaterThanOrEqual(SUMMIT_ROW + 6);
          const band = chunkBand(def.baseY!, c.entry.y);
          if (band < fullBands) perBand[band]++;
        }
        for (let b = 0; b < fullBands; b++) {
          expect(perBand[b], `${def.id} seed ${seed}: band ${b} has ${perBand[b]} chunks`).toBeGreaterThanOrEqual(1);
          expect(perBand[b], `${def.id} seed ${seed}: band ${b} has ${perBand[b]} chunks`).toBeLessThanOrEqual(2);
        }
        // the entry and exit ledges are consecutive steps of the climb
        const steps = towerSteps(def);
        for (const c of chunks) {
          const i = steps.findIndex((s) => s.y === c.entry.y && s.x0 === c.entry.x0 && s.x1 === c.entry.x1);
          expect(i).toBeGreaterThan(0);
          expect(steps[i + 1]).toEqual(c.exit);
        }
      }
    }
    expect(placed).toBeGreaterThan(50 * (3 + 11));
  });

  it('50 seeds: the steps into and out of every chunk keep the tower contract (rise ≤ 4, gap ≤ 5, effective climb ≤ 4, standable)', () => {
    const worst: string[] = [];
    for (let seed = 1; seed <= 50; seed++) {
      for (const def of [makeDailyLevel(seed), makeEndlessLevel(seed)]) {
        const steps = towerSteps(def);
        for (const c of towerChunks(def)) {
          const i = steps.findIndex((s) => s === c.entry || (s.y === c.entry.y && s.x0 === c.entry.x0));
          const below = steps[i - 1], above = steps[i + 2];
          for (const [a, b, what] of [[below, c.entry, 'into'], [c.exit, above, 'out of']] as const) {
            const rise = a.y - b.y;
            const gap = Math.max(0, b.x0 - a.x1 - 1, a.x0 - b.x1 - 1);
            const eff = effectiveClimb(def.rows, a, b);
            if (rise < 3 || rise > MAX_STEP_RISE || gap > MAX_STEP_GAP || eff > MAX_STEP_RISE || !standableColumns(def.rows, b).length) {
              worst.push(`${def.id} seed ${seed} ${what} ${c.id} (rows ${a.y}→${b.y}): rise ${rise} gap ${gap} effective ${eff}`);
            }
          }
        }
      }
    }
    expect(worst).toEqual([]);
  });

  it('every chunk gets used across 50 daily + endless seeds; a daily never repeats one, an endless tower repeats only once the list is spent (or the summit forces a shorter one)', () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 50; seed++) {
      const daily = towerChunks(makeDailyLevel(seed)).map((c) => c.id);
      expect(new Set(daily).size, `daily seed ${seed}: ${daily.join(' ')}`).toBe(daily.length);
      const endless = towerChunks(makeEndlessLevel(seed)).map((c) => c.id);
      const first = endless.slice(0, CHUNKS.length);
      // unused chunks are preferred; only the fit filter under the summit may force one early repeat
      expect(new Set(first).size, `endless seed ${seed}: ${first.join(' ')}`).toBeGreaterThanOrEqual(first.length - 1);
      for (const id of [...daily, ...endless]) seen.add(id);
    }
    expect([...seen].sort()).toEqual(CHUNKS.map((c) => c.id));
  });

  it('daily generation is deterministic and reproduces on the server: same seed → identical rows and placements, and the chunk list is part of it', () => {
    const a = makeDailyLevel(2026), b = makeDailyLevel(2026);
    expect(a.rows).toEqual(b.rows);
    expect(towerChunks(a)).toEqual(towerChunks(b));
    expect(towerChunks(a).length).toBeGreaterThanOrEqual(3);
    // a tower built from a different chunk list (or none) is a different tower — hence GEN_VERSION
    expect(bareDaily(2026).rows).not.toEqual(a.rows);
    expect(towerChunks(bareDaily(2026))).toEqual([]);
    const fewer = buildTower(2026, { id: 'daily', name: 'x', en: 'X', hint: '', par: 200, rows: DAILY_ROWS, crystals: true, chunks: CHUNKS.slice(0, 3) });
    expect(fewer.rows).not.toEqual(a.rows);
    expect(towerChunks(fewer).every((c) => CHUNKS.slice(0, 3).some((s) => s.id === c.id))).toBe(true);
  });

  it('the daily still loads and plays: P stands under the first climb, and a scripted run neither desyncs nor throws', () => {
    for (const seed of [1, 2, 3]) {
      const def = makeDailyLevel(seed);
      const a = new Sim(def), b = new Sim(def);
      for (let i = 0; i < 2400; i++) {
        const m = i % 40 < 20 ? 2 | 16 : 1;
        a.step(m); b.step(m);
      }
      expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
    }
  });

  it("verifying today's daily with chunks costs no more than +20 % over the same tower without them (24 000 ticks, tide off, best of 5)", () => {
    // the server regenerates the tower and replays the log; the cost is the entity count × ticks, and chunks
    // replace the platforms (and spawns) they cover, so the bill must not grow beyond the roadmap's bound
    const rng = makeRng(9);
    const masks = new Uint8Array(24_000);
    let cur = 0;
    for (let i = 0; i < masks.length; i++) {
      if (i % 12 === 0) { cur = rng.chance(0.7) ? (rng.chance(0.6) ? 2 : 1) : 0; if (rng.chance(0.35)) cur |= 16; if (rng.chance(0.15)) cur |= 32; }
      masks[i] = cur;
    }
    const time = (def: LevelDef): number => {
      let best = Infinity;
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        const v = verifyReplay(def, { v: SIM_VERSION, levelId: def.id, seed: def.seed, assist: false, masks });
        expect(v.reason).toBe('not-finished');
        best = Math.min(best, performance.now() - t0);
      }
      return best;
    };
    let withChunks = 0, without = 0;
    for (const seed of [dailySeed('2026-09-06', 'test-secret').seed, 42, 7]) {
      withChunks += time({ ...makeDailyLevel(seed), tide: undefined });
      without += time({ ...bareDaily(seed), tide: undefined });
    }
    expect(withChunks, `with chunks ${withChunks.toFixed(0)} ms vs without ${without.toFixed(0)} ms`).toBeLessThanOrEqual(without * 1.2 + 30);
  });
});
