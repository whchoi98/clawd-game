/**
 * Run submission service. Nothing the client claims is trusted: the masks are
 * decoded, the level is resolved server-side, the run is replayed with the
 * injected verifier and the score is recomputed from the verified summary.
 *
 * Order of checks (cheapest first): assist → mode eligibility (level, date,
 * seed) → mask decoding → replay verification → story must be cleared →
 * personal-best bookkeeping.
 */
import { randomUUID } from 'node:crypto';
import type { LevelDef, Replay, RunClaim, RunSummary, VerifyResult } from '../sim/types.js';
import { decodeMasks } from '../sim/replay.js';
import { boardScore } from '../sim/config.js';
import type { Mode, RunResponse, RunSubmit } from '../shared/protocol.js';
import type { Repo, StoredRun } from './repo/types.js';
import { dailySeed, isFreshDate } from './daily.js';
import { resolveLevel } from './levels.js';

/** Daily runs (and their board entries) expire after 30 days. */
export const DAILY_TTL_SECONDS = 30 * 86_400;

export interface SubmitDeps {
  repo: Repo;
  now: () => Date;
  dailySecret: string;
  verify: (def: LevelDef, replay: Replay, claim?: RunClaim) => VerifyResult;
  /** Level resolution; defaults to the real table + generator. Injectable for tests. */
  resolve?: (mode: Mode, levelId: string, seed: number) => LevelDef | null;
}

export interface SubmitOutcome {
  status: 200 | 422;
  body: RunResponse;
}

const reject = (reason: string, summary?: RunSummary): SubmitOutcome => ({
  status: 422,
  body: summary ? { accepted: false, reason, summary } : { accepted: false, reason },
});

/**
 * Board and seed for a submission, or a rejection reason.
 * story → board = levelId, seed = the level's own seed.
 * daily → board = date (today or yesterday UTC), seed must match the issued one.
 */
function eligibility(deps: SubmitDeps, body: RunSubmit): { board: string; seed: number } | { reason: string } {
  if (body.mode === 'daily') {
    if (body.levelId !== 'daily') return { reason: 'bad-level' };
    if (!body.date || !isFreshDate(body.date, deps.now())) return { reason: 'stale-date' };
    const issued = dailySeed(body.date, deps.dailySecret).seed;
    if (body.seed === undefined || body.seed !== issued) return { reason: 'bad-seed' };
    return { board: body.date, seed: issued };
  }
  return { board: body.levelId, seed: 0 };
}

export async function submitRun(deps: SubmitDeps, body: RunSubmit): Promise<SubmitOutcome> {
  if (body.assist) return reject('assist');

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
    return reject(e instanceof Error && e.message ? e.message : 'bad-masks');
  }

  const replay: Replay = { v: 1, levelId: body.levelId, seed, assist: false, masks };
  const result = deps.verify(def, replay, body.claim);
  if (!result.ok) return reject(result.reason ?? 'claim-mismatch', result.summary);
  const summary = result.summary;
  if (body.mode === 'story' && !summary.cleared) return reject('not-finished', summary);

  const now = deps.now();
  const score = boardScore(summary);
  const prev = await deps.repo.getPlayerBest(body.player.id, body.mode, elig.board);
  const personalBest = !prev || score < prev.score;

  let runId: string;
  let bestScore: number;
  if (personalBest) {
    const run: StoredRun = {
      runId: randomUUID(),
      mode: body.mode,
      board: elig.board,
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
    await deps.repo.saveBest(run, prev?.runId);
    runId = run.runId;
    bestScore = score;
  } else {
    runId = prev.runId;
    bestScore = prev.score;
  }

  const { better, total } = await deps.repo.rankOf(body.mode, elig.board, bestScore);
  return {
    status: 200,
    body: {
      accepted: true,
      runId,
      rank: better + 1,
      total: Math.max(1, total),
      score,
      personalBest,
      summary,
    },
  };
}

/**
 * Sliding-window limiter keyed by player id (the per-IP limit lives in
 * @fastify/rate-limit). In-process by design: with several Fargate tasks the
 * effective budget is `max × tasks`, which is fine for an abuse brake.
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
