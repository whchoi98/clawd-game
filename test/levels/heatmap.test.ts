/**
 * levels/heatmap/<zone>.json — the novice-bot death heat maps (tools/novice.ts),
 * the synthetic stand-in for player telemetry that placed the P2-8 checkpoints.
 * Every zone carries one, recorded against the current sim and geometry, and
 * the tool itself is deterministic: the same seed reproduces the same numbers.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { ZONES } from '../../levels/build.js';
import { census, isVerticalZone } from '../../levels/dsl.js';
import { decodeMasks, verifyReplay } from '../../src/sim/replay.js';
import { Sim } from '../../src/sim/sim.js';
import { SIM_VERSION, TILE } from '../../src/sim/types.js';
import {
  FLAWLESS, NOVICE, clusters, heatmapPath, parseArgs, recordGuide, renderHeat, renderOverlay, runEpisode, runZone, summarize,
} from '../../tools/novice.js';
import type { CellStat, ZoneHeat } from '../../tools/novice.js';
import { makeRng } from '../../src/sim/rng.js';

const byId = Object.fromEntries(ZONES.map((z) => [z.id, z]));

describe('levels/heatmap — one novice heat map per zone, current and self-consistent', () => {
  for (const def of ZONES) {
    it(`${def.id}: recorded on sim v${SIM_VERSION} at rev ${def.rev ?? 0} with 300 episodes; cells, causes and checkpoints add up`, () => {
      const path = heatmapPath(def.id);
      expect(existsSync(path), `${path} missing — run \`npx tsx tools/novice.ts ${def.id}\``).toBe(true);
      const h = JSON.parse(readFileSync(path, 'utf8')) as ZoneHeat;
      expect(h.levelId).toBe(def.id);
      expect(h.sim).toBe(SIM_VERSION);
      expect(h.rev).toBe(def.rev ?? 0);
      expect(h.seed).toBe(def.seed);
      expect(h.par).toBe(def.par);
      expect(h.episodes).toBe(300);
      expect(h.policy).toEqual(NOVICE);
      expect(h.clears + h.gaveUp).toBe(h.episodes);
      expect(h.clearRate).toBeCloseTo(h.clears / h.episodes, 9);
      expect(h.cells.reduce((n, c) => n + c.deaths, 0)).toBe(h.deaths);
      expect(Object.values(h.causes).reduce((a, b) => a + b, 0)).toBe(h.deaths);
      for (const c of h.cells) {
        expect(Object.values(c.causes).reduce((a, b) => a + b, 0)).toBe(c.deaths);
        expect(c.tx).toBeGreaterThanOrEqual(0);
        expect(c.tx).toBeLessThan(def.rows[0].length);
        expect(c.ty).toBeGreaterThanOrEqual(0);
        expect(c.ty).toBeLessThan(def.rows.length);
      }
      // heaviest first
      for (let i = 1; i < h.cells.length; i++) expect(h.cells[i - 1].deaths).toBeGreaterThanOrEqual(h.cells[i].deaths);
      // one entry per checkpoint, in play order, each at a real 'C' cell
      expect(h.checkpoints).toHaveLength(census(def).checkpoints);
      for (let i = 1; i < h.checkpoints.length; i++) expect(h.checkpoints[i].tx).toBeGreaterThanOrEqual(h.checkpoints[i - 1].tx);
      for (const c of h.checkpoints) {
        expect(def.rows[c.ty][c.tx]).toBe('C');
        expect(c.rate).toBeCloseTo(c.reached / h.episodes, 9);
      }
      // hot spots are the heaviest clusters and never exceed the total
      const total = h.hotspots.reduce((n, s) => n + s.deaths, 0);
      expect(total).toBeLessThanOrEqual(h.deaths);
      for (let i = 1; i < h.hotspots.length; i++) expect(h.hotspots[i - 1].deaths).toBeGreaterThanOrEqual(h.hotspots[i].deaths);
      // the file is the tool's own rendering (2-space JSON, trailing newline)
      expect(readFileSync(path, 'utf8')).toBe(renderHeat(h));
    });
  }

  it('the checkpoints of every zone stand right before its hot spots: the heaviest cluster of each zone is never more than 32 tiles past a P or C along the route', () => {
    for (const def of ZONES) {
      const h = JSON.parse(readFileSync(heatmapPath(def.id), 'utf8')) as ZoneHeat;
      if (!h.hotspots.length) continue;
      const P = new Sim(def).level.spawns.find((s) => s.ch === 'P')!;
      const top = h.hotspots[0];
      if (isVerticalZone(def)) {
        // a tower is climbed bottom to top: the anchor is a P or C at or below the cluster's row, within 32 rows
        const anchors = [...h.checkpoints.map((c) => c.ty), P.ty];
        const below = anchors.filter((y) => y >= top.ty);
        expect(below.length, `${def.id}: nothing below the hot spot at row ${top.ty}`).toBeGreaterThan(0);
        expect(Math.min(...below) - top.ty, `${def.id}: hot spot row ${top.ty}`).toBeLessThanOrEqual(32);
      } else {
        const anchors = [...h.checkpoints.map((c) => c.tx), P.tx];
        const before = anchors.filter((x) => x <= top.x1);
        expect(before.length, `${def.id}: nothing before the hot spot at x ${top.x0}..${top.x1}`).toBeGreaterThan(0);
        expect(top.x1 - Math.max(...before), `${def.id}: hot spot x ${top.x0}..${top.x1}`).toBeLessThanOrEqual(32);
      }
    }
  });

  it('the vertical zones (P2-10 / P5-1) carry a heat map too, and it is honest: the right-holding novice policy never climbs a tower, so it records no clear and no death rather than an invented one', () => {
    for (const id of ['t4', 's4', 'v4', 'm4']) {
      const def = byId[id];
      expect(isVerticalZone(def)).toBe(true);
      const h = JSON.parse(readFileSync(heatmapPath(id), 'utf8')) as ZoneHeat;
      expect(h.episodes).toBe(300);
      expect(h.clears).toBe(0);
      expect(h.deaths).toBe(0);
      expect(h.hotspots).toEqual([]);
      // every checkpoint is still listed, at its real cell, with a reach rate the bot earned (none)
      expect(h.checkpoints).toHaveLength(census(def).checkpoints);
      for (const c of h.checkpoints) expect(def.rows[c.ty][c.tx]).toBe('C');
    }
  });

  it('t1: the novice bot clears the tuned zone more often than not and every checkpoint is reached by most runs', () => {
    const h = JSON.parse(readFileSync(heatmapPath('t1'), 'utf8')) as ZoneHeat;
    expect(h.clearRate).toBeGreaterThanOrEqual(0.7);
    for (const c of h.checkpoints) expect(c.rate, `C at ${c.tx}`).toBeGreaterThanOrEqual(0.9);
    expect(h.deathsPerEpisode).toBeLessThan(1);
  });
});

describe('tools/novice — the bot and its aggregation', () => {
  it('an episode is deterministic for a seed and ends cleared, dead 25 times or after 90 s', () => {
    const a = runEpisode(byId.t1, makeRng(7));
    const b = runEpisode(byId.t1, makeRng(7));
    expect(a).toEqual(b);
    expect(a.cleared || a.gaveUp).toBe(true);
    if (a.gaveUp) expect(a.deaths.length >= 25 || a.ticks >= 90 * 120).toBe(true);
    for (const d of a.deaths) {
      expect(['pit', 'spike', 'foe', 'saw', 'bolt', 'switch', 'tide', 'retry']).toContain(d.cause);
      expect(d.tx).toBeGreaterThanOrEqual(0);
      expect(d.ty).toBeLessThan(byId.t1.rows.length);
    }
    // another seed is another run
    const c = runEpisode(byId.t1, makeRng(8));
    expect(c.ticks === a.ticks && c.deaths.length === a.deaths.length && c.cleared === a.cleared).toBe(false);
  });

  it('runZone aggregates episodes: counts add up, checkpoints are in play order, clusters are contiguous columns heaviest first', () => {
    const h = runZone(byId.t2, { episodes: 12, seed: 3 });
    expect(h.episodes).toBe(12);
    expect(h.clears + h.gaveUp).toBe(12);
    expect(h.cells.reduce((n, c) => n + c.deaths, 0)).toBe(h.deaths);
    expect(h.checkpoints.map((c) => c.tx)).toEqual([23, 48, 78, 91]);
    for (let i = 1; i < h.hotspots.length; i++) {
      expect(h.hotspots[i - 1].deaths).toBeGreaterThanOrEqual(h.hotspots[i].deaths);
      expect(h.hotspots[i].x1).toBeGreaterThanOrEqual(h.hotspots[i].x0);
    }
    expect(runZone(byId.t2, { episodes: 12, seed: 3 })).toEqual(h);
    const text = summarize(h);
    expect(text).toContain('t2 조류의 도약 — par 55s');
    expect(text).toContain('checkpoints: C1(23,17)');
    const overlay = renderOverlay(byId.t2, h.cells);
    expect(overlay.split('\n')).toHaveLength(byId.t2.rows.length + 3);
    expect(overlay).toContain('y=0 ');
  });

  it('clusters: adjacent columns merge, a gap splits, share and dominant cause are per cluster', () => {
    const cells: CellStat[] = [
      { tx: 10, ty: 5, deaths: 3, causes: { pit: 3 } },
      { tx: 11, ty: 5, deaths: 5, causes: { pit: 4, foe: 1 } },
      { tx: 20, ty: 2, deaths: 1, causes: { spike: 1 } },
      { tx: 21, ty: 2, deaths: 1, causes: { spike: 1 } },
    ];
    const out = clusters(cells, 10);
    expect(out).toEqual([
      { x0: 10, x1: 11, ty: 5, deaths: 8, share: 0.8, cause: 'pit' },
      { x0: 20, x1: 21, ty: 2, deaths: 2, share: 0.2, cause: 'spike' },
    ]);
    expect(clusters([], 0)).toEqual([]);
  });

  it('recordGuide: the flawless policy reaches t1\'s second checkpoint (tile 49) with no deaths and stands still — a valid, unfinished v3 log', () => {
    const rec = recordGuide(byId.t1, 2);
    expect(rec).not.toBeNull();
    expect(rec!.deaths).toBe(0);
    expect(rec!.checkpoints).toBe(2);
    expect(rec!.x).toBeGreaterThan(47 * TILE);
    expect(rec!.ticks).toBeLessThan(120 * 16);
    const masks = decodeMasks(rec!.masks);
    expect(masks).toHaveLength(rec!.ticks);
    const v = verifyReplay(byId.t1, { v: SIM_VERSION, levelId: 't1', seed: byId.t1.seed, assist: false, masks });
    expect(v.reason).toBe('not-finished');
    expect(v.summary.deaths).toBe(0);
    // the same run twice is the same log
    expect(recordGuide(byId.t1, 2)).toEqual(rec);
    expect(FLAWLESS.maxDelay).toBe(0);
  });

  it('parseArgs: values, booleans and zone ids; unknown options are refused', () => {
    const { flags, ids } = parseArgs(['t1', '--episodes=50', '--seed', '9', '--no-write', 's2']);
    expect(ids).toEqual(['t1', 's2']);
    expect(flags.get('episodes')).toBe('50');
    expect(flags.get('seed')).toBe('9');
    expect(flags.has('no-write')).toBe(true);
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown option/);
    expect(() => parseArgs(['--seed'])).toThrow(/needs a value/);
  });
});
