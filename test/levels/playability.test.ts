/**
 * Playability probes on the hand-made zones: the situations the hints promise
 * are safe must be safe under a naive input policy, on the real geometry.
 */
import { describe, expect, it } from 'vitest';
import { ZONES } from '../../levels/build.js';
import { Sim } from '../../src/sim/sim.js';
import { IN, TILE } from '../../src/sim/types.js';
import type { LevelDef, SimEvent } from '../../src/sim/types.js';

const byId: Record<string, LevelDef> = Object.fromEntries(ZONES.map((z) => [z.id, z]));
const INTRO_TICKS = 60;

function playing(def: LevelDef): Sim {
  const sim = new Sim(def);
  for (let i = 0; i < INTRO_TICKS; i++) sim.step(0);
  sim.drainEvents();
  expect(sim.state.phase).toBe('play');
  return sim;
}

/** Teleport the player so its centre is at world x `cx` with its feet at world y `feet`. */
function place(sim: Sim, cx: number, feet: number): void {
  const p = sim.state.player;
  p.x = cx - p.w / 2;
  p.y = feet - p.h;
  p.vx = 0; p.vy = 0;
  p.grounded = false;
}

function fatal(ev: SimEvent[]): string[] {
  return ev.filter((e) => e.type === 'hurt' || e.type === 'death').map((e) => e.type);
}

/** Contiguous runs of water surface in the given row → [x0, x1] tile ranges. */
function pools(def: LevelDef, row: number): [number, number][] {
  const out: [number, number][] = [];
  const r = def.rows[row];
  let start = -1;
  for (let x = 0; x <= r.length; x++) {
    const water = x < r.length && r[x] === '~';
    if (water && start < 0) start = x;
    if (!water && start >= 0) { out.push([start, x - 1]); start = -1; }
  }
  return out;
}

describe('t2 — the pools are a safety net', () => {
  const t2 = byId.t2;
  const surfaceRow = t2.rows.findIndex((r) => r.includes('~'));
  const ps = pools(t2, surfaceRow);

  it('has three pools, each with rock under it (the map bottom is never open under water)', () => {
    expect(ps.length).toBe(3);
    for (const [x0, x1] of ps) {
      for (let x = x0; x <= x1; x++) {
        let bed = false;
        for (let y = surfaceRow + 1; y < t2.rows.length; y++) {
          const ch = t2.rows[y][x];
          if (ch === '#') { bed = true; break; }
          expect(ch, `t2 column ${x} row ${y} under water should be water or rock`).toBe('W');
        }
        expect(bed, `t2 column ${x} has no rock under the water`).toBe(true);
      }
    }
  });

  for (const [x0, x1] of ps) {
    for (const where of ['left', 'centre', 'right'] as const) {
      it(`pool x=${x0}..${x1}, dropped at the ${where}: hold toward the nearest bank + tap JUMP → standing on rock within 4 s, no damage`, () => {
        const sim = playing(t2);
        const p = sim.state.player;
        const L = sim.level;
        const cx = where === 'left' ? (x0 + 1) * TILE + TILE / 2
          : where === 'right' ? x1 * TILE - TILE / 2
          : ((x0 + x1 + 1) / 2) * TILE;
        // everything spent on the way in, one tile above the surface
        place(sim, cx, surfaceRow * TILE - TILE);
        p.jumps = 2;
        p.dashReady = false;
        sim.drainEvents();

        const leftBank = x0 * TILE, rightBank = (x1 + 1) * TILE;
        let standing = -1;
        const bad: string[] = [];
        for (let i = 0; i < 480; i++) {
          const c = p.x + p.w / 2;
          const dir = c - leftBank < rightBank - c ? IN.LEFT : IN.RIGHT;
          // a player mashing jump: 20 ticks held, 4 released
          const mask = dir | (i % 24 < 20 ? IN.JUMP : 0);
          sim.step(mask);
          bad.push(...fatal(sim.drainEvents()));
          const feet = p.y + p.h;
          const onRock = L.solidPx(c, feet + 1) && !L.waterPx(c, feet - 2);
          if (p.grounded && !p.inWater && onRock) { standing = i; break; }
        }
        expect(bad).toEqual([]);
        expect(standing, 'never stood on rock').toBeGreaterThanOrEqual(0);
        expect(standing).toBeLessThan(480);
        expect(p.dead).toBe(false);
      });
    }
  }
});

/**
 * Walk off the bank edge at `edgeTx` (moving `dir`), then steer to keep the
 * centre inside the column at `colTx`. Returns the fatal events and the
 * highest point (lowest y) the feet reached, in world units.
 */
function rideColumn(sim: Sim, edgeTx: number, bankTop: number, colTx: number, dir: 1 | -1, ticks: number): { bad: string[]; topFeet: number } {
  const p = sim.state.player;
  place(sim, edgeTx * TILE + TILE / 2, bankTop * TILE);
  p.grounded = true;
  sim.drainEvents();
  const colX = colTx * TILE + TILE / 2;
  const bad: string[] = [];
  let topFeet = Infinity;
  for (let i = 0; i < ticks; i++) {
    const c = p.x + p.w / 2;
    let mask = 0;
    if (p.grounded) mask = dir > 0 ? IN.RIGHT : IN.LEFT;   // step off the edge
    else if (c < colX - 2) mask = IN.RIGHT;                 // steer into the column
    else if (c > colX + 2) mask = IN.LEFT;
    sim.step(mask);
    bad.push(...fatal(sim.drainEvents()));
    topFeet = Math.min(topFeet, p.y + p.h);
  }
  return { bad, topFeet };
}

describe('updraft pits are entered from the bank edge and catch the player', () => {
  it('v2: stepping off the start yard into the first column lifts the player to cliff height, no spikes touched', () => {
    const v2 = byId.v2;
    const F = 24;
    const sim = playing(v2);
    // the yard ends at x=16 and the column stands at x=17, flush with the edge
    expect(v2.rows[F][16]).toBe('#');
    expect(v2.rows[F][17]).toBe('.');
    expect(v2.rows[F + 1][17]).toBe('z');
    const { bad, topFeet } = rideColumn(sim, 16, F, 17, 1, 240);
    expect(bad).toEqual([]);
    expect(topFeet).toBeLessThanOrEqual((F - 10) * TILE);   // cliff top row
    expect(sim.state.player.dead).toBe(false);
  });

  it('v3: stepping off the summit shelf into the column lifts the player above the shelf, no spikes touched', () => {
    const v3 = byId.v3;
    const F = 26;
    const sim = playing(v3);
    expect(v3.rows[F - 15][82]).toBe('#');
    expect(v3.rows[F - 15][83]).toBe('.');
    expect(v3.rows[F - 14][83]).toBe('z');
    const { bad, topFeet } = rideColumn(sim, 82, F - 15, 83, 1, 240);
    expect(bad).toEqual([]);
    expect(topFeet).toBeLessThan((F - 15) * TILE - 4 * TILE);
    expect(sim.state.player.dead).toBe(false);
  });
});
