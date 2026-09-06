/**
 * Persistence: two versioned documents in localStorage — `Settings` and
 * `Progress` — read once at boot, mutated in place by the UI and the shell,
 * and written back debounced. Both are defensively merged over their defaults
 * so a schema change never bricks an existing save.
 *
 * Everything environment-specific (storage, timers, the reduced-motion media
 * query, the id generator) is injectable so the layer runs in Node.
 */
import type { Binds, LevelRecord, Progress, Settings } from './contracts.js';
import type { DailyResponse } from '../shared/protocol.js';
import { SIM_VERSION } from '../sim/types.js';
import { BIND_ACTIONS, DEFAULT_BINDS, cloneBinds } from './input/binds.js';

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
const MS_PER_DAY = 86_400_000;

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
  /** Debounce timer hooks (defaults: setTimeout / clearTimeout). */
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  /** Player id generator (defaults to crypto.randomUUID). */
  newId?: () => string;
}

const QUALITIES = new Set(['auto', 'high', 'balanced', 'low']);
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const NAME_RE = /^[^\p{C}<>&"'`]+$/u;

export function defaultSettings(binds: Binds = DEFAULT_BINDS): Settings {
  return {
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
    binds: cloneBinds(binds),
  };
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
  const s = deepMerge(structuredClone(defaults), isObj(raw) ? { ...raw, binds: undefined } : {});
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
  if (!QUALITIES.has(s.quality as string)) s.quality = 'auto';
  if (typeof s.skin !== 'string' || !s.skin) s.skin = defaults.skin;
  s.binds = repairBinds(isObj(raw) ? raw.binds : undefined, defaults.binds);
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
      daily[date] = {
        bestTicks: int(d.bestTicks), cleared: bool(d.cleared, false), height: num(d.height, 0, 1e6, 0), seed: int(d.seed) >>> 0,
        ...(typeof d.runId === 'string' ? { runId: d.runId } : {}),
        ...(typeof d.masks === 'string' && d.sim === SIM_VERSION ? { masks: d.masks, sim: SIM_VERSION } : {}),
      };
    }
  }
  p.daily = daily;
  // Retention inputs: a positive epoch ms, a whole day count and a UTC date string — or nothing.
  if (typeof p.firstSeen !== 'number' || !Number.isFinite(p.firstSeen) || p.firstSeen <= 0) delete p.firstSeen;
  p.playDays = int(p.playDays);
  if (typeof p.lastPlayDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(p.lastPlayDay)) delete p.lastPlayDay;
  p.endless = {
    bestHeight: num(p.endless?.bestHeight, 0, 1e6, 0), bestShards: int(p.endless?.bestShards), runs: int(p.endless?.runs),
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

  constructor(opts: SaveOptions = {}) {
    this.storage = opts.storage === undefined ? defaultStorage() : opts.storage;
    this.schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancel = opts.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.defaultBinds = opts.defaultBinds ?? DEFAULT_BINDS;
    this.newId = opts.newId ?? newPlayerId;

    const rawSettings = this.read(SETTINGS_KEY);
    this.firstRun = rawSettings === undefined;
    this.settings = repairSettings(rawSettings, defaultSettings(this.defaultBinds));
    this.progress = repairProgress(this.read(PROGRESS_KEY), defaultProgress(this.newId()));

    // The stylesheet honours prefers-reduced-motion for UI animation, but the
    // game's own motion lives in the canvas: seed those toggles from the OS
    // preference on a first run, then leave the player's explicit choices alone.
    if (this.firstRun && opts.reducedMotion) {
      this.settings.shake = 0;
      this.settings.flashes = false;
      this.settings.grain = false;
      this.write(SETTINGS_KEY, this.settings);
    }
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

  private write(key: string, doc: unknown): void {
    if (!this.storage) return;
    try { this.storage.setItem(key, JSON.stringify(doc)); } catch { /* private mode / quota */ }
  }

  saveSettings(): void {
    if (this.setTimer !== null) this.cancel(this.setTimer);
    this.setTimer = this.schedule(() => { this.setTimer = null; this.write(SETTINGS_KEY, this.settings); }, SAVE_DEBOUNCE_MS);
  }

  saveProgress(): void {
    if (this.prgTimer !== null) this.cancel(this.prgTimer);
    this.prgTimer = this.schedule(() => { this.prgTimer = null; this.write(PROGRESS_KEY, this.progress); }, SAVE_DEBOUNCE_MS);
  }

  /** Write both documents now (pagehide / before a reload). */
  flush(): void {
    if (this.setTimer !== null) { this.cancel(this.setTimer); this.setTimer = null; }
    if (this.prgTimer !== null) { this.cancel(this.prgTimer); this.prgTimer = null; }
    this.write(SETTINGS_KEY, this.settings);
    this.write(PROGRESS_KEY, this.progress);
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
    const fresh = defaultProgress(this.progress.player.id, this.progress.player.name);
    Object.assign(this.progress, fresh);
    if (this.prgTimer !== null) { this.cancel(this.prgTimer); this.prgTimer = null; }
    this.write(PROGRESS_KEY, this.progress);
  }
}
