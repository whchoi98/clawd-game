/**
 * Persistence: two versioned documents in localStorage — `Settings` and
 * `Progress` — mutated in place by the UI and the shell, and written back
 * debounced. A write reconciles edits since the last read with the latest
 * stored document, so another tab's accomplishments are not overwritten.
 * Both documents are defensively merged over their defaults at load.
 *
 * Everything environment-specific (storage, timers, the reduced-motion media
 * query, the id generator) is injectable so the layer runs in Node.
 */
import type { Binds, LevelRecord, Progress, Settings } from './contracts.js';
import type { DailyResponse, TransferGetResponse } from '../shared/protocol.js';
import { MAX_TRANSFER_BYTES } from '../shared/protocol.js';
import type { LevelDef, Rank } from '../sim/types.js';
import { SIM_VERSION, GEN_VERSION } from '../sim/types.js';
import { BIND_ACTIONS, DEFAULT_BINDS, cloneBinds } from './input/binds.js';
import { MEDAL_ORDER } from './ui/ceremony.js';
import { normalizeGoalTargets, type GoalPreference } from './goal-settings.js';

export const SETTINGS_KEY = 'clawd-echo.settings.v1';
export const PROGRESS_KEY = 'clawd-echo.progress.v1';
/** Today's DailyResponse, so the Daily Tower can start offline once the seed was seen. */
export const DAILY_CACHE_KEY = 'clawd-echo.daily-cache.v1';

export interface DailyCache { date: string; seed: number; expiresAt: string }

/** 'YYYY-MM-DD' in UTC for a ms timestamp — the server's daily board key. */
export function utcDateStr(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
export const DEFAULT_NAME = '클로드';
export const SAVE_DEBOUNCE_MS = 250;
export const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------- names
/**
 * The name a player who skips the inline prompt submits under: the default
 * name plus four hex digits of a stable local hash of the player id (FNV-1a),
 * so two anonymous players stop reading as the same '클로드' on a board. Nine
 * code points, inside the 12-char name rule; the id itself never leaves the
 * device this way (four hex digits are not reversible).
 */
export function fallbackName(playerId: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < playerId.length; i++) {
    h ^= playerId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${DEFAULT_NAME} #${h.toString(16).padStart(8, '0').slice(0, 4)}`;
}

// ---------------------------------------------------------------- daily streak
/**
 * Consecutive UTC days, ending today or yesterday, that carry a daily record
 * (any attempt counts as a 도전). `serverDate` is the DailyResponse date so a
 * wrong device clock cannot break a streak; dates after it are ignored. Pure.
 */
export function streakFor(daily: Readonly<Record<string, unknown>>, serverDate: string): number {
  const today = Date.parse(`${serverDate}T00:00:00.000Z`);
  if (!Number.isFinite(today)) return 0;
  const has = (ms: number): boolean => Object.prototype.hasOwnProperty.call(daily, utcDateStr(ms)) && isObj(daily[utcDateStr(ms)]);
  let cursor = has(today) ? today : has(today - MS_PER_DAY) ? today - MS_PER_DAY : NaN;
  if (Number.isNaN(cursor)) return 0;
  let n = 0;
  while (has(cursor)) { n++; cursor -= MS_PER_DAY; }
  return n;
}

// ---------------------------------------------------------------- zone unlocking
/**
 * Story zones open for `progress`: the first zone, every zone whose
 * predecessor is done, and — clearing zone N opens N+1 and N+2 — every zone two
 * steps past a cleared one, unless it is the first zone of a tier (t3→s1 and
 * s3→v1 still need the previous zone cleared). Shared by the select screen
 * and the shell's unlock bookkeeping so the two never disagree.
 */
export function unlockedZones(levels: readonly Pick<LevelDef, 'id' | 'biome'>[], progress: Pick<Progress, 'levels'>): Set<string> {
  const open = new Set<string>();
  const done = (i: number): boolean => i >= 0 && !!progress.levels[levels[i].id]?.done;
  levels.forEach((lv, i) => {
    const tierFirst = i > 0 && levels[i - 1].biome !== lv.biome;
    // A cleared zone is always open again, whatever the save says about its predecessors.
    if (i === 0 || done(i) || done(i - 1) || (!tierFirst && done(i - 2))) open.add(lv.id);
  });
  return open;
}

// ---------------------------------------------------------------- echo versioning
/**
 * A locally kept replay is only meaningful for the SIM_VERSION that recorded
 * it, so the version is stored next to `masks` (the LevelRecord / daily record
 * contract does not name the field yet; it is read and written through these
 * helpers only). Records whose masks predate the current version — including
 * v1 saves, which carry no version at all — lose the masks and keep everything
 * else (best time, stars, run id).
 */
export interface EchoVersioned { sim?: number }
type EchoRecord = { masks?: string; runId?: string } & EchoVersioned;

/** Store a finished run's masks as the record's echo, stamped with the current SIM_VERSION. */
export function markEcho(rec: EchoRecord, encoded: string): void {
  rec.masks = encoded;
  rec.sim = SIM_VERSION;
}

/** The record's echo masks when they were recorded by the current SIM_VERSION, else undefined. */
export function echoMasks(rec: EchoRecord | undefined): string | undefined {
  if (!rec || typeof rec.masks !== 'string' || !rec.masks) return undefined;
  return rec.sim === SIM_VERSION ? rec.masks : undefined;
}

// ---------------------------------------------------------------- world echo mode (P2-4)
/**
 * Which board entry runs as the 세계 메아리: the leader ('top') or the entry
 * ranked just above the player's own ('rival', the default). The Settings
 * contract does not name the field yet, so it lives on the object as an extra
 * property and is read and written through these helpers only.
 */
export type EchoWorldMode = 'top' | 'rival';
export const ECHO_WORLD_MODES: readonly EchoWorldMode[] = ['top', 'rival'];
export const DEFAULT_ECHO_WORLD_MODE: EchoWorldMode = 'rival';
export interface SettingsExtra { echoWorldMode?: EchoWorldMode }

/** The settings' world echo mode, defaulting to 'rival' for a save that predates the field. */
export function echoWorldMode(s: Settings): EchoWorldMode {
  const v = (s as Settings & SettingsExtra).echoWorldMode;
  return v === 'top' || v === 'rival' ? v : DEFAULT_ECHO_WORLD_MODE;
}

export function setEchoWorldMode(s: Settings, mode: EchoWorldMode): void {
  (s as Settings & SettingsExtra).echoWorldMode = mode;
}

// ---------------------------------------------------------------- touch layout (P3-7)
/**
 * The virtual pad's layout: a size and opacity scale, per-side offsets in CSS
 * px (positive = toward the screen centre / up), and the floating stick (the
 * pad appears wherever the thumb lands on the left half). Every value is
 * clamped to these limits on load; a save from before the field gets the
 * defaults. The idle opacity default matches the stylesheet's resting value.
 */
export type TouchLayout = NonNullable<Settings['touch']>;
export const TOUCH_LIMITS = {
  scale: { min: 0.8, max: 1.4, step: 0.05 },
  opacity: { min: 0.2, max: 0.8, step: 0.05 },
  offset: { min: -80, max: 80, step: 4 },
} as const;
export const DEFAULT_TOUCH: Readonly<TouchLayout> = Object.freeze({
  scale: 1, opacity: 0.35, leftX: 0, leftY: 0, rightX: 0, rightY: 0, floating: false,
});

/** A valid TouchLayout from anything: clamped numbers, booleans coerced, defaults for the rest. */
export function repairTouch(raw: unknown): TouchLayout {
  const r = isObj(raw) ? raw : {};
  const L = TOUCH_LIMITS;
  return {
    scale: num(r.scale, L.scale.min, L.scale.max, DEFAULT_TOUCH.scale),
    opacity: num(r.opacity, L.opacity.min, L.opacity.max, DEFAULT_TOUCH.opacity),
    leftX: num(r.leftX, L.offset.min, L.offset.max, 0),
    leftY: num(r.leftY, L.offset.min, L.offset.max, 0),
    rightX: num(r.rightX, L.offset.min, L.offset.max, 0),
    rightY: num(r.rightY, L.offset.min, L.offset.max, 0),
    floating: bool(r.floating, false),
  };
}

/**
 * The settings' touch layout. A settings object that predates the field (or a
 * test fixture) gets the defaults attached on first read, so the layout editor
 * always edits the object the settings document persists.
 */
export function touchLayout(s: Settings): TouchLayout {
  return s.touch ?? (s.touch = repairTouch(undefined));
}

// ---------------------------------------------------------------- mute (P3-7)
/**
 * The HUD mute chip: master volume 0 is "muted"; the volume it had before is
 * kept as an extra field so unmuting restores it. Both persist with the
 * settings document like every other change.
 */
export interface MuteExtra { masterBeforeMute?: number }
export const UNMUTE_FALLBACK_MASTER = 0.8;

export function isMuted(s: Settings): boolean {
  return !(s.master > 0);
}

/** Flip the mute state in place; returns the new muted flag. */
export function toggleMute(s: Settings): boolean {
  const x = s as Settings & MuteExtra;
  if (isMuted(s)) {
    const back = typeof x.masterBeforeMute === 'number' && x.masterBeforeMute > 0 ? Math.min(1, x.masterBeforeMute) : UNMUTE_FALLBACK_MASTER;
    s.master = back;
    delete x.masterBeforeMute;
    return false;
  }
  x.masterBeforeMute = s.master;
  s.master = 0;
  return true;
}

// ---------------------------------------------------------------- segment bests (P2-4)
/**
 * Best time (ticks) per checkpoint segment of a story zone on this install:
 * index 0 = start → first checkpoint, the last index = last checkpoint → goal.
 * 0 = no record yet. The LevelRecord contract does not name the field, so it
 * is an extra property handled through these helpers and `repairLevelRecord`.
 */
export interface LevelRecordExtra {
  segBest?: number[];
  /** Best clear rank letter of the zone (P3-6). */
  bestRank?: Rank;
  /** Longest shard combo reached in the zone (P3-6). */
  bestCombo?: number;
  /** Last known world rank of the best on the zone's board (accepted submission / GET /api/me), P3-6. */
  rank?: number;
}

export function segmentBests(rec: LevelRecord): readonly number[] {
  const v = (rec as LevelRecord & LevelRecordExtra).segBest;
  return Array.isArray(v) ? v : [];
}

// ---------------------------------------------------------------- rank · combo · world rank (P3-6)
const RANKS: readonly Rank[] = ['C', 'B', 'A', 'S'];
const isRankValue = (v: unknown): v is Rank => typeof v === 'string' && (RANKS as readonly string[]).includes(v);

/** The record's best clear rank, or null before any clear. */
export function bestRankOf(rec: LevelRecord | undefined | null): Rank | null {
  const v = (rec as (LevelRecord & LevelRecordExtra) | undefined | null)?.bestRank;
  return isRankValue(v) ? v : null;
}

/** Keep the better of the stored rank and `rank`; returns true when the record improved. */
export function recordBestRank(rec: LevelRecord, rank: Rank): boolean {
  if (!isRankValue(rank)) return false;
  const r = rec as LevelRecord & LevelRecordExtra;
  const prev = bestRankOf(rec);
  if (prev && RANKS.indexOf(prev) >= RANKS.indexOf(rank)) return false;
  r.bestRank = rank;
  return true;
}

export function bestComboOf(rec: LevelRecord | undefined | null): number {
  const v = (rec as (LevelRecord & LevelRecordExtra) | undefined | null)?.bestCombo;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** Keep the longer of the stored combo and `combo`; returns true when the record improved (a first combo counts). */
export function recordBestCombo(rec: LevelRecord, combo: number): boolean {
  const c = Number.isFinite(combo) && combo > 0 ? Math.floor(combo) : 0;
  if (c <= bestComboOf(rec)) return false;
  (rec as LevelRecord & LevelRecordExtra).bestCombo = c;
  return true;
}

/** The world rank last stored for the record's best (undefined = never known). */
export function worldRankOf(rec: LevelRecord | undefined | null): number | undefined {
  const v = (rec as (LevelRecord & LevelRecordExtra) | undefined | null)?.rank;
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : undefined;
}

/** Store the world rank of the record's best; returns true when it changed. */
export function setWorldRank(rec: LevelRecord, rank: number): boolean {
  if (!Number.isFinite(rank) || rank < 1) return false;
  const r = rec as LevelRecord & LevelRecordExtra;
  const v = Math.floor(rank);
  if (r.rank === v) return false;
  r.rank = v;
  return true;
}

/** Forget the world rank (the record's best changed and the board has not answered yet). */
export function clearWorldRank(rec: LevelRecord): void {
  delete (rec as LevelRecord & LevelRecordExtra).rank;
}

const MEDAL_IDS: ReadonlySet<string> = new Set(MEDAL_ORDER);
const SKIN_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/** Known medal ids in display order, duplicates and junk dropped. */
export function cleanMedals(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const have = new Set(raw.filter((m): m is string => typeof m === 'string' && MEDAL_IDS.has(m)));
  return MEDAL_ORDER.filter((m) => have.has(m));
}

/** Well-formed skin ids, unique, in the order given. */
export function cleanSkins(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((s): s is string => typeof s === 'string' && SKIN_ID_RE.test(s)))];
}

/** Record `ticks` for segment `idx` when it beats the stored best; returns true when it did. */
export function recordSegmentBest(rec: LevelRecord, idx: number, ticks: number): boolean {
  if (!Number.isInteger(idx) || idx < 0 || idx > 64 || !Number.isFinite(ticks) || ticks <= 0) return false;
  const r = rec as LevelRecord & LevelRecordExtra;
  const arr = Array.isArray(r.segBest) ? r.segBest : [];
  const t = Math.floor(ticks);
  const prev = arr[idx] ?? 0;
  if (prev > 0 && prev <= t) return false;
  while (arr.length <= idx) arr.push(0);
  arr[idx] = t;
  r.segBest = arr;
  return true;
}

// ---------------------------------------------------------------- retention (anonymous)
export type DaysBucket = '0' | '1' | '2-6' | '7+';

/** Coarse day count for the boot event: 0 · 1 · 2-6 · 7+. */
export function daysBucket(days: number): DaysBucket {
  if (!Number.isFinite(days) || days <= 0) return '0';
  if (days < 2) return '1';
  if (days < 7) return '2-6';
  return '7+';
}

/**
 * Mark today (UTC) as played: seeds `firstSeen` on the first boot and counts a
 * new distinct UTC day in `playDays`. Returns true when anything changed.
 */
export function touchPlayDay(p: Progress, nowMs: number): boolean {
  const today = utcDateStr(nowMs);
  let changed = false;
  if (typeof p.firstSeen !== 'number' || !Number.isFinite(p.firstSeen) || p.firstSeen <= 0) { p.firstSeen = nowMs; changed = true; }
  if (p.lastPlayDay !== today) {
    p.lastPlayDay = today;
    p.playDays = (typeof p.playDays === 'number' && Number.isFinite(p.playDays) && p.playDays > 0 ? Math.floor(p.playDays) : 0) + 1;
    changed = true;
  }
  return changed;
}

/** The two anonymous retention buckets the boot event carries (whole UTC days since first boot, distinct days played). */
export function retentionBuckets(p: Progress, nowMs: number): { daysSinceFirstSeen: DaysBucket; daysPlayedBucket: DaysBucket } {
  const first = typeof p.firstSeen === 'number' && Number.isFinite(p.firstSeen) && p.firstSeen > 0 ? p.firstSeen : nowMs;
  const days = Math.floor(nowMs / MS_PER_DAY) - Math.floor(first / MS_PER_DAY);
  return { daysSinceFirstSeen: daysBucket(days), daysPlayedBucket: daysBucket(p.playDays ?? 0) };
}

/** The subset of the Storage interface the save layer uses. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SaveOptions {
  /** Defaults to `localStorage` when it exists; `null` keeps everything in memory. */
  storage?: StorageLike | null;
  /** Defaults to the input layer's DEFAULT_BINDS (the single source of truth). */
  defaultBinds?: Binds;
  /** `prefers-reduced-motion: reduce` — seeds shake/flashes/grain off on a FIRST run only. */
  reducedMotion?: boolean;
  /** `(pointer: coarse)` — with reducedMotion, decides the haptics default of a save that never set it. */
  coarsePointer?: boolean;
  /** Debounce timer hooks (defaults: setTimeout / clearTimeout). */
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  /** Player id generator (defaults to crypto.randomUUID). */
  newId?: () => string;
}

/** Settings.haptics when the player never chose: on for touch devices, off under prefers-reduced-motion. */
export function defaultHaptics(coarsePointer: boolean, reducedMotion: boolean): boolean {
  return coarsePointer && !reducedMotion;
}

const QUALITIES = new Set(['auto', 'high', 'balanced', 'low']);
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const NAME_RE = /^[^\p{C}<>&"'`]+$/u;

export function defaultSettings(binds: Binds = DEFAULT_BINDS): Settings {
  const s: Settings & SettingsExtra = {
    v: 1,
    master: 0.8, music: 0.55, sfx: 0.85,
    shake: 1,
    bloom: true, grain: true,
    quality: 'auto',
    flashes: true,
    showTimer: true,
    skin: 'clawd',
    assist: false,
    invincible: false,
    echoSelf: true, echoWorld: true,
    echoWorldMode: DEFAULT_ECHO_WORLD_MODE,
    touch: { ...DEFAULT_TOUCH },
    goalTargets: {},
    binds: cloneBinds(binds),
  };
  return s;
}

export function defaultProgress(playerId: string, name = DEFAULT_NAME): Progress {
  return {
    v: 1,
    levels: {},
    endless: { bestHeight: 0, bestShards: 0, runs: 0 },
    daily: {},
    totals: { deaths: 0, shards: 0 },
    seen: {},
    lastLevel: null,
    player: { id: playerId, name },
  };
}

export function defaultLevelRecord(): LevelRecord {
  return { done: false, bestTicks: 0, bestShards: 0, stars: 0, relics: 0, deaths: 0 };
}

// ---------------------------------------------------------------- merge
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Recursive merge of `patch` over `base`: plain objects merge key by key,
 * everything else (arrays, scalars) is replaced by the patch value. `base` is
 * mutated and returned.
 */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isObj(patch)) return (patch === undefined || patch === null ? base : (patch as T));
  if (!isObj(base)) return { ...patch } as T;
  const out = base as Record<string, unknown>;
  for (const k of Object.keys(patch)) {
    const pv = patch[k];
    const bv = out[k];
    if (isObj(bv) && isObj(pv)) out[k] = deepMerge(bv, pv);
    else if (pv !== undefined) out[k] = pv;
  }
  return base;
}

// ---------------------------------------------------------------- ids
export function isValidPlayerId(id: unknown): id is string { return typeof id === 'string' && ID_RE.test(id); }

export function isValidName(name: unknown): name is string {
  if (typeof name !== 'string') return false;
  const t = name.trim();
  return t.length >= 1 && [...t].length <= 12 && NAME_RE.test(t);
}

/** A stable per-browser player id: a UUID when available, else 20 random base-36 chars. */
export function newPlayerId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  try {
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  } catch { /* fall through */ }
  const bytes = new Uint8Array(20);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s;
}

// ---------------------------------------------------------------- repair
const num = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
const int = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;

function repairBinds(raw: unknown, defaults: Binds): Binds {
  const out = cloneBinds(defaults);
  if (!isObj(raw)) return out;
  for (const a of BIND_ACTIONS) {
    const v = raw[a];
    if (Array.isArray(v)) {
      const codes = v.filter((c): c is string => typeof c === 'string' && c.length > 0 && c.length < 40);
      out[a] = codes;
    }
  }
  return out;
}

export function repairSettings(raw: unknown, defaults: Settings): Settings {
  const s = deepMerge(structuredClone(defaults), isObj(raw) ? { ...raw, binds: undefined, goalTargets: undefined } : {});
  s.v = 1;
  s.master = num(s.master, 0, 1, defaults.master);
  s.music = num(s.music, 0, 1, defaults.music);
  s.sfx = num(s.sfx, 0, 1, defaults.sfx);
  s.shake = num(s.shake, 0, 1, defaults.shake);
  s.bloom = bool(s.bloom, defaults.bloom);
  s.grain = bool(s.grain, defaults.grain);
  s.flashes = bool(s.flashes, defaults.flashes);
  s.showTimer = bool(s.showTimer, defaults.showTimer);
  s.assist = bool(s.assist, false);
  s.invincible = bool(s.invincible, false);
  s.echoSelf = bool(s.echoSelf, defaults.echoSelf);
  s.echoWorld = bool(s.echoWorld, defaults.echoWorld);
  // 세계 메아리 = 1위 / 라이벌: anything but the two known modes reads as the default.
  setEchoWorldMode(s, echoWorldMode(s));
  // Haptics: a boolean the player chose, or absent (the Save seeds the device default at boot).
  if (typeof s.haptics !== 'boolean') delete s.haptics;
  // Touch layout (P3-7): every field clamped, a v1 save gets the defaults, the player's values survive.
  s.touch = repairTouch(isObj(raw) ? raw.touch : undefined);
  // The pre-mute volume only makes sense as a positive number while muted.
  const mx = s as Settings & MuteExtra;
  if (typeof mx.masterBeforeMute !== 'number' || !(mx.masterBeforeMute > 0) || s.master > 0) delete mx.masterBeforeMute;
  else mx.masterBeforeMute = Math.min(1, mx.masterBeforeMute);
  if (!QUALITIES.has(s.quality as string)) s.quality = 'auto';
  if (typeof s.skin !== 'string' || !s.skin) s.skin = defaults.skin;
  s.binds = repairBinds(isObj(raw) ? raw.binds : undefined, defaults.binds);
  s.goalTargets = normalizeGoalTargets(isObj(raw) && raw.goalTargets !== undefined ? raw.goalTargets : defaults.goalTargets);
  return s;
}

function repairLevelRecord(raw: unknown): LevelRecord {
  const r = deepMerge(defaultLevelRecord(), raw);
  r.done = bool(r.done, false);
  r.bestTicks = int(r.bestTicks);
  r.bestShards = int(r.bestShards);
  r.stars = Math.min(3, int(r.stars));
  r.relics = int(r.relics);
  r.deaths = int(r.deaths);
  if (typeof r.runId !== 'string') delete r.runId;
  // Echo masks survive only with the SIM_VERSION that recorded them (see markEcho).
  const v = r as LevelRecord & EchoVersioned;
  if (typeof v.masks !== 'string' || v.sim !== SIM_VERSION) { delete v.masks; delete v.sim; }
  // Stuck-detector input: deaths in this zone on this install (absent until the first one).
  const sd = int(r.sessionDeaths);
  if (sd > 0) r.sessionDeaths = sd; else delete r.sessionDeaths;
  // Segment bests (P2-4): whole ticks per checkpoint segment, 0 = none; anything else is dropped.
  const seg = (r as LevelRecord & LevelRecordExtra).segBest as unknown;
  if (Array.isArray(seg) && seg.length > 0 && seg.length <= 65 && seg.some((v) => int(v) > 0)) {
    (r as LevelRecord & LevelRecordExtra).segBest = seg.map((v) => int(v));
  } else delete (r as LevelRecord & LevelRecordExtra).segBest;
  // Medals · best rank · best combo · world rank (P3-6): known ids only, absent when empty.
  const medals = cleanMedals(r.medals);
  if (medals.length) r.medals = medals; else delete r.medals;
  const x = r as LevelRecord & LevelRecordExtra;
  if (!isRankValue(x.bestRank)) delete x.bestRank;
  const combo = int(x.bestCombo);
  if (combo > 0) x.bestCombo = combo; else delete x.bestCombo;
  const rank = int(x.rank);
  if (rank > 0) x.rank = rank; else delete x.rank;
  return r;
}

export function repairProgress(raw: unknown, defaults: Progress): Progress {
  const p = deepMerge(structuredClone(defaults), raw);
  p.v = 1;
  const levels: Progress['levels'] = {};
  if (isObj(p.levels)) for (const [id, rec] of Object.entries(p.levels)) if (isObj(rec)) levels[id] = repairLevelRecord(rec);
  p.levels = levels;
  const daily: Progress['daily'] = {};
  if (isObj(p.daily)) {
    for (const [date, rec] of Object.entries(p.daily)) {
      if (!isObj(rec) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const d = rec as Record<string, unknown>;
      const rank = int(d.rank);
      daily[date] = {
        bestTicks: int(d.bestTicks), cleared: bool(d.cleared, false), height: num(d.height, 0, 1e6, 0), seed: int(d.seed) >>> 0,
        ...(typeof d.runId === 'string' ? { runId: d.runId } : {}),
        ...(typeof d.masks === 'string' && d.sim === SIM_VERSION ? { masks: d.masks, sim: SIM_VERSION } : {}),
        ...(rank > 0 ? { rank } : {}),
      };
    }
  }
  p.daily = daily;
  // Retention inputs: a positive epoch ms, a whole day count and a UTC date string — or nothing.
  if (typeof p.firstSeen !== 'number' || !Number.isFinite(p.firstSeen) || p.firstSeen <= 0) delete p.firstSeen;
  p.playDays = int(p.playDays);
  if (typeof p.lastPlayDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(p.lastPlayDay)) delete p.lastPlayDay;
  // Install card dismissals (P3-4): a whole count, absent until the first 나중에.
  const dismissed = int(p.installCardDismissed);
  if (dismissed > 0) p.installCardDismissed = dismissed; else delete p.installCardDismissed;
  // Ceremony flags (P3-9): the tiers whose one-time 층 돌파 card was shown (unique biome ids) and whether the ending played.
  const rawCeremony = p as unknown as Record<string, unknown>;
  const tiers = Array.isArray(rawCeremony.tiersBroken)
    ? [...new Set((rawCeremony.tiersBroken as unknown[]).filter((t): t is string => typeof t === 'string' && t.length > 0 && t.length <= 32))]
    : [];
  if (tiers.length) p.tiersBroken = tiers; else delete p.tiersBroken;
  if (rawCeremony.endingSeen === true) p.endingSeen = true; else delete p.endingSeen;
  // Skins unlocked so far (P3-6): well-formed ids, unique; absent when none.
  const skins = cleanSkins(rawCeremony.unlockedSkins);
  if (skins.length) p.unlockedSkins = skins; else delete p.unlockedSkins;
  // The best endless run's replay (self echo on 같은 탑 다시) survives only with the SIM_VERSION that recorded it.
  const e = (isObj(p.endless) ? p.endless : {}) as Record<string, unknown>;
  const bestMasks = typeof e.bestMasks === 'string' && e.bestMasks && e.bestSim === SIM_VERSION && e.bestGen === GEN_VERSION && typeof e.bestSeed === 'number'
    ? { bestMasks: e.bestMasks, bestSeed: int(e.bestSeed) >>> 0, bestSim: SIM_VERSION, bestGen: GEN_VERSION }
    : {};
  p.endless = {
    bestHeight: num(e.bestHeight, 0, 1e6, 0), bestShards: int(e.bestShards), runs: int(e.runs),
    ...bestMasks,
  };
  p.totals = { deaths: int(p.totals?.deaths), shards: int(p.totals?.shards) };
  if (!isObj(p.seen)) p.seen = {};
  if (typeof p.lastLevel !== 'string') p.lastLevel = null;
  const player: Record<string, unknown> = isObj(p.player) ? p.player : {};
  p.player = {
    id: isValidPlayerId(player.id) ? player.id : defaults.player.id,
    name: isValidName(player.name) ? (player.name as string).trim() : defaults.player.name,
  };
  return p;
}

// ---------------------------------------------------------------- shared-storage reconciliation
/** Reset/import boundaries are local persistence metadata; snapshots never export this field. */
type SharedProgress = Progress & { _saveEpoch?: string };
const saveEpoch = (p: Progress): string => {
  const v = (p as SharedProgress)._saveEpoch;
  return typeof v === 'string' ? v : '';
};

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  if (!isObj(a) || !isObj(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && sameValue(a[k], b[k]));
}

/**
 * Remember explicit choices, including assignments back to a baseline value.
 * Accessors keep the public documents structured-cloneable (unlike a Proxy).
 */
function observeAssignments(
  obj: object, onEdit: (path: string) => void, path: string[] = [], keys = Object.keys(obj),
): void {
  const record = obj as Record<string, unknown>;
  for (const key of keys) {
    const at = [...path, key];
    let value = record[key];
    if (isObj(value)) observeAssignments(value, onEdit, at);
    Object.defineProperty(record, key, {
      enumerable: true, configurable: true,
      get: () => value,
      set: (next: unknown) => {
        value = next;
        if (isObj(value)) observeAssignments(value, onEdit, at);
        onEdit(at.join('.'));
      },
    });
  }
}

/** Keep live document/record references intact, including intentional property deletions. */
function replaceContents<T extends object>(target: T, next: T): void {
  const out = target as Record<string, unknown>, src = next as Record<string, unknown>;
  for (const key of Object.keys(out)) if (!Object.hasOwn(src, key)) delete out[key];
  for (const [key, value] of Object.entries(src)) {
    if (isObj(out[key]) && isObj(value)) replaceContents(out[key], value);
    else out[key] = structuredClone(value);
  }
}

/**
 * Three-way merge: only changed fields are edits. Missing fields are deletions,
 * settings arrays are replacements, and progress has a few domain-specific
 * rules for accomplishments/counters. This is not the transfer merge: replays
 * and install-local records must survive synchronization between browser tabs.
 */
function mergeEdits(
  base: unknown, local: unknown, stored: unknown, progress = false, path: string[] = [], edits?: ReadonlySet<string>,
): unknown {
  const at = path.join('.');
  if (edits?.has(at)) return structuredClone(local);
  const editedBelow = edits && [...edits].some((key) => !path.length || key.startsWith(`${at}.`));
  if (!editedBelow && sameValue(local, base)) return structuredClone(stored);
  if (sameValue(stored, base)) return structuredClone(local);
  // A deletion on either side must not be undone by the other side's old data.
  if (local === undefined || stored === undefined) return undefined;

  const key = path.at(-1);
  const levelField = path[0] === 'levels' && path.length === 3;
  const dailyField = path[0] === 'daily' && path.length === 3;
  const endlessField = path[0] === 'endless' && path.length === 2;
  if (progress) {
    if (typeof local === 'number' && typeof stored === 'number') {
      const old = typeof base === 'number' ? base : 0;
      const counter = (path[0] === 'totals' && path.length === 2)
        || (levelField && (key === 'deaths' || key === 'sessionDeaths'))
        || (endlessField && key === 'runs') || (path.length === 1 && key === 'installCardDismissed');
      if (counter && local >= old && stored >= old) return stored + local - old;
      const best = (levelField && ['bestShards', 'stars', 'relics', 'bestCombo'].includes(key!))
        || (dailyField && key === 'height') || (endlessField && key === 'bestShards')
        || (path.length === 1 && key === 'playDays');
      if (best && local >= old && stored >= old) return Math.max(local, stored);
      if ((path.length === 1 && key === 'firstSeen') || (path[0] === 'levels' && path[2] === 'segBest' && path.length === 4)) {
        return local > 0 && stored > 0 ? Math.min(local, stored) : Math.max(local, stored);
      }
    }
    if (levelField && key === 'bestRank' && isRankValue(local) && isRankValue(stored)) {
      return RANKS.indexOf(local) > RANKS.indexOf(stored) ? local : stored;
    }
    if (path.length === 1 && key === 'lastPlayDay' && typeof local === 'string' && typeof stored === 'string') {
      return local > stored ? local : stored;
    }
    if (Array.isArray(local) && Array.isArray(stored)) {
      const before = Array.isArray(base) ? base : [];
      if ((levelField && key === 'medals') || (path.length === 1 && (key === 'unlockedSkins' || key === 'tiersBroken'))) {
        // Union additions, but honor removals relative to the common baseline.
        return [...new Set([...stored, ...local])].filter((v) => !before.includes(v) || (local.includes(v) && stored.includes(v)));
      }
      if (levelField && key === 'segBest') {
        return Array.from({ length: Math.max(local.length, stored.length) }, (_, i) =>
          mergeEdits(before[i], local[i], stored[i], true, [...path, String(i)], edits) ?? 0);
      }
    }
  }
  if (isObj(local) && isObj(stored)) {
    const before = isObj(base) ? base : {};
    const out: Record<string, unknown> = {};
    for (const k of new Set([...Object.keys(before), ...Object.keys(local), ...Object.keys(stored)])) {
      const value = mergeEdits(before[k], local[k], stored[k], progress, [...path, k], edits);
      if (value !== undefined) Object.defineProperty(out, k, { value, enumerable: true, writable: true, configurable: true });
    }
    if (progress && ((path.length === 2 && (path[0] === 'levels' || path[0] === 'daily')) || (path.length === 1 && path[0] === 'endless'))) {
      mergeReplay(out, before, local, stored, path[0]);
    }
    return out;
  }
  // Two explicit edits of the same scalar/setting: the current writer wins.
  return structuredClone(local);
}

/** A best's timing, replay and server id belong together; never combine competing runs. */
function mergeReplay(
  out: Record<string, unknown>, base: Record<string, unknown>, local: Record<string, unknown>, stored: Record<string, unknown>, kind: string,
): void {
  const endless = kind === 'endless', daily = kind === 'daily';
  const identity = endless ? ['bestHeight', 'bestMasks', 'bestSeed', 'bestSim', 'bestGen']
    : daily ? ['cleared', 'bestTicks', 'seed', 'masks', 'sim'] : ['bestTicks', 'masks', 'sim'];
  const sameRun = (a: Record<string, unknown>, b: Record<string, unknown>): boolean =>
    identity.every((k) => sameValue(a[k], b[k])) && (!daily || a.cleared === true || sameValue(a.height, b.height));
  // Compatible edits (e.g. an accepted run id plus a new medal) already merged field by field.
  if (sameRun(local, stored)) return;
  let winner = stored;
  if (sameRun(stored, base)) winner = local;
  else if (!sameRun(local, base)) {
    const ticks = (r: Record<string, unknown>): number => int(r.bestTicks) || Infinity;
    if (endless) {
      if (Number(local.bestHeight) > Number(stored.bestHeight)) winner = local;
    } else if (daily) {
      if (local.cleared && !stored.cleared) winner = local;
      else if (!!local.cleared === !!stored.cleared
        && (local.cleared ? ticks(local) < ticks(stored) : Number(local.height) > Number(stored.height))) winner = local;
    } else if (ticks(local) < ticks(stored)) winner = local;
  }
  const fields = endless ? identity : [...identity, 'runId', 'rank'];
  for (const k of fields) {
    if (winner[k] === undefined) delete out[k];
    else out[k] = structuredClone(winner[k]);
  }
}

// ---------------------------------------------------------------- save
function defaultStorage(): StorageLike | null {
  try {
    const ls = (globalThis as { localStorage?: StorageLike }).localStorage;
    return ls ?? null;
  } catch {
    return null;
  }
}

export class Save {
  readonly settings: Settings;
  readonly progress: Progress;
  /** True when no settings document existed at boot (a first run). */
  readonly firstRun: boolean;

  private readonly storage: StorageLike | null;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private readonly defaultBinds: Binds;
  private readonly newId: () => string;
  private setTimer: unknown = null;
  private prgTimer: unknown = null;
  private settingsBase: Settings;
  private progressBase: Progress;
  private hadProgress: boolean;
  private readonly settingsEdits = new Set<string>();
  private readonly progressEdits = new Set<string>();
  private readonly settingsAdopters = new Set<() => void>();
  private adopting = false;

  constructor(opts: SaveOptions = {}) {
    this.storage = opts.storage === undefined ? defaultStorage() : opts.storage;
    this.schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancel = opts.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.defaultBinds = opts.defaultBinds ?? DEFAULT_BINDS;
    this.newId = opts.newId ?? newPlayerId;

    const rawSettings = this.read(SETTINGS_KEY);
    this.firstRun = rawSettings === undefined;
    this.settings = repairSettings(rawSettings, defaultSettings(this.defaultBinds));
    // Never chosen: the device decides (touch → on, reduced motion → off); persisted with the next settings write.
    if (typeof this.settings.haptics !== 'boolean') this.settings.haptics = defaultHaptics(!!opts.coarsePointer, !!opts.reducedMotion);
    const rawProgress = this.read(PROGRESS_KEY);
    this.progress = repairProgress(rawProgress, defaultProgress(this.newId()));
    this.hadProgress = isObj(rawProgress);

    // The stylesheet honours prefers-reduced-motion for UI animation, but the
    // game's own motion lives in the canvas: seed those toggles from the OS
    // preference on a first run, then leave the player's explicit choices alone.
    if (this.firstRun && opts.reducedMotion) {
      this.settings.shake = 0;
      this.settings.flashes = false;
      this.settings.grain = false;
      this.write(SETTINGS_KEY, this.settings);
    }
    this.settingsBase = structuredClone(this.settings);
    this.progressBase = structuredClone(this.progress);
    observeAssignments(this.settings, (path) => { if (!this.adopting) this.settingsEdits.add(path); });
    observeAssignments(this.progress, (path) => { if (!this.adopting) this.progressEdits.add(path); }, [], ['player', 'lastLevel']);
  }

  // ------------------------------------------------------------ io
  private read(key: string): unknown {
    if (!this.storage) return undefined;
    try {
      const raw = this.storage.getItem(key);
      if (!raw) return undefined;
      return JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
  }

  private write(key: string, doc: unknown): boolean {
    if (!this.storage) return false;
    try { this.storage.setItem(key, JSON.stringify(doc)); return true; } catch { /* private mode / quota */ return false; }
  }

  private adopt<T extends object>(target: T, next: T, edits: Set<string>): void {
    this.adopting = true;
    try { replaceContents(target, next); } finally { this.adopting = false; }
    edits.clear();
  }

  private commitSettings(): void {
    const raw = this.read(SETTINGS_KEY);
    const latest = isObj(raw) ? repairSettings(raw, defaultSettings(this.defaultBinds)) : undefined;
    // A saved haptics default may still be absent on disk until the first edit.
    if (latest && typeof latest.haptics !== 'boolean') latest.haptics = this.settingsBase.haptics;
    const next = latest ? mergeEdits(this.settingsBase, this.settings, latest, false, [], this.settingsEdits) as Settings : structuredClone(this.settings);
    if ((latest && sameValue(next, latest)) || this.write(SETTINGS_KEY, next)) {
      const changed = !sameValue(this.settings, next);
      this.adopt(this.settings, next, this.settingsEdits);
      this.settingsBase = structuredClone(next);
      if (changed) for (const cb of this.settingsAdopters) {
        try { cb(); } catch { /* a subscriber cannot undo an already persisted document */ }
      }
    }
  }

  /** Live subsystems cache settings; reapply when a merge adopts another tab's edits. */
  onSettingsAdopt(cb: () => void): () => void {
    this.settingsAdopters.add(cb);
    return () => { this.settingsAdopters.delete(cb); };
  }

  private commitProgress(): void {
    const raw = this.read(PROGRESS_KEY);
    const latest = isObj(raw) ? repairProgress(raw, defaultProgress(this.progress.player.id, this.progress.player.name)) : undefined;
    const localBoundary = saveEpoch(this.progress) !== saveEpoch(this.progressBase);
    const storedBoundary = latest && (saveEpoch(latest) !== saveEpoch(this.progressBase)
      || (this.hadProgress && latest.player.id !== this.progressBase.player.id));
    const next = !latest || localBoundary ? structuredClone(this.progress)
      : storedBoundary ? latest : mergeEdits(this.progressBase, this.progress, latest, true, [], this.progressEdits) as Progress;
    if ((latest && sameValue(next, latest)) || this.write(PROGRESS_KEY, next)) {
      this.adopt(this.progress, next, this.progressEdits);
      this.progressBase = structuredClone(next);
      this.hadProgress = true;
    }
  }

  saveSettings(): void {
    if (this.setTimer !== null) this.cancel(this.setTimer);
    this.setTimer = this.schedule(() => { this.setTimer = null; this.commitSettings(); }, SAVE_DEBOUNCE_MS);
  }

  /** A per-zone edit must not replace targets changed by another browser tab. */
  setGoalTarget(levelId: string, preference: GoalPreference): boolean {
    const safe = normalizeGoalTargets({ [levelId]: preference });
    if (!Object.hasOwn(safe, levelId)) return false;
    const targets = this.settings.goalTargets ??= {};
    targets[levelId] = safe[levelId];
    this.settingsEdits.add(`goalTargets.${levelId}`);
    this.saveSettings();
    return true;
  }

  saveProgress(): void {
    if (this.prgTimer !== null) this.cancel(this.prgTimer);
    this.prgTimer = this.schedule(() => { this.prgTimer = null; this.commitProgress(); }, SAVE_DEBOUNCE_MS);
  }

  /** Write both documents now (pagehide / before a reload). */
  flush(): void {
    if (this.setTimer !== null) { this.cancel(this.setTimer); this.setTimer = null; }
    if (this.prgTimer !== null) { this.cancel(this.prgTimer); this.prgTimer = null; }
    this.commitSettings();
    this.commitProgress();
  }

  // ------------------------------------------------------------ records
  levelRecord(id: string): LevelRecord {
    return (this.progress.levels[id] ||= defaultLevelRecord());
  }

  dailyRecord(date: string, seed: number): Progress['daily'][string] {
    return (this.progress.daily[date] ||= { bestTicks: 0, cleared: false, height: 0, seed: seed >>> 0 });
  }

  /** Boot: count today (UTC) as a play day and seed firstSeen; written through when anything changed. */
  touchPlayDay(nowMs: number): void {
    if (touchPlayDay(this.progress, nowMs)) this.saveProgress();
  }

  // ------------------------------------------------------------ daily cache
  /** Remember today's seed (written immediately: it is tiny and must survive a crash). */
  cacheDaily(d: DailyResponse): void {
    const doc: DailyCache = { date: d.date, seed: d.seed >>> 0, expiresAt: d.expiresAt };
    this.write(DAILY_CACHE_KEY, doc);
  }

  /** The cached DailyResponse when it is for `date` (UTC), else null. */
  cachedDaily(date: string): DailyResponse | null {
    const raw = this.read(DAILY_CACHE_KEY);
    if (!isObj(raw) || raw.date !== date) return null;
    if (typeof raw.seed !== 'number' || !Number.isFinite(raw.seed) || typeof raw.expiresAt !== 'string') return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(raw.expiresAt))) return null;
    return { date, seed: raw.seed >>> 0, levelId: 'daily', expiresAt: raw.expiresAt };
  }

  /** Wipe zones, daily, endless and totals; the player identity (id, name) survives. */
  resetProgress(): void {
    this.commitProgress();
    const fresh = defaultProgress(this.progress.player.id, this.progress.player.name);
    Object.assign(this.progress, fresh);
    // Optional flags are not in the defaults, so Object.assign leaves them: a wiped save must earn its ceremonies again (P3-9)
    // and its skins again (P3-6; the selected skin stays available through grandfathering).
    delete this.progress.tiersBroken;
    delete this.progress.endingSeen;
    delete this.progress.unlockedSkins;
    (this.progress as SharedProgress)._saveEpoch = newPlayerId();
    if (this.prgTimer !== null) { this.cancel(this.prgTimer); this.prgTimer = null; }
    this.commitProgress();
  }

  // ------------------------------------------------------------ transfer (P3-5)
  /** The stripped Progress that travels to another device (see snapshotProgress). */
  snapshot(): Record<string, unknown> {
    return snapshotProgress(this.progress);
  }

  /** Restore a snapshot from another device into this save (see mergeProgress) and write it through at once. */
  importSnapshot(snap: TransferGetResponse): void {
    this.commitProgress();
    mergeProgress(this.progress, snap);
    (this.progress as SharedProgress)._saveEpoch = newPlayerId();
    if (this.prgTimer !== null) { this.cancel(this.prgTimer); this.prgTimer = null; }
    this.commitProgress();
  }
}

// ---------------------------------------------------------------- progress transfer (P3-5)
/** progress.seen flag: navigator.storage.persist() was requested once (after the first story clear). */
export const PERSIST_ASKED_KEY = 'storage:persist';
/** Bytes left for the `player` envelope and JSON framing inside MAX_TRANSFER_BYTES. */
export const TRANSFER_MARGIN_BYTES = 512;

/** UTF-8 size of a document's JSON. */
export function jsonBytes(doc: unknown): number {
  const json = JSON.stringify(doc);
  const enc = (globalThis as { TextEncoder?: new () => { encode(s: string): Uint8Array } }).TextEncoder;
  if (enc) return new enc().encode(json).length;
  let n = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? (i++, 4) : 3;
  }
  return n;
}

/**
 * The Progress document as it travels to another device: records, stars,
 * run ids, daily and endless bests, totals, seen flags and the retention
 * fields — never a replay. Zone and daily masks, the endless best climb,
 * segment bests and session death counts stay on this device (they are this
 * install's, or would never verify on another sim). Oldest daily records are
 * dropped until the JSON fits `maxBytes`.
 */
export function snapshotProgress(p: Progress, maxBytes = MAX_TRANSFER_BYTES - TRANSFER_MARGIN_BYTES): Record<string, unknown> {
  const levels: Record<string, unknown> = {};
  for (const [id, rec] of Object.entries(p.levels)) {
    if (!isObj(rec)) continue;
    const medals = cleanMedals(rec.medals);
    const bestRank = bestRankOf(rec), bestCombo = bestComboOf(rec), rank = worldRankOf(rec);
    levels[id] = {
      done: !!rec.done, bestTicks: int(rec.bestTicks), bestShards: int(rec.bestShards), stars: Math.min(3, int(rec.stars)),
      relics: int(rec.relics), deaths: int(rec.deaths), ...(typeof rec.runId === 'string' ? { runId: rec.runId } : {}),
      // Medals, best rank, best combo and the world rank (P3-6) are records, not replays: they travel.
      ...(medals.length ? { medals } : {}), ...(bestRank ? { bestRank } : {}), ...(bestCombo > 0 ? { bestCombo } : {}), ...(rank ? { rank } : {}),
    };
  }
  const dailyDates = Object.keys(p.daily).sort();
  const dailyOf = (dates: string[]): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const date of dates) {
      const d = p.daily[date];
      if (!isObj(d)) continue;
      out[date] = {
        bestTicks: int(d.bestTicks), cleared: !!d.cleared, height: Math.floor(num(d.height, 0, 1e6, 0)), seed: int(d.seed) >>> 0,
        ...(typeof d.runId === 'string' ? { runId: d.runId } : {}), ...(int(d.rank) > 0 ? { rank: int(d.rank) } : {}),
      };
    }
    return out;
  };
  const e = p.endless;
  const seen: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(p.seen)) if (v === true) seen[k] = true;
  const base = {
    v: 1,
    levels,
    endless: { bestHeight: Math.floor(num(e.bestHeight, 0, 1e6, 0)), bestShards: int(e.bestShards), runs: int(e.runs) },
    totals: { deaths: int(p.totals.deaths), shards: int(p.totals.shards) },
    seen,
    lastLevel: typeof p.lastLevel === 'string' ? p.lastLevel : null,
    player: { id: p.player.id, name: p.player.name },
    ...(typeof p.firstSeen === 'number' && p.firstSeen > 0 ? { firstSeen: Math.floor(p.firstSeen) } : {}),
    ...(int(p.playDays) > 0 ? { playDays: int(p.playDays) } : {}),
    ...(typeof p.lastPlayDay === 'string' ? { lastPlayDay: p.lastPlayDay } : {}),
    // Ceremonies seen (P3-9) travel too: the other device must not replay the 층 돌파 card or the ending.
    ...(Array.isArray(p.tiersBroken) && p.tiersBroken.length ? { tiersBroken: p.tiersBroken.filter((t) => typeof t === 'string') } : {}),
    ...(p.endingSeen === true ? { endingSeen: true } : {}),
    // Skins unlocked (P3-6) travel too: the other device keeps the look without re-earning it.
    ...(cleanSkins(p.unlockedSkins).length ? { unlockedSkins: cleanSkins(p.unlockedSkins) } : {}),
  };
  // Daily history is the only unbounded part: shed the oldest dates until the document fits.
  let keep = dailyDates.length;
  let doc: Record<string, unknown> = { ...base, daily: dailyOf(dailyDates) };
  while (keep > 0 && jsonBytes(doc) > maxBytes) {
    keep = Math.max(0, keep - Math.max(1, Math.ceil(keep / 4)));
    doc = { ...base, daily: dailyOf(dailyDates.slice(dailyDates.length - keep)) };
  }
  return doc;
}

/** The better of two zone records: faster clear wins the time (and its run id), everything else takes the max. */
function mergeLevelRecord(local: LevelRecord, remote: LevelRecord): LevelRecord {
  const out: LevelRecord = { ...local };
  out.done = local.done || remote.done;
  const lt = local.bestTicks > 0 ? local.bestTicks : Infinity;
  const rt = remote.bestTicks > 0 ? remote.bestTicks : Infinity;
  const ox = out as LevelRecord & LevelRecordExtra;
  if (rt < lt) {
    // The other device's clear is the best now: the local replay no longer belongs to the record, nor does its world rank.
    out.bestTicks = remote.bestTicks;
    if (remote.runId) out.runId = remote.runId; else delete out.runId;
    delete out.masks; delete out.sim;
    const rr = worldRankOf(remote);
    if (rr) ox.rank = rr; else delete ox.rank;
  } else if (rt === lt && !out.runId && remote.runId) out.runId = remote.runId;
  out.bestShards = Math.max(local.bestShards, remote.bestShards);
  out.stars = Math.max(local.stars, remote.stars);
  out.relics = Math.max(local.relics, remote.relics);
  out.deaths = Math.max(local.deaths, remote.deaths);
  // Medals are a union, the rank the better letter, the combo the longer one (P3-6).
  const medals = cleanMedals([...(local.medals ?? []), ...(remote.medals ?? [])]);
  if (medals.length) out.medals = medals; else delete out.medals;
  const lr = bestRankOf(local), rr2 = bestRankOf(remote);
  const best = !lr ? rr2 : !rr2 ? lr : RANKS.indexOf(lr) >= RANKS.indexOf(rr2) ? lr : rr2;
  if (best) ox.bestRank = best; else delete ox.bestRank;
  const combo = Math.max(bestComboOf(local), bestComboOf(remote));
  if (combo > 0) ox.bestCombo = combo; else delete ox.bestCombo;
  return out;
}

type DailyRec = Progress['daily'][string];

/** A cleared record beats an uncleared one; then the faster clear, or the greater height. */
function mergeDailyRecord(local: DailyRec, remote: DailyRec): DailyRec {
  const remoteBetter = remote.cleared
    ? !local.cleared || local.bestTicks === 0 || (remote.bestTicks > 0 && remote.bestTicks < local.bestTicks)
    : !local.cleared && Math.floor(remote.height) > Math.floor(local.height);
  const height = Math.max(Math.floor(local.height), Math.floor(remote.height));
  if (!remoteBetter) return { ...local, height };
  return {
    bestTicks: remote.bestTicks, cleared: remote.cleared, height, seed: remote.seed,
    ...(remote.runId ? { runId: remote.runId } : {}),
    ...(remote.rank ? { rank: remote.rank } : {}),
  };
}

/**
 * Restore a snapshot from another device into `local` (mutated and returned):
 *   • the player identity (id, name) becomes the snapshot's — the other
 *     device's boards, run ids and player tag follow the id;
 *   • zone, daily and endless records keep the better of the two per zone /
 *     date; totals take the max; seen flags are OR-ed; lastLevel is kept
 *     unless empty; firstSeen takes the earlier, playDays the greater;
 *   • no replay is ever imported — masks, the endless best climb, segment
 *     bests and session deaths are the local device's, and a local replay whose
 *     record was beaten is dropped.
 * The snapshot passes `repairProgress` first, so its shape is never trusted.
 */
export function mergeProgress(local: Progress, snap: TransferGetResponse): Progress {
  const id = isValidPlayerId(snap.playerId) ? snap.playerId : local.player.id;
  const name = isValidName(snap.name) ? snap.name.trim() : local.player.name;
  const remote = repairProgress(snap.progress, defaultProgress(id, name));

  for (const [zone, rec] of Object.entries(remote.levels)) {
    const clean: LevelRecord = { ...rec };
    delete clean.masks; delete clean.sim; delete clean.sessionDeaths; delete clean.segBest;
    local.levels[zone] = local.levels[zone] ? mergeLevelRecord(local.levels[zone], clean) : clean;
  }
  for (const [date, rec] of Object.entries(remote.daily)) {
    const clean: DailyRec = { ...rec };
    delete clean.masks; delete clean.sim;
    local.daily[date] = local.daily[date] ? mergeDailyRecord(local.daily[date], clean) : clean;
  }
  const le = local.endless, re = remote.endless;
  if (Math.floor(re.bestHeight) > Math.floor(le.bestHeight)) {
    le.bestHeight = Math.floor(re.bestHeight);
    delete le.bestMasks; delete le.bestSeed; delete le.bestSim; delete le.bestGen;
  }
  le.bestShards = Math.max(le.bestShards, re.bestShards);
  le.runs = Math.max(le.runs, re.runs);
  local.totals.deaths = Math.max(local.totals.deaths, remote.totals.deaths);
  local.totals.shards = Math.max(local.totals.shards, remote.totals.shards);
  for (const [k, v] of Object.entries(remote.seen)) if (v === true) local.seen[k] = true;
  if (!local.lastLevel && remote.lastLevel) local.lastLevel = remote.lastLevel;
  if (typeof remote.firstSeen === 'number') local.firstSeen = typeof local.firstSeen === 'number' ? Math.min(local.firstSeen, remote.firstSeen) : remote.firstSeen;
  if ((remote.playDays ?? 0) > (local.playDays ?? 0)) local.playDays = remote.playDays;
  if (remote.lastPlayDay && (!local.lastPlayDay || remote.lastPlayDay > local.lastPlayDay)) local.lastPlayDay = remote.lastPlayDay;
  // Ceremonies already seen on either device stay seen (P3-9): no second 층 돌파 card or ending after an import.
  if (remote.tiersBroken?.length) local.tiersBroken = [...new Set([...(local.tiersBroken ?? []), ...remote.tiersBroken])];
  if (remote.endingSeen) local.endingSeen = true;
  // Skins unlocked on either device stay unlocked (P3-6).
  const skins = cleanSkins([...(local.unlockedSkins ?? []), ...(remote.unlockedSkins ?? [])]);
  if (skins.length) local.unlockedSkins = skins;
  local.player = { id, name };
  return local;
}
