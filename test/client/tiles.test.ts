/**
 * Terrain face decor (P5-3): `tileDecor` is a pure function of biome and tile
 * coordinates — the same tile always grows the same barnacles, so a ledge
 * never shimmers — and every biome gets its own kinds on the faces they belong to.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { BIOMES } from '../../src/shared/biomes.js';
import type { BiomeId } from '../../src/sim/types.js';
import { TILE } from '../../src/sim/types.js';
import { Level } from '../../src/sim/level.js';
import { SPIKE_RIM_BIOMES, TERRAIN_MAX_PATH_FILLS, Terrain, tileDecor, type FaceDecor, type TileFaces } from '../../src/client/render/tiles.js';
import { Stage, alpha, mixHex } from '../../src/client/render/stage.js';

const ALL: TileFaces = { up: true, dn: true, lf: true, rt: true };
const NONE: TileFaces = { up: false, dn: false, lf: false, rt: false };
const BIOME_IDS = Object.keys(BIOMES) as BiomeId[];

function grid(biome: BiomeId, faces: TileFaces, n = 12): FaceDecor[][] {
  const out: FaceDecor[][] = [];
  for (let ty = 0; ty < n; ty++) for (let tx = 0; tx < n; tx++) out.push(tileDecor(biome, tx, ty, faces));
  return out;
}

describe('tiles · face decor (P5-3)', () => {
  it.each(BIOME_IDS)('%s: the same tile coordinates always yield the same decor', (biome) => {
    for (let i = 0; i < 40; i++) {
      const tx = (i * 37) % 101, ty = (i * 53) % 73;
      const faces: TileFaces = { up: i % 2 === 0, dn: i % 3 === 0, lf: i % 5 !== 0, rt: i % 7 !== 0 };
      const a = tileDecor(biome, tx, ty, faces), b = tileDecor(biome, tx, ty, faces);
      expect(b).toEqual(a);
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    }
  });

  it.each(BIOME_IDS)('%s: decor varies across tiles, stays inside the tile band and never grows on a buried tile', (biome) => {
    const all = grid(biome, ALL);
    const distinct = new Set(all.map((d) => JSON.stringify(d)));
    expect(distinct.size).toBeGreaterThan(1);
    expect(all.some((d) => d.length > 0)).toBe(true);
    for (const items of all) {
      for (const d of items) {
        expect(d.x).toBeGreaterThanOrEqual(0);
        expect(d.x).toBeLessThanOrEqual(TILE);
        expect(d.y).toBeGreaterThanOrEqual(0);
        expect(d.y).toBeLessThanOrEqual(TILE);
        expect([-1, 0, 1]).toContain(d.side);
        expect(d.v).toBeGreaterThanOrEqual(0);
        expect(d.v).toBeLessThanOrEqual(1);
      }
    }
    for (let ty = 0; ty < 12; ty++) for (let tx = 0; tx < 12; tx++) expect(tileDecor(biome, tx, ty, NONE)).toEqual([]);
  });

  it('kinds belong to their biome and face: barnacles/moss, runes, crystals, sheen/snow caps', () => {
    const kinds = (biome: BiomeId, faces: TileFaces) => new Set(grid(biome, faces).flat().map((d) => d.kind));
    expect([...kinds('tidepool', ALL)].sort()).toEqual(['barnacle', 'moss']);
    expect([...kinds('stormspire', ALL)]).toEqual(['rune']);
    expect([...kinds('voidreef', ALL)]).toEqual(['crystal']);
    expect([...kinds('summit', ALL)].sort()).toEqual(['sheen', 'snowcap']);
    // face rules: barnacles, runes and sheen hang on side faces only; moss and snow caps on lips; hanging crystals under ceilings
    const upOnly: TileFaces = { up: true, dn: false, lf: false, rt: false };
    expect([...kinds('tidepool', upOnly)]).toEqual(['moss']);
    expect(kinds('stormspire', upOnly).size).toBe(0);
    expect(kinds('summit', upOnly)).toEqual(new Set(['snowcap']));
    const dnOnly: TileFaces = { up: false, dn: true, lf: false, rt: false };
    expect([...kinds('voidreef', dnOnly)]).toEqual(['crystal']);
    for (const d of grid('voidreef', dnOnly).flat()) expect(d.side).toBe(0);
    const sides: TileFaces = { up: false, dn: false, lf: true, rt: true };
    for (const d of grid('tidepool', sides).flat()) expect(d.side).not.toBe(0);
    for (const d of grid('summit', sides).flat()) { expect(d.kind).toBe('sheen'); expect(d.side).not.toBe(0); }
  });

  it('every summit lip wears a snow cap, and a left-only face puts the decor on the left', () => {
    for (let tx = 0; tx < 30; tx++) {
      const items = tileDecor('summit', tx, 5, { up: true, dn: false, lf: false, rt: false });
      expect(items.filter((d) => d.kind === 'snowcap').length).toBe(1);
      const cap = items[0];
      expect(cap.w).toBe(TILE);
      expect(cap.h).toBeGreaterThanOrEqual(2.4);
      expect(cap.h).toBeLessThanOrEqual(3.6);
    }
    const left: TileFaces = { up: false, dn: false, lf: true, rt: false };
    for (const d of grid('tidepool', left).flat()) expect(d.side).toBe(-1);
    const right: TileFaces = { up: false, dn: false, lf: false, rt: true };
    for (const d of grid('stormspire', right).flat()) expect(d.side).toBe(1);
  });

  it('exposes the fill budget and the rim biomes the QA harness reads', () => {
    expect(TERRAIN_MAX_PATH_FILLS).toBe(9);
    expect(SPIKE_RIM_BIOMES.has('voidreef')).toBe(true);
    expect(SPIKE_RIM_BIOMES.has('summit')).toBe(true);
    expect(SPIKE_RIM_BIOMES.has('tidepool')).toBe(false);
    expect(SPIKE_RIM_BIOMES.has('stormspire')).toBe(false);
  });
});

// ------------------------------------------------------------------ band crossfade support (P5-4b)
describe('Terrain · band crossfade support (P5-4b)', () => {
  class StubPath2D {
    rects = 0;
    rect(): void { this.rects++; }
    moveTo(): void {}
    lineTo(): void {}
    closePath(): void {}
    arc(): void {}
    ellipse(): void {}
    quadraticCurveTo(): void {}
    roundRect(): void {}
  }
  /** globalAlpha assignments, Path2D fills and fillStyle strings the stub saw. */
  interface Rec { alphas: number[]; pathFills: number; styles: Set<string> }
  const stubCanvas = (rec: Rec): HTMLCanvasElement => {
    let state: Record<string, unknown> = { globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '#000', strokeStyle: '#000', lineWidth: 1 };
    const stack: Record<string, unknown>[] = [];
    const ctx = new Proxy(state, {
      get(_t, p) {
        if (typeof p !== 'string') return undefined;
        if (p in state) return state[p];
        return (...args: unknown[]) => {
          switch (p) {
            case 'save': stack.push({ ...state }); return undefined;
            case 'restore': if (stack.length) state = stack.pop()!; return undefined;
            case 'fill': if (args[0] instanceof StubPath2D) rec.pathFills++; return undefined;
            case 'createLinearGradient': case 'createRadialGradient': return { addColorStop() {} };
            case 'createPattern': return { setTransform() {} };
            case 'createImageData': return { width: 1, height: 1, data: new Uint8ClampedArray(Math.max(4, Number(args[0] || 1) * Number(args[1] || 1) * 4)) };
            case 'getImageData': return { width: 1, height: 1, data: new Uint8ClampedArray(4) };
            default: return undefined;
          }
        };
      },
      set(_t, p, v) {
        if (typeof p === 'string') {
          state[p] = v;
          if (p === 'globalAlpha') rec.alphas.push(Number(v));
          if (p === 'fillStyle' && typeof v === 'string') rec.styles.add(v);
        }
        return true;
      },
      has() { return true; },
    });
    const cv = { width: 300, height: 150, getContext: () => ctx } as unknown as HTMLCanvasElement;
    (state as { canvas?: unknown }).canvas = cv;
    return cv;
  };
  /** 12×5: a ledge with a lip, a one-way platform, spikes, water and a buried row. */
  const ROWS = ['............', '..==..^^..~~', '####..######', '############', '############'];
  const build = (biome: BiomeId): { t: Terrain; stage: Stage; rec: Rec } => {
    const rec: Rec = { alphas: [], pathFills: 0, styles: new Set() };
    const stage = new Stage(stubCanvas(rec), { createCanvas: () => stubCanvas(rec), viewport: () => ({ w: 480, h: 270, dpr: 1 }), storage: null });
    stage.setSettings({ bloom: true, grain: true, flashes: true, quality: 'high' });
    const level = new Level({ id: 't1', name: '', en: '', biome, par: 10, seed: 1, rows: ROWS });
    const t = new Terrain(stage, level, BIOMES[biome], () => stubCanvas(rec));
    stage.begin();
    stage.world(96, 40, 0, 0, 1, 0);
    return { t, stage, rec };
  };

  beforeAll(() => { (globalThis as unknown as { Path2D: unknown }).Path2D = StubPath2D; });

  it('draw and drawHazards never assign globalAlpha, so an outer alpha (the fading old palette) stays in force', () => {
    const { t, stage, rec } = build('summit');
    stage.ctx.globalAlpha = 0.4;
    rec.alphas.length = 0;
    t.draw(0.5, 0);
    t.drawHazards(0.5);
    expect(rec.alphas).toEqual([]);
    expect(stage.ctx.globalAlpha).toBe(0.4);
    expect(rec.pathFills).toBeGreaterThan(0);
  });

  it('two biomes over one level each stay within the fill budget (a fading frame draws both) and paint their own crust colours', () => {
    const a = build('tidepool'), b = build('summit');
    a.t.draw(0.5, 0); a.t.drawHazards(0.5);
    b.t.draw(0.5, 0); b.t.drawHazards(0.5);
    // the decor batches differ per biome (barnacle + moss vs sheen + snow cap + shadow), the rock passes do not
    expect(a.rec.pathFills).toBeGreaterThan(0);
    expect(a.rec.pathFills).toBeLessThanOrEqual(TERRAIN_MAX_PATH_FILLS);
    expect(b.rec.pathFills).toBeLessThanOrEqual(TERRAIN_MAX_PATH_FILLS);
    expect(a.t.decorCount).toBeGreaterThan(0);
    expect(b.t.decorCount).toBeGreaterThan(0);
    // the lit lip of a ledge: crustHi toward white at alpha 0.8, per biome
    const lip = (id: BiomeId): string => alpha(mixHex(BIOMES[id].crustHi, '#ffffff', 0.25), 0.8);
    expect(a.rec.styles.has(lip('tidepool'))).toBe(true);
    expect(a.rec.styles.has(lip('summit'))).toBe(false);
    expect(b.rec.styles.has(lip('summit'))).toBe(true);
    expect(b.rec.styles.has(lip('tidepool'))).toBe(false);
  });
});
