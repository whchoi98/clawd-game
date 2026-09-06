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
import { MAX_MASKS_B64 } from '../shared/protocol.js';
import type { DailyResponse, LeaderboardResponse, RunSubmit } from '../shared/protocol.js';
import type {
  ApiPort, AudioPort, HudState, InputPort, Progress, RendererPort, ResultView, UIAction, UIPort,
} from './contracts.js';
import { MAX_FRAME_DT, TickScheduler } from './loop.js';
import { FxBus } from './fx.js';
import { Camera } from './camera.js';
import { Save, echoMasks, markEcho, retentionBuckets, utcDateStr } from './save.js';
import { cloneBinds } from './input/binds.js';
import { ApiError } from './net/api.js';
import type { FlushEvent, FlushResult, QueuedRun, SubmitQueue } from './net/queue.js';
import type { TelemetryData, TelemetryPort } from './net/telemetry.js';
import { Echo } from './echo/echo.js';
import { GUIDE_COLOR, GUIDE_DELAY, GUIDE_LABEL, guideFor } from './echo/guide.js';
import { REHINT_HAZARD, REHINT_PIT } from './ui/hints.js';

export type RunMode = 'story' | 'daily' | 'endless';

/** UIPort plus the optional extras the concrete UI offers. */
export interface ShellUI extends UIPort {
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
}
/** AudioPort plus the pause-menu muffle the concrete engine offers. */
export interface ShellAudio extends AudioPort {
  setMuffle?(on: boolean): void;
}

export interface ScenesDeps {
  renderer: RendererPort;
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
}

/** Seconds of clear animation before the result screen. */
export const RESULT_DELAY = 1.25;
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
  summary: RunSummary | null;
  view: ResultView | null;
  resultKind: 'clear' | 'over' | null;
  resultTimer: number;
  resultShown: boolean;
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

  private readonly renderer: RendererPort;
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
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly runEndListeners: (() => void)[] = [];

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
    this.fx = new FxBus({ random: deps.random });
    this.fx.applySettings(this.save.settings);
    this.ui.on((a) => this.onAction(a));
  }

  // ================================================================ boot
  /** Everything boot does, synchronously (tests and the capture harness). */
  bootSync(): void {
    this.applySettings();
    this.ui.setPortraitPainter((ctx, skin, size, t) => this.renderer.drawPortrait(ctx, skin, size, t));
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
    this.ui.refreshSelect(this.save.progress, this.levels);
    this.bootTelemetry();
    ui.boot?.(1, '준비 완료');
    await hooks.wait(240);
    this.showTitle();
    // Runs finished while offline last time go out now (never awaited: boot must not wait on the network).
    void this.flushQueue();
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
      case 'openSelect': this.ui.refreshSelect(this.save.progress, this.levels); break;
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
      default:
        break;
    }
  }

  // ================================================================ run lifecycle
  startLevel(id: string, opts: { restart?: boolean } = {}): boolean {
    const def = this.levelById[id];
    if (!def) return false;
    this.save.progress.lastLevel = id;
    this.save.saveProgress();
    this.beginRun(def, 'story', def.seed, null, !!opts.restart);
    return true;
  }

  startDaily(daily: DailyResponse, opts: { restart?: boolean; offline?: boolean } = {}): void {
    const def = this.makeDaily(daily.seed);
    this.daily = daily;
    this.beginRun(def, 'daily', daily.seed, { date: daily.date, seed: daily.seed }, !!opts.restart, !!opts.offline);
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
    const run: Run = {
      sim, def, mode, biome, seed, masks: new MaskLog(), daily, echoes: [],
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
      summary: null, view: null, resultKind: null, resultTimer: -1, resultShown: false,
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
    this.setMuffle(false);
    this.audio.setTrack(biome.track);
    this.audio.setIntensity(0.55);
    this.input.reset();
    this.ui.hint(null);
    this.ui.show('play');
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
    this.ui.hud(this.hudState(run));
    this.telemetry?.track(mode === 'daily' ? 'daily_start' : 'zone_start', { levelId: def.id, mode, restart });
    void this.track(this.loadEchoes(run));
  }

  /** Story zones open right now: the first one plus every zone whose predecessor is done (mirrors the select screen). */
  private unlockedZones(progress: Progress = this.save.progress): Set<string> {
    const open = new Set<string>();
    this.levels.forEach((lv, i) => {
      if (i === 0 || progress.levels[this.levels[i - 1].id]?.done) open.add(lv.id);
    });
    return open;
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
    else if (run.mode === 'daily' && run.daily) this.startDaily(this.dailyFor(run), { restart: true, offline: run.offline });
    else this.startEndless(run.seed);
  }

  private retryRun(): void {
    const run = this.run;
    if (!run) return;
    if (run.mode === 'story') this.startLevel(run.def.id, { restart: true });
    else if (run.mode === 'daily' && run.daily) this.startDaily(this.dailyFor(run), { restart: true, offline: run.offline });
    else this.startEndless();
  }

  private nextLevel(): void {
    const run = this.run;
    if (!run || run.mode !== 'story') { this.retryRun(); return; }
    // The very first clear returns to the tower: the eight cards, one newly lit, are the reward.
    if (run.firstEver && run.summary?.cleared) { this.quitToMenu(); return; }
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
    for (const e of run.echoes) e.step();
    const events = sim.drainEvents();
    for (const ev of events) {
      this.fx.onEvent(ev);
      this.renderer.onEvent(ev, sim);
      this.audio.onEvent(ev, sim);
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
  }

  /** The clear / game-over countdown; runs whether or not the play screen is up. */
  private resultTick(run: Run, dt: number): void {
    if (run.resultTimer < 0) return;
    run.resultTimer -= dt;
    if (run.resultTimer < 0) this.showResult(run);
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
        this.dropGuide(run);
        run.segDeaths.pit = 0;
        run.segDeaths.hazard = 0;
        run.checkpoints++;
        break;
      case 'death': {
        const line = deathLine(ev.cause);
        if (line && run.mode === 'story') this.ui.toast(line);
        this.rehint(run, ev.cause);
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
    if (kind === 'clear') {
      this.telemetry?.track(run.mode === 'daily' ? 'daily_clear' : 'clear', {
        levelId: run.def.id, mode: run.mode, ticks: summary.ticks, deaths: summary.deaths, shards: summary.shards,
      });
    } else if (run.mode === 'daily') {
      this.telemetry?.track('daily_over', { levelId: run.def.id, height: Math.floor(summary.height), deaths: summary.deaths, ticks: summary.ticks });
    }
    const encoded = run.echoSafe ? encodeMasks(run.masks.bytes()) : null;
    run.encoded = encoded;
    if (encoded && encoded.length > MAX_MASKS_B64) run.eligible = false;
    const openBefore = this.unlockedZones();
    const personalBest = this.recordProgress(run, summary, encoded);
    const justUnlocked = new Set<string>();
    for (const id of this.unlockedZones()) if (!openBefore.has(id)) justUnlocked.add(id);
    const i = this.levels.findIndex((l) => l.id === run.def.id);
    const nextLevelId = run.mode === 'story' && i >= 0 && i + 1 < this.levels.length ? this.levels[i + 1].id : undefined;
    run.view = {
      summary,
      levelName: run.def.name,
      personalBest,
      stars: starsFor(summary),
      submit: { state: run.eligible ? 'pending' : 'idle' },
      nextLevelId,
      ...(nextLevelId && justUnlocked.has(nextLevelId) ? { unlocked: { levelId: nextLevelId, name: this.levelById[nextLevelId].name } } : {}),
    };
    this.ui.refreshSelect(this.save.progress, this.levels, justUnlocked);
    if (run.eligible && encoded) void this.track(this.submit(run, encoded));
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
        }
        rec.stars = Math.max(rec.stars, starsFor(s));
      }
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
    if (run.resultKind === 'clear') {
      this.ui.showResult(run.view);
    } else {
      this.ui.showOver(run.summary, run.prevBestHeight);
      if (run.view.submit.state !== 'idle') this.ui.updateResult(run.view);
    }
    this.telemetry?.track('result_shown', { levelId: run.def.id, kind: run.resultKind ?? 'clear', mode: run.mode });
    this.settleRunEnd(run);
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
        view.submit = { state: 'accepted', rank: res.rank, total: res.total };
        this.storeRunId(run, res.runId, encoded);
        this.trackVerdict(run, { accepted: true });
      } else {
        view.submit = { state: 'rejected', reason: res.reason };
        this.trackVerdict(run, { accepted: false, reason: res.reason });
      }
    } catch (err) {
      const offline = !(err instanceof ApiError) || err.offline;
      reachable = !offline;
      if (!offline) {
        view.submit = { state: 'rejected', reason: (err as ApiError).reason };
        this.trackVerdict(run, { accepted: false, reason: (err as ApiError).reason });
      } else if (this.queue) {
        // Kept locally and sent on the next boot / `online`; the result line says so.
        this.queue.enqueue(body, { mode, board, levelId: run.def.id });
        view.submit = { state: 'queued' };
      } else view.submit = { state: 'offline' };
    }
    this.pushResult(run);
    if (!reachable) return;
    try {
      view.leaderboard = await this.api.leaderboard({ mode, board, limit: 20, playerId: player.id });
      if (mode === 'daily') { this.dailyLb = view.leaderboard; }
    } catch { /* the board is decoration */ }
    this.pushResult(run);
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
    if (response.accepted) this.adoptRunId(item, response.runId);
    this.trackVerdict({ mode: item.mode, def: { id: item.levelId } as LevelDef },
      response.accepted ? { accepted: true } : { accepted: false, reason: response.reason });
    // The result screen of the run that was just queued is still up: settle its line.
    const run = this.run;
    if (run?.view && run.view.submit.state === 'queued' && run.encoded === item.body.masks) {
      run.view.submit = response.accepted
        ? { state: 'accepted', rank: response.rank, total: response.total }
        : { state: 'rejected', reason: response.reason };
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
      const rec = run.mode === 'story' ? prog.levels[run.def.id] : run.mode === 'daily' && run.daily ? prog.daily[run.daily.date] : undefined;
      // Only a replay recorded by this SIM_VERSION reproduces on this sim (older masks are dropped).
      const masks = echoMasks(rec);
      if (masks) {
        try {
          const echo = new Echo(run.def, decodeMasks(masks), run.seed, false, C.echoSelf, '나');
          echo.syncTo(run.sim.state.tick);
          run.echoes.push(echo);
        } catch { /* a corrupt local replay is simply not shown */ }
      }
    }
    if (!s.echoWorld || run.mode === 'endless' || run.offline) return;
    const mode = run.mode === 'daily' ? 'daily' : 'story';
    const board = run.mode === 'daily' ? run.daily!.date : run.def.id;
    try {
      // playerId goes with every board query so the server can flag our own row
      // (`you`); entries never carry a raw player id, only an opaque tag.
      const lb = await this.api.leaderboard({ mode, board, limit: 1, playerId: prog.player.id });
      const top = lb.entries[0];
      // Our own best is already running as the self echo.
      if (!top || top.you || this.run !== run) return;
      const g = await this.api.ghost(top.runId);
      if (this.run !== run || g.levelId !== run.def.id) return;
      if (run.mode === 'daily' && g.seed !== run.daily!.seed) return;
      const echo = new Echo(run.def, decodeMasks(g.masks), g.seed, g.assist, C.echoWorld, g.name || top.name);
      echo.syncTo(run.sim.state.tick);
      run.echoes.push(echo);
    } catch { /* offline: no world echo */ }
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
    await this.refreshDailyBoard();
  }

  async refreshDailyBoard(): Promise<void> {
    const d = this.daily;
    if (!d) return;
    try {
      const lb = await this.api.leaderboard({ mode: 'daily', board: d.date, limit: 20, playerId: this.save.progress.player.id });
      if (this.daily !== d) return;
      this.dailyLb = lb;
      this.ui.setDaily(d, lb, 'ok');
    } catch {
      if (this.daily === d) this.ui.setDaily(d, this.dailyLb, 'error');
    }
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
