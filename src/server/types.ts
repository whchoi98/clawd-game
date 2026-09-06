/**
 * Server composition contract. `buildApp(deps)` assembles the Fastify
 * instance; `index.ts` provides production deps (DynamoRepo, real clock),
 * tests provide MemoryRepo and a fixed clock.
 */
import type { FastifyInstance } from 'fastify';
import type { Repo } from './repo/types.js';
import type { LevelDef, Replay, RunClaim, VerifyResult } from '../sim/types.js';

export interface AppDeps {
  repo: Repo;
  /** Current time; injectable for deterministic tests. */
  now: () => Date;
  /** HMAC key for daily seeds. */
  dailySecret: string;
  /** Replay verifier — the real one from src/sim in production. */
  verify: (def: LevelDef, replay: Replay, claim?: RunClaim) => VerifyResult;
  /** Absolute path of the built client (dist/public). Omit to skip static serving (tests). */
  staticDir?: string;
  version: string;
  /** Requests per minute per IP and per player. */
  rateLimit?: { perIp: number; perPlayer: number };
  logger?: boolean;
}

export type BuildApp = (deps: AppDeps) => Promise<FastifyInstance>;

/** Daily seed derivation, shared by the /api/daily route and run verification. */
export interface DailySeed {
  date: string;   // YYYY-MM-DD (UTC)
  seed: number;   // uint32
  expiresAt: string;
}
