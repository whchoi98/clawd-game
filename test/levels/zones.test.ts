import { describe, expect, it } from 'vitest';
import {
  CHECKPOINT_MAX_GAP, CHECKPOINT_PAR_SEC, SHARD_MAX, SHARD_MIN, ZONE_SHAPES, census, checkpointsFor, climbOrder, isVerticalZone, validate,
  validateZone, zoneRules, zoneShape,
} from '../../levels/dsl.js';
import { ZONES } from '../../levels/build.js';
import { Level } from '../../src/sim/level.js';
import type { LevelDef } from '../../src/sim/types.js';
import { hasRawKeyName, hintFor } from '../../src/client/ui/hints.js';

const ORDER = ['t1', 't2', 't3', 't4', 's1', 's2', 's3', 's4', 'v1', 'v2', 'v3', 'v4'];
const PAR: Record<string, number> = { t1: 45, t2: 55, t3: 70, t4: 90, s1: 60, s2: 75, s3: 90, s4: 110, v1: 70, v2: 85, v3: 120, v4: 120 };
const BIOME: Record<string, string> = {
  t1: 'tidepool', t2: 'tidepool', t3: 'tidepool', t4: 'tidepool',
  s1: 'stormspire', s2: 'stormspire', s3: 'stormspire', s4: 'stormspire',
  v1: 'voidreef', v2: 'voidreef', v3: 'voidreef', v4: 'voidreef',
};
/** The vertical zone of each tier (P2-10): a 44-wide tower climbed bottom to top. */
const VERTICAL = ['t4', 's4', 'v4'];
const HANGUL = /[가-힣]/;

const byId: Record<string, LevelDef> = Object.fromEntries(ZONES.map((z) => [z.id, z]));

/** Every P / C / G marker with its cell. */
function markers(def: LevelDef): { ch: string; x: number; y: number }[] {
  const out: { ch: string; x: number; y: number }[] = [];
  def.rows.forEach((r, y) => { for (let x = 0; x < r.length; x++) if ('PCG'.includes(r[x])) out.push({ ch: r[x], x, y }); });
  return out;
}

/** Columns of every P / C / G marker, left to right (the horizontal-zone reading). */
function markerColumns(def: LevelDef): { ch: string; x: number }[] {
  return markers(def).sort((a, b) => a.x - b.x || a.y - b.y).map(({ ch, x }) => ({ ch, x }));
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

/** Longest run of rows where two rock walls face each other across exactly four empty columns (a wall-jump shaft). */
function tallestFourWideShaft(rows: readonly string[]): number {
  let best = 0;
  for (let x = 1; x < rows[0].length - 5; x++) {
    let run = 0;
    for (const r of rows) {
      const seg = r.slice(x - 1, x + 5);
      if (seg[0] === '#' && seg[5] === '#' && !seg.slice(1, 5).includes('#')) { run++; best = Math.max(best, run); } else run = 0;
    }
  }
  return best;
}

/** Distinct four-wide shafts at least `minRows` tall: one per interior column span. */
function fourWideShafts(rows: readonly string[], minRows: number): number {
  let n = 0;
  for (let x = 1; x < rows[0].length - 5; x++) {
    let run = 0, counted = false;
    for (const r of rows) {
      const seg = r.slice(x - 1, x + 5);
      if (seg[0] === '#' && seg[5] === '#' && !seg.slice(1, 5).includes('#')) {
        run++;
        if (run >= minRows && !counted) { n++; counted = true; }
      } else { run = 0; counted = false; }
    }
  }
  return n;
}

describe('the twelve zones', () => {
  it('are exactly t1..v4 in tower order — four per tier, the fourth vertical — with the planned biomes and pars', () => {
    expect(ZONES.map((z) => z.id)).toEqual(ORDER);
    for (const z of ZONES) {
      expect(z.biome).toBe(BIOME[z.id]);
      expect(z.par).toBe(PAR[z.id]);
      expect(isVerticalZone(z), z.id).toBe(VERTICAL.includes(z.id));
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
    expect(byId.t4.hint).toMatch(/\{jump\}/);
    expect(byId.s4.hint).toMatch(/\{dash\}/);
    expect(byId.v4.hint).toMatch(/\{dash\}/);
  });

  it('the nine original zones are at geometry revision 1 (P2-8 tune-up); the vertical zones ship fresh at rev 0', () => {
    for (const z of ZONES) {
      if (VERTICAL.includes(z.id)) expect(z.rev ?? 0, z.id).toBe(0);
      else expect(z.rev, z.id).toBe(1);
    }
  });

  for (const id of ORDER) {
    const vertical = VERTICAL.includes(id);
    describe(id, () => {
      it('passes every validator rule, geometry and zone pacing alike', () => {
        expect(validate(byId[id])).toEqual([]);
        expect(zoneRules(byId[id])).toEqual([]);
        expect(validateZone(byId[id])).toEqual([]);
      });

      it(vertical ? 'is a vertical zone: 36–48 columns by 60–100 rows' : 'is a horizontal zone: 60–120 columns by 16–30 rows', () => {
        const c = census(byId[id]);
        const env = ZONE_SHAPES[vertical ? 'vertical' : 'horizontal'];
        expect(zoneShape(byId[id])).toBe(vertical ? 'vertical' : 'horizontal');
        expect(c.w).toBeGreaterThanOrEqual(env.cols[0]);
        expect(c.w).toBeLessThanOrEqual(env.cols[1]);
        expect(c.h).toBeGreaterThanOrEqual(env.rows[0]);
        expect(c.h).toBeLessThanOrEqual(env.rows[1]);
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

      if (vertical) {
        it(`keeps P, every checkpoint and G within ${CHECKPOINT_MAX_GAP} tiles (Manhattan) of their neighbours along the climb, P at the bottom and G at the top`, () => {
          const route = climbOrder(markers(byId[id]));
          expect(route[0].ch).toBe('P');
          expect(route[route.length - 1].ch).toBe('G');
          expect(route[0].y).toBe(Math.max(...route.map((m) => m.y)));
          expect(route[route.length - 1].y).toBe(Math.min(...route.map((m) => m.y)));
          for (let i = 1; i < route.length; i++) {
            const a = route[i - 1], b = route[i];
            const gap = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
            expect(gap, `${id}: ${a.ch}@(${a.x},${a.y}) → ${b.ch}@(${b.x},${b.y})`).toBeLessThanOrEqual(CHECKPOINT_MAX_GAP);
          }
        });

        it('is framed like the daily tower: two-tile rock walls the whole height and a solid base of four rows, no bottomless pit anywhere', () => {
          const rows = byId[id].rows;
          const w = rows[0].length;
          for (const r of rows) {
            expect(r.slice(0, 2)).toBe('##');
            expect(r.slice(w - 2)).toBe('##');
          }
          for (let y = rows.length - 4; y < rows.length; y++) expect(rows[y]).toBe('#'.repeat(w));
          expect(widestPit(byId[id])).toBe(0);
        });

        it('has no two checkpoints in the same or a neighbouring column (the novice tool matches checkpoints by column)', () => {
          const cs = markers(byId[id]).filter((m) => m.ch === 'C').map((m) => m.x).sort((a, b) => a - b);
          for (let i = 1; i < cs.length; i++) expect(cs[i] - cs[i - 1], `${id}: checkpoints at columns ${cs.join(', ')}`).toBeGreaterThanOrEqual(1);
        });
      } else {
        it(`keeps P, every checkpoint and G within ${CHECKPOINT_MAX_GAP} columns of their neighbours`, () => {
          const m = markerColumns(byId[id]);
          expect(m[0].ch).toBe('P');
          expect(m[m.length - 1].ch).toBe('G');
          for (let i = 1; i < m.length; i++) {
            expect(m[i].x - m[i - 1].x, `${id}: ${m[i - 1].ch}@${m[i - 1].x} → ${m[i].ch}@${m[i].x}`).toBeLessThanOrEqual(CHECKPOINT_MAX_GAP);
          }
        });
      }

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
    expect(tallestFourWideShaft(byId.t3.rows)).toBeGreaterThanOrEqual(8);
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

  describe('the vertical zones (P2-10)', () => {
    it('are 44 columns by 60 or more rows (at most 48 x 100), with at least five checkpoints each', () => {
      for (const id of VERTICAL) {
        const c = census(byId[id]);
        expect(c.w, id).toBe(44);
        expect(c.h, id).toBeGreaterThanOrEqual(60);
        expect(c.w).toBeLessThanOrEqual(48);
        expect(c.h).toBeLessThanOrEqual(100);
        expect(c.checkpoints, id).toBeGreaterThanOrEqual(5);
      }
    });

    it('t4 stacks at least two four-wide wall-jump shafts (three, each with a spring, two one-way rest ledges and a pool on the shelf above)', () => {
      const t4 = byId.t4;
      expect(fourWideShafts(t4.rows, 8)).toBeGreaterThanOrEqual(2);
      expect(fourWideShafts(t4.rows, 8)).toBe(3);
      const flat = t4.rows.join('');
      expect(flat.split('S').length - 1).toBe(3);
      expect(flat.split('=').length - 1).toBe(6 * 4);
      // two pools, each with a rock bed under it
      const surfaces = t4.rows.map((r, y) => (r.includes('~') ? y : -1)).filter((y) => y >= 0);
      expect(surfaces).toHaveLength(2);
      for (const y of surfaces) {
        for (let x = 0; x < t4.rows[y].length; x++) {
          if (t4.rows[y][x] !== '~') continue;
          let bed = false;
          for (let yy = y + 1; yy < t4.rows.length; yy++) { const ch = t4.rows[yy][x]; if (ch === '#') { bed = true; break; } if (ch !== 'W') break; }
          expect(bed, `t4: no bed under the water at (${x},${y})`).toBe(true);
        }
      }
    });

    it('s4 rides at least two vertical platforms, climbs crumble stairs and flips a switch-block lift with two toggles', () => {
      const s4 = byId.s4;
      const flat = s4.rows.join('');
      expect(flat.split('M').length - 1).toBeGreaterThanOrEqual(2);
      expect(flat.split('X').length - 1).toBeGreaterThanOrEqual(4);
      expect(census(s4).toggles).toBe(2);
      expect(flat).toMatch(/%/);
      expect(flat).toMatch(/&/);
      expect(flat).toContain('t');
      expect(flat).toContain('s');
      // every platform marker has open air under it to ride through and rock at the bottom of the ride
      const lv = new Level(s4);
      for (const p of lv.spawns.filter((s) => s.ch === 'M')) {
        expect(lv.solid(p.tx, p.ty + 1), `s4: M at (${p.tx},${p.ty}) has no ride`).toBe(false);
        expect(lv.patrolSpan(p.tx, p.ty, 0, 1, 8)).toBeGreaterThanOrEqual(4 * 16);
      }
    });

    it('v4 rises on at least three updrafts and strings at least seven dash crystals into a chain, with the spikes on a wall face', () => {
      const v4 = byId.v4;
      const flat = v4.rows.join('');
      expect(flat.split('z').length - 1).toBeGreaterThanOrEqual(3);
      expect(census(v4).crystals).toBeGreaterThanOrEqual(7);
      // the only spikes are on a wall face (a vertical run of one sideways glyph), never on a floor a fall could meet
      expect(flat).toMatch(/[{}]/);
      expect(flat).not.toMatch(/[\^V]/);
      const faces = new Set<number>();
      v4.rows.forEach((r) => { for (let x = 0; x < r.length; x++) if ('{}'.includes(r[x])) faces.add(x); });
      expect(faces.size).toBe(1);
      // every updraft has at least twelve open rows above it: a full-height column
      const lv = new Level(v4);
      for (const z of lv.spawns.filter((s) => s.ch === 'z')) {
        expect(lv.solid(z.tx, z.ty + 1), `v4: z at (${z.tx},${z.ty}) floats`).toBe(true);
        expect(lv.patrolSpan(z.tx, z.ty, 0, -1, 12)).toBe(12 * 16);
      }
    });
  });
});
