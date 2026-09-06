import { describe, expect, it } from 'vitest';
import { census, validate } from '../../levels/dsl.js';
import { ZONES } from '../../levels/build.js';
import { Level } from '../../src/sim/level.js';
import type { LevelDef } from '../../src/sim/types.js';
import { hasRawKeyName, hintFor } from '../../src/client/ui/hints.js';

const ORDER = ['t1', 't2', 't3', 's1', 's2', 's3', 'v1', 'v2', 'v3'];
const PAR: Record<string, number> = { t1: 45, t2: 55, t3: 70, s1: 60, s2: 75, s3: 90, v1: 70, v2: 85, v3: 120 };
const BIOME: Record<string, string> = {
  t1: 'tidepool', t2: 'tidepool', t3: 'tidepool',
  s1: 'stormspire', s2: 'stormspire', s3: 'stormspire',
  v1: 'voidreef', v2: 'voidreef', v3: 'voidreef',
};
const HANGUL = /[가-힣]/;

const byId: Record<string, LevelDef> = Object.fromEntries(ZONES.map((z) => [z.id, z]));

describe('the nine zones', () => {
  it('are exactly t1..v3 in tower order with the planned biomes and pars', () => {
    expect(ZONES.map((z) => z.id)).toEqual(ORDER);
    for (const z of ZONES) {
      expect(z.biome).toBe(BIOME[z.id]);
      expect(z.par).toBe(PAR[z.id]);
    }
  });

  it('have distinct seeds and Korean names and hints', () => {
    const seeds = new Set(ZONES.map((z) => z.seed));
    expect(seeds.size).toBe(ZONES.length);
    for (const z of ZONES) {
      expect(z.name).toMatch(HANGUL);
      expect(z.hint ?? '').toMatch(HANGUL);
      expect(z.hint ?? '').not.toMatch(/\n/);
      expect(z.en).toMatch(/^[A-Z' ]+$/);
    }
  });

  it('hints are device-neutral token templates that render for keyboard, gamepad and touch', () => {
    for (const z of ZONES) {
      expect(hasRawKeyName(z.hint ?? ''), `${z.id}: ${z.hint}`).toBe(false);
      for (const device of ['keyboard', 'gamepad', 'touch'] as const) {
        const text = hintFor(z, device);
        expect(text, `${z.id}/${device}`).toMatch(HANGUL);
        expect(text).not.toMatch(/\{[a-z]+\}/);
      }
      expect(hintFor(z, 'touch')).not.toMatch(/Shift|Space|←|→/);
    }
    // the zones that teach a control name it through a token
    expect(byId.t1.hint).toMatch(/\{move\}/);
    expect(byId.t1.hint).toMatch(/\{jump\}/);
    expect(byId.t2.hint).toMatch(/\{dash\}/);
    expect(byId.s3.hint).toMatch(/\{stomp\}/);
  });

  for (const id of ORDER) {
    describe(id, () => {
      it('passes every validator rule', () => {
        expect(validate(byId[id])).toEqual([]);
      });

      it('is 60–120 columns by 16–30 rows', () => {
        const c = census(byId[id]);
        expect(c.w).toBeGreaterThanOrEqual(60);
        expect(c.w).toBeLessThanOrEqual(120);
        expect(c.h).toBeGreaterThanOrEqual(16);
        expect(c.h).toBeLessThanOrEqual(30);
      });

      it('has 18–32 shards, exactly one relic and the required checkpoints', () => {
        const c = census(byId[id]);
        expect(c.shards).toBeGreaterThanOrEqual(18);
        expect(c.shards).toBeLessThanOrEqual(32);
        expect(c.relics).toBe(1);
        if (id !== 't1') expect(c.checkpoints).toBeGreaterThanOrEqual(1);
      });

      it('loads as a Level whose start cell is open and stands on rock', () => {
        const lv = new Level(byId[id]);
        const p = lv.spawns.find((s) => s.ch === 'P')!;
        expect(p).toBeDefined();
        expect(lv.solid(p.tx, p.ty)).toBe(false);
        expect(lv.solid(p.tx, p.ty + 1)).toBe(true);
        const g = lv.spawns.find((s) => s.ch === 'G')!;
        expect(lv.solid(g.tx, g.ty)).toBe(false);
        expect(lv.solid(g.tx, g.ty + 1)).toBe(true);
        expect(lv.totalShards).toBe(census(byId[id]).shards);
        expect(lv.totalRelics).toBe(1);
      });

      it('lists spikers only on open cells above rock', () => {
        const lv = new Level(byId[id]);
        for (const [tx, ty] of byId[id].spikers ?? []) {
          expect(lv.solid(tx, ty)).toBe(false);
          expect(lv.solid(tx, ty + 1)).toBe(true);
        }
      });
    });
  }

  it('t1 has exactly 20 shards and teaches without dash crystals, toggles or switch blocks', () => {
    const c = census(byId.t1);
    expect(c.shards).toBe(20);
    expect(c.crystals).toBe(0);
    expect(c.toggles).toBe(0);
    expect(byId.t1.rows.join('')).not.toMatch(/[%&]/);
  });

  it('t3 contains a 4-wide wall-jump shaft', () => {
    // two rock walls facing across exactly four empty columns for at least eight rows
    const rows = byId.t3.rows;
    let best = 0;
    for (let x = 1; x < rows[0].length - 5; x++) {
      let run = 0;
      for (const r of rows) {
        const seg = r.slice(x - 1, x + 5);
        if (seg[0] === '#' && seg[5] === '#' && !seg.slice(1, 5).includes('#')) { run++; best = Math.max(best, run); } else run = 0;
      }
    }
    expect(best).toBeGreaterThanOrEqual(8);
  });

  it('s2 uses switch blocks of both polarities and at least two toggles', () => {
    const flat = byId.s2.rows.join('');
    expect(flat).toMatch(/%/);
    expect(flat).toMatch(/&/);
    expect(census(byId.s2).toggles).toBeGreaterThanOrEqual(2);
  });

  it('s3 fields turrets, saws and a chaser', () => {
    const flat = byId.s3.rows.join('');
    expect(flat.split('t').length - 1).toBeGreaterThanOrEqual(2);
    expect(flat.split('s').length - 1).toBeGreaterThanOrEqual(2);
    expect(flat).toMatch(/c/);
  });

  it('v1 chains at least five dash crystals', () => {
    expect(census(byId.v1).crystals).toBeGreaterThanOrEqual(5);
  });

  it('v2 has updrafts, flyers and one-way platforms', () => {
    const flat = byId.v2.rows.join('');
    expect(flat.split('z').length - 1).toBeGreaterThanOrEqual(2);
    expect(flat.split('f').length - 1).toBeGreaterThanOrEqual(2);
    expect(flat.split('=').length - 1).toBeGreaterThanOrEqual(12);
  });

  it('v3 is the finale: exactly two checkpoints and every mechanic present', () => {
    const c = census(byId.v3);
    expect(c.checkpoints).toBe(2);
    expect(c.crystals).toBeGreaterThanOrEqual(1);
    expect(c.toggles).toBeGreaterThanOrEqual(1);
    const flat = byId.v3.rows.join('');
    for (const ch of ['X', '=', '%', '&', 'S', 'z', 's', 't']) expect(flat, `v3 lacks '${ch}'`).toContain(ch);
  });
});
