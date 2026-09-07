/**
 * The determinism corpus self-test (P3-2), in-process on Node's V8: the
 * digests src/client/selftest.ts computes must equal the committed fixture
 * (regression net for physics / level / generator changes), the hashing
 * primitives must be what the browsers compute, and the `?shot=selftest`
 * stamp must keep the shape tools/qa/selftest.ts and smoke.ts parse.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GEN_VERSION, IN, SIM_VERSION } from '../../src/sim/types.js';
import { Sim } from '../../src/sim/sim.js';
import { LEVELS, LEVEL_BY_ID } from '../../src/sim/levels.generated.js';
import { GOAL_ECHOES } from '../../src/sim/echoes.generated.js';
import type { RendererPort } from '../../src/client/contracts.js';
import type { Scenes, ShellUI } from '../../src/client/scenes.js';
import { SHOT_SELFTEST, parseShotQuery, runShot } from '../../src/client/shot.js';
import {
  DAILY_SCRIPT_PERIOD, DAILY_SCRIPT_RUN, DAILY_SCRIPT_TAP, DAILY_SEEDS, DAILY_TICKS,
  canonicalJson, corpusKeys, dailyDigest, dailyScriptMask, engineOf, fnv1a32, runCorpusSelftest, selftestStamp, stateHash, storyDigest,
  type CorpusDigest,
} from '../../src/client/selftest.js';

const FIXTURE = JSON.parse(readFileSync(new URL('../fixtures/corpus-digests.json', import.meta.url), 'utf8')) as {
  sim: number; gen: number; engine: string; digests: CorpusDigest[];
};
/** The stamp's digest object keeps exactly these keys in this order — tools parse it by name. */
const DIGEST_KEYS = ['key', 'levelId', 'seed', 'tick', 'ticks', 'cleared', 'shards', 'deaths', 'x', 'y', 'hash'];

describe('selftest — hashing primitives', () => {
  it('fnv1a32 matches the published FNV-1a test vectors', () => {
    expect(fnv1a32('')).toBe('811c9dc5');
    expect(fnv1a32('a')).toBe('e40c292c');
    expect(fnv1a32('foobar')).toBe('bf9cf968');
  });

  it('canonicalJson sorts object keys recursively and otherwise matches JSON.stringify', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 2, { z: 0, y: null }], c: 'x' } })).toBe('{"a":{"c":"x","d":[1,2,{"y":null,"z":0}]},"b":1}');
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson([1.5, -0.25, 1e21, true, 'é'])).toBe(JSON.stringify([1.5, -0.25, 1e21, true, 'é']));
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson(null)).toBe('null');
  });

  it('stateHash is stable for equal states and changes after one more tick', () => {
    const a = new Sim(LEVELS[0], { seed: 5 });
    const b = new Sim(LEVELS[0], { seed: 5 });
    for (let i = 0; i < 100; i++) { a.step(IN.RIGHT); b.step(IN.RIGHT); }
    expect(stateHash(a)).toBe(stateHash(b));
    expect(stateHash(a)).toMatch(/^[0-9a-f]{8}$/);
    b.step(IN.RIGHT);
    expect(stateHash(b)).not.toBe(stateHash(a));
  });
});

describe('selftest — corpus digests', () => {
  const report = runCorpusSelftest();

  it('covers every zone with a goal echo and the two fixed daily seeds, in report order', () => {
    expect(report.sim).toBe(SIM_VERSION);
    expect(report.gen).toBe(GEN_VERSION);
    expect(report.digests.map((d) => d.key)).toEqual(corpusKeys());
    expect(report.digests.map((d) => d.key)).toEqual([...Object.keys(GOAL_ECHOES), ...DAILY_SEEDS.map((s) => `daily:${s}`)]);
    expect(Object.keys(GOAL_ECHOES)).toHaveLength(12);
    expect(DAILY_SEEDS).toEqual([1, 20260906]);
  });

  it('every story digest is a death-free clear whose play ticks equal the recording', () => {
    for (const id of Object.keys(GOAL_ECHOES)) {
      const d = report.digests.find((x) => x.key === id)!;
      expect(d.levelId).toBe(id);
      expect(d.seed).toBe(GOAL_ECHOES[id].seed);
      expect(d.cleared, `${id} cleared`).toBe(true);
      expect(d.deaths, `${id} deaths`).toBe(0);
      expect(d.ticks, `${id} ticks`).toBe(GOAL_ECHOES[id].ticks);
      expect(d.tick).toBeGreaterThan(d.ticks);
      expect(d.hash).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it('daily digests come from the generated tower under the fixed script, capped at DAILY_TICKS', () => {
    for (const seed of DAILY_SEEDS) {
      const d = report.digests.find((x) => x.key === `daily:${seed}`)!;
      expect(d.levelId).toBe('daily');
      expect(d.seed).toBe(seed);
      expect(d.tick).toBeLessThanOrEqual(DAILY_TICKS);
      expect(d.tick).toBeGreaterThan(0);
      expect(d.cleared).toBe(false);
    }
    // the script: RIGHT for 60 ticks, a 3-tick jump tap, repeat
    expect(DAILY_SCRIPT_PERIOD).toBe(64);
    for (let i = 0; i < DAILY_SCRIPT_RUN; i++) expect(dailyScriptMask(i)).toBe(IN.RIGHT);
    for (let i = DAILY_SCRIPT_RUN; i < DAILY_SCRIPT_RUN + DAILY_SCRIPT_TAP; i++) expect(dailyScriptMask(i)).toBe(IN.RIGHT | IN.JUMP);
    expect(dailyScriptMask(DAILY_SCRIPT_PERIOD - 1)).toBe(IN.RIGHT);
    expect(dailyScriptMask(DAILY_SCRIPT_PERIOD + DAILY_SCRIPT_RUN)).toBe(IN.RIGHT | IN.JUMP);
    // a different seed is a different tower
    expect(dailyDigest(1).hash).not.toBe(dailyDigest(20260906).hash);
  });

  it('equals the committed fixture (test/fixtures/corpus-digests.json) — rewrite it only with a deliberate sim change', () => {
    expect(FIXTURE.sim).toBe(SIM_VERSION);
    expect(FIXTURE.gen).toBe(GEN_VERSION);
    expect(FIXTURE.engine).toBe('v8');
    expect(report.digests).toEqual(FIXTURE.digests);
  });

  it('is deterministic across runs in one process, and a single mask change moves the hash', () => {
    expect(runCorpusSelftest()).toEqual(report);
    expect(storyDigest('t1')).toEqual(report.digests[0]);
    const def = LEVEL_BY_ID.t1;
    const a = new Sim(def, { seed: GOAL_ECHOES.t1.seed });
    const b = new Sim(def, { seed: GOAL_ECHOES.t1.seed });
    for (let i = 0; i < 400; i++) { a.step(IN.RIGHT); b.step(i === 200 ? IN.RIGHT | IN.JUMP : IN.RIGHT); }
    expect(stateHash(a)).not.toBe(stateHash(b));
  });

  it('refuses an unknown zone', () => {
    expect(() => storyDigest('nope')).toThrow(/no goal echo/);
  });
});

describe('selftest — engine detection', () => {
  const CHROME = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.8010.12 Safari/537.36';
  const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
  const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';
  const IOS_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
  const IOS_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0.6367.88 Mobile/15E148 Safari/604.1';
  const IOS_FIREFOX = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/125.0 Mobile/15E148 Safari/605.1.15';
  const IPAD = 'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
  const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36';
  const SAMSUNG = 'Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36';
  const EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0';

  it('maps Chromium-family browsers to v8, Safari to jsc, Firefox to spidermonkey', () => {
    expect(engineOf(CHROME)).toBe('v8');
    expect(engineOf(ANDROID_CHROME)).toBe('v8');
    expect(engineOf(SAMSUNG)).toBe('v8');
    expect(engineOf(EDGE)).toBe('v8');
    expect(engineOf(SAFARI)).toBe('jsc');
    expect(engineOf(FIREFOX)).toBe('spidermonkey');
  });

  it('every browser on iOS is WebKit, whatever its name', () => {
    expect(engineOf(IOS_SAFARI)).toBe('jsc');
    expect(engineOf(IOS_CHROME)).toBe('jsc');
    expect(engineOf(IOS_FIREFOX)).toBe('jsc');
    expect(engineOf(IPAD)).toBe('jsc');
  });

  it('Node is v8; nothing is unknown', () => {
    expect(engineOf('Node.js/22')).toBe('v8');
    expect(engineOf('')).toBe('unknown');
    expect(engineOf(undefined)).toBe('unknown');
    expect(engineOf('curl/8.5.0')).toBe('unknown');
  });
});

describe('selftest — ?shot=selftest stamp', () => {
  it('selftestStamp has the stable shape the QA tools parse', () => {
    const stamp = selftestStamp('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15');
    expect(Object.keys(stamp)).toEqual(['phase', 'engine', 'ua', 'sim', 'gen', 'corpus', 'selftest']);
    expect(stamp.phase).toBe('selftest');
    expect(stamp.engine).toBe('jsc');
    expect(stamp.sim).toBe(SIM_VERSION);
    expect(stamp.gen).toBe(GEN_VERSION);
    expect(stamp.corpus).toBe(stamp.selftest.length);
    expect(stamp.selftest).toEqual(FIXTURE.digests);
    for (const d of stamp.selftest) expect(Object.keys(d)).toEqual(DIGEST_KEYS);
    // the stamp is JSON that survives a data attribute round-trip unchanged
    expect(JSON.parse(JSON.stringify(stamp))).toEqual(stamp);
    expect(selftestStamp(undefined).ua).toBe('');
  });

  it('parseShotQuery keeps the selftest target and runShot stamps it without touching the scenes', () => {
    const spec = parseShotQuery(new URLSearchParams(`shot=${SHOT_SELFTEST}`));
    expect(spec?.target).toBe('selftest');
    const dataset: Record<string, string> = {};
    const doc = {
      documentElement: { dataset },
      querySelector: () => null,
      querySelectorAll: () => [],
      getElementById: () => null,
    } as unknown as Document;
    // No level is started: a Scenes that throws on any use proves the selftest branch never reaches it.
    const scenes = new Proxy({}, { get: (_t, k) => { throw new Error(`scenes.${String(k)} touched`); } }) as unknown as Scenes;
    const renderer = { viewW: 512, viewH: 288, qualityTier: 'high' } as unknown as RendererPort;
    const out = runShot(spec!, { scenes, renderer, ui: {} as ShellUI, doc, levels: LEVELS, build: 'test' });
    const stamped = JSON.parse(dataset.shot) as Record<string, unknown>;
    expect(stamped).toEqual(out);
    expect(stamped.error).toBeUndefined();
    expect(stamped.phase).toBe('selftest');
    expect(stamped.build).toBe('test');
    expect(stamped.selftest).toEqual(FIXTURE.digests);
    expect(stamped.corpus).toBe(FIXTURE.digests.length);
    // Node ≥ 21 exposes navigator.userAgent "Node.js/x" (v8); older Node has no navigator at all
    expect(['v8', 'unknown']).toContain(stamped.engine);
  });
});
