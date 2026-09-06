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
  /** SIM_VERSION / GEN_VERSION the client ran; a mismatch is refused before replaying (missing = 0 = legacy). */
  sim: z.number().int().min(0).max(1000).optional(),
  gen: z.number().int().min(0).max(1000).optional(),
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
  'bad-masks', 'rate-limited', 'duplicate', 'sim-version',
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
  /** GEN_VERSION the server will verify with; the client refuses to start a daily it cannot reproduce. */
  gen: z.number().int().optional(),
  sim: z.number().int().optional(),
  /** ISO timestamp of the next UTC midnight. */
  expiresAt: z.string(),
  /** Yesterday's date and seed: the server still accepts submissions for it (어제의 탑 재도전). */
  yesterday: z.object({ date: DateStr, seed: z.number().int() }).optional(),
});
export type DailyResponse = z.infer<typeof DailyResponse>;

export const HealthResponse = z.object({
  ok: z.literal(true),
  version: z.string(),
  uptime: z.number(),
  region: z.string().optional(),
  simVersion: z.number().int().optional(),
  genVersion: z.number().int().optional(),
});

// ---------------------------------------------------------------- telemetry (anonymous)
/**
 * Product telemetry. No player id, name or IP ever travels here; a per-boot
 * random session id ties events of one session together and nothing more.
 * Retention is measured from client-derived buckets (daysSinceFirstSeen).
 */
export const TelemetryName = z.enum([
  'boot', 'screen', 'zone_start', 'death', 'respawn', 'clear', 'result_shown', 'retry', 'quit',
  'daily_start', 'daily_clear', 'daily_over', 'share_click', 'race_link_open', 'submit_result',
  'fps_sample', 'js_error', 'install_prompt', 'install_done',
]);
export type TelemetryName = z.infer<typeof TelemetryName>;

const TelemetryValue = z.union([z.string().max(200), z.number(), z.boolean()]);
export const TelemetryEvent = z.object({
  t: TelemetryName,
  /** Milliseconds since the session started. */
  at: z.number().int().min(0).max(1e9),
  d: z.record(z.string().max(32), TelemetryValue).optional(),
});
export type TelemetryEvent = z.infer<typeof TelemetryEvent>;

export const MAX_EVENTS_PER_BATCH = 20;
export const MAX_EVENT_BODY_BYTES = 4096;
export const EventBatch = z.object({
  /** Random per-boot session id (16 hex chars). */
  s: z.string().regex(/^[a-f0-9]{16}$/),
  build: z.string().max(64),
  sim: z.number().int().min(0).max(1000),
  events: z.array(TelemetryEvent).min(1).max(MAX_EVENTS_PER_BATCH),
});
export type EventBatch = z.infer<typeof EventBatch>;
export type HealthResponse = z.infer<typeof HealthResponse>;

export const ErrorResponse = z.object({ error: z.string(), detail: z.unknown().optional() });
export type ErrorResponse = z.infer<typeof ErrorResponse>;
