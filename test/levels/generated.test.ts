import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GENERATED_PATH, ZONES, render } from '../../levels/build.js';
import { BIOMES, BIOME_ORDER } from '../../src/shared/biomes.js';
import { CHAPTERS, LEVELS, LEVEL_BY_ID } from '../../src/sim/levels.generated.js';

const root = fileURLToPath(new URL('../../', import.meta.url));

describe('levels/build.ts', () => {
  it('renders deterministically (same input → byte-identical output)', () => {
    const a = render(ZONES), b = render(ZONES);
    expect(a).toBe(b);
    expect(a.endsWith('\n')).toBe(true);
    expect(a).not.toMatch(/\r/);
  });

  it('starts with the GENERATED banner and imports only types from ./types.js', () => {
    const src = render(ZONES);
    expect(src.startsWith('/**\n * GENERATED — do not edit')).toBe(true);
    const imports = src.match(/^import .*$/gm) ?? [];
    expect(imports).toEqual(["import type { BiomeId, LevelDef } from './types.js';"]);
    expect(src).not.toMatch(/\brequire\(/);
  });

  it('the committed src/sim/levels.generated.ts is up to date with the zone sources', () => {
    const onDisk = readFileSync(GENERATED_PATH, 'utf8');
    expect(onDisk).toBe(render(ZONES));
    expect(GENERATED_PATH.startsWith(root)).toBe(true);
  });
});

describe('src/sim/levels.generated.ts', () => {
  it('exports LEVELS in tower order, each equal to its zone source', () => {
    expect(LEVELS.map((l) => l.id)).toEqual(['t1', 't2', 't3', 't4', 's1', 's2', 's3', 's4', 'v1', 'v2', 'v3', 'v4', 'm1', 'm2', 'm3', 'm4']);
    for (const z of ZONES) expect(LEVELS.find((l) => l.id === z.id)).toEqual(z);
  });

  it('exports LEVEL_BY_ID keyed by id', () => {
    for (const l of LEVELS) expect(LEVEL_BY_ID[l.id]).toBe(l);
    expect(Object.keys(LEVEL_BY_ID).sort()).toEqual(LEVELS.map((l) => l.id).sort());
  });

  it('exports CHAPTERS per biome with the shared names and four zone ids each, the fourth the tier\'s vertical zone (P2-10) — four tiers since P5-1', () => {
    expect(CHAPTERS.map((c) => c.id)).toEqual(BIOME_ORDER);
    expect(CHAPTERS.map((c) => c.id)).toEqual(['tidepool', 'stormspire', 'voidreef', 'summit']);
    expect(CHAPTERS).toHaveLength(4);
    for (const c of CHAPTERS) {
      expect(c.name).toBe(BIOMES[c.id].name);
      expect(c.kr).toBe(BIOMES[c.id].kr);
      expect(c.levels).toHaveLength(4);
      for (const id of c.levels) expect(LEVEL_BY_ID[id].biome).toBe(c.id);
      const last = LEVEL_BY_ID[c.levels[3]];
      expect(last.rows.length, `${c.id}: ${last.id} should be the vertical zone`).toBeGreaterThan(last.rows[0].length);
    }
    expect(CHAPTERS.map((c) => c.levels[3])).toEqual(['t4', 's4', 'v4', 'm4']);
    expect(CHAPTERS[3]).toMatchObject({ id: 'summit', name: 'AURORA SUMMIT', kr: '오로라 정점', levels: ['m1', 'm2', 'm3', 'm4'] });
    expect(CHAPTERS.flatMap((c) => c.levels)).toEqual(LEVELS.map((l) => l.id));
  });

  it('rows are rectangular strings and hints are single lines', () => {
    for (const l of LEVELS) {
      const w = l.rows[0].length;
      for (const r of l.rows) expect(r).toHaveLength(w);
      expect(l.hint).not.toMatch(/\n/);
    }
  });
});
