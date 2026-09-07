import { describe, expect, it } from 'vitest';
import {
  BUBBLE_P_CLEARANCE, CHECKPOINT_MAX_GAP, CHECKPOINT_PAR_SEC, SHARD_MAX, SHARD_MIN, ZONE_SHAPES, census, checkpointsFor, climbOrder,
  isVerticalZone, validate, validateZone, zoneRules, zoneShape,
} from '../../levels/dsl.js';
import { ZONES } from '../../levels/build.js';
import { PLAYER_W } from '../../src/sim/config.js';
import { Level } from '../../src/sim/level.js';
import { FOE_WAKE_GAP } from '../../src/sim/sim.js';
import type { LevelDef } from '../../src/sim/types.js';
import { hasRawKeyName, hintFor } from '../../src/client/ui/hints.js';

const ORDER = ['t1', 't2', 't3', 't4', 's1', 's2', 's3', 's4', 'v1', 'v2', 'v3', 'v4', 'm1', 'm2', 'm3', 'm4'];
const PAR: Record<string, number> = {
  t1: 45, t2: 55, t3: 70, t4: 90, s1: 60, s2: 75, s3: 90, s4: 110, v1: 70, v2: 85, v3: 120, v4: 120, m1: 80, m2: 95, m3: 110, m4: 130,
};
const BIOME: Record<string, string> = {
  t1: 'tidepool', t2: 'tidepool', t3: 'tidepool', t4: 'tidepool',
  s1: 'stormspire', s2: 'stormspire', s3: 'stormspire', s4: 'stormspire',
  v1: 'voidreef', v2: 'voidreef', v3: 'voidreef', v4: 'voidreef',
  m1: 'summit', m2: 'summit', m3: 'summit', m4: 'summit',
};
/** The vertical zone of each tier (P2-10 / P5-1): a 44-wide tower climbed bottom to top. */
const VERTICAL = ['t4', 's4', 'v4', 'm4'];
/** The fourth tier (P5-1), shipped fresh at geometry revision 0; m1 · m3 · m4 went to rev 1 with the bubbles (P5-5). */
const SUMMIT = ['m1', 'm2', 'm3', 'm4'];
/** Zones still at geometry revision 0: the three older vertical zones and m2 (the summit bubbles skipped it). */
const REV0 = ['t4', 's4', 'v4', 'm2'];
const HANGUL = /[가-힣]/;
/** Grid characters that are terrain (anything a bubble could not be stomped through). */
const TERRAIN = '#=X~W^V{}%&';

const byId: Record<string, LevelDef> = Object.fromEntries(ZONES.map((z) => [z.id, z]));

/** Every P / C / G marker with its cell. */
function markers(def: LevelDef): { ch: string; x: number; y: number }[] {
  const out: { ch: string; x: number; y: number }[] = [];
  def.rows.forEach((r, y) => { for (let x = 0; x < r.length; x++) if ('PCG'.includes(r[x])) out.push({ ch: r[x], x, y }); });
  return out;
}

/** Every bubble ('b') cell, in scan order (top row first). */
function bubbles(def: LevelDef): [number, number][] {
  const out: [number, number][] = [];
  def.rows.forEach((r, y) => { for (let x = 0; x < r.length; x++) if (r[x] === 'b') out.push([x, y]); });
  return out;
}

/**
 * The bubble placements of a zone (P5-5), read straight off the grid: exactly `expected` (any order), each with an
 * open tile or a spawn (never terrain) directly above so it can be stomped, and each more than BUBBLE_P_CLEARANCE
 * tiles (Chebyshev) from P so none sits in the spawn frame.
 */
function expectBubbles(def: LevelDef, expected: [number, number][]): void {
  const found = bubbles(def);
  expect(found).toHaveLength(expected.length);
  const key = (c: [number, number]) => `${c[0]},${c[1]}`;
  expect(found.map(key).sort()).toEqual(expected.map(key).sort());
  const p = markers(def).find((m) => m.ch === 'P')!;
  for (const [x, y] of found) {
    expect(y, `${def.id}: b at (${x},${y}) on the top row`).toBeGreaterThan(0);
    const above = def.rows[y - 1][x];
    expect(TERRAIN.includes(above), `${def.id}: b at (${x},${y}) has '${above}' above it`).toBe(false);
    expect(Math.max(Math.abs(x - p.x), Math.abs(y - p.y)), `${def.id}: b at (${x},${y}) is inside the spawn frame of P at (${p.x},${p.y})`).toBeGreaterThan(BUBBLE_P_CLEARANCE);
  }
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

describe('the sixteen zones', () => {
  it('are exactly t1..m4 in tower order — four tiers of four, the fourth of each vertical — with the planned biomes and pars', () => {
    expect(ZONES.map((z) => z.id)).toEqual(ORDER);
    expect(ZONES).toHaveLength(16);
    for (let i = 0; i < ORDER.length; i += 4) {
      const tier = ZONES.slice(i, i + 4);
      expect(new Set(tier.map((z) => z.biome)).size, `tier ${i / 4 + 1} shares one biome`).toBe(1);
      expect(isVerticalZone(tier[3]), `${tier[3].id} closes tier ${i / 4 + 1} as its vertical zone`).toBe(true);
    }
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
    expect(byId.m1.hint).toMatch(/\{jump\}/);
    expect(byId.m1.hint).toMatch(/\{dash\}/);
    expect(byId.m2.hint).toMatch(/\{stomp\}/);
    expect(byId.m3.hint).toMatch(/\{dash\}/);
    expect(byId.m4.hint).toMatch(/\{jump\}/);
    expect(byId.m4.hint).toMatch(/\{dash\}/);
  });

  it('geometry revisions: the nine original zones (P2-8 tune-up) and m1 · m3 · m4 (P5-5 bubbles) are at rev 1; t4 · s4 · v4 and m2 are still at rev 0', () => {
    for (const z of ZONES) expect(z.rev ?? 0, z.id).toBe(REV0.includes(z.id) ? 0 : 1);
    expect(byId.m1.rev).toBe(1);
    expect(byId.m3.rev).toBe(1);
    expect(byId.m4.rev).toBe(1);
    expect(byId.m2.rev).toBeUndefined();
    // no bubble anywhere but the three rev-1 summit zones
    for (const z of ZONES) if (!['m1', 'm3', 'm4'].includes(z.id)) expect(bubbles(z), z.id).toEqual([]);
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

  describe('the summit tier (P5-1)', () => {
    it('m1..m4 are the fourth tier: biome summit, pars 80 / 95 / 110 / 130, three horizontal rooms and the vertical m4', () => {
      expect(ZONES.slice(12).map((z) => z.id)).toEqual(SUMMIT);
      for (const id of SUMMIT) expect(byId[id].biome).toBe('summit');
      expect(SUMMIT.map((id) => byId[id].par)).toEqual([80, 95, 110, 130]);
      expect(SUMMIT.map((id) => isVerticalZone(byId[id]))).toEqual([false, false, false, true]);
      // pars climb through the tier and its vertical zone carries the tower's longest par
      for (let i = 1; i < 4; i++) expect(byId[SUMMIT[i]].par).toBeGreaterThan(byId[SUMMIT[i - 1]].par);
      expect(byId.m4.par).toBe(Math.max(...ZONES.map((z) => z.par)));
    });

    it('m1 roofs its hall with one-way ice shelves, climbs a two-crystal ladder and steps down three one-way shelves over the only spike bed', () => {
      const m1 = byId.m1;
      const flat = m1.rows.join('');
      const F = 22;
      // the hall ceiling: one continuous one-way row three above the floor, joined to a three-tile rock step
      expect(m1.rows[F - 3].slice(17, 43)).toBe('='.repeat(26));
      expect(m1.rows[F - 3].slice(43, 45)).toBe('##');
      expect(m1.rows[F - 1].slice(43, 45)).toBe('##');
      expect(m1.rows[F].slice(13, 45)).toBe('#'.repeat(32));
      // the ladder: two crystals against the cliff face
      expect(census(m1).crystals).toBe(2);
      expect(m1.rows[F - 8][58]).toBe('D');
      expect(m1.rows[F - 13][58]).toBe('D');
      for (let y = F - 14; y <= F - 4; y++) expect(m1.rows[y][59], `cliff face at row ${y}`).toBe('#');
      // the descent: three one-way shelves, and spikes only on the bed under them
      expect(flat.split('=').length - 1).toBe(26 + 3 * 3 + 2);
      const spikeRows = m1.rows.map((r, y) => (/[\^V{}]/.test(r) ? y : -1)).filter((y) => y >= 0);
      expect(spikeRows).toEqual([F - 1]);
      expect(m1.rows[F - 1].slice(73, 89)).toBe('^'.repeat(16));
      for (const ch of ['w', 's', 'f']) expect(flat, `m1 lacks '${ch}'`).toContain(ch);
      expect(flat).not.toMatch(/[%&kzmMt]/);
      // rev 1 (P5-5): two bubble perches over the spike bed, one in each shelf gap, a shard six rows over each
      expectBubbles(m1, [[79, F - 5], [84, F - 3]]);
      expect(m1.rows[F - 11][80]).toBe('o');
      expect(m1.rows[F - 9][84]).toBe('o');
      for (const [x, y] of bubbles(m1)) expect(m1.rows[F - 1][x], `spikes under the bubble at (${x},${y})`).toBe('^');
    });

    it('m2 crosses four crumble spans on rock piers, rides a horizontal and a vertical platform and fields three turrets', () => {
      const m2 = byId.m2;
      const flat = m2.rows.join('');
      const F = 20;
      // the bridge: X X X X X # # X X X X X # # ... from column 13 to 38
      expect(m2.rows[F].slice(13, 39)).toBe('XXXXX##XXXXX##XXXXX##XXXXX');
      expect(flat.split('X').length - 1).toBe(4 * 5 + 4);
      expect(flat.split('m').length - 1).toBe(1);
      expect(flat.split('M').length - 1).toBe(1);
      expect(flat.split('t').length - 1).toBe(3);
      // the platform's bed is spiked from end to end, with rock under it (never a bottomless pit under a ride)
      expect(m2.rows[F + 2].slice(73, 89)).toBe('^'.repeat(16));
      expect(m2.rows[F + 3].slice(73, 89)).toBe('#'.repeat(16));
      const lv = new Level(m2);
      for (const p of lv.spawns.filter((s) => s.ch === 'm' || s.ch === 'M')) {
        const span = p.ch === 'M' ? lv.patrolSpan(p.tx, p.ty, 0, 1, 8) : lv.patrolSpan(p.tx, p.ty, 1, 0, 8);
        expect(span, `m2: ${p.ch} at (${p.tx},${p.ty}) has a full ride`).toBe(8 * 16);
      }
      expect(flat).not.toMatch(/[%&kzDS]/);
    });

    it('m3 climbs three updrafts, runs a roofed switch corridor with two toggles and both gate kinds, and hides one chaser', () => {
      const m3 = byId.m3;
      const flat = m3.rows.join('');
      expect(flat.split('z').length - 1).toBe(3);
      expect(census(m3).toggles).toBe(2);
      expect(flat).toMatch(/%/);
      expect(flat).toMatch(/&/);
      expect(flat.split('c').length - 1).toBe(1);
      expect(flat).toContain('t');
      // the roof runs from the second column's lintel to the corridor exit, so the gates are the only way through
      expect(m3.rows[0].slice(31, 81)).toBe('#'.repeat(50));
      for (let y = 1; y <= 3; y++) expect(m3.rows[y].slice(31, 35), `lintel row ${y}`).toBe('####');
      // the second column's well is the rev 0 well: three spike columns (32..34) under the lintel, open air from row 4 down to
      // the spikes on row 18, shelf 2 starting at column 35 (top row 7) — and no bubble hangs in it (P5-5 fix round 1: every
      // rung position inside met the arc of a plain jump off shelf 1 lifted by the column)
      for (let y = 4; y <= 17; y++) expect(m3.rows[y].slice(31, 35), `well row ${y}`).toBe('....');
      expect(m3.rows[18].slice(31, 36)).toBe('z^^^#');
      expect(m3.rows[19].slice(31, 36)).toBe('#####');
      for (let y = 7; y <= 18; y++) expect(m3.rows[y][35], `shelf 2 face at row ${y}`).toBe('#');
      expect(m3.rows[6][35]).toBe('.');
      expect(m3.rows[16].slice(17, 31)).toBe('#'.repeat(14));   // shelf 1 ends at column 30
      // the bubbles (P5-5): the yard perch with its shard five rows up, and the shard stair up the chaser room's left wall —
      // (81,23) under the corridor exit and (83,20), two columns and three rows apart, the shard five rows over the upper
      // rung; twelve shards in all
      const F = 26;
      expectBubbles(m3, [[10, F - 6], [81, F - 3], [83, F - 6]]);
      expect(m3.rows[F - 11][10]).toBe('o');
      expect(m3.rows[F - 11][83]).toBe('o');
      expect(census(m3).shards).toBe(12);
      const stair = bubbles(m3).filter(([x]) => x >= 81).sort((a, b) => b[1] - a[1]);
      expect(stair).toEqual([[81, 23], [83, 20]]);
      for (let i = 1; i < stair.length; i++) {
        expect(Math.abs(stair[i][0] - stair[i - 1][0]), 'rungs two columns apart').toBe(2);
        expect(stair[i - 1][1] - stair[i][1], 'rungs three rows apart').toBe(3);
      }
      for (const [x, y] of stair) {
        // only air (or the stair's shard) between the corridor-exit row and the rung: a drop from the exit meets it from above,
        // its launch meets nothing but the shard
        for (let yy = 7; yy < y; yy++) if (m3.rows[yy][x] !== 'o') expect(m3.rows[yy][x], `open air over the rung at (${x},${y}), row ${yy}`).toBe('.');
        // the rung's bob envelope (centre + half bubble + bob amplitude) ends above a walker's head on the standing row 25
        expect(y * 16 + 8 + 6 + 10, `the rung at (${x},${y}) reaches a walker on the room floor`).toBeLessThan(25 * 16 + 1);
        expect(m3.rows[26][x], `room floor under the rung at (${x},${y})`).toBe('#');
      }
      for (let y = 1; y <= 6; y++) {
        expect(m3.rows[y].slice(57, 59), `gate 1 row ${y}`).toBe('%%');
        expect(m3.rows[y].slice(67, 69), `gate 2 row ${y}`).toBe('&&');
      }
      // every updraft column is a full twelve tiles and stands flush with a bank edge, spikes only beyond it
      const lv = new Level(m3);
      for (const z of lv.spawns.filter((s) => s.ch === 'z')) {
        expect(lv.solid(z.tx, z.ty + 1), `m3: z at (${z.tx},${z.ty}) floats`).toBe(true);
        expect(lv.patrolSpan(z.tx, z.ty, 0, -1, 12)).toBe(12 * 16);
        expect(m3.rows[z.ty][z.tx - 1], `bank edge left of the column at (${z.tx},${z.ty})`).toBe('#');
        expect(m3.rows[z.ty][z.tx + 1], `spikes right of the column at (${z.tx},${z.ty})`).toBe('^');
      }
      // the chaser floats out of wake range (130 units) of anyone on the room floor (row 26 is the floor top, 25 the standing row),
      // and within it of anyone on the relic perch (x 96..98, standing row 17)
      const chaser = lv.spawns.find((s) => s.ch === 'c')!;
      expect(m3.rows[26].slice(81, 99)).toBe('#'.repeat(18));
      expect((25 - chaser.ty) * 16).toBeGreaterThan(130);
      expect(Math.hypot((97 - chaser.tx) * 16, (17 - chaser.ty) * 16)).toBeLessThan(130);
      // the wake-range guard (P5-5 fix round 1): the chaser wakes when the gap between its 15-wide box and the player's box is
      // within FOE_WAKE_GAP on both axes, and a rider on the stair is inside its vertical range — so every rung keeps the
      // horizontal box gap of a player centred on it above FOE_WAKE_GAP (ten tiles or more of centre distance; nine is not enough)
      for (const [x, y] of stair) {
        expect(Math.abs(x - chaser.tx), `stair rung (${x},${y}) too close to the chaser`).toBeGreaterThanOrEqual(10);
        expect(Math.abs(x - chaser.tx) * 16 - 15 / 2 - PLAYER_W / 2, `stair rung (${x},${y}) inside the chaser's horizontal wake range`).toBeGreaterThan(FOE_WAKE_GAP);
      }
    });

    it('m4 is the summit: a shaft with a spring and two rest ledges, one lift, three updrafts, a two-crystal chain, no spikes, the goal on the top deck', () => {
      const m4 = byId.m4;
      const flat = m4.rows.join('');
      expect(fourWideShafts(m4.rows, 8)).toBe(1);
      expect(flat.split('S').length - 1).toBe(1);
      expect(flat.split('=').length - 1).toBe(2 * 4);
      expect(flat.split('M').length - 1).toBe(1);
      expect(flat.split('z').length - 1).toBe(3);
      expect(census(m4).crystals).toBe(2);
      expect(flat).not.toMatch(/[\^V{}~WX%&k]/);
      const lv = new Level(m4);
      for (const z of lv.spawns.filter((s) => s.ch === 'z')) {
        expect(lv.solid(z.tx, z.ty + 1), `m4: z at (${z.tx},${z.ty}) floats`).toBe(true);
        expect(lv.patrolSpan(z.tx, z.ty, 0, -1, 12)).toBe(12 * 16);
      }
      const lift = lv.spawns.find((s) => s.ch === 'M')!;
      expect(lv.patrolSpan(lift.tx, lift.ty, 0, 1, 8)).toBe(8 * 16);
      // rev 1 (P5-5): the bubble chain across the well, three left and three up per hop, under the crystal chain
      expectBubbles(m4, [[18, 11], [15, 8], [12, 5]]);
      for (const z of lv.spawns.filter((s) => s.ch === 'D')) expect(z.ty, `crystal at (${z.tx},${z.ty}) hangs above the bubbles`).toBeLessThan(8);
      // the goal deck is the highest floor in the tower and the goal stands on it
      const route = climbOrder(markers(m4));
      const goal = route[route.length - 1];
      expect(goal.ch).toBe('G');
      expect(goal.y).toBe(2);
      expect(m4.rows[3].slice(2, 12)).toBe('#'.repeat(10));
      expect(m4.rows.slice(0, 3).join('')).not.toMatch(/#{3,}/.source.replace('3', '11'));
    });
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
