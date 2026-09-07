/**
 * Level builder. Validates every hand-authored zone (geometry rules plus the
 * zone pacing rules: size envelope, checkpoint density and spacing, 8–12 shards) and writes
 * src/sim/levels.generated.ts — a dependency-free data module the sim, the
 * client and the server all import. Output is a pure function of the zone
 * sources, so rebuilding without changes yields a byte-identical file.
 *
 * It also turns the golden replay corpora into src/sim/echoes.generated.ts:
 * GOAL_ECHOES, one verified developer clear per zone, shown as the '목표' echo
 * on an empty board and used to seed boards on the server. The PACED corpus
 * (levels/solutions/par/*.json — a human-looking clear at 0.95–1.10 × par) is
 * the source; a zone without a usable paced solution falls back to the FAST
 * corpus (levels/solutions/*.json) with a printed warning, because a 7-second
 * ghost on a 45-second zone is not a goal anyone can follow. A solution
 * recorded on another SIM_VERSION, geometry revision or seed — or one that no
 * longer replays to a death-free clear — is never emitted.
 *
 * And it emits the authored tower chunks (levels/chunks/*.ts) as
 * src/sim/chunks.generated.ts: every chunk passes validateChunk() and its solo
 * room passes the DSL validator before anything is written. The generator
 * splices from that list, so its contents are part of GEN_VERSION.
 *
 *   npx tsx levels/build.ts        (npm run levels)
 *   npx tsx levels/build.ts --check   exit 1 if any generated file on disk is stale
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { SIM_VERSION } from '../src/sim/types.js';
import type { LevelDef } from '../src/sim/types.js';
import { decodeMasks, verifyReplay } from '../src/sim/replay.js';
import { BIOMES, BIOME_ORDER } from '../src/shared/biomes.js';
import { chunkRoom, validateChunk } from '../src/sim/gen/chunks.js';
import type { ChunkDef } from '../src/sim/gen/chunks.js';
import { census, validate, validateZone } from './dsl.js';
import { readSolutions, staleReason } from './solutions.js';
import type { Solution } from './solutions.js';
import { CHUNK_SOURCES } from './chunks/index.js';
import { t1 } from './zones/t1.js';
import { t2 } from './zones/t2.js';
import { t3 } from './zones/t3.js';
import { t4 } from './zones/t4.js';
import { s1 } from './zones/s1.js';
import { s2 } from './zones/s2.js';
import { s3 } from './zones/s3.js';
import { s4 } from './zones/s4.js';
import { v1 } from './zones/v1.js';
import { v2 } from './zones/v2.js';
import { v3 } from './zones/v3.js';
import { v4 } from './zones/v4.js';

/** Tower order: three tiers of four zones — three side-scrolling rooms and one vertical climb (t4 · s4 · v4, P2-10) each. */
export const ZONES: LevelDef[] = [t1, t2, t3, t4, s1, s2, s3, s4, v1, v2, v3, v4];

export const GENERATED_PATH = fileURLToPath(new URL('../src/sim/levels.generated.ts', import.meta.url));
export const ECHOES_PATH = fileURLToPath(new URL('../src/sim/echoes.generated.ts', import.meta.url));
export const CHUNKS_PATH = fileURLToPath(new URL('../src/sim/chunks.generated.ts', import.meta.url));

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
    problems.push(...validateZone(z));
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

/** Why a solution is not emitted as a goal echo, or null when it is current and replays to a death-free clear. */
export function solutionProblem(def: LevelDef, sol: Solution): string | null {
  const stale = staleReason(def, sol);
  if (stale) return stale;
  let masks: Uint8Array;
  try {
    masks = decodeMasks(sol.masks);
  } catch (e) {
    return `masks do not decode (${e instanceof Error ? e.message : String(e)})`;
  }
  const v = verifyReplay(def, { v: SIM_VERSION, levelId: def.id, seed: def.seed, assist: false, masks });
  if (!v.ok) return `replay does not verify (${v.reason})`;
  if (!v.summary.cleared) return 'replay does not clear the zone';
  if (v.summary.deaths !== 0) return `replay dies ${v.summary.deaths} time(s)`;
  if (v.summary.ticks !== sol.ticks) return `replay takes ${v.summary.ticks} ticks, the file says ${sol.ticks}`;
  return null;
}

/** Which corpus a goal echo came from. */
export type EchoSource = 'paced' | 'fast';

/**
 * Render src/sim/echoes.generated.ts. `paced` is the source corpus; a zone whose
 * paced solution is missing or no longer verifies takes its `fallback` (fast)
 * solution instead, with a warning. Zones with neither current solution are left
 * out and reported in `warnings` as well. `sources` says where each entry came from.
 */
export function renderEchoes(
  zones: readonly LevelDef[], paced: Readonly<Record<string, Solution>>, fallback: Readonly<Record<string, Solution>> = {},
): { src: string; warnings: string[]; sources: Record<string, EchoSource> } {
  const warnings: string[] = [];
  const entries: string[] = [];
  const sources: Record<string, EchoSource> = {};
  for (const z of zones) {
    let sol: Solution | undefined = paced[z.id];
    let source: EchoSource = 'paced';
    let problem = sol ? solutionProblem(z, sol) : 'no paced solution';
    if (problem) {
      const fast = fallback[z.id];
      const fastProblem = fast ? solutionProblem(z, fast) : 'no fast solution either';
      if (fast && !fastProblem) {
        warnings.push(`${z.id}: ${problem} — goal echo falls back to the fast corpus (${fast.time.toFixed(2)}s, ${((fast.time / z.par) * 100).toFixed(0)}% of par)`);
        sol = fast;
        source = 'fast';
        problem = null;
      } else {
        warnings.push(`${z.id}: solution skipped — ${problem}; ${fastProblem}`);
        continue;
      }
    }
    sources[z.id] = source;
    entries.push(`  ${z.id}: { sim: ${sol!.sim}, rev: ${sol!.rev}, seed: ${sol!.seed}, masks: ${q(sol!.masks)}, ticks: ${sol!.ticks} },`);
  }
  const src = [
    '/**',
    ' * GENERATED — do not edit. Source: levels/solutions/par/*.json (the paced corpus),',
    ' * built by levels/build.ts (`npm run levels`). One verified developer clear per',
    ' * story zone — deaths 0, human-paced at 0.95–1.10 × par (a zone without a paced',
    ' * solution falls back to levels/solutions/<id>.json, the fast corpus, with a build',
    ` * warning) — recorded against SIM_VERSION ${SIM_VERSION} at the zone's geometry revision.`,
    " * The client runs it as the '목표' echo when a board is empty or unreachable; the",
    ' * server seeds empty story boards with it. A zone without a current solution has',
    ' * no entry (see levels/solutions/par/PENDING.json and levels/solutions/PENDING.json).',
    ' */',
    '',
    'export interface GoalEcho {',
    '  /** SIM_VERSION the masks were recorded against. */',
    '  sim: number;',
    '  /** LevelDef.rev at recording time (missing rev = 0). */',
    '  rev: number;',
    '  seed: number;',
    '  /** RLE base64 masks (src/sim/replay.ts encodeMasks). */',
    '  masks: string;',
    '  /** Play ticks of the verified run. */',
    '  ticks: number;',
    '}',
    '',
    '/** Zone id → the developer clear that stands in for an empty leaderboard. */',
    'export const GOAL_ECHOES: Readonly<Record<string, GoalEcho>> = {',
    ...entries,
    '};',
    '',
  ].join('\n');
  return { src, warnings, sources };
}

/** Every problem with the authored chunks: geometry rules, duplicate ids, and the DSL validator on each solo room. */
export function chunkProblems(chunks: readonly ChunkDef[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const c of chunks) {
    if (ids.has(c.id)) problems.push(`${c.id}: duplicate id`);
    ids.add(c.id);
    const own = validateChunk(c);
    problems.push(...own);
    if (!own.length) problems.push(...validate(chunkRoom(c)).map((e) => `${c.id} (solo room): ${e}`));
  }
  return problems;
}

/** Render src/sim/chunks.generated.ts, sorted by id. Throws if any chunk fails validation. */
export function renderChunks(chunks: readonly ChunkDef[]): string {
  const problems = chunkProblems(chunks);
  if (problems.length) throw new Error(`chunk validation failed:\n  ${problems.join('\n  ')}`);
  const sorted = [...chunks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out: string[] = [
    '/**',
    ' * GENERATED — do not edit. Source: levels/chunks/*.ts, built by levels/build.ts',
    ' * (`npm run levels`). Authored tower chunks the daily / endless generator splices',
    ' * into every band (src/sim/gen/endless.ts); each passed validateChunk() and its',
    ' * solo room passed the DSL validator when this file was written. The list order',
    ' * (by id) is part of the generator output: any change here needs a GEN_VERSION bump.',
    ' */',
    "import type { ChunkDef } from './gen/chunks.js';",
    '',
    '/** Authored chunks, sorted by id. */',
    'export const CHUNKS: readonly ChunkDef[] = [',
  ];
  for (const c of sorted) {
    out.push('  {');
    out.push(`    id: ${q(c.id)}, name: ${q(c.name)}, tags: [${c.tags.map(q).join(', ')}],`);
    out.push(`    entry: { x0: ${c.entry.x0}, x1: ${c.entry.x1} }, exit: { x0: ${c.exit.x0}, x1: ${c.exit.x1} },`);
    out.push('    rows: [');
    for (const r of c.rows) out.push(`      ${q(r)},`);
    out.push('    ],');
    out.push('  },');
  }
  out.push('];', '');
  return out.join('\n');
}

/** One line per chunk for the console. */
export function chunkSummary(chunks: readonly ChunkDef[]): string {
  return chunks.map((c) => {
    const flat = c.rows.join('');
    const n = (ch: string) => flat.split(ch).length - 1;
    return `${c.id.padEnd(15)} ${c.name.padEnd(9)} ${c.rows[0].length}x${String(c.rows.length).padEnd(3)} [${c.tags.join(', ')}]  entry ${c.entry.x0}..${c.entry.x1}  exit ${c.exit.x0}..${c.exit.x1}  shards ${n('o')}  crystals ${n('D')}  toggles ${n('k')}`;
  }).join('\n');
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
  const ids = ZONES.map((z) => z.id);
  const echoes = renderEchoes(ZONES, readSolutions(ids, 'par'), readSolutions(ids, 'fast'));
  const chunks = renderChunks(CHUNK_SOURCES);
  for (const w of echoes.warnings) process.stderr.write(`warning: ${w}\n`);
  if (argv.includes('--check')) {
    let stale = 0;
    for (const [path, want] of [[GENERATED_PATH, src], [ECHOES_PATH, echoes.src], [CHUNKS_PATH, chunks]] as const) {
      let cur = '';
      try { cur = readFileSync(path, 'utf8'); } catch { /* missing */ }
      if (cur !== want) {
        process.stderr.write(`${path} is stale — run \`npm run levels\`\n`);
        stale++;
      }
    }
    if (stale) return 1;
    process.stdout.write('levels.generated.ts, echoes.generated.ts and chunks.generated.ts are up to date\n');
    return 0;
  }
  writeFileSync(GENERATED_PATH, src);
  writeFileSync(ECHOES_PATH, echoes.src);
  writeFileSync(CHUNKS_PATH, chunks);
  const solved = Object.keys(echoes.sources).length;
  const fast = Object.values(echoes.sources).filter((s) => s === 'fast').length;
  process.stdout.write(`${summary(ZONES)}\n${chunkSummary(CHUNK_SOURCES)}\nwrote ${GENERATED_PATH} (${src.length} bytes)\nwrote ${ECHOES_PATH} (${solved}/${ZONES.length} goal echoes${fast ? `, ${fast} from the fast corpus` : ', all human-paced'})\nwrote ${CHUNKS_PATH} (${CHUNK_SOURCES.length} chunks)\n`);
  return 0;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
