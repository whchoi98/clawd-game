/**
 * tools/hash-corpus.ts as a library: the fixture it renders must be exactly
 * what is committed in test/fixtures/corpus-digests.json (byte for byte, so
 * `--check` stays meaningful), and its CLI must write / check that file.
 * tools/qa/corpus.ts (the comparison the browser QA runs) is covered too.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GEN_VERSION, SIM_VERSION } from '../../src/sim/types.js';
import { GOAL_ECHOES } from '../../src/sim/echoes.generated.js';
import { DAILY_SEEDS, type CorpusDigest } from '../../src/client/selftest.js';
import { FIXTURE_PATH, corpusFixture, fixtureStale, main, parseArgs, readFixture, renderFixture } from '../../tools/hash-corpus.js';
import { FIXTURE_PATH as QA_FIXTURE_PATH, compareDigests, describeMismatches, loadFixture, parseSelftestStamp } from '../../tools/qa/corpus.js';

const SCRATCH = '/tmp/claude-1000/-home-ec2-user-my-project-clawd-game/f8aa643c-bc48-400a-8c09-d71da38a73d7/scratchpad';
mkdirSync(SCRATCH, { recursive: true });
const tmp = mkdtempSync(join(SCRATCH, 'hash-corpus-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Silence the CLI's stdout / stderr for one call. */
function quiet<T>(fn: () => T): T {
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    return fn();
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

describe('tools/hash-corpus — fixture', () => {
  const fixture = corpusFixture();

  it('renders exactly the committed test/fixtures/corpus-digests.json', () => {
    expect(FIXTURE_PATH.endsWith('test/fixtures/corpus-digests.json')).toBe(true);
    expect(QA_FIXTURE_PATH).toBe(FIXTURE_PATH);
    expect(renderFixture(fixture)).toBe(readFileSync(FIXTURE_PATH, 'utf8'));
    expect(fixtureStale()).toBe(false);
    expect(readFixture()).toEqual(fixture);
    expect(loadFixture()).toEqual(fixture);
  });

  it('carries the sim / gen versions, the v8 reference engine and one digest per corpus key', () => {
    expect(fixture.sim).toBe(SIM_VERSION);
    expect(fixture.gen).toBe(GEN_VERSION);
    expect(fixture.engine).toBe('v8');
    expect(fixture.digests.map((d) => d.key)).toEqual([...Object.keys(GOAL_ECHOES), ...DAILY_SEEDS.map((s) => `daily:${s}`)]);
    for (const d of fixture.digests) {
      expect(d.hash).toMatch(/^[0-9a-f]{8}$/);
      expect(Number.isInteger(d.x) && Number.isInteger(d.y)).toBe(true);
    }
    expect(new Set(fixture.digests.map((d) => d.hash)).size).toBe(fixture.digests.length);
  });

  it('renderFixture ends with one newline and is stable', () => {
    const s = renderFixture(fixture);
    expect(s.endsWith('}\n')).toBe(true);
    expect(s.endsWith('\n\n')).toBe(false);
    expect(renderFixture(corpusFixture())).toBe(s);
  });
});

describe('tools/hash-corpus — CLI', () => {
  it('parses --check, --out <path> and --out=<path>, refuses anything else', () => {
    expect(parseArgs([])).toEqual({ check: false, out: FIXTURE_PATH });
    expect(parseArgs(['--check']).check).toBe(true);
    expect(parseArgs(['--out', '/x/y.json']).out).toBe('/x/y.json');
    expect(parseArgs(['--out=/x/z.json']).out).toBe('/x/z.json');
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown argument/);
  });

  it('writes a fixture that --check then accepts, and flags a stale or missing one', () => {
    const out = join(tmp, 'digests.json');
    expect(fixtureStale(out)).toBe(true);                       // missing
    expect(quiet(() => main(['--check', '--out', out]))).toBe(1);
    expect(quiet(() => main(['--out', out]))).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe(renderFixture(corpusFixture()));
    expect(quiet(() => main(['--check', '--out', out]))).toBe(0);
    const stale = readFixture(out);
    stale.digests[0] = { ...stale.digests[0], hash: '00000000' };
    writeFileSync(out, renderFixture(stale));
    expect(fixtureStale(out)).toBe(true);
    expect(quiet(() => main(['--check', '--out', out]))).toBe(1);
    expect(quiet(() => main(['--nope']))).toBe(2);
  });

  it('readFixture rejects a file that is not a fixture', () => {
    const bad = join(tmp, 'bad.json');
    writeFileSync(bad, '{"hello":1}\n');
    expect(() => readFixture(bad)).toThrow(/not a corpus fixture/);
    expect(() => loadFixture(bad)).toThrow(/not a corpus fixture/);
  });
});

describe('tools/qa/corpus — stamp parsing and comparison', () => {
  const fixture = corpusFixture();
  const stamp = { phase: 'selftest', engine: 'jsc', ua: 'x', sim: fixture.sim, gen: fixture.gen, corpus: fixture.digests.length, selftest: fixture.digests };

  it('parses a selftest stamp and rejects error / foreign stamps', () => {
    const parsed = parseSelftestStamp(JSON.stringify(stamp));
    expect(parsed.engine).toBe('jsc');
    expect(parsed.sim).toBe(fixture.sim);
    expect(parsed.digests).toEqual(fixture.digests);
    expect(() => parseSelftestStamp(JSON.stringify({ error: 'boom' }))).toThrow(/harness reported: boom/);
    expect(() => parseSelftestStamp(JSON.stringify({ phase: 'play', tick: 3 }))).toThrow(/not a selftest stamp/);
    expect(() => parseSelftestStamp('not json')).toThrow(/not JSON/);
  });

  it('compareDigests is all-ok for identical lists and names the field that drifted', () => {
    const same = compareDigests(fixture.digests, fixture.digests);
    expect(same.every((r) => r.ok)).toBe(true);
    expect(describeMismatches(same)).toEqual([]);

    const drifted: CorpusDigest[] = fixture.digests.map((d, i) => (i === 2 ? { ...d, hash: 'deadbeef', x: d.x + 1 } : d));
    const missing = drifted.filter((d) => d.key !== 'daily:1');
    const rows = compareDigests(missing, fixture.digests);
    const bad = rows.filter((r) => !r.ok);
    expect(bad.map((r) => r.key)).toEqual([fixture.digests[2].key, 'daily:1']);
    expect(bad[0].diff).toEqual(['x', 'hash']);
    expect(bad[1].actual).toBeNull();
    const text = describeMismatches(rows);
    expect(text[0]).toContain(`hash "deadbeef" != "${fixture.digests[2].hash}"`);
    expect(text[1]).toMatch(/daily:1: no digest stamped/);
  });
});
