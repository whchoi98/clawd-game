/**
 * Run submission service. Nothing the client claims is trusted: the masks are
 * decoded, the level is resolved server-side, the run is replayed with the
 * injected verifier and the score is recomputed from the verified summary.
 *
 * Order of checks (cheapest first): assist → sim / generator version → mode
 * eligibility (level, date, seed) → mask decoding → mask budget for the claim
 * → replay verification → story must be cleared → personal-best bookkeeping.
 */
import { randomUUID } from 'node:crypto';
import type { LevelDef, Replay, RunClaim, RunSummary, VerifyResult } from '../sim/types.js';
import { GEN_VERSION, MAX_TICKS, SIM_VERSION, TICK_HZ } from '../sim/types.js';
import { DYING_T, INTRO_T, RESPAWN_INTRO_T } from '../sim/sim.js';
import { decodeMasks } from '../sim/replay.js';
import { boardScore } from '../sim/config.js';
import { RejectReason, type Mode, type RunResponse, type RunSubmit } from '../shared/protocol.js';
import { isSaveConflict } from './repo/errors.js';
import type { Repo, StoredRun } from './repo/types.js';
import { dailySeed, isFreshDate } from './daily.js';
import { resolveLevel } from './levels.js';
import type { AppDeps } from './types.js';

/** Daily runs (and their board entries) expire after 30 days. */
export const DAILY_TTL_SECONDS = 30 * 86_400;

export interface SubmitDeps {
  repo: Repo;
  now: () => Date;
  dailySecret: string;
  /** Sync or cooperative verifier; the service awaits whichever it gets. */
  verify: (def: LevelDef, replay: Replay, claim?: RunClaim) => VerifyResult | Promise<VerifyResult>;
  /** Level resolution; defaults to the real table + generator. Injectable for tests. */
  resolve?: (mode: Mode, levelId: string, seed: number) => LevelDef | null;
}

export interface SubmitOutcome {
  status: 200 | 422;
  body: RunResponse;
}

/**
 * `AppDeps.verify` is typed synchronous; `submitRun` awaits `Promise.resolve()`
 * of whatever it returns, so an async verifier fits through this adapter.
 */
export function asyncVerifier(
  fn: (def: LevelDef, replay: Replay, claim?: RunClaim) => Promise<VerifyResult>,
): AppDeps['verify'] {
  return fn as unknown as AppDeps['verify'];
}

// ---------------------------------------------------------------- mask budget
/**
 * A phase ends on the first tick whose accumulated time exceeds its threshold.
 * Every constant below is derived from the sim's exported phase lengths, never
 * from a literal, so a retimed sim retunes the budget automatically.
 */
export const phaseTicks = (seconds: number): number => Math.ceil(seconds * TICK_HZ) + 1;
/** Ticks of 'intro' before play starts on the first spawn. */
export const INTRO_TICKS = phaseTicks(INTRO_T);
/** Ticks of the shorter 'intro' that follows every respawn. */
export const RESPAWN_INTRO_TICKS = phaseTicks(RESPAWN_INTRO_T);
/** Ticks one death costs: the dying animation plus the respawn intro. */
export const DEATH_TICKS = phaseTicks(DYING_T) + RESPAWN_INTRO_TICKS;
/** Headroom for float drift in the phase timers and a client that stops recording a beat late. */
export const MASK_SLACK = 240;

/**
 * The most masks a replay reproducing `claim` can need: the claimed play ticks,
 * one intro, a dying + respawn-intro cycle per claimed death, and slack.
 * Verification stops at 'finished', so anything beyond this is padding whose
 * only effect is server CPU — it is refused before the sim is even constructed.
 */
export function maxMasksFor(claim: RunClaim): number {
  return Math.min(MAX_TICKS, claim.ticks + INTRO_TICKS + claim.deaths * DEATH_TICKS + MASK_SLACK);
}

// ---------------------------------------------------------------- versions
/**
 * A run only verifies against the sim (and, for daily towers, the generator)
 * it was recorded with. Missing fields are legacy clients (= 0) and are refused
 * the same way; the UI answers 'sim-version' with "refresh to the new version".
 */
export function versionMismatch(body: Pick<RunSubmit, 'mode' | 'sim' | 'gen'>): boolean {
  if ((body.sim ?? 0) !== SIM_VERSION) return true;
  return body.mode === 'daily' && (body.gen ?? 0) !== GEN_VERSION;
}

// ---------------------------------------------------------------- reasons
/**
 * Every reason the server emits is a RejectReason. The decoder's
 * 'bad-base64' | 'bad-rle' collapse to 'bad-masks'; anything unexpected is
 * reported as `fallback` rather than leaking a raw string.
 */
export function toRejectReason(raw: string | undefined, fallback: RejectReason = 'claim-mismatch'): RejectReason {
  if (raw === 'bad-base64' || raw === 'bad-rle') return 'bad-masks';
  const parsed = RejectReason.safeParse(raw);
  return parsed.success ? parsed.data : fallback;
}

const reject = (reason: RejectReason, summary?: RunSummary): SubmitOutcome => ({
  status: 422,
  body: summary ? { accepted: false, reason, summary } : { accepted: false, reason },
});

/**
 * Board and seed for a submission, or a rejection reason.
 * story → board = levelId, seed = the level's own seed.
 * daily → board = date (today or yesterday UTC), seed must match the issued one.
 */
function eligibility(deps: SubmitDeps, body: RunSubmit): { board: string; seed: number } | { reason: RejectReason } {
  if (body.mode === 'daily') {
    if (body.levelId !== 'daily') return { reason: 'bad-level' };
    if (!body.date || !isFreshDate(body.date, deps.now())) return { reason: 'stale-date' };
    const issued = dailySeed(body.date, deps.dailySecret).seed;
    if (body.seed === undefined || body.seed !== issued) return { reason: 'bad-seed' };
    return { board: body.date, seed: issued };
  }
  return { board: body.levelId, seed: 0 };
}

interface BestOutcome {
  runId: string;
  bestScore: number;
  personalBest: boolean;
}

/**
 * Personal-best bookkeeping. `saveBest` is conditional on the best we read; when
 * a concurrent submission of the same player wins the race the store refuses
 * the write, so we re-read and decide again — answering personalBest:false when
 * the other run was at least as good, retrying once when this run still beats it.
 */
async function persistBest(deps: SubmitDeps, body: RunSubmit, board: string, seed: number, summary: RunSummary, score: number): Promise<BestOutcome> {
  const { repo } = deps;
  let prev = await repo.getPlayerBest(body.player.id, body.mode, board);
  for (let attempt = 0; ; attempt++) {
    if (prev && score >= prev.score) return { runId: prev.runId, bestScore: prev.score, personalBest: false };
    const now = deps.now();
    const run: StoredRun = {
      runId: randomUUID(),
      mode: body.mode,
      board,
      levelId: body.levelId,
      seed,
      assist: false,
      masks: body.masks,
      playerId: body.player.id,
      name: body.player.name,
      score,
      ticks: summary.ticks,
      shards: summary.shards,
      deaths: summary.deaths,
      cleared: summary.cleared,
      height: summary.height,
      createdAt: now.toISOString(),
    };
    if (body.mode === 'daily') run.ttl = Math.floor(now.getTime() / 1000) + DAILY_TTL_SECONDS;
    try {
      await repo.saveBest(run, prev?.runId);
      return { runId: run.runId, bestScore: score, personalBest: true };
    } catch (err) {
      if (!isSaveConflict(err) || attempt >= 1) throw err;
      prev = await repo.getPlayerBest(body.player.id, body.mode, board);
    }
  }
}

export async function submitRun(deps: SubmitDeps, body: RunSubmit): Promise<SubmitOutcome> {
  if (body.assist) return reject('assist');
  if (versionMismatch(body)) return reject('sim-version');

  const elig = eligibility(deps, body);
  if ('reason' in elig) return reject(elig.reason);

  const resolve = deps.resolve ?? resolveLevel;
  const def = resolve(body.mode, body.levelId, elig.seed);
  if (!def) return reject('bad-level');
  const seed = body.mode === 'daily' ? elig.seed : def.seed;

  let masks: Uint8Array;
  try {
    masks = decodeMasks(body.masks);
  } catch (e) {
    return reject(toRejectReason(e instanceof Error ? e.message : undefined, 'bad-masks'));
  }
  if (masks.length > maxMasksFor(body.claim)) return reject('too-long');

  const replay: Replay = { v: SIM_VERSION, levelId: body.levelId, seed, assist: false, masks };
  const result = await Promise.resolve(deps.verify(def, replay, body.claim));
  if (!result.ok) return reject(toRejectReason(result.reason), result.summary);
  const summary = result.summary;
  if (body.mode === 'story' && !summary.cleared) return reject('not-finished', summary);

  const score = boardScore(summary);
  const best = await persistBest(deps, body, elig.board, seed, summary, score);
  const { better, total } = await deps.repo.rankOf(body.mode, elig.board, best.bestScore);
  return {
    status: 200,
    body: {
      accepted: true,
      runId: best.runId,
      rank: better + 1,
      total: Math.max(1, total),
      score,
      personalBest: best.personalBest,
      summary,
    },
  };
}

/**
 * Sliding-window limiter keyed by `ip:playerId` (the per-IP limits live in
 * @fastify/rate-limit). Keying on the pair means a third party who knows a
 * player's id cannot burn that player's budget from elsewhere. In-process by
 * design: with several Fargate tasks the effective budget is `max × tasks`,
 * which is fine for an abuse brake.
 */
export class PlayerLimiter {
  private readonly hits = new Map<string, number[]>();
  private ops = 0;

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  hit(key: string): { ok: true } | { ok: false; retryAfterSec: number } {
    const t = this.now();
    const floor = t - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((ts) => ts > floor);
    if (++this.ops % 256 === 0) this.sweep(floor);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((list[0] + this.windowMs - t) / 1000)) };
    }
    list.push(t);
    this.hits.set(key, list);
    return { ok: true };
  }

  private sweep(floor: number): void {
    for (const [k, list] of this.hits) {
      if (!list.length || list[list.length - 1] <= floor) this.hits.delete(k);
    }
  }
}
