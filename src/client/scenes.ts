/**
 * Scenes — the game flow. Owns the current run (a `Sim`, its mask log and its
 * echoes), reacts to `UIAction`s, drives the fixed-step tick per frame, and
 * turns a finished run into progress, a result screen and — when eligible —
 * a verified submission with a leaderboard.
 *
 * Everything it touches is a port from contracts.ts (renderer, audio, ui,
 * input, api) plus the save layer, so the whole flow runs headless in tests.
 * No DOM, no timers: delays are counted in frame dt, and async work (the API)
 * is tracked so tests can `await scenes.settle()`.
 *
 * Time model per frame: `input.poll()` → `held` / `takeLatched()` → the tick
 * scheduler turns wall dt (scaled by the fx bus's hitstop / slow-mo) into N
 * ticks, tick 0 carrying the latched press edges → every tick's mask is
 * recorded → render once.
 */
import { GEN_VERSION, IN, IN_ALL, MAX_TICKS, SIM_VERSION, TILE } from '../sim/types.js';
import type { InputMask, LevelDef, PlayerState, RunSummary, SimEvent } from '../sim/types.js';
import { PHYS } from '../sim/config.js';
import { Sim } from '../sim/sim.js';
import { decodeMasks, encodeMasks } from '../sim/replay.js';
import { bandBiome, makeDailyLevel } from '../sim/gen/daily.js';
import { makeEndlessLevel } from '../sim/gen/endless.js';
import { BIOMES, BIOME_ORDER, C, type Biome } from '../shared/biomes.js';
import { MAX_MASKS_B64, TransferCode } from '../shared/protocol.js';
import type { DailyResponse, GhostResponse, LeaderboardResponse, MeResponse, Mode, RunSubmit } from '../shared/protocol.js';
import type {
  ApiPort, AudioPort, HudState, InputPort, Progress, RendererPort, ResultView, UIAction, UIPort,
} from './contracts.js';
import { MAX_FRAME_DT, TickScheduler } from './loop.js';
import { FxBus } from './fx.js';
import { Camera } from './camera.js';
import {
  DEFAULT_NAME, MS_PER_DAY, PERSIST_ASKED_KEY, Save, clearWorldRank, echoMasks, echoWorldMode, fallbackName, isValidName, markEcho,
  recordBestCombo, recordBestRank, recordSegmentBest, retentionBuckets, segmentBests, setWorldRank, unlockedZones, utcDateStr,
} from './save.js';
import { medalsFor, mergeMedals, newMedals, syncUnlockedSkins } from './unlocks.js';
import { cloneBinds } from './input/binds.js';
import type { HapticsPort } from './haptics.js';
import { ApiError } from './net/api.js';
import { TRANSFER_KR } from './ui/transfer.js';
import type { FlushEvent, FlushResult, QueuedRun, SubmitQueue } from './net/queue.js';
import type { TelemetryData, TelemetryPort } from './net/telemetry.js';
import { Echo, checkpointKey } from './echo/echo.js';
import { GUIDE_COLOR, GUIDE_DELAY, GUIDE_LABEL, guideDropX, guideFor } from './echo/guide.js';
import { GOAL_LABEL, goalEchoFor } from './echo/goal.js';
import {
  RIVAL_LABEL, SPLIT_NONE, SPLIT_SECONDS, TOP_LABEL, fmtSplit, pickWorldEcho, withPersonalRow, worldEchoLabel, type SplitSign, type WorldEchoKind,
} from './echo/rival.js';
import {
  RACE_COLOR, RACE_KR, RUN_ID_RE, buildRaceUrl, defaultShareEnv, isFreshDailyDate, raceBanner, raceLabel, shareRaceLink, type ShareEnv,
} from './echo/race.js';
import { REHINT_HAZARD, REHINT_PIT } from './ui/hints.js';
import { fmtTime } from './ui/hud.js';
import { CARD_KR, defaultCardEnv, shareCard, type CardEnv, type ShareCardView } from './share/card.js';
import type { GoTarget } from './share/go.js';
import { endingView, tierCardView, tierComplete, towerComplete, type EndingView, type TierCardView } from './ui/ceremony.js';
import type { StingerKind } from './audio/sfx.js';
import { ENDING_TRACK } from './audio/music.js';

export type RunMode = 'story' | 'daily' | 'endless';

/** A death position (world units, the player's centre) drawn as an X mark for the rest of the zone session. */
export interface DeathMark { x: number; y: number }

/** One checkpoint segment of the current run, as the pause screen lists it. */
export interface SegmentRow {
  /** 0 = start → first checkpoint; the last row ends at the goal. */
  idx: number;
  /** Deaths inside this segment during the zone session. */
  deaths: number;
  /** Best time (ticks) for this segment on this install (story zones), null = none. */
  best: number | null;
  /** The segment the player is in right now. */
  current: boolean;
}

/** How the finished run compares with the world echo it raced: our ticks − theirs (negative = faster). */
export interface VersusView {
  /** '라이벌' or '1위'. */
  label: string;
  deltaTicks: number;
}

/** What a clear adds to the result screen beyond the summary (P3-6): the medals it just earned and the run's longest shard combo. */
export interface ClearExtras {
  /** Medal ids the record did not hold before this clear (they pop, with the unlock sound). */
  newMedals: string[];
  /** Longest shard combo of this run. */
  combo: number;
  /** The combo beat the zone's stored best (a first combo counts). */
  comboRecord: boolean;
}

/** Everything a zone remembers across restarts within one browser session (never saved). */
interface ZoneSession {
  marks: DeathMark[];
  segDeaths: number[];
}

/** The friend's echo a run races (P3-3): the ghost's run id and name, and its length for the result row. */
export interface RaceInfo {
  runId: string;
  name: string;
  ticks: number;
}

/**
 * A race the shell is in (from a `?race=` link): the ghost as the server sent
 * it, decoded once, and how it was started. Survives restarts / retries of the
 * same zone; any other run, or quitting to the menus, ends it.
 */
interface PendingRace {
  g: GhostResponse;
  masks: Uint8Array;
  name: string;
  /** A story zone the player has not unlocked: raced once, never recorded, never submitted, opens nothing. */
  locked: boolean;
  /** A daily the server still accepts (today / yesterday); stale ones are raced offline. */
  fresh: boolean;
}

/** Death X marks kept per zone session. */
export const DEATH_MARKS_MAX = 5;
/** Pause screen: at most this many segment rows (procedural towers can carry many checkpoints). */
export const MAX_SEGMENT_ROWS = 12;

/**
 * Yesterday's tower as the daily screen shows it: the date, the seed when the
 * server sent one (null = cannot be climbed), and its board with our row when
 * it was fetched (null = not yet / offline).
 */
export interface YesterdayInfo {
  date: string;
  seed: number | null;
  lb: LeaderboardResponse | null;
}

/** UIPort plus the optional extras the concrete UI offers. */
export interface ShellUI extends UIPort {
  /** Daily screen: yesterday's tower row ("어제의 탑 · 세계 N위 / M명") and the 재도전 entry. */
  setYesterday?(info: YesterdayInfo | null): void;
  /** `justUnlocked` names the zones this refresh opens (card animation + unlock sound). */
  refreshSelect(progress: Progress, levels: LevelDef[], justUnlocked?: ReadonlySet<string>): void;
  banner?(text: string): void;
  boot?(k: number, label?: string): void;
  /** navigator.onLine mirror (title badge). */
  setOffline?(on: boolean): void;
  /** Where the renderer drew the goal after the last frame (hides the zone chip under the HUD's top-right block). */
  setGoalScreen?(g: { x: number; y: number; onScreen: boolean } | null): void;
  /** The server runs a newer sim than this bundle: the update bar turns urgent. */
  setVersionBehind?(on: boolean): void;
  /** Live checkpoint split chip ('+0.84s' / '−1.20s' / '—'; sign −1 ahead · 0 even · 1 behind); null hides it. */
  split?(text: string | null, sign?: SplitSign): void;
  /** Pause screen: per-checkpoint-segment death counts and segment bests of the current run; null clears them. */
  segments?(rows: SegmentRow[] | null): void;
  /** Result screen: the "라이벌보다 0.62s 빠름" row when a world echo was raced; null hides it. */
  setVersus?(v: VersusView | null): void;
  /** Result screen (P3-6): the medals this clear just earned and its longest combo; null for a run without them. Call before showResult. */
  setClearExtras?(x: ClearExtras | null): void;
  /** Settings → 데이터: a one-time transfer code was created (P3-5). */
  showTransferCode?(code: string, expiresAt: string): void;
  /** Settings → 데이터: progress / error line under the transfer widgets; null clears it. */
  transferStatus?(text: string | null, kind?: 'ok' | 'error' | 'busy'): void;
  /**
   * Result screen (P3-4): the shell allows the install card for this result
   * (a story clear, fewer than INSTALL_CARD_MAX_DISMISS dismissals); the UI
   * shows it only when the browser can install (prompt captured / iOS Safari).
   */
  installCard?(on: boolean): void;
  /**
   * 층 돌파 (P3-9): the one-time vista card for a completed tier, shown over
   * the finished run before its result; the UI calls `done` once the card ends
   * or is skipped, and the shell then shows the result.
   */
  tierBreak?(card: TierCardView, done: () => void): void;
  /** 엔딩 (P3-9): the ending screen in place of the last zone's result (the result view rides along for its submission line). */
  showEnding?(view: EndingView): void;
}
/** AudioPort plus the pause-menu muffle and the ceremony stingers the concrete engine offers. */
export interface ShellAudio extends AudioPort {
  setMuffle?(on: boolean): void;
  /** Tier fanfare / ending chord / star / medal, outside the sim event stream (P3-9). */
  stinger?(kind: StingerKind, idx?: number): void;
}
/** RendererPort plus the death X marks the concrete renderer draws (the shell keeps the list). */
export interface ShellRenderer extends RendererPort {
  setDeathMarks?(marks: readonly DeathMark[]): void;
}

export interface ScenesDeps {
  renderer: ShellRenderer;
  audio: ShellAudio;
  ui: ShellUI;
  input: InputPort;
  api: ApiPort;
  save: Save;
  /**
   * Offline submission queue. Without one, an unreachable server leaves the
   * result at 'offline'; with one the run is queued and sent on `flushQueue()`.
   */
  queue?: SubmitQueue;
  /** Story zones in progression order. */
  levels: LevelDef[];
  makeDaily?: (seed: number) => LevelDef;
  makeEndless?: (seed: number) => LevelDef;
  /** Client-side randomness for endless seeds (never used inside the sim). */
  randomSeed?: () => number;
  /** Randomness for shake offsets. */
  random?: () => number;
  /** Build id sent with submissions. */
  build?: string;
  now?: () => number;
  /** Vibration / gamepad rumble on sim events (P3-8); none in tests without one. */
  haptics?: HapticsPort;
  /**
   * `navigator.storage.persist()` — asked once per install after the first
   * story clear so an idle iOS install is not evicted after 7 days. Default:
   * the platform's, when it has one.
   */
  persistStorage?: () => Promise<boolean> | boolean | void;
  /** Anonymous telemetry sink (none in tests without one, and under the capture harness). */
  telemetry?: TelemetryPort;
  /** Device facts for the boot event (uaFamily, dpr, hwConcurrency) — never a raw UA string. */
  telemetryEnv?: TelemetryData;
  /**
   * The server reported (or implied, through a 'sim-version' rejection) a sim
   * newer than this bundle: main.ts asks the service worker to update. The
   * argument is the server's SIM_VERSION when known, null otherwise.
   */
  onServerNewer?: (serverSim: number | null) => void;
  /** Origin of the race links the result screen shares (P3-3). Default: location.origin, '' in Node. */
  origin?: string;
  /** Web Share / clipboard hooks for '메아리 링크 공유'. Default: the platform's navigator. */
  share?: ShareEnv;
  /** Canvas / Web Share (files) / clipboard hooks for the result card (P3-4). Default: the platform's navigator and document. */
  card?: CardEnv;
}

/** Seconds of clear animation before the result screen. */
export const RESULT_DELAY = 1.25;
/** Seconds between the 층 돌파 card ending and the result screen (P3-9). */
export const TIER_RESULT_GAP = 0.2;
/** Menu screens redraw the title backdrop at most this often (30 fps). */
export const MENU_FRAME_DT = 1 / 30;
/** Seconds after the tide swallows the player before the game-over screen. */
export const OVER_DELAY = 1.1;
export const HINT_DELAY = 2.0;
export const HINT_DURATION = 7.0;
/** Deaths of one kind (pit · spike/saw) inside one checkpoint segment before the matching hint is shown again. */
export const REHINT_DEATHS = 2;
export const TIDE_TOAST_DELAY = 1.7;
/** The title vista rotates biomes this often. */
export const TITLE_ROTATE = 14;
/** Foes closer than this raise the music intensity. */
const THREAT_RANGE = 150;
/** Deaths in one story zone (on this install) before the assist offer; it comes back every further multiple unless declined for good. */
export const ASSIST_OFFER_DEATHS = 20;
/** progress.seen flag: the inline name prompt was shown once (asked once per install). */
export const NAME_ASKED_KEY = 'name:asked';
/** progress.seen flag per zone: 다시 묻지 않기 on the assist offer. */
export const assistSeenKey = (levelId: string): string => `assist:${levelId}`;
/** 나중에 presses on the result screen's install card before it stays hidden for good (P3-4). */
export const INSTALL_CARD_MAX_DISMISS = 3;
/** A zone's world rank (the select card's 세계 N위) is re-read from the board at most this often (P3-6). */
export const RANK_REFRESH_MS = 5 * 60_000;
/** The public top page consulted before /api/me when a card's rank is refreshed (our run id is in it when we are that high). */
export const RANK_TOP_LIMIT = 20;

/** Growable per-tick mask recording, capped at MAX_TICKS. */
export class MaskLog {
  private buf = new Uint8Array(4096);
  length = 0;
  /** Set once a run outgrew the cap; such a run is not leaderboard-eligible. */
  overflow = false;

  push(m: InputMask): void {
    if (this.length >= MAX_TICKS) { this.overflow = true; return; }
    if (this.length === this.buf.length) {
      const next = new Uint8Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.length++] = m & IN_ALL;
  }

  bytes(): Uint8Array { return this.buf.slice(0, this.length); }
}

export interface Run {
  sim: Sim;
  def: LevelDef;
  mode: RunMode;
  biome: Biome;
  seed: number;
  masks: MaskLog;
  daily: { date: string; seed: number } | null;
  echoes: Echo[];
  /**
   * The world echo (라이벌 / 1위, or the 목표 stand-in) and the self echo, kept
   * after they finish: their checkpoint ticks feed the live splits.
   */
  worldEcho: Echo | null;
  selfEcho: Echo | null;
  /** The board entry raced as the world echo (a cleared run), for the result screen's 라이벌보다 row. */
  rival: { kind: WorldEchoKind; name: string; ticks: number } | null;
  /** A friend's echo from a race link (P3-3) and its ghost; the result row compares against it first. */
  race: RaceInfo | null;
  raceEcho: Echo | null;
  /** Racing a zone the player has not unlocked: no progress, no submission, no unlock. */
  raceLocked: boolean;
  /** Server id of this run once a submission was accepted (what '메아리 링크 공유' links to). */
  acceptedRunId: string | null;
  /** Live tick at which the player passed each checkpoint (see checkpointKey). */
  cpTicks: Map<string, number>;
  /** The split chip waiting to be pushed to the UI (`dirty`) and its remaining lifetime (−1 = none). */
  split: { text: string; sign: SplitSign; dirty: boolean } | null;
  splitTimer: number;
  /** Tick at which the current checkpoint segment began (segment bests). */
  segStart: number;
  /** Death marks and per-segment deaths of this zone, shared by every run of it in this session. */
  session: ZoneSession;
  /** The bundled '길잡이' echo while it is running (first play of a guided zone), else null. */
  guide: Echo | null;
  /** Seconds until the guide sets off; -1 = none pending. */
  guideTimer: number;
  /** Deaths per kind since the last checkpoint, for the re-hints. */
  segDeaths: { pit: number; hazard: number };
  /** No story zone had been cleared when this run began: its clear returns to the tower instead of the next zone. */
  firstEver: boolean;
  /** Checkpoints reached so far (the segment index a death is reported under). */
  checkpoints: number;
  /** Wall-clock `t` of the last death, for the death → respawn gap the player felt. */
  deathAt: number;
  /** onRunEnd has fired for this run (result settled, or quit). */
  endNotified: boolean;
  /**
   * Started without a server (capture harness, or a daily begun while the
   * server was unreachable): no leaderboard or ghost fetch, never submitted.
   * Sticky across restart / retry of the same run.
   */
  offline: boolean;
  /** Leaderboard-eligible so far (no assist / invincible / overflow, submittable mode, online). */
  eligible: boolean;
  /** The run can be kept as a self echo (no assist / invincible). */
  echoSafe: boolean;
  /** Encoded mask log of the finished run (echoSafe only); matches queued / stored records. */
  encoded: string | null;
  /** An eligible run whose submission waits for the inline name prompt on the result screen. */
  pendingSubmit: string | null;
  summary: RunSummary | null;
  view: ResultView | null;
  resultKind: 'clear' | 'over' | null;
  resultTimer: number;
  resultShown: boolean;
  /** The 층 돌파 card this clear earned, until it has been shown (P3-9). */
  tierCard: TierCardView | null;
  /** This clear completed the tower for the first time: the ending stands in for the result (P3-9). */
  ending: boolean;
  /** Medals this clear added to the zone's record (P3-6); they pop on the result screen. */
  newMedals: string[];
  /** This run's longest shard combo beat the zone's stored best (P3-6). */
  comboRecord: boolean;
  /** Best height before this run (tide modes), for the 신기록 label. */
  prevBestHeight: number;
  hintTimer: number;
  hintText: string | null;
  hintUntil: number;
  toastTimer: number;
  toastText: string | null;
  /** Wall-clock seconds spent in the play screen. */
  t: number;
}

function deathLine(cause: string): string | null {
  switch (cause) {
    case 'retry': return null;   // the player asked for it
    case 'pit': return '심연';
    case 'spike': return '가시';
    case 'saw': return '톱날';
    case 'tide': return '조류에 잠겼다';
    case 'bolt': return '피격';
    case 'foe': return '적에게 당했다';
    case 'switch': return '블록에 끼였다';
    default: return '쓰러졌다';
  }
}

export function starsFor(s: RunSummary): number {
  if (!s.cleared) return 0;
  let stars = 1;
  if (s.totalShards > 0 && s.shards >= s.totalShards) stars++;
  if (s.time <= s.par) stars++;
  return stars;
}

export class Scenes {
  readonly fx: FxBus;
  readonly camera = new Camera();
  readonly scheduler = new TickScheduler();
  run: Run | null = null;
  daily: DailyResponse | null = null;
  dailyLb: LeaderboardResponse | null = null;
  /** Yesterday's tower (date / seed / board), fetched once per day at boot and when the daily screen opens. */
  yesterday: YesterdayInfo | null = null;

  private readonly renderer: ShellRenderer;
  private readonly audio: ShellAudio;
  private readonly ui: ShellUI;
  private readonly input: InputPort;
  private readonly api: ApiPort;
  private readonly save: Save;
  private readonly queue: SubmitQueue | null;
  private readonly levels: LevelDef[];
  private readonly levelById: Record<string, LevelDef>;
  private readonly makeDaily: (seed: number) => LevelDef;
  private readonly makeEndless: (seed: number) => LevelDef;
  private readonly randomSeed: () => number;
  private readonly build: string;
  private readonly now: () => number;
  private readonly telemetry: TelemetryPort | null;
  private readonly telemetryEnv: TelemetryData;
  private readonly onServerNewer: ((serverSim: number | null) => void) | null;
  private readonly haptics: HapticsPort | null;
  private readonly persistStorage: (() => Promise<boolean> | boolean | void) | null;
  private readonly origin: string;
  private readonly shareEnv: ShareEnv;
  private readonly cardEnv: CardEnv;
  /** The race a `?race=` link started (kept across restarts of that zone); null when not racing. */
  private race: PendingRace | null = null;
  /** startRace is about to begin the raced run: the next beginRun attaches the ghost. */
  private raceArm = false;
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly runEndListeners: (() => void)[] = [];
  /** Per-zone session memory (death marks, segment deaths), keyed by mode · zone · seed. */
  private readonly sessions = new Map<string, ZoneSession>();
  /** When each zone's world rank was last re-read from the board (P3-6), for the RANK_REFRESH_MS throttle. */
  private readonly rankRefreshedAt = new Map<string, number>();

  private titleT = 0;
  private titleSwitchT = 0;
  private titleIdx = 0;
  /** Menu backdrop throttle: dt accumulated since the last drawTitle, and "draw on the next frame regardless". */
  private titleAcc = 0;
  private titleDirty = true;
  private muffled = false;
  /** A latched RETRY press waiting for a frame that runs ticks (see frame()). */
  private retryCarry: InputMask = 0;
  /** The tab was hidden: the next frame renders once and runs no catch-up ticks. */
  private resumeDiscard = false;
  /** The UI screen the last frame saw (screen-change telemetry). */
  private lastScreen: string | null = null;

  constructor(deps: ScenesDeps) {
    this.renderer = deps.renderer;
    this.audio = deps.audio;
    this.ui = deps.ui;
    this.input = deps.input;
    this.api = deps.api;
    this.save = deps.save;
    this.queue = deps.queue ?? null;
    this.levels = deps.levels;
    this.levelById = Object.fromEntries(deps.levels.map((l) => [l.id, l]));
    this.makeDaily = deps.makeDaily ?? makeDailyLevel;
    this.makeEndless = deps.makeEndless ?? makeEndlessLevel;
    this.randomSeed = deps.randomSeed ?? defaultRandomSeed;
    this.build = deps.build ?? 'dev';
    this.now = deps.now ?? (() => Date.now());
    this.telemetry = deps.telemetry ?? null;
    this.telemetryEnv = deps.telemetryEnv ?? {};
    this.onServerNewer = deps.onServerNewer ?? null;
    this.haptics = deps.haptics ?? null;
    this.persistStorage = deps.persistStorage ?? defaultPersistStorage();
    this.origin = deps.origin ?? defaultOrigin();
    this.shareEnv = deps.share ?? defaultShareEnv();
    this.cardEnv = deps.card ?? defaultCardEnv();
    this.fx = new FxBus({ random: deps.random });
    this.fx.applySettings(this.save.settings);
    this.ui.on((a) => this.onAction(a));
  }

  // ================================================================ boot
  /** Everything boot does, synchronously (tests and the capture harness). */
  bootSync(): void {
    this.applySettings();
    this.ui.setPortraitPainter((ctx, skin, size, t) => this.renderer.drawPortrait(ctx, skin, size, t));
    this.unlockSkins(false);
    this.ui.refreshSelect(this.save.progress, this.levels);
    this.bootTelemetry();
    this.showTitle();
  }

  /** Staged boot with a progress bar; `raf` yields a frame, `wait` sleeps. */
  async boot(hooks: { raf: () => Promise<void>; wait: (ms: number) => Promise<void>; fonts?: Promise<unknown> }): Promise<void> {
    const ui = this.ui;
    ui.boot?.(0.15, '렌더 파이프라인 구성…');
    await hooks.raf();
    this.applySettings();
    this.ui.setPortraitPainter((ctx, skin, size, t) => this.renderer.drawPortrait(ctx, skin, size, t));
    // The server's sim version is compared in the background: boot never waits on the network.
    void this.track(this.checkServerVersion());
    ui.boot?.(0.4, '지형 텍스처 베이킹…');
    await hooks.raf();
    // warm the sky gradients / noise before the first visible frame
    this.renderer.drawTitle(0, 0, BIOMES[BIOME_ORDER[0]]);
    if (hooks.fonts) { try { await Promise.race([hooks.fonts, hooks.wait(1400)]); } catch { /* no font API */ } }
    ui.boot?.(0.7, '레벨 로드…');
    await hooks.raf();
    // Skins the rules grant to this save (a rule may have arrived after the clears that satisfy it) — silently at boot.
    this.unlockSkins(false);
    this.ui.refreshSelect(this.save.progress, this.levels);
    this.bootTelemetry();
    ui.boot?.(1, '준비 완료');
    await hooks.wait(240);
    this.showTitle();
    // Runs finished while offline last time go out now (never awaited: boot must not wait on the network).
    void this.flushQueue();
    // Yesterday's tower (our rank on its board) for the daily screen and the title subtitle: once per day, in the background.
    void this.track(this.loadYesterday());
  }

  /** Count today as a play day and report the anonymous boot event (device facts + retention buckets). */
  private bootTelemetry(): void {
    const now = this.now();
    this.save.touchPlayDay(now);
    this.telemetry?.track('boot', { ...this.telemetryEnv, ...retentionBuckets(this.save.progress, now) });
  }

  /**
   * GET /api/health carries the server's SIM_VERSION: a newer one means this
   * bundle's replays would be refused, so the update is offered right away.
   */
  private async checkServerVersion(): Promise<void> {
    try {
      const h = await this.api.health();
      if (typeof h.simVersion === 'number' && h.simVersion > SIM_VERSION) this.serverNewer(h.simVersion);
    } catch { /* offline or a pre-versioning server: nothing to compare */ }
  }

  private serverNewer(serverSim: number | null): void {
    this.ui.setVersionBehind?.(true);
    this.onServerNewer?.(serverSim);
  }

  private showTitle(): void {
    this.ui.show('title');
    this.audio.setTrack('title');
    this.audio.setIntensity(0.45);
    this.titleDirty = true;
  }

  /** Push the settings object to every subsystem (cheap to repeat). */
  applySettings(): void {
    const s = this.save.settings;
    this.renderer.applySettings(s);
    this.audio.applySettings(s);
    this.ui.applySettings(s);
    this.fx.applySettings(s);
    this.haptics?.applySettings(s);
  }

  // ================================================================ async bookkeeping
  private track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p);
    const done = () => { this.inflight.delete(p); };
    p.then(done, done);
    return p;
  }

  /** Resolve once every tracked API round trip has finished (tests). */
  async settle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  // ================================================================ actions
  onAction(a: UIAction): void {
    switch (a.type) {
      case 'start': this.startLevel(a.levelId); break;
      case 'daily': this.onDailyStart(); break;
      case 'endless': this.startEndless(); break;
      case 'resume': this.resume(); break;
      case 'restart': this.trackRun('retry', { kind: 'restart' }); this.restartRun(); break;
      case 'quit': this.quitToMenu(); break;
      case 'next': this.nextLevel(); break;
      case 'retry': this.trackRun('retry', { kind: 'retry' }); this.retryRun(); break;
      // Game-over comeback: the same tower (same seed → the self echo of the best climb) or a fresh one.
      case 'sameTower': this.trackRun('retry', { kind: 'sameTower' }); this.sameTower(); break;
      case 'newTower': this.trackRun('retry', { kind: 'newTower' }); this.newTower(); break;
      case 'retryYesterday': this.startYesterday(); break;
      case 'assistAccept': this.acceptAssist(); break;
      case 'assistDecline': this.declineAssist(a.never); break;
      case 'openSelect':
        this.ui.refreshSelect(this.save.progress, this.levels);
        // The cards' 세계 N위 badges: re-read from the boards in the background (throttled per zone).
        void this.track(this.refreshWorldRanks());
        break;
      case 'openDaily': void this.track(this.openDaily()); break;
      case 'openSettings':
      case 'openCredits':
      case 'back':
        break;
      case 'settingsChanged':
        this.applySettings();
        this.save.saveSettings();
        break;
      case 'rebind':
        this.save.settings.binds = cloneBinds(a.binds);
        this.save.saveSettings();
        break;
      case 'resetProgress':
        this.save.resetProgress();
        this.ui.refreshSelect(this.save.progress, this.levels);
        this.ui.toast('진행 기록을 지웠다');
        break;
      case 'setName':
        this.save.progress.player.name = a.name;
        this.save.saveProgress();
        this.ui.refreshSelect(this.save.progress, this.levels);
        break;
      case 'toggleEcho':
        if (a.which === 'self') this.save.settings.echoSelf = a.on;
        else this.save.settings.echoWorld = a.on;
        this.save.saveSettings();
        break;
      case 'requestLeaderboard':
        if (a.mode === 'daily') void this.track(this.refreshDailyBoard());
        break;
      case 'transferExport': void this.track(this.transferExport()); break;
      case 'transferImport': void this.track(this.transferImport(a.code)); break;
      case 'shareEcho': void this.track(this.shareEcho()); break;
      case 'shareCard': void this.track(this.shareCard()); break;
      case 'installCardDismiss': this.dismissInstallCard(); break;
      default:
        break;
    }
  }

  // ================================================================ deep links (P3-4)
  /**
   * A manifest shortcut (`/?go=daily|endless`, read by main.ts before boot):
   * open the daily screen, or start a fresh endless climb. Ignored mid-run.
   * Returns whether anything happened.
   */
  go(target: GoTarget): boolean {
    if (this.run) return false;
    if (target === 'daily') {
      this.ui.show('daily');
      void this.track(this.openDaily());
      return true;
    }
    this.startEndless();
    return true;
  }

  // ================================================================ race links (P3-3)
  /**
   * `?race=<runId>` at boot: fetch the ghost and start what it was recorded on.
   * A story ghost starts its zone — a locked one too, once, without progress,
   * submission or unlock. A daily ghost starts that date's tower: today's or
   * yesterday's is a real, submittable climb; an older one is raced locally
   * (the server would refuse the record) and says so. The friend's echo is
   * added as '경주 · <name>' and the result screen compares against it.
   * Resolves true when a run started.
   */
  async startRace(runId: string): Promise<boolean> {
    if (!RUN_ID_RE.test(runId)) return false;
    let g: GhostResponse;
    try {
      g = await this.api.ghost(runId);
    } catch (err) {
      this.ui.toast(err instanceof ApiError && !err.offline ? RACE_KR.notFound : RACE_KR.offline);
      return false;
    }
    let masks: Uint8Array;
    try { masks = decodeMasks(g.masks); } catch { this.ui.toast(RACE_KR.notFound); return false; }
    if (!masks.length) { this.ui.toast(RACE_KR.notFound); return false; }
    const name = g.name || '친구';
    let fresh = true;
    let locked = false;
    if (g.mode === 'story') {
      const def = this.levelById[g.levelId];
      if (!def) { this.ui.toast(RACE_KR.badZone); return false; }
      locked = !this.unlockedZones().has(def.id);
      this.race = { g, masks, name, locked, fresh };
      this.raceArm = true;
      this.startLevel(def.id);
    } else {
      const today = utcDateStr(this.now());
      fresh = isFreshDailyDate(g.board, today);
      this.race = { g, masks, name, locked, fresh };
      this.raceArm = true;
      const expiresAt = new Date(Date.parse(`${g.board}T00:00:00.000Z`) + MS_PER_DAY).toISOString();
      this.startDaily({ date: g.board, seed: g.seed, levelId: 'daily', expiresAt }, { past: g.board !== today, offline: !fresh });
      if (!fresh) this.ui.toast(RACE_KR.staleDaily);
    }
    this.raceArm = false;
    this.telemetry?.track('race_link_open', { levelId: g.levelId, mode: g.mode, fresh, locked });
    return this.run !== null && this.run.race !== null;
  }

  /**
   * beginRun: attach the pending race to this run when it is the raced zone
   * (started by startRace, or a restart / retry of it); anything else ends the race.
   */
  private attachRace(run: Run, restart: boolean): void {
    const race = this.race;
    const arm = this.raceArm;
    this.raceArm = false;
    if (!race) return;
    const sameZone = race.g.levelId === run.def.id && (run.mode !== 'daily' || race.g.seed === run.seed) && run.mode !== 'endless';
    if (!sameZone || !(arm || restart)) { this.race = null; return; }
    const echo = new Echo(run.def, race.masks, race.g.seed, race.g.assist, RACE_COLOR, raceLabel(race.name));
    run.echoes.push(echo);
    run.raceEcho = echo;
    run.race = { runId: race.g.runId, name: race.name, ticks: race.g.ticks };
    run.raceLocked = race.locked;
    if (race.locked) run.eligible = false;
    if (!restart) this.ui.banner?.(raceBanner(race.name));
  }

  /**
   * '메아리 링크 공유': a `?race=<runId>&z=<levelId>` link to this run's accepted
   * submission, through the Web Share API or the clipboard (toast either way).
   */
  private async shareEcho(): Promise<void> {
    const run = this.run;
    const runId = run?.acceptedRunId ?? null;
    if (!run || !runId || run.view?.submit.state !== 'accepted') { this.ui.toast(RACE_KR.notShareable); return; }
    const url = buildRaceUrl(this.origin, runId, run.def.id);
    const text = `${this.save.progress.player.name}의 메아리와 경주하자 · ${run.def.name}`;
    const outcome = await shareRaceLink(url, text, this.shareEnv);
    this.telemetry?.track('share_click', { levelId: run.def.id, mode: run.mode, via: outcome });
    if (outcome === 'cancelled') return;
    this.ui.toast(outcome === 'shared' ? RACE_KR.shared : outcome === 'copied' ? RACE_KR.copied : RACE_KR.shareFailed);
  }

  /** The race link a friend could open for this run right now (tests / console), or null before an accepted submission. */
  raceUrl(): string | null {
    const run = this.run;
    return run?.acceptedRunId ? buildRaceUrl(this.origin, run.acceptedRunId, run.def.id) : null;
  }

  // ================================================================ share card (P3-4)
  /** What the card prints for the finished run, or null before a result exists. */
  cardView(): ShareCardView | null {
    const run = this.run;
    const s = run?.summary, v = run?.view;
    if (!run || !s || !v) return null;
    const sub = v.submit;
    return {
      biome: run.def.biome,
      zoneName: run.def.name,
      zoneEn: run.def.en,
      timeText: fmtTime(s.time),
      rank: s.rank,
      stars: v.stars,
      cleared: s.cleared,
      ...(s.height > 0 ? { height: Math.floor(s.height) } : {}),
      world: sub.state === 'accepted' && sub.rank ? { rank: sub.rank, ...(sub.total ? { total: sub.total } : {}) } : null,
      playerName: this.save.progress.player.name,
      skin: this.save.settings.skin,
      // The race link when the submission was accepted; the site itself otherwise (the card still travels).
      url: this.raceUrl() ?? `${this.origin.replace(/\/+$/, '')}/`,
    };
  }

  /**
   * '공유': the result card as a PNG through the Web Share API (files), else
   * the link through it, else the clipboard — toast either way, and a
   * share_click with the outcome.
   */
  private async shareCard(): Promise<void> {
    const run = this.run;
    const view = this.cardView();
    if (!run || !view) { this.ui.toast(CARD_KR.noResult); return; }
    const outcome = await shareCard(view, this.cardEnv, (ctx, skin, size, t) => this.renderer.drawPortrait(ctx, skin, size, t));
    this.telemetry?.track('share_click', { levelId: run.def.id, mode: run.mode, via: outcome, kind: 'card' });
    if (outcome === 'cancelled') return;
    this.ui.toast(CARD_KR[outcome]);
  }

  // ================================================================ install card (P3-4)
  /** The install card may sit on this result: a story clear the player recorded, fewer than INSTALL_CARD_MAX_DISMISS 나중에 so far. */
  private installCardAllowed(run: Run): boolean {
    if (run.mode !== 'story' || run.raceLocked || run.resultKind !== 'clear') return false;
    return (this.save.progress.installCardDismissed ?? 0) < INSTALL_CARD_MAX_DISMISS;
  }

  /** 나중에: count the dismissal (persisted) and drop the card from this result. */
  private dismissInstallCard(): void {
    const p = this.save.progress;
    p.installCardDismissed = (p.installCardDismissed ?? 0) + 1;
    this.save.saveProgress();
    this.ui.installCard?.(false);
  }

  /** The result row against the raced friend: story ghosts are clears by contract; a daily ghost must have cleared too. */
  private raceVersus(run: Run): VersusView | null {
    const race = run.race, echo = run.raceEcho;
    if (!race || !echo || !run.summary?.cleared || !(race.ticks > 0)) return null;
    if (run.mode !== 'story') {
      // Let the recording play out (it is behind the result modal): did the friend reach the top?
      echo.syncTo(Math.max(echo.tick, race.ticks + 1));
      if (echo.sim.state.phase !== 'clear') return null;
    }
    return { label: race.name, deltaTicks: run.summary.ticks - race.ticks };
  }

  // ================================================================ progress transfer (P3-5)
  /**
   * 다른 기기로 옮기기: the stripped Progress (no replay, see snapshotProgress)
   * goes up with the player identity; the server answers with a one-time code
   * the UI shows big. Nothing local changes.
   */
  private async transferExport(): Promise<void> {
    if (!this.api.transferCreate) { this.transferFail(TRANSFER_KR.unsupported); return; }
    this.ui.transferStatus?.(TRANSFER_KR.creating, 'busy');
    const p = this.save.progress;
    try {
      const res = await this.api.transferCreate({ player: { id: p.player.id, name: p.player.name }, progress: this.save.snapshot() });
      this.ui.showTransferCode?.(res.code, res.expiresAt);
      this.ui.transferStatus?.(TRANSFER_KR.created, 'ok');
      this.ui.toast(TRANSFER_KR.created);
    } catch (err) {
      this.transferFail(transferErrorText(err, 'export'));
    }
  }

  /**
   * 코드로 가져오기: the snapshot behind a code is merged into this save (the
   * better record per zone wins, the player identity becomes the other
   * device's, no replay is imported — see mergeProgress). Refused mid-run: the
   * live run holds references into the records it would rewrite.
   */
  private async transferImport(code: string): Promise<void> {
    if (this.run) { this.transferFail(TRANSFER_KR.inRun); return; }
    if (!this.api.transferGet) { this.transferFail(TRANSFER_KR.unsupported); return; }
    if (!TransferCode.safeParse(code).success) { this.transferFail(TRANSFER_KR.badCode); return; }
    this.ui.transferStatus?.(TRANSFER_KR.importing, 'busy');
    try {
      const snap = await this.api.transferGet(code);
      this.save.importSnapshot(snap);
      this.unlockSkins(false);
      this.ui.refreshSelect(this.save.progress, this.levels);
      this.ui.transferStatus?.(`${TRANSFER_KR.imported} · ${snap.name}`, 'ok');
      this.ui.toast(TRANSFER_KR.imported);
    } catch (err) {
      this.transferFail(transferErrorText(err, 'import'));
    }
  }

  private transferFail(text: string): void {
    this.ui.transferStatus?.(text, 'error');
    this.ui.toast(text);
  }

  /**
   * navigator.storage.persist(), once per install, after the first story
   * clear: the moment the save is worth keeping. Remembered in progress.seen
   * so a refused request is not repeated every clear; every failure is silent.
   */
  private requestPersist(): void {
    const p = this.save.progress;
    if (p.seen[PERSIST_ASKED_KEY]) return;
    p.seen[PERSIST_ASKED_KEY] = true;
    this.save.saveProgress();
    if (!this.persistStorage) return;
    try {
      const r = this.persistStorage();
      const maybe = r as { catch?: (fn: () => void) => unknown } | null | undefined;
      if (maybe && typeof maybe.catch === 'function') maybe.catch(() => undefined);
    } catch { /* no Storage API, or it refused */ }
  }

  // ================================================================ run lifecycle
  startLevel(id: string, opts: { restart?: boolean } = {}): boolean {
    const def = this.levelById[id];
    if (!def) return false;
    // A locked zone raced through a link is not "the zone in progress": 이어하기 must not lead back into it.
    if (!(this.race?.locked && this.race.g.levelId === id)) {
      this.save.progress.lastLevel = id;
      this.save.saveProgress();
    }
    this.beginRun(def, 'story', def.seed, null, !!opts.restart);
    return true;
  }

  /**
   * Start a daily tower. `past` marks yesterday's tower: it is climbed and
   * submitted under its own date but never becomes `this.daily` (today's).
   * Starting counts as a 도전 for the streak, whether or not the run finishes.
   */
  startDaily(daily: DailyResponse, opts: { restart?: boolean; offline?: boolean; past?: boolean } = {}): void {
    const def = this.makeDaily(daily.seed);
    if (!opts.past) this.daily = daily;
    this.save.dailyRecord(daily.date, daily.seed);
    this.save.saveProgress();
    this.beginRun(def, 'daily', daily.seed, { date: daily.date, seed: daily.seed }, !!opts.restart, !!opts.offline);
  }

  /** 어제의 탑 재도전: yesterday's seed under yesterday's date — the server still accepts it until the end of today. */
  private startYesterday(): void {
    const y = this.yesterday;
    if (!y || y.seed === null) { this.ui.toast('어제의 탑 시드를 아직 받지 못했다'); return; }
    if (this.daily && !dailyVersionOk(this.daily)) {
      this.ui.toast('새 버전이 나왔다. 새로고침 후 오늘의 탑을 오를 수 있다');
      this.serverNewer(this.daily.sim ?? null);
      return;
    }
    const expiresAt = new Date(Date.parse(`${y.date}T00:00:00.000Z`) + 2 * MS_PER_DAY).toISOString();
    this.startDaily({ date: y.date, seed: y.seed, levelId: 'daily', expiresAt }, { past: true });
  }

  startEndless(seed?: number): void {
    const s = (seed ?? this.randomSeed()) >>> 0;
    const def = this.makeEndless(s);
    this.save.progress.endless.runs++;
    this.save.saveProgress();
    this.beginRun(def, 'endless', s, null, seed !== undefined);
  }

  private onDailyStart(): void {
    const d = this.daily;
    if (!d || Date.parse(d.expiresAt) < this.now()) {
      this.ui.toast(d ? '오늘의 탑이 바뀌었다. 다시 받아온다' : '오늘의 탑을 아직 받지 못했다');
      void this.track(this.openDaily());
      return;
    }
    // A tower generated by a newer sim / generator cannot be reproduced here, so its
    // record would be refused: the player is asked to update instead of wasting a climb.
    if (!dailyVersionOk(d)) {
      this.ui.toast('새 버전이 나왔다. 새로고침 후 오늘의 탑을 오를 수 있다');
      this.serverNewer(d.sim ?? null);
      return;
    }
    this.startDaily(d);
  }

  private beginRun(def: LevelDef, mode: RunMode, seed: number, daily: Run['daily'], restart: boolean, offline = false): void {
    const s = this.save.settings;
    const sim = new Sim(def, { seed, assist: s.assist, invincible: s.invincible });
    const biome = BIOMES[def.biome];
    const echoSafe = !s.assist && !s.invincible;
    const firstPlay = !restart && !this.save.progress.seen[def.id];
    const guided = firstPlay && mode === 'story' && guideFor(def, seed) !== null;
    const session = this.zoneSession(mode, def.id, seed);
    const run: Run = {
      sim, def, mode, biome, seed, masks: new MaskLog(), daily, echoes: [],
      worldEcho: null, selfEcho: null, rival: null,
      race: null, raceEcho: null, raceLocked: false, acceptedRunId: null,
      cpTicks: new Map(), split: null, splitTimer: -1, segStart: 0, session,
      guide: null, guideTimer: guided ? GUIDE_DELAY : -1,
      segDeaths: { pit: 0, hazard: 0 },
      firstEver: mode === 'story' && !this.levels.some((l) => this.save.progress.levels[l.id]?.done),
      checkpoints: 0,
      deathAt: -1,
      endNotified: false,
      offline,
      eligible: echoSafe && mode !== 'endless' && !offline,
      echoSafe,
      encoded: null,
      pendingSubmit: null,
      summary: null, view: null, resultKind: null, resultTimer: -1, resultShown: false,
      tierCard: null, ending: false,
      newMedals: [], comboRecord: false,
      // Stored heights are whole tiles; floor defensively for saves written before that rule.
      prevBestHeight: Math.floor(mode === 'daily' && daily ? (this.save.progress.daily[daily.date]?.height ?? 0)
        : mode === 'endless' ? this.save.progress.endless.bestHeight : 0),
      hintTimer: -1, hintText: null, hintUntil: -1,
      toastTimer: -1, toastText: null,
      t: 0,
    };
    this.run = run;
    this.fx.reset(1);
    this.camera.reset(sim.state.player);
    this.scheduler.reset();
    this.renderer.setLevel(sim, biome);
    this.renderer.clearParticles();
    // The zone session's death marks outlive a restart; the split chip does not.
    this.renderer.setDeathMarks?.(session.marks.slice());
    this.setMuffle(false);
    this.audio.setTrack(biome.track);
    this.audio.setIntensity(0.55);
    this.input.reset();
    this.ui.hint(null);
    this.ui.split?.(null);
    this.ui.show('play');
    this.pushSegments(run);
    this.retryCarry = 0;
    if (!restart) {
      this.ui.banner?.(def.name);
      if (firstPlay) {
        this.save.progress.seen[def.id] = true;
        this.save.saveProgress();
        if (def.hint) {
          run.hintTimer = HINT_DELAY;
          run.hintText = def.hint;
        }
      }
      if (def.tide) { run.toastTimer = TIDE_TOAST_DELAY; run.toastText = '아래에서 조류가 밀려온다'; }
    }
    // A race link's ghost rides along from tick 0 (after the zone banner, so its banner is what stays on screen).
    this.attachRace(run, restart);
    this.ui.hud(this.hudState(run));
    this.telemetry?.track(mode === 'daily' ? 'daily_start' : 'zone_start', { levelId: def.id, mode, restart });
    void this.track(this.loadEchoes(run));
  }

  /** Story zones open right now (the select screen applies the same rule: clearing N opens N+1 and N+2 within the tier). */
  private unlockedZones(progress: Progress = this.save.progress): Set<string> {
    return unlockedZones(this.levels, progress);
  }

  /** The session memory of one zone (a daily / endless tower is a zone per seed), created on first use. */
  private zoneSession(mode: RunMode, levelId: string, seed: number): ZoneSession {
    const key = `${mode}:${levelId}:${seed >>> 0}`;
    let s = this.sessions.get(key);
    if (!s) { s = { marks: [], segDeaths: [] }; this.sessions.set(key, s); }
    return s;
  }

  private resume(): void {
    if (!this.run) return;
    this.ui.show('play');
    this.setMuffle(false);
    this.input.reset();
    this.scheduler.reset();
  }

  private restartRun(): void {
    const run = this.run;
    if (!run) return;
    if (run.mode === 'story') this.startLevel(run.def.id, { restart: true });
    else if (run.mode === 'daily' && run.daily) this.startDaily(this.dailyFor(run), { restart: true, offline: run.offline, past: this.isPast(run) });
    else this.startEndless(run.seed);
  }

  // ================================================================ stuck detector (assist offer)
  /**
   * Every death in a story zone counts on this install (LevelRecord.sessionDeaths).
   * At every ASSIST_OFFER_DEATHS-th death, with assist off and the zone not
   * marked 다시 묻지 않기, the UI offers to restart the zone in assist mode.
   */
  private countDeath(run: Run): void {
    if (run.mode !== 'story') return;
    const rec = this.save.levelRecord(run.def.id);
    rec.sessionDeaths = (rec.sessionDeaths ?? 0) + 1;
    this.save.saveProgress();
    if (rec.sessionDeaths % ASSIST_OFFER_DEATHS !== 0) return;
    if (this.save.settings.assist || run.sim.assist || this.save.progress.seen[assistSeenKey(run.def.id)]) return;
    this.ui.offerAssist?.(run.def.name);
  }

  /** 다시 시작: assist on (the Sim takes it in its constructor, so the zone restarts) — the run is no longer board-eligible. */
  private acceptAssist(): void {
    const run = this.run;
    this.save.settings.assist = true;
    this.save.saveSettings();
    this.applySettings();
    if (!run) return;
    if (run.mode === 'story') this.startLevel(run.def.id, { restart: true });
    else this.restartRun();
  }

  /** 이번엔 괜찮다 / 다시 묻지 않기: back to the run; `never` marks the zone so the offer is not repeated. */
  private declineAssist(never: boolean): void {
    const run = this.run;
    if (never && run) {
      this.save.progress.seen[assistSeenKey(run.def.id)] = true;
      this.save.saveProgress();
    }
    if (run && !run.summary) this.resume();
  }

  private retryRun(): void {
    const run = this.run;
    if (!run) return;
    if (run.mode === 'story') this.startLevel(run.def.id, { restart: true });
    else if (run.mode === 'daily' && run.daily) this.startDaily(this.dailyFor(run), { restart: true, offline: run.offline, past: this.isPast(run) });
    else this.startEndless();
  }

  /** 같은 탑 다시: the same seed — endless keeps its seed, a daily is the same daily anyway. */
  private sameTower(): void {
    const run = this.run;
    if (!run) return;
    if (run.mode === 'endless') this.startEndless(run.seed);
    else this.retryRun();
  }

  /** 새 탑: a fresh endless seed; for anything else the plain retry. */
  private newTower(): void {
    const run = this.run;
    if (!run) return;
    if (run.mode === 'endless') this.startEndless();
    else this.retryRun();
  }

  /** A daily run for a date other than today's (yesterday's tower). */
  private isPast(run: Run): boolean {
    return run.mode === 'daily' && !!run.daily && !!this.daily && run.daily.date !== this.daily.date;
  }

  private nextLevel(): void {
    const run = this.run;
    if (!run || run.mode !== 'story') { this.retryRun(); return; }
    // The very first clear returns to the tower: the eight cards, one newly lit, are the reward. A locked race leads nowhere else.
    if ((run.firstEver && run.summary?.cleared) || run.raceLocked) { this.quitToMenu(); return; }
    const i = this.levels.findIndex((l) => l.id === run.def.id);
    if (i >= 0 && i + 1 < this.levels.length) this.startLevel(this.levels[i + 1].id);
    else this.quitToMenu();
  }

  /** The DailyResponse a daily run was started from (kept for restarts without a server). */
  private dailyFor(run: Run): DailyResponse {
    const d = this.daily;
    if (d && run.daily && d.seed === run.daily.seed && d.date === run.daily.date) return d;
    return { date: run.daily!.date, seed: run.daily!.seed, levelId: 'daily', expiresAt: new Date(this.now() + 86_400_000).toISOString() };
  }

  quitToMenu(): void {
    const run = this.run;
    if (run) {
      this.telemetry?.track('quit', { levelId: run.def.id, mode: run.mode, t: Math.round(run.t), finished: run.sim.finished });
      this.notifyRunEnd(run);
    }
    this.run = null;
    this.race = null;
    this.titleDirty = true;
    this.setMuffle(false);
    this.audio.setTrack('title');
    this.audio.setIntensity(0.45);
    this.input.reset();
    this.ui.hint(null);
    const to = run?.mode === 'story' ? 'select' : run?.mode === 'daily' ? 'daily' : 'title';
    this.ui.refreshSelect(this.save.progress, this.levels);
    this.ui.show(to);
    if (to === 'daily') void this.track(this.refreshDailyBoard());
    if (to === 'select') void this.track(this.refreshWorldRanks());
  }

  // ================================================================ per frame
  /** One rendered frame. `dtRaw` is wall-clock seconds since the previous frame. */
  frame(dtRaw: number): void {
    let dt = Number.isFinite(dtRaw) && dtRaw > 0 ? Math.min(dtRaw, 0.25) : 0;
    // Back from a hidden tab: the gap is not play time. Render once, tick nothing.
    if (this.resumeDiscard) { this.resumeDiscard = false; dt = 0; }
    this.input.poll();
    const held = this.input.held();
    const latched = this.input.takeLatched();
    this.ui.frame(dt, this.input);
    const screen = this.ui.screen;
    if (screen !== this.lastScreen) {
      this.lastScreen = screen;
      this.telemetry?.screen(screen);
    }

    const run = this.run;
    if (!run) { this.menuFrame(dt); return; }

    const playing = screen === 'play';
    this.setMuffle(!playing && !run.summary);
    // The clear / game-over countdown belongs to the run, not to the play
    // screen: a pause or a lost gamepad during the animation still lands on the result.
    if (!playing) this.resultTick(run, dt);
    if (playing) {
      const dtWall = Math.min(dt, MAX_FRAME_DT);
      run.t += dtWall;
      this.fx.update(dtWall);
      const live = !run.sim.finished;
      const masks = this.scheduler.plan(dtWall, live ? held : 0, live ? latched : 0, this.fx);
      // IN.RETRY rides along with the other bits. The scheduler may still mask
      // to the six movement bits, so the retry bit is re-applied here with the
      // same semantics: a held bind on every tick, a tap on the first tick that
      // runs (carried across hitstop frames). Idempotent once the scheduler
      // passes IN_ALL through.
      if (live) {
        this.retryCarry |= latched & IN.RETRY;
        if (masks.length) {
          const heldRetry = held & IN.RETRY;
          if (heldRetry) for (let i = 0; i < masks.length; i++) masks[i] |= heldRetry;
          masks[0] |= this.retryCarry;
          this.retryCarry = 0;
        }
      }
      for (const m of masks) this.tick(m);
      const p = run.sim.state.player;
      this.camera.update(dtWall * (this.fx.hitstop > 0 ? 0.2 : 1), p, run.sim.level, this.renderer.viewW, this.renderer.viewH, this.fx.zoom);
      this.timers(run, dtWall);
      this.resultTick(run, dtWall);
      this.audio.setIntensity(run.sim.finished ? 0.25 : 0.55 + this.threat(run) * 0.45);
    }
    this.drawFrame(playing ? dt : 0);
  }

  /** Menu screens: the title backdrop is redrawn at most 30 times a second (the first frame after a switch right away). */
  private menuFrame(dt: number): void {
    this.titleAcc += dt;
    if (!this.titleDirty && this.titleAcc < MENU_FRAME_DT - 1e-6) return;
    this.titleDirty = false;
    const step = this.titleAcc;
    this.titleAcc = 0;
    this.titleFrame(step);
  }

  // ================================================================ lifecycle hooks (main.ts)
  /**
   * document.visibilitychange. Hidden: nothing to do here (the UI pauses, the
   * audio engine stops its clock). Visible again: the next frame's dt is the
   * whole absence, so it is discarded — one render, no catch-up ticks.
   */
  visibility(hidden: boolean): void {
    if (hidden) return;
    this.resumeDiscard = true;
    this.scheduler.reset();
  }

  /** The gamepad went away mid-run: pause so the character does not run on unattended. */
  gamepadLost(): void {
    const run = this.run;
    if (!run || run.sim.finished || this.ui.screen !== 'play') return;
    this.ui.show('pause');
    this.ui.toast('게임패드 연결이 끊겼다');
  }

  /**
   * A reload right now would destroy something: a run from its start until the
   * result has settled (submission answered or not needed). Paused counts too.
   */
  isBusy(): boolean {
    return this.run !== null && !this.run.endNotified;
  }

  /** Called once per run when it stops being busy (result settled, or the player quit). */
  onRunEnd(cb: () => void): void {
    this.runEndListeners.push(cb);
  }

  private notifyRunEnd(run: Run): void {
    if (run.endNotified) return;
    run.endNotified = true;
    for (const cb of this.runEndListeners) { try { cb(); } catch { /* a listener must not break the flow */ } }
  }

  /** The result is on screen and nothing is in flight any more: the run has ended. */
  private settleRunEnd(run: Run): void {
    if (run.resultShown && run.view && run.view.submit.state !== 'pending') this.notifyRunEnd(run);
  }

  /** Telemetry about the current run (no-op without one). */
  private trackRun(t: 'retry', extra: TelemetryData): void {
    const run = this.run;
    if (!run) return;
    this.telemetry?.track(t, { levelId: run.def.id, mode: run.mode, ...extra });
  }

  /** Step the live sim one tick, echoes in lockstep, and dispatch the tick's events. */
  tick(mask: InputMask): SimEvent[] {
    const run = this.run;
    if (!run) return [];
    const sim = run.sim;
    if (!sim.finished) {
      run.masks.push(mask);
      if (run.masks.overflow) run.eligible = false;
    }
    sim.step(mask);
    const splitEcho = this.splitEchoOf(run);
    for (const e of run.echoes) {
      const evs = e.step();
      // The echo reaching a pillar the player already passed: the player is ahead, and now by how much.
      if (e === splitEcho) for (const ev of evs) if (ev.type === 'checkpoint') this.onEchoCheckpoint(run, e, ev.x, ev.y);
    }
    const events = sim.drainEvents();
    for (const ev of events) {
      this.fx.onEvent(ev);
      this.renderer.onEvent(ev, sim);
      this.audio.onEvent(ev, sim);
      this.haptics?.onEvent(ev);
      this.onSimEvent(run, ev);
    }
    return events;
  }

  /** Draw the world (or nothing when there is no run); `dt` = 0 freezes visual-only motion. */
  drawFrame(dt: number): void {
    const run = this.run;
    if (!run) return;
    if (run.echoes.some((e) => e.done)) {
      run.echoes = run.echoes.filter((e) => !e.done);
      if (run.guide && !run.echoes.includes(run.guide)) run.guide = null;
    }
    const ghosts = [];
    for (const e of run.echoes) { const v = e.view(); if (v) ghosts.push(v); }
    this.renderer.draw(run.sim, this.camera.view(this.fx.zoom), this.fx.state(), ghosts, dt);
    this.ui.setGoalScreen?.(this.renderer.goalScreen);
    this.ui.hud(this.hudState(run));
  }

  /** The title vista behind the menus, rotating biomes. */
  titleFrame(dt: number): void {
    this.titleT += dt;
    this.titleSwitchT += dt;
    if (this.titleSwitchT > TITLE_ROTATE) {
      this.titleSwitchT = 0;
      this.titleIdx = (this.titleIdx + 1) % BIOME_ORDER.length;
    }
    this.renderer.drawTitle(this.titleT, dt, BIOMES[BIOME_ORDER[this.titleIdx]]);
  }

  private timers(run: Run, dt: number): void {
    if (run.hintTimer >= 0) {
      run.hintTimer -= dt;
      if (run.hintTimer < 0 && run.hintText) {
        this.ui.hint(run.hintText);
        run.hintUntil = HINT_DURATION;
      }
    }
    if (run.hintUntil >= 0) {
      run.hintUntil -= dt;
      if (run.hintUntil < 0) this.ui.hint(null);
    }
    if (run.toastTimer >= 0) {
      run.toastTimer -= dt;
      if (run.toastTimer < 0 && run.toastText) { this.ui.toast(run.toastText); run.toastText = null; }
    }
    if (run.guideTimer >= 0) {
      run.guideTimer -= dt;
      if (run.guideTimer < 0) this.spawnGuide(run);
    }
    // The split chip: pushed on the frame after the checkpoint, gone SPLIT_SECONDS later.
    if (run.split?.dirty) {
      run.split.dirty = false;
      this.ui.split?.(run.split.text, run.split.sign);
    }
    if (run.splitTimer >= 0) {
      run.splitTimer -= dt;
      if (run.splitTimer < 0) { run.split = null; this.ui.split?.(null); }
    }
  }

  /** The clear / game-over countdown; runs whether or not the play screen is up. A pending 층 돌파 card comes before the result. */
  private resultTick(run: Run, dt: number): void {
    if (run.resultTimer < 0) return;
    run.resultTimer -= dt;
    if (run.resultTimer >= 0) return;
    if (run.tierCard) this.showTierCard(run);
    else this.showResult(run);
  }

  /**
   * The one-time 층 돌파 card (P3-9): the fanfare, then the UI's vista card;
   * the result follows TIER_RESULT_GAP after the card ends or is skipped. A
   * UI without the card goes straight to the result.
   */
  private showTierCard(run: Run): void {
    run.resultTimer = -1;
    const card = run.tierCard;
    run.tierCard = null;
    if (!card || !this.ui.tierBreak) { this.showResult(run); return; }
    this.audio.stinger?.('tier');
    this.ui.tierBreak(card, () => {
      if (this.run === run && !run.resultShown && run.resultTimer < 0) run.resultTimer = TIER_RESULT_GAP;
    });
  }

  /**
   * Ceremonies (P3-9) a story clear earns, decided once its record is written:
   * the tier's 층 돌파 card the first time every zone of the tier is done, and
   * the ending the first time every zone of the tower is — recorded in
   * Progress.tiersBroken / endingSeen so neither plays twice. A locked race
   * (no record) earns nothing; the ending outranks the last tier's card.
   */
  private planCeremonies(run: Run, s: RunSummary): void {
    if (run.mode !== 'story' || run.raceLocked || !s.cleared) return;
    const p = this.save.progress;
    let changed = false;
    if (!p.endingSeen && towerComplete(this.levels, p)) {
      p.endingSeen = true;
      run.ending = true;
      changed = true;
    }
    const broken = p.tiersBroken ?? [];
    if (!broken.includes(run.def.biome) && tierComplete(this.levels, p, run.def.biome)) {
      p.tiersBroken = [...broken, run.def.biome];
      if (!run.ending) run.tierCard = tierCardView(run.def.biome);
      changed = true;
    }
    if (changed) this.save.saveProgress();
  }

  /**
   * Add the bundled guide echo: a second Sim fed the recorded masks from its
   * own tick 0, so it sets off from the spawn point GUIDE_DELAY seconds after
   * the player did. Silent, never recorded, never submitted.
   */
  private spawnGuide(run: Run): void {
    if (run.guide || run.sim.finished) return;
    const masks = guideFor(run.def, run.seed);
    if (!masks) return;
    const echo = new Echo(run.def, masks, run.seed, false, GUIDE_COLOR, GUIDE_LABEL);
    run.guide = echo;
    run.echoes.push(echo);
  }

  /** The player reached a checkpoint: the guide has done its job. */
  private dropGuide(run: Run): void {
    run.guideTimer = -1;
    if (!run.guide) return;
    run.echoes = run.echoes.filter((e) => e !== run.guide);
    run.guide = null;
  }

  private threat(run: Run): number {
    const p = run.sim.state.player;
    let threat = 0;
    for (const f of run.sim.state.foes) {
      if (f.dead) continue;
      const d = Math.hypot(f.x - p.x, f.y - p.y);
      if (d < THREAT_RANGE) threat = Math.max(threat, 1 - d / THREAT_RANGE);
    }
    return threat;
  }

  private setMuffle(on: boolean): void {
    if (on === this.muffled) return;
    this.muffled = on;
    this.audio.setMuffle?.(on);
  }

  hudState(run: Run): HudState {
    const st = run.sim.state;
    const p = st.player;
    const s = this.save.settings;
    const biomeId = run.def.tide ? bandBiome(run.def, Math.floor((p.y + p.h - 1) / TILE)) : run.def.biome;
    return {
      hp: p.hp, maxHp: PHYS.maxHp,
      shards: st.stats.shards, totalShards: run.sim.level.totalShards,
      relics: st.stats.relics, totalRelics: run.sim.level.totalRelics,
      time: st.time,
      showTimer: s.showTimer,
      levelName: run.def.name,
      biomeName: BIOMES[biomeId].kr,
      height: st.tide ? Math.floor(st.tide.maxHeight) : undefined,
      combo: st.stats.combo,
      dashReady: p.dashReady,
      assist: run.sim.assist,
    };
  }

  // ================================================================ capture-harness helpers
  /** Drop the player at world feet position (x, y) and make it the respawn point. */
  teleport(x: number, y: number): void {
    const run = this.run;
    if (!run) return;
    const p: PlayerState = run.sim.state.player;
    p.x = x - p.w / 2;
    p.y = y - p.h;
    p.vx = 0; p.vy = 0;
    run.sim.state.respawn = { x, y };
    this.camera.reset(p);
  }

  /** Converge the camera on the player without animating (single-frame captures). */
  settleCamera(): void {
    const run = this.run;
    if (!run) return;
    this.camera.reset(run.sim.state.player);
    for (let i = 0; i < 90; i++) {
      this.camera.update(1 / 60, run.sim.state.player, run.sim.level, this.renderer.viewW, this.renderer.viewH, this.fx.zoom);
    }
  }

  // ================================================================ sim events
  private onSimEvent(run: Run, ev: SimEvent): void {
    switch (ev.type) {
      case 'shard':
        if (ev.total > 0 && ev.n === ev.total) this.ui.toast('파편 전부 회수');
        break;
      case 'relic': this.ui.toast('유물 발견'); break;
      case 'checkpoint':
        this.ui.toast('기록 지점');
        // The guide leaves once the player reaches the checkpoint it demonstrates
        // up to (t1: tile 49, past the first lethal pit) — not at C32 before it.
        if (ev.x >= guideDropX(run.def) - 1) this.dropGuide(run);
        run.segDeaths.pit = 0;
        run.segDeaths.hazard = 0;
        this.onCheckpoint(run, ev.x, ev.y);
        break;
      case 'death': {
        const line = deathLine(ev.cause);
        if (line && run.mode === 'story') this.ui.toast(line);
        this.rehint(run, ev.cause);
        this.countDeath(run);
        this.markDeath(run, ev.x, ev.y);
        run.deathAt = run.t;
        // Tile coordinates only: the death heat-map needs nothing finer.
        this.telemetry?.track('death', {
          levelId: run.def.id, cause: ev.cause, tx: Math.floor(ev.x / TILE), ty: Math.floor(ev.y / TILE), checkpointIdx: run.checkpoints,
        });
        break;
      }
      case 'respawn':
        this.telemetry?.track('respawn', {
          levelId: run.def.id, ...(run.deathAt >= 0 ? { ms: Math.max(0, Math.round((run.t - run.deathAt) * 1000)) } : {}),
        });
        run.deathAt = -1;
        break;
      case 'goal': this.finish(run, ev.summary, 'clear'); break;
      case 'tideOver': this.finish(run, ev.summary, 'over'); break;
      default: break;
    }
  }

  // ================================================================ splits · segments · death marks (P2-4)
  /** The echo the live splits are read against: the raced friend first, then the world echo (라이벌 / 1위 / 목표), else the self echo. */
  private splitEchoOf(run: Run): Echo | null {
    return run.raceEcho ?? run.worldEcho ?? run.selfEcho;
  }

  /**
   * The player reached a checkpoint: remember the tick (for the echo's later
   * arrival), close the segment for the segment best, and show the split
   * against the echo — '—' while the echo has not been here yet.
   */
  private onCheckpoint(run: Run, x: number, y: number): void {
    const tick = run.sim.state.tick;
    run.cpTicks.set(checkpointKey(x, y), tick);
    this.recordSegment(run, run.checkpoints, tick - run.segStart);
    run.segStart = tick;
    run.checkpoints++;
    const echo = this.splitEchoOf(run);
    if (echo) {
      const et = echo.checkpointTick(x, y);
      this.showSplit(run, et === null ? { text: SPLIT_NONE, sign: 0 } : fmtSplit(tick - et));
    }
    this.pushSegments(run);
  }

  /** The split echo reached a pillar the player passed earlier: the player was ahead by this much. */
  private onEchoCheckpoint(run: Run, echo: Echo, x: number, y: number): void {
    const mine = run.cpTicks.get(checkpointKey(x, y));
    if (mine === undefined) return;   // the echo leads here; the split shows when the player arrives
    const et = echo.checkpointTick(x, y);
    if (et === null) return;
    this.showSplit(run, fmtSplit(mine - et));
  }

  private showSplit(run: Run, s: { text: string; sign: SplitSign }): void {
    run.split = { text: s.text, sign: s.sign, dirty: true };
    run.splitTimer = SPLIT_SECONDS;
  }

  /** A story segment's time (ticks, deaths included) goes to the install's segment bests — never from assist / invincible runs or a locked race. */
  private recordSegment(run: Run, idx: number, ticks: number): void {
    if (run.mode !== 'story' || !run.echoSafe || run.raceLocked || ticks <= 0) return;
    const rec = this.save.levelRecord(run.def.id);
    if (recordSegmentBest(rec, idx, ticks)) this.save.saveProgress();
  }

  /** Pause-screen rows: one per checkpoint segment of the level (capped), with the session's deaths and the install's bests. */
  segmentRows(run: Run): SegmentRow[] {
    let checkpoints = 0;
    for (const e of run.sim.state.entities) if (e.kind === 'checkpoint') checkpoints++;
    const n = Math.min(MAX_SEGMENT_ROWS, checkpoints + 1);
    const rec = run.mode === 'story' ? this.save.progress.levels[run.def.id] : undefined;
    const bests = rec ? segmentBests(rec) : [];
    const current = Math.min(run.checkpoints, n - 1);
    const rows: SegmentRow[] = [];
    for (let i = 0; i < n; i++) {
      const best = bests[i] ?? 0;
      rows.push({ idx: i, deaths: run.session.segDeaths[i] ?? 0, best: best > 0 ? best : null, current: i === current });
    }
    return rows;
  }

  private pushSegments(run: Run): void {
    this.ui.segments?.(this.segmentRows(run));
  }

  /**
   * A death leaves an X mark for the rest of the zone session (the last
   * DEATH_MARKS_MAX) and counts against the current segment. A pit death is
   * marked at the level's floor line so it stays in view.
   */
  private markDeath(run: Run, x: number, y: number): void {
    const s = run.session;
    const floor = run.sim.level.pxH - TILE / 2;
    s.marks.push({ x, y: Math.min(y, floor) });
    while (s.marks.length > DEATH_MARKS_MAX) s.marks.shift();
    s.segDeaths[run.checkpoints] = (s.segDeaths[run.checkpoints] ?? 0) + 1;
    this.renderer.setDeathMarks?.(s.marks.slice());
    this.pushSegments(run);
  }

  /**
   * Repeated deaths of one kind in a checkpoint segment bring the matching
   * hint back: two pits → the double jump, two spikes / saws → the dash. Same
   * delay and lifetime as the zone hint.
   */
  private rehint(run: Run, cause: string): void {
    const kind = cause === 'pit' ? 'pit' : cause === 'spike' || cause === 'saw' ? 'hazard' : null;
    if (!kind) return;
    run.segDeaths[kind]++;
    if (run.segDeaths[kind] !== REHINT_DEATHS) return;
    run.hintText = kind === 'pit' ? REHINT_PIT : REHINT_HAZARD;
    run.hintTimer = HINT_DELAY;
  }

  private finish(run: Run, summary: RunSummary, kind: 'clear' | 'over'): void {
    if (run.summary) return;
    run.summary = summary;
    run.resultKind = kind;
    run.resultTimer = kind === 'clear' ? RESULT_DELAY : OVER_DELAY;
    this.ui.hint(null);
    this.dropGuide(run);
    // The last segment ends at the goal.
    if (kind === 'clear') {
      this.recordSegment(run, run.checkpoints, run.sim.state.tick - run.segStart);
      this.pushSegments(run);
    }
    if (kind === 'clear') {
      this.telemetry?.track(run.mode === 'daily' ? 'daily_clear' : 'clear', {
        levelId: run.def.id, mode: run.mode, ticks: summary.ticks, deaths: summary.deaths, shards: summary.shards,
      });
      // The first story clear is when the save becomes worth keeping: ask the browser to keep it.
      if (run.mode === 'story') this.requestPersist();
    } else if (run.mode === 'daily') {
      this.telemetry?.track('daily_over', { levelId: run.def.id, height: Math.floor(summary.height), deaths: summary.deaths, ticks: summary.ticks });
    }
    const encoded = run.echoSafe ? encodeMasks(run.masks.bytes()) : null;
    run.encoded = encoded;
    if (encoded && encoded.length > MAX_MASKS_B64) run.eligible = false;
    const openBefore = this.unlockedZones();
    // A locked zone raced through a link leaves no trace: no record, no totals, nothing opens.
    const personalBest = run.raceLocked ? false : this.recordProgress(run, summary, encoded);
    // Skins the record now grants (P3-6): announced over the clear animation, before the result lands.
    if (run.mode === 'story' && !run.raceLocked) this.unlockSkins(true);
    const justUnlocked = new Set<string>();
    for (const id of this.unlockedZones()) if (!openBefore.has(id)) justUnlocked.add(id);
    const i = this.levels.findIndex((l) => l.id === run.def.id);
    // A locked race offers no 다음 구역: the tower is still to be climbed.
    const nextLevelId = run.mode === 'story' && !run.raceLocked && i >= 0 && i + 1 < this.levels.length ? this.levels[i + 1].id : undefined;
    run.view = {
      summary,
      levelName: run.def.name,
      personalBest,
      stars: starsFor(summary),
      submit: { state: run.eligible ? 'pending' : 'idle' },
      nextLevelId,
      ...(nextLevelId && justUnlocked.has(nextLevelId) ? { unlocked: { levelId: nextLevelId, name: this.levelById[nextLevelId].name } } : {}),
    };
    this.planCeremonies(run, summary);
    this.ui.refreshSelect(this.save.progress, this.levels, justUnlocked);
    if (run.eligible && encoded) {
      // The first eligible record of an install still carrying the default name
      // waits for the inline name prompt on the result screen (see showResult).
      if (this.needsNamePrompt()) run.pendingSubmit = encoded;
      else void this.track(this.submit(run, encoded));
    }
  }

  /** The default name would go on a board: ask once per install, before the first eligible submission. */
  private needsNamePrompt(): boolean {
    const p = this.save.progress;
    return p.player.name === DEFAULT_NAME && !p.seen[NAME_ASKED_KEY];
  }

  /**
   * Inline name onboarding: after the rank animation the result screen asks
   * for a name; a confirmed one is saved and used in the body, 건너뛰기 stores
   * the default plus four hex digits of the player id's hash. Then the run is
   * submitted as usual. A UI without the prompt is a skip.
   */
  private async promptNameThenSubmit(run: Run, encoded: string): Promise<void> {
    const p = this.save.progress;
    p.seen[NAME_ASKED_KEY] = true;
    this.save.saveProgress();
    let name: string | null = null;
    try {
      name = this.ui.askNameInline ? await this.ui.askNameInline() : null;
    } catch { name = null; }
    const trimmed = typeof name === 'string' ? name.trim() : '';
    p.player.name = isValidName(trimmed) && trimmed !== DEFAULT_NAME ? trimmed : fallbackName(p.player.id);
    // The title chip picks the name up on the next refreshSelect (every way back to the menus passes one).
    this.save.saveProgress();
    await this.submit(run, encoded);
  }

  /** Update progress from a finished run; returns whether it was a personal best. */
  private recordProgress(run: Run, s: RunSummary, encoded: string | null): boolean {
    const prog = this.save.progress;
    let pb = false;
    if (run.mode === 'story') {
      const rec = this.save.levelRecord(run.def.id);
      if (s.cleared) {
        rec.done = true;
        pb = rec.bestTicks === 0 || s.ticks < rec.bestTicks;
        if (pb) {
          rec.bestTicks = s.ticks;
          if (encoded) markEcho(rec, encoded);
          else { delete rec.masks; delete rec.runId; }
          // The world rank described the previous best: the submission / the board says the new one.
          clearWorldRank(rec);
        }
        rec.stars = Math.max(rec.stars, starsFor(s));
        // Medals (P3-6): earned ones are never lost; the new ones pop on the result screen.
        const earned = medalsFor(s);
        run.newMedals = newMedals(rec.medals, earned);
        const medals = mergeMedals(rec.medals, earned);
        if (medals.length) rec.medals = medals;
        recordBestRank(rec, s.rank);
      }
      run.comboRecord = recordBestCombo(rec, run.sim.state.stats.bestCombo);
      rec.bestShards = Math.max(rec.bestShards, s.shards);
      rec.relics = Math.max(rec.relics, s.relics);
      rec.deaths += s.deaths;
    } else if (run.mode === 'daily' && run.daily) {
      // Heights are kept as whole tiles (what the player reads); a floored
      // height of 0 can never beat the stored 0, so a sub-tile climb is no record.
      const h = Math.floor(s.height);
      const rec = this.save.dailyRecord(run.daily.date, run.daily.seed);
      const better = s.cleared
        ? !rec.cleared || rec.bestTicks === 0 || s.ticks < rec.bestTicks
        : !rec.cleared && h > Math.floor(rec.height);
      if (better) {
        pb = true;
        if (s.cleared) { rec.cleared = true; rec.bestTicks = s.ticks; }
        if (encoded) markEcho(rec, encoded);
        else { delete rec.masks; delete rec.runId; }
        rec.seed = run.daily.seed;
      }
      rec.height = Math.max(Math.floor(rec.height), h);
    } else {
      const h = Math.floor(s.height);
      const e = prog.endless;
      pb = h > Math.floor(e.bestHeight);
      e.bestHeight = Math.max(Math.floor(e.bestHeight), h);
      e.bestShards = Math.max(e.bestShards, s.shards);
      // The best climb's replay rides along with its seed: 같은 탑 다시 runs it as the self echo.
      if (pb) {
        if (encoded && encoded.length <= MAX_MASKS_B64) { e.bestMasks = encoded; e.bestSeed = run.seed; e.bestSim = SIM_VERSION; e.bestGen = GEN_VERSION; }
        else { delete e.bestMasks; delete e.bestSeed; delete e.bestSim; delete e.bestGen; }
      }
    }
    prog.totals.shards += s.shards;
    prog.totals.deaths += s.deaths;
    this.save.saveProgress();
    return pb;
  }

  private showResult(run: Run): void {
    run.resultTimer = -1;
    run.resultShown = true;
    if (!run.view || !run.summary) return;
    if (run.resultKind === 'clear' && run.ending && this.ui.showEnding) {
      // The ending stands in for the last zone's result (P3-9): the tower's totals, the three lines, this clear's submission line.
      this.ui.installCard?.(false);
      this.ui.showEnding(endingView(this.save.progress, this.levels, run.view));
      this.audio.stinger?.('ending');
      this.audio.setTrack(ENDING_TRACK);
    } else if (run.resultKind === 'clear') {
      // "<친구>보다 / 라이벌보다 0.62s 빠름": our play ticks against the raced echo's (both the board's score).
      const r = run.rival;
      this.ui.setVersus?.(this.raceVersus(run) ?? (r && run.summary.cleared
        ? { label: r.kind === 'top' ? TOP_LABEL : RIVAL_LABEL, deltaTicks: run.summary.ticks - r.ticks }
        : null));
      // The medals this clear added and its longest combo (P3-6); a locked race recorded nothing.
      this.ui.setClearExtras?.(run.raceLocked ? null : {
        newMedals: run.newMedals.slice(), combo: run.sim.state.stats.bestCombo, comboRecord: run.comboRecord,
      });
      this.ui.installCard?.(this.installCardAllowed(run));
      this.ui.showResult(run.view);
    } else {
      this.ui.installCard?.(false);
      this.ui.showOver(run.summary, run.prevBestHeight, {
        sameTowerAvailable: run.mode === 'endless',
        ...(run.mode === 'daily' ? { worldBest: this.worldBestFor(run) } : {}),
      });
      if (run.view.submit.state !== 'idle') this.ui.updateResult(run.view);
    }
    this.telemetry?.track('result_shown', { levelId: run.def.id, kind: run.resultKind ?? 'clear', mode: run.mode });
    const pending = run.pendingSubmit;
    if (pending) {
      run.pendingSubmit = null;
      void this.track(this.promptNameThenSubmit(run, pending));
    }
    this.settleRunEnd(run);
  }

  /** The top of the daily board this run was climbed on, in whole tiles — the "세계 최고" of the game-over screen. */
  private worldBestFor(run: Run): number | undefined {
    const board = run.daily?.date;
    if (!board) return undefined;
    const lb = this.dailyLb?.board === board ? this.dailyLb : this.yesterday?.date === board ? this.yesterday.lb : null;
    let best = -1;
    for (const e of lb?.entries ?? []) best = Math.max(best, Math.floor(e.height));
    if (lb?.yours) best = Math.max(best, Math.floor(lb.yours.height));
    return best >= 0 ? best : undefined;
  }

  private pushResult(run: Run): void {
    if (this.run === run && run.resultShown && run.view) this.ui.updateResult(run.view);
    this.settleRunEnd(run);
  }

  /** The server's verdict on a submission, for the funnel; a 'sim-version' refusal also means this bundle is behind. */
  private trackVerdict(run: Pick<Run, 'mode' | 'def'>, res: { accepted: true } | { accepted: false; reason: string }): void {
    const mode = run.mode === 'daily' ? 'daily' : 'story';
    this.telemetry?.track('submit_result', {
      accepted: res.accepted, mode, levelId: run.def.id, ...(res.accepted ? {} : { reason: res.reason }),
    });
    if (!res.accepted && res.reason === 'sim-version') this.serverNewer(null);
  }

  // ================================================================ submission
  private async submit(run: Run, encoded: string): Promise<void> {
    const s = run.summary!;
    const view = run.view!;
    const player = { ...this.save.progress.player };
    const mode: RunSubmit['mode'] = run.mode === 'daily' ? 'daily' : 'story';
    const board = mode === 'daily' ? run.daily!.date : run.def.id;
    const body: RunSubmit = {
      player,
      mode,
      levelId: run.def.id,
      ...(mode === 'daily' ? { date: run.daily!.date, seed: run.daily!.seed } : {}),
      assist: false,
      // The versions this replay was recorded under; the server refuses a mismatch before replaying.
      sim: SIM_VERSION,
      gen: GEN_VERSION,
      masks: encoded,
      claim: { ticks: s.ticks, shards: s.shards, deaths: s.deaths, cleared: s.cleared, height: s.height },
      client: { build: this.build },
    };
    let reachable = true;
    try {
      const res = await this.api.submitRun(body);
      if (res.accepted) {
        // The immediate rank is the submission's own answer: the public board page may lag it by a few seconds.
        view.submit = { state: 'accepted', rank: res.rank, total: res.total };
        run.acceptedRunId = res.runId;
        this.storeRunId(run, res.runId, encoded);
        if (mode === 'daily') this.storeDailyRank(board, res.rank);
        else this.storeStoryRank(run.def.id, res.rank, encoded);
        this.trackVerdict(run, { accepted: true });
      } else {
        view.submit = { state: 'rejected', reason: res.reason };
        this.trackVerdict(run, { accepted: false, reason: res.reason });
      }
    } catch (err) {
      const e = err instanceof ApiError ? err : null;
      // 503 busy (the verification pool is full) / 429: the server is up but wants a retry — queued, resent after Retry-After.
      const retryable = e !== null && e.retryable;
      const offline = e === null || e.offline;
      reachable = false;
      if (e && !offline && !retryable) {
        reachable = true;
        view.submit = { state: 'rejected', reason: e.reason };
        this.trackVerdict(run, { accepted: false, reason: e.reason });
      } else if (this.queue) {
        // Kept locally and sent on the next boot / `online` (or the retry timer); the result line says which.
        this.queue.enqueue(body, { mode, board, levelId: run.def.id });
        view.submit = retryable ? { state: 'queued', reason: 'busy' } : { state: 'queued' };
        if (retryable) this.queue.retryLater(this.api, (ev) => this.onQueued(ev), e?.retryAfter);
      } else view.submit = { state: 'offline' };
    }
    this.pushResult(run);
    if (!reachable) return;
    try {
      // The public top page (edge-cached, no player id) plus our own row from /api/me.
      view.leaderboard = await this.boardWithMe(mode, board, 20);
      if (mode === 'daily') this.adoptDailyBoard(board, view.leaderboard);
      else if (view.leaderboard.yours) this.storeStoryRank(run.def.id, view.leaderboard.yours.rank, encoded);
    } catch { /* the board is decoration */ }
    this.pushResult(run);
  }

  // ================================================================ personal rows (P3-12 / P3-6)
  /** Our own row on a board (GET /api/me, never cached), or null when the API has no such call or it failed. */
  private async myRow(mode: Mode, board: string): Promise<MeResponse | null> {
    if (!this.api.me) return null;
    try { return await this.api.me({ mode, board, limit: 1, playerId: this.save.progress.player.id }); } catch { return null; }
  }

  /**
   * A public board page plus our own row: /api/leaderboard is shared between
   * viewers at the edge and carries nothing personal, so `yours` (and the `you`
   * flag on the matching entry) come from /api/me. Rejects only when the page
   * itself failed; a missing personal row leaves the page as it came.
   */
  private async boardWithMe(mode: Mode, board: string, limit: number): Promise<LeaderboardResponse> {
    const [lb, me] = await Promise.all([this.api.leaderboard({ mode, board, limit }), this.myRow(mode, board)]);
    return withPersonalRow(lb, me);
  }

  /**
   * Remember the world rank of a story zone's best (the card's 세계 N위): from an
   * accepted submission or a board row. `encoded` names the run the rank is
   * about; it must still be the record's best. The cards repaint on a change.
   */
  private storeStoryRank(levelId: string, rank: number, encoded?: string): void {
    const rec = this.save.progress.levels[levelId];
    if (!rec || !(rank >= 1)) return;
    if (encoded !== undefined && rec.masks !== encoded) return;
    if (!setWorldRank(rec, rank)) return;
    this.save.saveProgress();
    this.ui.refreshSelect(this.save.progress, this.levels);
  }

  /**
   * The select screen's 세계 N위 badges (P3-6): for every zone whose best was
   * submitted, at most once per RANK_REFRESH_MS, read the public top page
   * first (our run id sits in it when we are that high — one cached request)
   * and ask /api/me only when it does not. Failures keep the last known rank.
   */
  async refreshWorldRanks(): Promise<void> {
    const now = this.now();
    const jobs: Promise<void>[] = [];
    for (const lv of this.levels) {
      const rec = this.save.progress.levels[lv.id];
      if (!rec?.runId) continue;
      const last = this.rankRefreshedAt.get(lv.id);
      if (last !== undefined && now - last < RANK_REFRESH_MS) continue;
      this.rankRefreshedAt.set(lv.id, now);
      jobs.push(this.refreshWorldRank(lv.id, rec.runId));
    }
    if (jobs.length) await Promise.allSettled(jobs);
  }

  private async refreshWorldRank(levelId: string, runId: string): Promise<void> {
    try {
      const lb = await this.api.leaderboard({ mode: 'story', board: levelId, limit: RANK_TOP_LIMIT });
      const hit = lb.entries.find((e) => e.runId === runId);
      if (hit) { this.storeStoryRank(levelId, hit.rank); return; }
      const me = await this.myRow('story', levelId);
      if (me?.yours) this.storeStoryRank(levelId, me.yours.rank);
    } catch {
      // The badge keeps what it knew; the throttle lets the next select visit try again after RANK_REFRESH_MS.
    }
  }

  // ================================================================ skin unlocks (P3-6)
  /**
   * Record every skin the rules grant to this save; the new ones are announced
   * (toast + unlock sound) when `announce` is set — after a clear, never at boot.
   * The UI's skin picker follows on the next refreshSelect.
   */
  private unlockSkins(announce: boolean): void {
    const fresh = syncUnlockedSkins(this.save.progress, this.levels);
    if (!fresh.length) return;
    this.save.saveProgress();
    if (!announce) return;
    const names = fresh.map((id) => this.renderer.skins[id]?.kr ?? id);
    this.ui.toast(`새 캐릭터 해금 · ${names.join(' · ')}`);
    this.audio.ui('unlock');
  }

  /**
   * A daily board just arrived: it is today's (the daily screen's board),
   * yesterday's (the 어제의 탑 row), and our rank on it is remembered on the
   * record for the 7-day strip.
   */
  private adoptDailyBoard(board: string, lb: LeaderboardResponse): void {
    if (this.daily?.date === board) {
      this.dailyLb = lb;
      this.ui.setDaily(this.daily, lb, 'ok');
    }
    if (this.yesterday?.date === board) {
      this.yesterday = { ...this.yesterday, lb };
      this.ui.setYesterday?.(this.yesterday);
    }
    if (lb.yours) this.storeDailyRank(board, lb.yours.rank);
  }

  /** Remember the world rank of our best on a daily board (the strip's number); the record must exist. */
  private storeDailyRank(board: string, rank: number): void {
    const rec = this.save.progress.daily[board];
    if (!rec || !(rank >= 1)) return;
    if (rec.rank === rank) return;
    rec.rank = rank;
    this.save.saveProgress();
    this.ui.refreshSelect(this.save.progress, this.levels);
  }

  /** Remember the server id of the accepted run when it is still the local best. */
  private storeRunId(run: Run, runId: string, encoded: string): void {
    if (run.mode === 'story') {
      const rec = this.save.levelRecord(run.def.id);
      if (rec.masks === encoded) rec.runId = runId;
    } else if (run.mode === 'daily' && run.daily) {
      const rec = this.save.dailyRecord(run.daily.date, run.daily.seed);
      if (rec.masks === encoded) rec.runId = runId;
    }
    this.save.saveProgress();
  }

  // ================================================================ offline queue
  /**
   * Send every queued run (boot, and the window `online` event). Resolves with
   * the pass summary, or null when there is no queue or nothing waiting.
   */
  flushQueue(): Promise<FlushResult | null> {
    const q = this.queue;
    if (!q || q.size() === 0) return Promise.resolve(null);
    return this.track(q.flush(this.api, (ev) => this.onQueued(ev)));
  }

  private onQueued(ev: FlushEvent): void {
    if (ev.kind !== 'sent') return;
    const { item, response } = ev;
    if (response.accepted) {
      this.adoptRunId(item, response.runId);
      if (item.mode === 'story') this.storeStoryRank(item.levelId, response.rank, item.body.masks);
      else this.storeDailyRank(item.board, response.rank);
    }
    this.trackVerdict({ mode: item.mode, def: { id: item.levelId } as LevelDef },
      response.accepted ? { accepted: true } : { accepted: false, reason: response.reason });
    // The result screen of the run that was just queued is still up: settle its line.
    const run = this.run;
    if (run?.view && run.view.submit.state === 'queued' && run.encoded === item.body.masks) {
      run.view.submit = response.accepted
        ? { state: 'accepted', rank: response.rank, total: response.total }
        : { state: 'rejected', reason: response.reason };
      if (response.accepted) run.acceptedRunId = response.runId;
      this.pushResult(run);
    }
  }

  /** A queued run was accepted later: attach its server id to the record it still is the best of. */
  private adoptRunId(item: QueuedRun, runId: string): void {
    const prog = this.save.progress;
    const rec = item.mode === 'story' ? prog.levels[item.levelId] : prog.daily[item.board];
    if (!rec || rec.masks !== item.body.masks) return;
    rec.runId = runId;
    this.save.saveProgress();
  }

  // ================================================================ echoes
  private async loadEchoes(run: Run): Promise<void> {
    const s = this.save.settings;
    const prog = this.save.progress;
    if (s.echoSelf) {
      // Endless: the best climb's replay only fits the tower it was climbed on (같은 탑 다시).
      const e = prog.endless;
      const rec = run.mode === 'story' ? prog.levels[run.def.id]
        : run.mode === 'daily' && run.daily ? prog.daily[run.daily.date]
          : e.bestSeed === run.seed && (e.bestGen ?? 0) === GEN_VERSION ? { masks: e.bestMasks, sim: e.bestSim } : undefined;
      // Only a replay recorded by this SIM_VERSION reproduces on this sim (older masks are dropped).
      const masks = echoMasks(rec);
      if (masks) {
        try {
          const echo = new Echo(run.def, decodeMasks(masks), run.seed, false, C.echoSelf, '나');
          echo.syncTo(run.sim.state.tick);
          run.echoes.push(echo);
          run.selfEcho = echo;
        } catch { /* a corrupt local replay is simply not shown */ }
      }
    }
    if (!s.echoWorld || run.mode === 'endless') return;
    // A race link's friend is the rival of this run: the board's echo stays away.
    if (run.race) return;
    // No world echo to show (empty board, offline, API error): the bundled goal run stands in as '목표'.
    const goal = (): void => {
      if (this.run !== run || run.echoes.some((e) => e.label === GOAL_LABEL)) return;
      const echo = goalEchoFor(run.def);
      if (!echo) return;
      echo.syncTo(run.sim.state.tick);
      run.echoes.push(echo);
      run.worldEcho ??= echo;
    };
    if (run.offline) { goal(); return; }
    const mode = run.mode === 'daily' ? 'daily' : 'story';
    const board = run.mode === 'daily' ? run.daily!.date : run.def.id;
    try {
      // The whole top 50 (public, edge-cached) with our own row from /api/me flagged
      // `you` / `yours` (entries never carry a raw player id, only an opaque tag):
      // the 라이벌 is the entry ranked just above ours, the 1위 the leader — see echo/rival.ts.
      const lb = await this.boardWithMe(mode, board, 50);
      if (this.run !== run) return;
      if (lb.entries.length === 0) { goal(); return; }
      const pick = pickWorldEcho(lb, echoWorldMode(s));
      // Only our own row qualifies: it is already running as the self echo.
      if (!pick) return;
      const g = await this.api.ghost(pick.entry.runId);
      if (this.run !== run) return;
      if (g.levelId !== run.def.id || (run.mode === 'daily' && g.seed !== run.daily!.seed)) { goal(); return; }
      const name = g.name || pick.entry.name;
      const echo = new Echo(run.def, decodeMasks(g.masks), g.seed, g.assist, C.echoWorld, worldEchoLabel(pick.kind, name));
      echo.syncTo(run.sim.state.tick);
      run.echoes.push(echo);
      run.worldEcho = echo;
      // A cleared entry is a time to beat on the result screen; a daily height-only row is not.
      if (pick.entry.cleared) run.rival = { kind: pick.kind, name, ticks: g.ticks > 0 ? g.ticks : pick.entry.ticks };
    } catch { goal(); }
  }

  // ================================================================ daily screen
  async openDaily(): Promise<void> {
    this.ui.setDaily(this.daily, this.dailyLb, 'loading');
    try {
      this.daily = await this.api.daily();
      this.save.cacheDaily(this.daily);
      // A newer sim / generator on the server: offer the update now, not after a climb the server would refuse.
      if (!dailyVersionOk(this.daily)) this.serverNewer(this.daily.sim ?? null);
    } catch {
      // Offline: today's seed seen earlier (this session or a cached one) still
      // starts a real daily — the seed is the server's, so the run stays
      // eligible and queues. Without one the screen says the seed is missing.
      const now = this.now();
      if (!this.daily || Date.parse(this.daily.expiresAt) < now) {
        const cached = this.save.cachedDaily(utcDateStr(now));
        this.daily = cached && Date.parse(cached.expiresAt) > now ? cached : null;
        if (this.daily === null) this.dailyLb = null;
      }
      this.ui.setDaily(this.daily, this.dailyLb, 'error');
      return;
    }
    this.ui.setDaily(this.daily, this.dailyLb, 'loading');
    await Promise.all([this.refreshDailyBoard(), this.loadYesterday()]);
  }

  async refreshDailyBoard(): Promise<void> {
    const d = this.daily;
    if (!d) return;
    try {
      const lb = await this.boardWithMe('daily', d.date, 20);
      if (this.daily !== d) return;
      this.dailyLb = lb;
      this.ui.setDaily(d, lb, 'ok');
      if (lb.yours) this.storeDailyRank(d.date, lb.yours.rank);
    } catch {
      if (this.daily === d) this.ui.setDaily(d, this.dailyLb, 'error');
    }
  }

  /**
   * Yesterday's tower: its date and seed from the DailyResponse (fetched here
   * when the daily screen has not been opened yet), then its board with our
   * row. Once per UTC day — a second call for the same date is a no-op, so
   * boot and the daily screen may both ask.
   */
  async loadYesterday(): Promise<void> {
    const now = this.now();
    if (!this.daily || Date.parse(this.daily.expiresAt) < now) {
      try {
        this.daily = await this.api.daily();
        this.save.cacheDaily(this.daily);
      } catch { /* offline: yesterday's board cannot be read either */ }
    }
    const d = this.daily;
    const date = d?.yesterday?.date ?? utcDateStr(now - MS_PER_DAY);
    const prev = this.yesterday?.date === date ? this.yesterday : null;
    const info: YesterdayInfo = { date, seed: d?.yesterday?.seed ?? prev?.seed ?? null, lb: prev?.lb ?? null };
    this.yesterday = info;
    this.ui.setYesterday?.(info);
    if (info.lb) return;
    try {
      const lb = await this.boardWithMe('daily', date, 1);
      if (this.yesterday !== info) return;
      this.yesterday = { ...info, lb };
      this.ui.setYesterday?.(this.yesterday);
      if (lb.yours) this.storeDailyRank(date, lb.yours.rank);
    } catch { /* offline: the row stays at what the local record says */ }
  }
}

/**
 * A daily can only be climbed when this bundle reproduces the server's tower:
 * the sim and the generator versions must match (a pre-versioning server sends
 * neither and is trusted).
 */
export function dailyVersionOk(d: DailyResponse): boolean {
  if (typeof d.sim === 'number' && d.sim !== SIM_VERSION) return false;
  if (typeof d.gen === 'number' && d.gen !== GEN_VERSION) return false;
  return true;
}

/**
 * Korean line for a failed transfer call. The API client's status carries the
 * verdict: 410 = the code was used or expired, 400 / 404 = not a code, 413 =
 * the snapshot is too large, 429 = rate-limited; a network failure (status 0,
 * 5xx, or any non-ApiError) is '서버에 닿지 않는다'.
 */
export function transferErrorText(err: unknown, kind: 'export' | 'import'): string {
  if (err instanceof ApiError) {
    if (err.status === 410) return TRANSFER_KR.gone;
    if (err.status === 400 || err.status === 404) return kind === 'import' ? TRANSFER_KR.badCode : TRANSFER_KR.createFailed;
    if (err.status === 413) return TRANSFER_KR.tooBig;
    if (err.status === 429) return TRANSFER_KR.busyRate;
    if (err.offline) return TRANSFER_KR.offline;
    return kind === 'import' ? TRANSFER_KR.importFailed : TRANSFER_KR.createFailed;
  }
  return TRANSFER_KR.offline;
}

/** `location.origin` where there is one (the browser), '' in Node — race links are then relative. */
function defaultOrigin(): string {
  const loc = (globalThis as { location?: { origin?: string } }).location;
  return typeof loc?.origin === 'string' && loc.origin !== 'null' ? loc.origin : '';
}

/** `navigator.storage.persist` bound to its manager, or null where the platform has none (Node, old WebViews). */
function defaultPersistStorage(): (() => Promise<boolean> | boolean | void) | null {
  const nav = (globalThis as { navigator?: { storage?: { persist?: () => Promise<boolean> } } }).navigator;
  const sm = nav?.storage;
  if (!sm || typeof sm.persist !== 'function') return null;
  return () => sm.persist!();
}

/** 32 random bits for endless seeds, from the platform CSPRNG when available. */
function defaultRandomSeed(): number {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.getRandomValues === 'function') {
    const u = new Uint32Array(1);
    c.getRandomValues(u);
    return u[0] >>> 0;
  }
  return Math.floor(Math.random() * 0x1_0000_0000) >>> 0;
}
