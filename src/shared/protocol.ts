/**
 * Wire protocol between the browser and the Fastify server. Zod schemas are
 * the contract; both sides import the inferred types. Every request body and
 * query is parsed with these before any handler logic runs.
 */
import { z } from 'zod';

export const API_PREFIX = '/api';
/** Encoded replay hard cap (bytes of base64). 10 minutes of RLE masks fits comfortably. */
export const MAX_MASKS_B64 = 64 * 1024;

export const PlayerRef = z.object({
  /** Client-generated, stable per browser. */
  id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  /** Display name; Korean allowed. Trimmed, 1–12 code points. */
  name: z.string().trim().min(1).max(12).regex(/^[^\p{C}<>&"'`]+$/u),
});
export type PlayerRef = z.infer<typeof PlayerRef>;

export const Mode = z.enum(['story', 'daily']);
export type Mode = z.infer<typeof Mode>;

export const LevelId = z.string().regex(/^[a-z][a-z0-9]{0,15}$/);
export const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const RunClaim = z.object({
  ticks: z.number().int().min(1).max(120 * 60 * 10),
  shards: z.number().int().min(0).max(10_000),
  deaths: z.number().int().min(0).max(100_000),
  cleared: z.boolean(),
  height: z.number().min(0).max(100_000),
});
export type RunClaim = z.infer<typeof RunClaim>;

export const RunSubmit = z.object({
  player: PlayerRef,
  mode: Mode,
  /** story: the zone id. daily: 'daily'. */
  levelId: LevelId,
  /** daily only — the UTC date the seed was issued for. */
  date: DateStr.optional(),
  /** daily only — must equal the server's seed for `date`. Ignored for story. */
  seed: z.number().int().min(0).max(0xffffffff).optional(),
  assist: z.boolean(),
  /** RLE + base64 input masks, see sim/replay.ts. */
  masks: z.string().min(1).max(MAX_MASKS_B64),
  claim: RunClaim,
  client: z.object({ build: z.string().max(64) }),
});
export type RunSubmit = z.infer<typeof RunSubmit>;

export const RunSummaryWire = z.object({
  levelId: z.string(), cleared: z.boolean(), ticks: z.number(), time: z.number(),
  shards: z.number(), totalShards: z.number(), relics: z.number(), totalRelics: z.number(),
  deaths: z.number(), par: z.number(), rank: z.enum(['S', 'A', 'B', 'C']), height: z.number(),
});

export const RunAccepted = z.object({
  accepted: z.literal(true),
  runId: z.string(),
  /** 1-based rank on the board after this submission (of the player's best). */
  rank: z.number().int().min(1),
  total: z.number().int().min(1),
  score: z.number(),
  personalBest: z.boolean(),
  summary: RunSummaryWire,
});
/**
 * The complete set of reasons a run can be refused. The sim's VerifyResult.reason
 * is a plain string (the sim cannot depend on zod); the server maps it onto this
 * enum ('bad-base64' | 'bad-rle' → 'bad-masks'), and the UI translates every
 * member. Adding a reason here without a translation fails the UI tests.
 */
export const RejectReason = z.enum([
  'assist', 'too-long', 'not-finished', 'claim-mismatch', 'bad-level', 'bad-seed', 'stale-date',
  'bad-masks', 'rate-limited', 'duplicate',
]);
export type RejectReason = z.infer<typeof RejectReason>;

export const RunRejected = z.object({
  accepted: z.literal(false),
  reason: RejectReason,
  summary: RunSummaryWire.optional(),
});
export const RunResponse = z.discriminatedUnion('accepted', [RunAccepted, RunRejected]);
export type RunResponse = z.infer<typeof RunResponse>;

export const LeaderboardQuery = z.object({
  mode: Mode,
  /** story: levelId · daily: YYYY-MM-DD */
  board: z.string().regex(/^[a-z0-9-]{1,16}$/),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  playerId: PlayerRef.shape.id.optional(),
});
export type LeaderboardQuery = z.infer<typeof LeaderboardQuery>;

export const LeaderboardEntry = z.object({
  /** Competition rank: 1 + the number of strictly better scores (ties share a rank). */
  rank: z.number().int(),
  runId: z.string(),
  /**
   * Opaque, stable per player (HMAC of the player id, 12 hex chars). The raw player
   * id is the player's only credential and is never published.
   */
  playerTag: z.string().regex(/^[a-f0-9]{12}$/),
  /** True when the entry belongs to the `playerId` passed in the query. */
  you: z.boolean(),
  name: z.string(),
  score: z.number(),
  ticks: z.number().int(),
  shards: z.number().int(),
  deaths: z.number().int(),
  cleared: z.boolean(),
  height: z.number(),
  createdAt: z.string(),
});
export type LeaderboardEntry = z.infer<typeof LeaderboardEntry>;

export const LeaderboardResponse = z.object({
  mode: Mode,
  board: z.string(),
  total: z.number().int(),
  entries: z.array(LeaderboardEntry),
  yours: LeaderboardEntry.optional(),
});
export type LeaderboardResponse = z.infer<typeof LeaderboardResponse>;

export const GhostResponse = z.object({
  runId: z.string(),
  mode: Mode,
  board: z.string(),
  levelId: z.string(),
  seed: z.number().int(),
  assist: z.boolean(),
  masks: z.string(),
  name: z.string(),
  ticks: z.number().int(),
});
export type GhostResponse = z.infer<typeof GhostResponse>;

export const DailyResponse = z.object({
  date: DateStr,
  seed: z.number().int(),
  levelId: z.literal('daily'),
  /** ISO timestamp of the next UTC midnight. */
  expiresAt: z.string(),
});
export type DailyResponse = z.infer<typeof DailyResponse>;

export const HealthResponse = z.object({
  ok: z.literal(true),
  version: z.string(),
  uptime: z.number(),
  region: z.string().optional(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

export const ErrorResponse = z.object({ error: z.string(), detail: z.unknown().optional() });
export type ErrorResponse = z.infer<typeof ErrorResponse>;
