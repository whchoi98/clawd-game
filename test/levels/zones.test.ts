import { describe, expect, it } from 'vitest';
import {
  CHECKPOINT_MAX_GAP, CHECKPOINT_PAR_SEC, SHARD_MAX, SHARD_MIN, census, checkpointsFor, validate, validateZone, zoneRules,
} from '../../levels/dsl.js';
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

/** Columns of every P / C / G marker, left to right. */
function markerColumns(def: LevelDef): { ch: string; x: number }[] {
  const out: { ch: string; x: number }[] = [];
  for (const r of def.rows) for (let x = 0; x < r.length; x++) if ('PCG'.includes(r[x])) out.push({ ch: r[x], x });
  return out.sort((a, b) => a.x - b.x);
}

/** Widest run of bottomless columns (no floor character anywhere in the column). */
function widestPit(def: LevelDef): number {
  const w = def.rows[0].length;
  let run = 0, best = 0;
  for (let x = 0; x < w; x++) {
    const floored = def.rows.some((r) => '#X=~W'.includes(r[x]));
    run = floored ? 0 : run + 1;
    best = Math.max(best, run);
  }
  return best;
}

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

  it('are all at geometry revision 1 (P2-8 tune-up: SIM_VERSION 3 boards start fresh)', () => {
    for (const z of ZONES) expect(z.rev, z.id).toBe(1);
  });

  for (const id of ORDER) {
    describe(id, () => {
      it('passes every validator rule, geometry and zone pacing alike', () => {
        expect(validate(byId[id])).toEqual([]);
        expect(zoneRules(byId[id])).toEqual([]);
        expect(validateZone(byId[id])).toEqual([]);
      });

      it('is 60–120 columns by 16–30 rows', () => {
        const c = census(byId[id]);
        expect(c.w).toBeGreaterThanOrEqual(60);
        expect(c.w).toBeLessThanOrEqual(120);
        expect(c.h).toBeGreaterThanOrEqual(16);
        expect(c.h).toBeLessThanOrEqual(30);
      });

      it(`has ${SHARD_MIN}–${SHARD_MAX} shards, exactly one relic and at least ceil(par / ${CHECKPOINT_PAR_SEC}) checkpoints`, () => {
        const c = census(byId[id]);
        expect(c.shards).toBeGreaterThanOrEqual(SHARD_MIN);
        expect(c.shards).toBeLessThanOrEqual(SHARD_MAX);
        expect(c.relics).toBe(1);
        const need = Math.ceil(PAR[id] / CHECKPOINT_PAR_SEC);
        expect(checkpointsFor(PAR[id])).toBe(need);
        expect(c.checkpoints).toBeGreaterThanOrEqual(need);
      });

      it(`keeps P, every checkpoint and G within ${CHECKPOINT_MAX_GAP} columns of their neighbours`, () => {
        const m = markerColumns(byId[id]);
        expect(m[0].ch).toBe('P');
        expect(m[m.length - 1].ch).toBe('G');
        for (let i = 1; i < m.length; i++) {
          expect(m[i].x - m[i - 1].x, `${id}: ${m[i - 1].ch}@${m[i - 1].x} → ${m[i].ch}@${m[i].x}`).toBeLessThanOrEqual(CHECKPOINT_MAX_GAP);
        }
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

      it('every checkpoint stands on something: rock or a one-way ledge directly below', () => {
        const lv = new Level(byId[id]);
        for (const c of lv.spawns.filter((s) => s.ch === 'C')) {
          expect(lv.solid(c.tx, c.ty), `${id}: C at (${c.tx},${c.ty}) is inside rock`).toBe(false);
          expect(lv.solid(c.tx, c.ty + 1) || lv.oneWay(c.tx, c.ty + 1), `${id}: C at (${c.tx},${c.ty}) floats`).toBe(true);
        }
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

  it('t1 has 11 shards on perches, three checkpoints (32 / 49 / 70), no pit wider than five, and teaches without dash crystals, toggles or switch blocks', () => {
    const t1 = byId.t1;
    const c = census(t1);
    expect(c.shards).toBe(11);
    expect(c.checkpoints).toBe(3);
    expect(markerColumns(t1).map((m) => `${m.ch}${m.x}`)).toEqual(['P3', 'C32', 'C49', 'C70', 'G96']);
    expect(widestPit(t1)).toBeLessThanOrEqual(5);
    // the first lethal pit is tiles 41..45 (its far lip at 46 keeps the guide echo's checkpoint route), the wide pit is 63..67
    const floor = t1.rows[16];
    expect(floor.slice(40, 47)).toBe('#.....#');
    expect(floor.slice(62, 69)).toBe('#.....#');
    // no shard is left on the start yard's sand
    expect(t1.rows[15].slice(0, 15)).not.toContain('o');
    expect(c.crystals).toBe(0);
    expect(c.toggles).toBe(0);
    expect(t1.rows.join('')).not.toMatch(/[%&]/);
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

  it('s2 uses switch blocks of both polarities, at least two toggles, and seals its first gate with a roof', () => {
    const flat = byId.s2.rows.join('');
    expect(flat).toMatch(/%/);
    expect(flat).toMatch(/&/);
    expect(census(byId.s2).toggles).toBeGreaterThanOrEqual(2);
    // the pillar above gate 1 meets a rock roof over the start yard: no wall jump gets past row 0
    const rows = byId.s2.rows;
    expect(rows[0].slice(0, 18)).toBe('#'.repeat(18));
    for (let y = 2; y <= 13; y++) expect(rows[y].slice(14, 16)).toBe('##');
    expect(rows[14].slice(14, 16)).toBe('%%');
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

  it('v3 is the finale: at least six checkpoints (par 120) and every mechanic present', () => {
    const c = census(byId.v3);
    expect(c.checkpoints).toBeGreaterThanOrEqual(6);
    expect(c.crystals).toBeGreaterThanOrEqual(1);
    expect(c.toggles).toBeGreaterThanOrEqual(1);
    const flat = byId.v3.rows.join('');
    for (const ch of ['X', '=', '%', '&', 'S', 'z', 's', 't']) expect(flat, `v3 lacks '${ch}'`).toContain(ch);
  });
});
