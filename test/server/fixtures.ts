/**
 * Shared fixtures for the server tests: a fixture level, a stub verifier that
 * echoes the claim, and `makeApp()` which assembles the Fastify app with the
 * in-memory repo and a fixed clock.
 *
 * Every test file that touches the app must hoist these two mocks itself
 * (vi.mock is file-scoped):
 *
 *   vi.mock('./sim.js', () => ({ Sim: class {} }));          // see note below
 *   vi.mock('../../src/server/levels.js', async () => ({ resolveLevel: (await import('./levelfix.js')).fakeResolveLevel }));
 *
 * The factories must import the leaf module `levelfix.ts`, never this file:
 * this file imports the app, whose graph imports the mocked module, whose
 * factory would then wait on this file — a deadlock.
 *
 * Note on the first mock: src/sim/replay.ts imports './sim.js', which Task A
 * is still writing. While that file is absent vitest resolves the import to
 * the raw specifier, and a mock registered under the same raw specifier
 * intercepts it. Once src/sim/sim.ts exists the mock no longer matches and
 * the real module loads — the stub verifier never touches Sim either way.
 */
import type { LevelDef, Replay, RunClaim, RunSummary, VerifyResult } from '../../src/sim/types.js';
import type { RunSubmit } from '../../src/shared/protocol.js';
import type { AppDeps } from '../../src/server/types.js';
import { encodeMasks } from '../../src/sim/replay.js';
import { MemoryRepo } from '../../src/server/repo/memory.js';
import { buildApp } from '../../src/server/app.js';

export { FIX_T1, fixDaily, fakeResolveLevel } from './levelfix.js';

export const FIXED_NOW = new Date('2026-09-06T12:00:00.000Z');
export const TODAY = '2026-09-06';
export const YESTERDAY = '2026-09-05';
export const SECRET = 'test-secret';

/** 600 ticks of RIGHT held, then 120 ticks of RIGHT|JUMP. */
export const MASKS = (() => {
  const m = new Uint8Array(720);
  m.fill(2, 0, 600);
  m.fill(2 | 16, 600, 720);
  return m;
})();
export const MASKS_B64 = encodeMasks(MASKS);

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
  verify?: AppDeps['verify'];
  rateLimit?: AppDeps['rateLimit'];
  repo?: MemoryRepo;
  staticDir?: string;
  dailySecret?: string;
  version?: string;
}

export async function makeApp(opts: MakeAppOpts = {}) {
  const repo = opts.repo ?? new MemoryRepo();
  const deps: AppDeps = {
    repo,
    now: () => opts.now ?? FIXED_NOW,
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
