/**
 * Shared by tools/qa/smoke.ts and tools/qa/selftest.ts: read the Node fixture
 * (test/fixtures/corpus-digests.json), parse the `?shot=selftest` stamp a page
 * carries on <html data-shot>, and compare the two digest lists key by key.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CorpusDigest, EngineFamily } from '../../src/client/selftest.js';

export const FIXTURE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'corpus-digests.json');
export const FIXTURE_NAME = 'test/fixtures/corpus-digests.json';

export interface Fixture { sim: number; gen: number; engine: string; digests: CorpusDigest[] }

export interface SelftestStampData {
  engine: EngineFamily;
  ua: string;
  sim: number;
  gen: number;
  digests: CorpusDigest[];
}

/** One corpus key compared between the fixture and an engine. */
export interface Comparison {
  key: string;
  expected: CorpusDigest;
  /** Null when the engine stamped no digest for this key. */
  actual: CorpusDigest | null;
  ok: boolean;
  /** Field names that differ (empty when ok or when actual is null). */
  diff: (keyof CorpusDigest)[];
}

/** The digest fields the engines must agree on. */
const COMPARED: readonly (keyof CorpusDigest)[] = ['levelId', 'seed', 'tick', 'ticks', 'cleared', 'shards', 'deaths', 'x', 'y', 'hash'];

export function loadFixture(path = FIXTURE_PATH): Fixture {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Fixture>;
  if (typeof parsed.sim !== 'number' || typeof parsed.gen !== 'number' || !Array.isArray(parsed.digests)) {
    throw new Error(`${path} is not a corpus fixture — run \`npx tsx tools/hash-corpus.ts\``);
  }
  return parsed as Fixture;
}

/** Parse the harness stamp; throws when it reports an error or is not a selftest stamp. */
export function parseSelftestStamp(raw: string): SelftestStampData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`data-shot is not JSON: ${raw.slice(0, 80)}`);
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('data-shot is not an object');
  const o = parsed as Record<string, unknown>;
  if (typeof o.error === 'string') throw new Error(`harness reported: ${o.error}`);
  if (o.phase !== 'selftest' || !Array.isArray(o.selftest)) throw new Error('data-shot is not a selftest stamp (phase / selftest missing)');
  return {
    engine: (typeof o.engine === 'string' ? o.engine : 'unknown') as EngineFamily,
    ua: typeof o.ua === 'string' ? o.ua : '',
    sim: Number(o.sim),
    gen: Number(o.gen),
    digests: o.selftest as CorpusDigest[],
  };
}

/** Compare an engine's digests against the fixture, one row per fixture key (extra engine keys are ignored). */
export function compareDigests(actual: readonly CorpusDigest[], expected: readonly CorpusDigest[]): Comparison[] {
  const byKey = new Map(actual.map((d) => [d.key, d] as const));
  return expected.map((exp) => {
    const act = byKey.get(exp.key) ?? null;
    const diff = act ? COMPARED.filter((f) => act[f] !== exp[f]) : [];
    return { key: exp.key, expected: exp, actual: act, ok: act !== null && diff.length === 0, diff };
  });
}

/** One line per mismatch, for issue lists. */
export function describeMismatches(rows: readonly Comparison[]): string[] {
  return rows.filter((r) => !r.ok).map((r) => {
    if (!r.actual) return `${r.key}: no digest stamped (fixture ${r.expected.hash})`;
    const fields = r.diff.map((f) => `${f} ${JSON.stringify(r.actual?.[f])} != ${JSON.stringify(r.expected[f])}`);
    return `${r.key}: ${fields.join(', ')}`;
  });
}
