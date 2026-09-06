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
import { MAX_TICKS, TILE } from '../sim/types.js';
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
  ApiPort, AudioPort, HudState, InputPort, RendererPort, ResultView, UIAction, UIPort,
} from './contracts.js';
import { MAX_FRAME_DT, TickScheduler } from './loop.js';
import { FxBus } from './fx.js';
import { Camera } from './camera.js';
import { Save } from './save.js';
import { cloneBinds } from './input/binds.js';
import { ApiError } from './net/api.js';
import { Echo } from './echo/echo.js';

export type RunMode = 'story' | 'daily' | 'endless';

/** UIPort plus the optional extras the concrete UI offers. */
export interface ShellUI extends UIPort {
  banner?(text: string): void;
  boot?(k: number, label?: string): void;
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
}

/** Seconds of clear animation before the result screen. */
export const RESULT_DELAY = 1.25;
/** Seconds after the tide swallows the player before the game-over screen. */
export const OVER_DELAY = 1.1;
export const HINT_DELAY = 2.0;
export const HINT_DURATION = 7.0;
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
    this.buf[this.length++] = m & 0x3f;
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
   * Started without a server (capture harness, or a daily begun while the
   * server was unreachable): no leaderboard or ghost fetch, never submitted.
   * Sticky across restart / retry of the same run.
   */
  offline: boolean;
  /** Leaderboard-eligible so far (no assist / invincible / overflow, submittable mode, online). */
  eligible: boolean;
  /** The run can be kept as a self echo (no assist / invincible). */
  echoSafe: boolean;
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

function deathLine(cause: string): string {
  switch (cause) {
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
  private readonly levels: LevelDef[];
  private readonly levelById: Record<string, LevelDef>;
  private readonly makeDaily: (seed: number) => LevelDef;
  private readonly makeEndless: (seed: number) => LevelDef;
  private readonly randomSeed: () => number;
  private readonly build: string;
  private readonly now: () => number;
  private readonly inflight = new Set<Promise<unknown>>();

  private titleT = 0;
  private titleSwitchT = 0;
  private titleIdx = 0;
  private muffled = false;

  constructor(deps: ScenesDeps) {
    this.renderer = deps.renderer;
    this.audio = deps.audio;
    this.ui = deps.ui;
    this.input = deps.input;
    this.api = deps.api;
    this.save = deps.save;
    this.levels = deps.levels;
    this.levelById = Object.fromEntries(deps.levels.map((l) => [l.id, l]));
    this.makeDaily = deps.makeDaily ?? makeDailyLevel;
    this.makeEndless = deps.makeEndless ?? makeEndlessLevel;
    this.randomSeed = deps.randomSeed ?? defaultRandomSeed;
    this.build = deps.build ?? 'dev';
    this.now = deps.now ?? (() => Date.now());
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
    this.showTitle();
  }

  /** Staged boot with a progress bar; `raf` yields a frame, `wait` sleeps. */
  async boot(hooks: { raf: () => Promise<void>; wait: (ms: number) => Promise<void>; fonts?: Promise<unknown> }): Promise<void> {
    const ui = this.ui;
    ui.boot?.(0.15, '렌더 파이프라인 구성…');
    await hooks.raf();
    this.applySettings();
    this.ui.setPortraitPainter((ctx, skin, size, t) => this.renderer.drawPortrait(ctx, skin, size, t));
    ui.boot?.(0.4, '지형 텍스처 베이킹…');
    await hooks.raf();
    // warm the sky gradients / noise before the first visible frame
    this.renderer.drawTitle(0, 0, BIOMES[BIOME_ORDER[0]]);
    if (hooks.fonts) { try { await Promise.race([hooks.fonts, hooks.wait(1400)]); } catch { /* no font API */ } }
    ui.boot?.(0.7, '레벨 로드…');
    await hooks.raf();
    this.ui.refreshSelect(this.save.progress, this.levels);
    ui.boot?.(1, '준비 완료');
    await hooks.wait(240);
    this.showTitle();
  }

  private showTitle(): void {
    this.ui.show('title');
    this.audio.setTrack('title');
    this.audio.setIntensity(0.45);
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
      case 'restart': this.restartRun(); break;
      case 'quit': this.quitToMenu(); break;
      case 'next': this.nextLevel(); break;
      case 'retry': this.retryRun(); break;
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
    this.startDaily(d);
  }

  private beginRun(def: LevelDef, mode: RunMode, seed: number, daily: Run['daily'], restart: boolean, offline = false): void {
    const s = this.save.settings;
    const sim = new Sim(def, { seed, assist: s.assist, invincible: s.invincible });
    const biome = BIOMES[def.biome];
    const echoSafe = !s.assist && !s.invincible;
    const run: Run = {
      sim, def, mode, biome, seed, masks: new MaskLog(), daily, echoes: [],
      offline,
      eligible: echoSafe && mode !== 'endless' && !offline,
      echoSafe,
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
    if (!restart) {
      this.ui.banner?.(def.name);
      if (def.hint && !this.save.progress.seen[def.id]) {
        this.save.progress.seen[def.id] = true;
        this.save.saveProgress();
        run.hintTimer = HINT_DELAY;
        run.hintText = def.hint;
      }
      if (def.tide) { run.toastTimer = TIDE_TOAST_DELAY; run.toastText = '아래에서 조류가 밀려온다'; }
    }
    this.ui.hud(this.hudState(run));
    void this.track(this.loadEchoes(run));
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
    this.run = null;
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
    const dt = Number.isFinite(dtRaw) && dtRaw > 0 ? Math.min(dtRaw, 0.25) : 0;
    this.input.poll();
    const held = this.input.held();
    const latched = this.input.takeLatched();
    this.ui.frame(dt, this.input);

    const run = this.run;
    if (!run) { this.titleFrame(dt); return; }

    const playing = this.ui.screen === 'play';
    this.setMuffle(!playing && !run.summary);
    if (playing) {
      const dtWall = Math.min(dt, MAX_FRAME_DT);
      run.t += dtWall;
      this.fx.update(dtWall);
      const live = !run.sim.finished;
      const masks = this.scheduler.plan(dtWall, live ? held : 0, live ? latched : 0, this.fx);
      for (const m of masks) this.tick(m);
      const p = run.sim.state.player;
      this.camera.update(dtWall * (this.fx.hitstop > 0 ? 0.2 : 1), p, run.sim.level, this.renderer.viewW, this.renderer.viewH, this.fx.zoom);
      this.timers(run, dtWall);
      this.audio.setIntensity(run.sim.finished ? 0.25 : 0.55 + this.threat(run) * 0.45);
    }
    this.drawFrame(playing ? dt : 0);
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
    if (run.echoes.some((e) => e.done)) run.echoes = run.echoes.filter((e) => !e.done);
    const ghosts = [];
    for (const e of run.echoes) { const v = e.view(); if (v) ghosts.push(v); }
    this.renderer.draw(run.sim, this.camera.view(this.fx.zoom), this.fx.state(), ghosts, dt);
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
    if (run.resultTimer >= 0) {
      run.resultTimer -= dt;
      if (run.resultTimer < 0) this.showResult(run);
    }
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
      case 'checkpoint': this.ui.toast('기록 지점'); break;
      case 'death':
        if (run.mode === 'story') this.ui.toast(deathLine(ev.cause));
        break;
      case 'goal': this.finish(run, ev.summary, 'clear'); break;
      case 'tideOver': this.finish(run, ev.summary, 'over'); break;
      default: break;
    }
  }

  private finish(run: Run, summary: RunSummary, kind: 'clear' | 'over'): void {
    if (run.summary) return;
    run.summary = summary;
    run.resultKind = kind;
    run.resultTimer = kind === 'clear' ? RESULT_DELAY : OVER_DELAY;
    this.ui.hint(null);
    const encoded = run.echoSafe ? encodeMasks(run.masks.bytes()) : null;
    if (encoded && encoded.length > MAX_MASKS_B64) run.eligible = false;
    const personalBest = this.recordProgress(run, summary, encoded);
    const i = this.levels.findIndex((l) => l.id === run.def.id);
    run.view = {
      summary,
      levelName: run.def.name,
      personalBest,
      stars: starsFor(summary),
      submit: { state: run.eligible ? 'pending' : 'idle' },
      nextLevelId: run.mode === 'story' && i >= 0 && i + 1 < this.levels.length ? this.levels[i + 1].id : undefined,
    };
    this.ui.refreshSelect(this.save.progress, this.levels);
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
          if (encoded) rec.masks = encoded;
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
        if (encoded) rec.masks = encoded;
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
  }

  private pushResult(run: Run): void {
    if (this.run === run && run.resultShown && run.view) this.ui.updateResult(run.view);
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
      } else {
        view.submit = { state: 'rejected', reason: res.reason };
      }
    } catch (err) {
      const offline = !(err instanceof ApiError) || err.offline;
      reachable = !offline;
      view.submit = offline ? { state: 'offline' } : { state: 'rejected', reason: (err as ApiError).reason };
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

  // ================================================================ echoes
  private async loadEchoes(run: Run): Promise<void> {
    const s = this.save.settings;
    const prog = this.save.progress;
    if (s.echoSelf) {
      const rec = run.mode === 'story' ? prog.levels[run.def.id] : run.mode === 'daily' && run.daily ? prog.daily[run.daily.date] : null;
      if (rec?.masks) {
        try {
          const echo = new Echo(run.def, decodeMasks(rec.masks), run.seed, false, C.echoSelf, '나');
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
    } catch {
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
