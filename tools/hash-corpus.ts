/**
 * Node (V8) side of the cross-engine determinism corpus.
 *
 *   npx tsx tools/hash-corpus.ts                 rewrite test/fixtures/corpus-digests.json
 *   npx tsx tools/hash-corpus.ts --check         exit 1 when the fixture on disk is stale
 *   npx tsx tools/hash-corpus.ts --out <path>    write somewhere else (tests)
 *
 * The fixture holds, for every story zone's goal echo and two scripted daily
 * towers, the digest src/client/selftest.ts computes (outcome + FNV-1a of the
 * final state). vitest asserts the in-process digests equal it (regression
 * net: any physics or level change shows up here before it reaches a board);
 * tools/qa/selftest.ts asserts every browser engine stamps the same digests
 * through `?shot=selftest` (the V8 ↔ JavaScriptCore proof).
 *
 * Rewrite the fixture deliberately, together with a SIM_VERSION / GEN_VERSION
 * bump or a golden replay re-recording — never to make a red test green.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCorpusSelftest, type CorpusDigest } from '../src/client/selftest.js';

export const FIXTURE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'corpus-digests.json');

export interface CorpusFixture {
  /** SIM_VERSION / GEN_VERSION the digests were computed against. */
  sim: number;
  gen: number;
  /** The reference engine: the fixture is always Node's V8. */
  engine: 'v8';
  digests: CorpusDigest[];
}

/** Compute the fixture from the sim in this process. */
export function corpusFixture(): CorpusFixture {
  const report = runCorpusSelftest();
  return { sim: report.sim, gen: report.gen, engine: 'v8', digests: report.digests };
}

/** The exact bytes written to disk (2-space JSON, trailing newline) so `--check` is byte-stable. */
export function renderFixture(fixture: CorpusFixture): string {
  return `${JSON.stringify(fixture, null, 2)}\n`;
}

/** Parse a fixture file. Throws on a missing or malformed file. */
export function readFixture(path = FIXTURE_PATH): CorpusFixture {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<CorpusFixture>;
  if (typeof parsed.sim !== 'number' || typeof parsed.gen !== 'number' || !Array.isArray(parsed.digests)) {
    throw new Error(`${path}: not a corpus fixture`);
  }
  return parsed as CorpusFixture;
}

/** True when the file at `path` differs from what this process would write. A missing file is stale. */
export function fixtureStale(path = FIXTURE_PATH): boolean {
  let onDisk: string;
  try {
    onDisk = readFileSync(path, 'utf8');
  } catch {
    return true;
  }
  return onDisk !== renderFixture(corpusFixture());
}

export function parseArgs(argv: string[]): { check: boolean; out: string } {
  let check = false;
  let out = FIXTURE_PATH;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') check = true;
    else if (a === '--out') out = resolve(argv[++i] ?? '');
    else if (a.startsWith('--out=')) out = resolve(a.slice('--out='.length));
    else throw new Error(`unknown argument '${a}'`);
  }
  if (!out) throw new Error('--out needs a path');
  return { check, out };
}

/** CLI entry. Returns the exit code; writes progress to stdout / stderr. */
export function main(argv: string[]): number {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`hash-corpus: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  const fixture = corpusFixture();
  const lines = fixture.digests.map((d) => `  ${d.key.padEnd(15)} ${d.hash}  ticks ${String(d.ticks).padStart(5)}  ${d.cleared ? 'clear' : 'open '}  deaths ${d.deaths}`);
  if (args.check) {
    if (fixtureStale(args.out)) {
      process.stderr.write(`hash-corpus: ${args.out} is stale — run \`npx tsx tools/hash-corpus.ts\` and commit the result\n`);
      return 1;
    }
    process.stdout.write(`hash-corpus: ${args.out} is current (sim ${fixture.sim} · gen ${fixture.gen} · ${fixture.digests.length} digests)\n`);
    return 0;
  }
  writeFileSync(args.out, renderFixture(fixture));
  process.stdout.write(`hash-corpus: wrote ${args.out} (sim ${fixture.sim} · gen ${fixture.gen} · ${fixture.digests.length} digests)\n${lines.join('\n')}\n`);
  return 0;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
