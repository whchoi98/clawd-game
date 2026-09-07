/**
 * Terrain face decor (P5-3): `tileDecor` is a pure function of biome and tile
 * coordinates — the same tile always grows the same barnacles, so a ledge
 * never shimmers — and every biome gets its own kinds on the faces they belong to.
 */
import { describe, expect, it } from 'vitest';
import { BIOMES } from '../../src/shared/biomes.js';
import type { BiomeId } from '../../src/sim/types.js';
import { TILE } from '../../src/sim/types.js';
import { SPIKE_RIM_BIOMES, TERRAIN_MAX_PATH_FILLS, tileDecor, type FaceDecor, type TileFaces } from '../../src/client/render/tiles.js';

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
