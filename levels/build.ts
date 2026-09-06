/**
 * Level builder. Validates every hand-authored zone and writes
 * src/sim/levels.generated.ts — a dependency-free data module the sim, the
 * client and the server all import. Output is a pure function of the zone
 * sources, so rebuilding without changes yields a byte-identical file.
 *
 *   npx tsx levels/build.ts        (npm run levels)
 *   npx tsx levels/build.ts --check   exit 1 if the file on disk is stale
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { LevelDef } from '../src/sim/types.js';
import { BIOMES, BIOME_ORDER } from '../src/shared/biomes.js';
import { census, validate } from './dsl.js';
import { t1 } from './zones/t1.js';
import { t2 } from './zones/t2.js';
import { t3 } from './zones/t3.js';
import { s1 } from './zones/s1.js';
import { s2 } from './zones/s2.js';
import { s3 } from './zones/s3.js';
import { v1 } from './zones/v1.js';
import { v2 } from './zones/v2.js';
import { v3 } from './zones/v3.js';

/** Tower order: three tiers of three zones. */
export const ZONES: LevelDef[] = [t1, t2, t3, s1, s2, s3, v1, v2, v3];

export const GENERATED_PATH = fileURLToPath(new URL('../src/sim/levels.generated.ts', import.meta.url));

/** Single-quoted TS string literal. */
const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** Emit one LevelDef as TypeScript source. Keys in a fixed order, rows one per line. */
function emitLevel(d: LevelDef): string {
  const out: string[] = [];
  out.push('  {');
  out.push(`    id: ${q(d.id)}, name: ${q(d.name)}, en: ${q(d.en)}, biome: ${q(d.biome)},`);
  out.push(`    par: ${d.par}, seed: ${d.seed},`);
  if (d.rev !== undefined) out.push(`    rev: ${d.rev},`);
  if (d.hint !== undefined) out.push(`    hint: ${q(d.hint)},`);
  if (d.tide) out.push('    tide: true,');
  if (d.baseY !== undefined) out.push(`    baseY: ${d.baseY},`);
  if (d.spikers?.length) out.push(`    spikers: ${JSON.stringify(d.spikers)},`);
  out.push('    rows: [');
  for (const r of d.rows) out.push(`      ${q(r)},`);
  out.push('    ],');
  out.push('  },');
  return out.join('\n');
}

/** Render the whole generated module. Throws if any zone fails validation. */
export function render(zones: readonly LevelDef[]): string {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const z of zones) {
    if (ids.has(z.id)) problems.push(`${z.id}: duplicate id`);
    ids.add(z.id);
    problems.push(...validate(z));
  }
  if (problems.length) throw new Error(`level validation failed:\n  ${problems.join('\n  ')}`);

  const chapters = BIOME_ORDER.map((b) => ({
    id: b, name: BIOMES[b].name, kr: BIOMES[b].kr,
    levels: zones.filter((z) => z.biome === b).map((z) => z.id),
  }));

  const out: string[] = [
    '/**',
    ' * GENERATED — do not edit. Source: levels/zones/*.ts, built by levels/build.ts',
    ' * (`npm run levels`). Rows are rectangular and every geometry rule in',
    ' * levels/dsl.ts validate() held when this file was written.',
    ' */',
    "import type { BiomeId, LevelDef } from './types.js';",
    '',
    '/** Story zones in tower order. */',
    'export const LEVELS: LevelDef[] = [',
    ...zones.map(emitLevel),
    '];',
    '',
    'export const LEVEL_BY_ID: Record<string, LevelDef> = Object.fromEntries(LEVELS.map((l) => [l.id, l]));',
    '',
    'export interface Chapter {',
    '  id: BiomeId;',
    '  /** English biome name. */',
    '  name: string;',
    '  /** Korean biome name. */',
    '  kr: string;',
    '  /** Zone ids in play order. */',
    '  levels: string[];',
    '}',
    '',
    '/** Zones grouped by tower tier, in play order. */',
    'export const CHAPTERS: Chapter[] = [',
    ...chapters.map((c) => `  { id: ${q(c.id)}, name: ${q(c.name)}, kr: ${q(c.kr)}, levels: [${c.levels.map(q).join(', ')}] },`),
    '];',
    '',
  ];
  return out.join('\n');
}

/** One line per zone for the console. */
export function summary(zones: readonly LevelDef[]): string {
  return zones.map((z) => {
    const c = census(z);
    return `${z.id.padEnd(3)} ${z.name.padEnd(8)} ${String(c.w).padStart(3)}x${String(c.h).padEnd(3)} par ${String(z.par).padStart(3)}  shards ${String(c.shards).padStart(2)}  relics ${c.relics}  checkpoints ${c.checkpoints}`;
  }).join('\n');
}

function main(argv: string[]): number {
  const src = render(ZONES);
  if (argv.includes('--check')) {
    let cur = '';
    try { cur = readFileSync(GENERATED_PATH, 'utf8'); } catch { /* missing */ }
    if (cur !== src) {
      process.stderr.write(`${GENERATED_PATH} is stale — run \`npm run levels\`\n`);
      return 1;
    }
    process.stdout.write('levels.generated.ts is up to date\n');
    return 0;
  }
  writeFileSync(GENERATED_PATH, src);
  process.stdout.write(`${summary(ZONES)}\nwrote ${GENERATED_PATH} (${src.length} bytes)\n`);
  return 0;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
