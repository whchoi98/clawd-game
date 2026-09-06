/**
 * Persistence: two versioned documents in localStorage — `Settings` and
 * `Progress` — read once at boot, mutated in place by the UI and the shell,
 * and written back debounced. Both are defensively merged over their defaults
 * so a schema change never bricks an existing save.
 *
 * Everything environment-specific (storage, timers, the reduced-motion media
 * query, the id generator) is injectable so the layer runs in Node.
 */
import type { BindAction, Binds, LevelRecord, Progress, Settings } from './contracts.js';

export const SETTINGS_KEY = 'clawd-echo.settings.v1';
export const PROGRESS_KEY = 'clawd-echo.progress.v1';
export const DEFAULT_NAME = '클로드';
export const SAVE_DEBOUNCE_MS = 250;

/** The subset of the Storage interface the save layer uses. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SaveOptions {
  /** Defaults to `localStorage` when it exists; `null` keeps everything in memory. */
  storage?: StorageLike | null;
  /** The input layer's DEFAULT_BINDS; the fallback below mirrors them. */
  defaultBinds?: Binds;
  /** `prefers-reduced-motion: reduce` — seeds shake/flashes/grain off on a FIRST run only. */
  reducedMotion?: boolean;
  /** Debounce timer hooks (defaults: setTimeout / clearTimeout). */
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  /** Player id generator (defaults to crypto.randomUUID). */
  newId?: () => string;
}

const BIND_ACTIONS: readonly BindAction[] = [
  'left', 'right', 'up', 'down', 'jump', 'dash', 'pause', 'confirm', 'cancel', 'restart',
];

/** Mirrors input/binds.ts DEFAULT_BINDS; the real table is injected by main.ts. */
const FALLBACK_BINDS: Binds = {
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
  up: ['ArrowUp', 'KeyW'],
  down: ['ArrowDown', 'KeyS'],
  jump: ['Space', 'KeyZ', 'KeyJ'],
  dash: ['ShiftLeft', 'ShiftRight', 'KeyX', 'KeyK'],
  pause: ['Escape', 'KeyP'],
  confirm: ['Enter', 'Space'],
  cancel: ['Escape', 'Backspace'],
  restart: ['KeyR'],
};

const QUALITIES = new Set(['auto', 'high', 'balanced', 'low']);
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const NAME_RE = /^[^\p{C}<>&"'`]+$/u;

export function cloneBinds(b: Binds): Binds {
  const out = {} as Binds;
  for (const a of BIND_ACTIONS) out[a] = [...(b[a] ?? [])];
  return out;
}

export function defaultSettings(binds: Binds = FALLBACK_BINDS): Settings {
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
  if (typeof r.masks !== 'string') delete r.masks;
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
        ...(typeof d.masks === 'string' ? { masks: d.masks } : {}),
      };
    }
  }
  p.daily = daily;
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
    this.defaultBinds = opts.defaultBinds ?? FALLBACK_BINDS;
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

  /** Wipe zones, daily, endless and totals; the player identity (id, name) survives. */
  resetProgress(): void {
    const fresh = defaultProgress(this.progress.player.id, this.progress.player.name);
    Object.assign(this.progress, fresh);
    if (this.prgTimer !== null) { this.cancel(this.prgTimer); this.prgTimer = null; }
    this.write(PROGRESS_KEY, this.progress);
  }
}
