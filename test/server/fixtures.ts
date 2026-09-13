/**
 * Shared fixtures for the server tests: a fixture level, a stub verifier that
 * echoes the claim, and `makeApp()` which assembles the Fastify app with the
 * in-memory repo and a fixed clock.
 *
 * Every test file that touches the app must hoist this mock itself (vi.mock is
 * file-scoped); it routes `t1` and `daily` to the fixture levels so the tests
 * do not depend on the shipped level data:
 *
 *   vi.mock('../../src/server/levels.js', async () => ({ resolveLevel: (await import('./levelfix.js')).fakeResolveLevel }));
 *
 * The factory must import the leaf module `levelfix.ts`, never this file:
 * this file imports the app, whose graph imports the mocked module, whose
 * factory would then wait on this file — a deadlock.
 */
import type { LevelDef, Replay, RunClaim, RunSummary, VerifyResult } from '../../src/sim/types.js';
import type { RunSubmit } from '../../src/shared/protocol.js';
import type { AppDeps } from '../../src/server/types.js';
import type { LogRecord } from '../../src/server/metrics.js';
import { encodeMasks } from '../../src/sim/replay.js';
import { GEN_VERSION, SIM_VERSION } from '../../src/sim/types.js';
import { MemoryRepo } from '../../src/server/repo/memory.js';
import { buildApp } from '../../src/server/app.js';

export { FIX_T1, fixDaily, fakeResolveLevel } from './levelfix.js';

export const FIXED_NOW = new Date('2026-09-06T12:00:00.000Z');
export const TODAY = '2026-09-06';
export const YESTERDAY = '2026-09-05';
export const SECRET = 'test-secret';

/**
 * 600 ticks of RIGHT held, then 120 ticks of RIGHT|JUMP. The server refuses logs
 * longer than `maxMasksFor(claim)` (ticks + INTRO_TICKS + DEATH_TICKS·deaths + 240,
 * derived from the sim's phase constants), so a test that steers the score through
 * `claim.ticks` must keep it ≥ 720 − INTRO_TICKS − 240 or pass shorter masks.
 */
export const MASKS = (() => {
  const m = new Uint8Array(720);
  m.fill(2, 0, 600);
  m.fill(2 | 16, 600, 720);
  return m;
})();
export const MASKS_B64 = encodeMasks(MASKS);

let uniqueSeq = 0;
/**
 * A fresh 720-tick log for every call: the same replay may be on a board only
 * once (P3-1 'duplicate'), so a test that posts several players must give
 * each their own masks. One RIGHT tick inside the first 600 is cleared per call.
 */
export function uniqueMasks(): string {
  const m = new Uint8Array(MASKS);
  m[uniqueSeq++ % 590] = 0;
  return encodeMasks(m);
}

export const BASE_SUMMARY: RunSummary = {
  levelId: 't1', cleared: true, ticks: 720, time: 6, shards: 3, totalShards: 20,
  relics: 0, totalRelics: 1, deaths: 0, par: 45, rank: 'S', height: 0,
};

export interface VerifyCall { def: LevelDef; replay: Replay; claim?: RunClaim }

/** A verifier that trusts the claim: the summary echoes it, so tests steer scores through the claim. */
export function echoVerify(calls?: VerifyCall[]): AppDeps['verify'] {
  return (def, replay, claim) => {
    calls?.push({ def, replay, claim });
    const summary: RunSummary = {
      ...BASE_SUMMARY,
      levelId: def.id,
      par: def.par,
      ticks: claim?.ticks ?? replay.masks.length,
      time: (claim?.ticks ?? replay.masks.length) / 120,
      shards: claim?.shards ?? 0,
      deaths: claim?.deaths ?? 0,
      cleared: claim?.cleared ?? true,
      height: claim?.height ?? 0,
    };
    return { ok: true, summary };
  };
}

export function failVerify(reason: string): AppDeps['verify'] {
  return (def) => ({ ok: false, reason, summary: { ...BASE_SUMMARY, levelId: def.id, cleared: false } });
}

export function verifyResult(ok: boolean, reason?: string, summary?: Partial<RunSummary>): VerifyResult {
  return { ok, reason, summary: { ...BASE_SUMMARY, ...summary } };
}

export type SubmitOverride = Omit<Partial<RunSubmit>, 'claim'> & { claim?: Partial<RunSubmit['claim']> };

export function submitBody(over: SubmitOverride = {}): RunSubmit {
  const { claim, ...rest } = over;
  return {
    player: { id: 'player-0001', name: '클로드' },
    mode: 'story',
    levelId: 't1',
    assist: false,
    sim: SIM_VERSION,
    gen: GEN_VERSION,
    masks: MASKS_B64,
    claim: { ticks: 720, shards: 3, deaths: 0, cleared: true, height: 0, ...claim },
    client: { build: 'test' },
    ...rest,
  };
}

export function dailyBody(seed: number, over: SubmitOverride = {}): RunSubmit {
  return submitBody({ mode: 'daily', levelId: 'daily', date: TODAY, seed, ...over });
}

export interface MakeAppOpts {
  now?: Date;
  /** A live clock (wins over `now`); an explicitly supplied repo must share it for ttl tests. */
  clock?: () => Date;
  verify?: AppDeps['verify'];
  rateLimit?: AppDeps['rateLimit'];
  repo?: MemoryRepo;
  staticDir?: string;
  dailySecret?: string;
  version?: string;
}

export async function makeApp(opts: MakeAppOpts = {}) {
  const now = opts.clock ?? (() => opts.now ?? FIXED_NOW);
  const repo = opts.repo ?? new MemoryRepo({ now: () => now().getTime() });
  const deps: AppDeps = {
    repo,
    now,
    dailySecret: opts.dailySecret ?? SECRET,
    verify: opts.verify ?? echoVerify(),
    staticDir: opts.staticDir,
    version: opts.version ?? 'test-1',
    rateLimit: opts.rateLimit ?? { perIp: 1000, perPlayer: 1000 },
    logger: false,
  };
  const app = await buildApp(deps);
  return { app, repo, deps };
}

export async function postRun(app: Awaited<ReturnType<typeof makeApp>>['app'], body: unknown, headers: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url: '/api/runs', payload: body as object, headers: { 'content-type': 'application/json', ...headers } });
}

export interface LogLine { record: LogRecord; msg: string }

/**
 * A recording logger standing in for `app.log`: every info line is captured as
 * pino would receive it. Install with `captureLog(ctx.app)` — the api child
 * instance inherits `log` from the root, so the routes' default sinks land here.
 */
export function captureLog(app: Awaited<ReturnType<typeof makeApp>>['app']): LogLine[] {
  const lines: LogLine[] = [];
  const noop = () => {};
  const logger = {
    info: (record: LogRecord | string, msg?: string) => {
      if (typeof record === 'string') lines.push({ record: {}, msg: record });
      else lines.push({ record, msg: msg ?? '' });
    },
    warn: noop, error: noop, debug: noop, trace: noop, fatal: noop, silent: noop,
    level: 'info',
    child() { return logger; },
  };
  (app as unknown as { log: unknown }).log = logger;
  return lines;
}
