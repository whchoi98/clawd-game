/**
 * Shell tests: the tick scheduler, the fx bus, the camera, the save layer, the
 * API client, echoes and the scene machine — all headless. `Scenes` is driven
 * through fake ports (renderer / audio / ui / input / api), so the whole flow
 * "start → run right → goal → progress → submit → result" runs in Node, and the
 * recorded mask log is replayed through `verifyReplay` exactly as the server
 * would.
 */
import { describe, expect, it, vi } from 'vitest';
import { DT, GEN_VERSION, IN, IN_ALL, MAX_TICKS, SIM_VERSION, TILE } from '../../src/sim/types.js';
import type {
  InputMask, LevelDef, PlayerState, RunSummary, SimEvent,
} from '../../src/sim/types.js';
import { Sim } from '../../src/sim/sim.js';
import { decodeMasks, encodeMasks, verifyReplay } from '../../src/sim/replay.js';
import { LEVELS as REAL_LEVELS } from '../../src/sim/levels.generated.js';
import { GUIDE_DELAY, GUIDE_LABEL, GUIDE_T1, guideFor } from '../../src/client/echo/guide.js';
import { REHINT_HAZARD, REHINT_PIT } from '../../src/client/ui/hints.js';
import { DEATH_FADE_AT, FADE_IN_HALF } from '../../src/client/fx.js';
import { MAX_MASKS_B64, MAX_TRANSFER_BYTES, PlayerRef, RejectReason, TransferCode } from '../../src/shared/protocol.js';
import type {
  DailyResponse, GhostResponse, LeaderboardEntry, LeaderboardQuery, LeaderboardResponse, RunResponse, RunSubmit,
  TransferCreateRequest, TransferGetResponse,
} from '../../src/shared/protocol.js';
import type {
  ApiPort, AudioPort, Binds, FxState, GhostView, HudState, InputPort, LevelRecord, MenuAction, Progress, RendererPort, ResultView,
  Screen, Settings, TouchState, UIAction, WorldView,
} from '../../src/client/contracts.js';
import { MAX_STEPS_PER_FRAME, TickScheduler, planTicks } from '../../src/client/loop.js';
import { FxBus } from '../../src/client/fx.js';
import { Camera } from '../../src/client/camera.js';
import {
  DAILY_CACHE_KEY, DEFAULT_NAME, PERSIST_ASKED_KEY, PROGRESS_KEY, SETTINGS_KEY, Save, deepMerge, fallbackName, jsonBytes, markEcho,
  newPlayerId, streakFor, utcDateStr,
  type StorageLike,
} from '../../src/client/save.js';
import { TRANSFER_KR } from '../../src/client/ui/transfer.js';
import type { HapticsPort } from '../../src/client/haptics.js';
import { Api, ApiError } from '../../src/client/net/api.js';
import { QUEUE_KEY, SubmitQueue } from '../../src/client/net/queue.js';
import type { TelemetryData, TelemetryPort } from '../../src/client/net/telemetry.js';
import type { TelemetryName } from '../../src/shared/protocol.js';
import { ECHO_ALPHA, Echo } from '../../src/client/echo/echo.js';
import { GOAL_LABEL } from '../../src/client/echo/goal.js';
import { GOAL_ECHOES } from '../../src/sim/echoes.generated.js';
import { SPLIT_NONE, SPLIT_SECONDS, fmtSplit, fmtVersus, pickWorldEcho, worldEchoLabel } from '../../src/client/echo/rival.js';
import { RACE_COLOR, RACE_KR, type ShareData, type ShareEnv } from '../../src/client/echo/race.js';
import { CARD_KR, type CardEnv, type CardShareData } from '../../src/client/share/card.js';
import { INSTALL_CARD_MAX_DISMISS } from '../../src/client/scenes.js';
import { defaultProgress, repairProgress } from '../../src/client/save.js';
import { fmtTime } from '../../src/client/ui/hud.js';
import { echoWorldMode, segmentBests, setEchoWorldMode } from '../../src/client/save.js';
import {
  ASSIST_OFFER_DEATHS, DEATH_MARKS_MAX, NAME_ASKED_KEY, Scenes, HINT_DELAY, MENU_FRAME_DT, REHINT_DEATHS, RESULT_DELAY, assistSeenKey,
  transferErrorText,
  type DeathMark, type SegmentRow, type ShellUI, type VersusView, type YesterdayInfo,
} from '../../src/client/scenes.js';
import { ShotScript, parseShotQuery } from '../../src/client/shot.js';
import { checkpointRoom, flatRoom, openRoom, pitRoom, shaftRoom, spikeRoom, tideRoom } from '../fixtures/levels.js';

const BINDS: Binds = {
  left: ['ArrowLeft', 'KeyA'], right: ['ArrowRight', 'KeyD'], up: ['ArrowUp', 'KeyW'], down: ['ArrowDown', 'KeyS'],
  jump: ['Space', 'KeyZ'], dash: ['ShiftLeft', 'KeyX'], pause: ['Escape', 'KeyP'],
  confirm: ['Enter', 'Space'], cancel: ['Escape', 'Backspace'], restart: ['KeyR'],
};

// ================================================================ fakes
class MemStorage implements StorageLike {
  readonly map = new Map<string, string>();
  writes = 0;
  getItem(k: string): string | null { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string): void { this.map.set(k, v); this.writes++; }
  removeItem(k: string): void { this.map.delete(k); }
}

/** Manual timer queue so debounced writes can be flushed deterministically. */
function manualTimers() {
  const q: { fn: () => void; id: number }[] = [];
  let seq = 1;
  return {
    schedule: (fn: () => void): number => { const id = seq++; q.push({ fn, id }); return id; },
    cancel: (id: unknown): void => { const i = q.findIndex((t) => t.id === id); if (i >= 0) q.splice(i, 1); },
    fire: (): void => { const all = q.splice(0); for (const t of all) t.fn(); },
    pending: (): number => q.length,
  };
}

function makeSave(storage = new MemStorage(), extra: Partial<ConstructorParameters<typeof Save>[0]> = {}) {
  const timers = manualTimers();
  const save = new Save({ storage, defaultBinds: BINDS, schedule: timers.schedule, cancel: timers.cancel, ...extra });
  return { save, storage, timers };
}

interface FakeRenderer extends RendererPort {
  setLevelCalls: number; draws: number; titleDraws: number; events: SimEvent[]; lastView: WorldView | null;
  lastGhosts: GhostView[]; lastFx: FxState | null; lastDt: number;
  /** The death marks the shell last handed over (ShellRenderer.setDeathMarks). */
  deathMarks: readonly DeathMark[];
  setDeathMarks(marks: readonly DeathMark[]): void;
}
function fakeRenderer(): FakeRenderer {
  const r: FakeRenderer = {
    setLevelCalls: 0, draws: 0, titleDraws: 0, events: [], lastView: null, lastGhosts: [], lastFx: null, lastDt: 0, goalScreen: null,
    deathMarks: [],
    setDeathMarks(marks) { r.deathMarks = marks; },
    setLevel() { r.setLevelCalls++; },
    draw(_sim, view, fx, ghosts, dt) { r.draws++; r.lastView = view; r.lastFx = fx; r.lastGhosts = ghosts; r.lastDt = dt; },
    onEvent(ev) { r.events.push(ev); },
    drawTitle() { r.titleDraws++; },
    drawPortrait() {},
    resize() {},
    viewW: 512, viewH: 288, fps: 60, qualityTier: 'high',
    applySettings() {},
    clearParticles() {},
    skins: { clawd: { name: 'CLAWD', kr: '클로드' } },
  };
  return r;
}

interface FakeAudio extends AudioPort { events: SimEvent[]; track: string | null; intensity: number; muffled: boolean; inits: number }
function fakeAudio(): FakeAudio & { setMuffle(on: boolean): void } {
  const a = {
    events: [] as SimEvent[], track: null as string | null, intensity: 0, muffled: false, inits: 0, ready: true, running: true,
    init() { a.inits++; },
    unlock() { a.inits++; },
    applySettings() {},
    onEvent(ev: SimEvent) { a.events.push(ev); },
    setTrack(k: string | null) { a.track = k; },
    setIntensity(v: number) { a.intensity = v; },
    ui() {},
    suspend() {},
    resume() {},
    setMuffle(on: boolean) { a.muffled = on; },
  };
  return a;
}

type OverExtra = { worldBest?: number; sameTowerAvailable?: boolean };
interface FakeUI extends ShellUI {
  cbs: ((a: UIAction) => void)[]; shown: Screen[]; result: ResultView | null;
  over: { summary: RunSummary; best: number; extra: OverExtra | undefined } | null;
  huds: HudState[]; hints: (string | null)[]; toasts: string[]; banners: string[];
  dailyCalls: [DailyResponse | null, LeaderboardResponse | null, string][]; selectRefreshes: number;
  /** The `justUnlocked` set of every refreshSelect call (undefined when the shell passed none). */
  unlockCalls: (ReadonlySet<string> | undefined)[];
  goalScreens: ({ x: number; y: number; onScreen: boolean } | null)[];
  /** Every setVersionBehind() value, in order. */
  versionBehind: boolean[];
  /** Zone names of every offerAssist() call; the fake shows the 'assist' screen like the real UI. */
  offers: string[];
  /** askNameInline(): how often it was asked and what the fake answers (null = 건너뛰기). */
  nameAsks: number; nameAnswer: string | null;
  /** Every setYesterday() value, in order. */
  yesterdays: (YesterdayInfo | null)[];
  /** Every split() call (P2-4): text null = the chip was hidden. */
  splits: { text: string | null; sign: number | undefined }[];
  /** Every segments() call (P2-4). */
  segmentCalls: (SegmentRow[] | null)[];
  /** Every setVersus() call (P2-4). */
  versusCalls: (VersusView | null)[];
  /** Every showTransferCode() / transferStatus() call (P3-5). */
  transferCodes: { code: string; expiresAt: string }[];
  transferStatuses: { text: string | null; kind: string | undefined }[];
  /** Every installCard() value (P3-4). */
  installCards: boolean[];
  emit(a: UIAction): void; setScreen(s: Screen): void;
}
function fakeUI(): FakeUI {
  let scr: Screen = 'boot';
  const touch: TouchState = { active: false, x: 0, y: 0, jump: false, dash: false, jumpPressed: false, dashPressed: false };
  const u: FakeUI = {
    cbs: [], shown: [], result: null, over: null, huds: [], hints: [], toasts: [], banners: [], dailyCalls: [], selectRefreshes: 0,
    unlockCalls: [], goalScreens: [], versionBehind: [], offers: [], nameAsks: 0, nameAnswer: null, yesterdays: [],
    splits: [], segmentCalls: [], versusCalls: [], transferCodes: [], transferStatuses: [], installCards: [],
    installCard(on) { u.installCards.push(on); },
    showTransferCode(code, expiresAt) { u.transferCodes.push({ code, expiresAt }); },
    transferStatus(text, kind) { u.transferStatuses.push({ text, kind }); },
    split(text, sign) { u.splits.push({ text, sign }); },
    segments(rows) { u.segmentCalls.push(rows); },
    setVersus(v) { u.versusCalls.push(v); },
    offerAssist(name) { u.offers.push(name); scr = 'assist'; u.shown.push('assist'); },
    askNameInline() { u.nameAsks++; return Promise.resolve(u.nameAnswer); },
    setYesterday(info) { u.yesterdays.push(info); },
    on(cb) { u.cbs.push(cb); },
    show(s) { scr = s; u.shown.push(s); },
    get screen() { return scr; },
    frame() {},
    hud(h) { u.huds.push(h); },
    hint(t) { u.hints.push(t); },
    toast(t) { u.toasts.push(t); },
    banner(t) { u.banners.push(t); },
    refreshSelect(_p: Progress, _l: LevelDef[], justUnlocked?: ReadonlySet<string>) { u.selectRefreshes++; u.unlockCalls.push(justUnlocked); },
    setGoalScreen(g) { u.goalScreens.push(g); },
    setVersionBehind(on) { u.versionBehind.push(on); },
    setDaily(d, lb, status) { u.dailyCalls.push([d, lb, status]); },
    showResult(v) { u.result = v; scr = 'result'; u.shown.push('result'); },
    updateResult(v) { u.result = v; },
    showOver(s, best, extra) { u.over = { summary: s, best, extra }; scr = 'over'; u.shown.push('over'); },
    applySettings() {},
    touch,
    setPortraitPainter() {},
    emit(a) { for (const cb of u.cbs) cb(a); },
    setScreen(s) { scr = s; },
  };
  return u;
}

interface FakeInput extends InputPort { heldMask: InputMask; latchedMask: InputMask; resets: number }
function fakeInput(): FakeInput {
  const touch: TouchState = { active: false, x: 0, y: 0, jump: false, dash: false, jumpPressed: false, dashPressed: false };
  const i: FakeInput = {
    heldMask: 0, latchedMask: 0, resets: 0,
    poll() {},
    held() { return i.heldMask; },
    takeLatched() { const l = i.latchedMask; i.latchedMask = 0; return l; },
    takeMenu(): MenuAction[] { return []; },
    menuHeld() { return false; },
    setBinds() {},
    capture() {},
    reset() { i.resets++; },
    lastDevice: 'keyboard',
    touch,
    keyLabel(c) { return c; },
  };
  return i;
}

/**
 * A board row as the fake server stores it: the owner's raw id stays server-side
 * and is turned into `you` per query, exactly like the real leaderboard route.
 */
type StoredEntry = Omit<LeaderboardEntry, 'you'> & { ownerId: string };

/** An API fake that verifies submissions with the real sim, like the server. */
interface FakeApi extends ApiPort {
  submissions: RunSubmit[]; lbQueries: LeaderboardQuery[]; ghosts: Record<string, GhostResponse>; failWith: Error | null;
  levels: Record<string, LevelDef>; board: StoredEntry[];
  /** Versions the fake server reports (undefined = field absent, like a pre-P1 server). */
  healthSim?: number; dailySim?: number; dailyGen?: number;
  healthCalls: number;
  /** Progress transfer (P3-5): snapshots by code, redeemed once; every create body. */
  snapshots: Map<string, TransferGetResponse>;
  transferCreates: TransferCreateRequest[];
  transferCreate(body: TransferCreateRequest): Promise<{ code: string; expiresAt: string }>;
  transferGet(code: string): Promise<TransferGetResponse>;
}
/** Valid wire codes the fake hands out, in order. */
const FAKE_CODES = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ', '23456789'];
function fakeApi(levels: LevelDef[]): FakeApi {
  const a: FakeApi = {
    submissions: [], lbQueries: [], ghosts: {}, failWith: null, board: [], healthCalls: 0,
    snapshots: new Map(), transferCreates: [],
    levels: Object.fromEntries(levels.map((l) => [l.id, l])),
    async transferCreate(body) {
      if (a.failWith) throw a.failWith;
      a.transferCreates.push(body);
      if (jsonBytes(body) > MAX_TRANSFER_BYTES) throw new ApiError('too large', 413, 'too-long');
      const code = FAKE_CODES[a.transferCreates.length - 1] ?? FAKE_CODES[0];
      a.snapshots.set(code, { playerId: body.player.id, name: body.player.name, progress: JSON.parse(JSON.stringify(body.progress)) as Record<string, unknown> });
      return { code, expiresAt: '2026-09-13T00:00:00.000Z' };
    },
    async transferGet(code) {
      if (a.failWith) throw a.failWith;
      if (!TransferCode.safeParse(code).success) throw new ApiError('bad code', 400, 'bad-code');
      const snap = a.snapshots.get(code);
      if (!snap) throw new ApiError('gone', 410, 'gone');
      a.snapshots.delete(code); // one-time
      return snap;
    },
    async daily(): Promise<DailyResponse> {
      return {
        date: '2026-09-06', seed: 12345, levelId: 'daily', expiresAt: '2026-09-07T00:00:00.000Z',
        ...(a.dailySim !== undefined ? { sim: a.dailySim } : {}), ...(a.dailyGen !== undefined ? { gen: a.dailyGen } : {}),
      };
    },
    async submitRun(body): Promise<RunResponse> {
      if (a.failWith) throw a.failWith;
      a.submissions.push(body);
      // the real server refuses another sim / gen version before it replays anything
      if (body.sim !== SIM_VERSION || (body.mode === 'daily' && body.gen !== GEN_VERSION)) return { accepted: false, reason: 'sim-version' };
      const def = a.levels[body.levelId];
      const masks = decodeMasks(body.masks);
      const v = verifyReplay(def, { v: SIM_VERSION, levelId: body.levelId, seed: body.seed ?? def.seed, assist: body.assist, masks }, body.claim);
      if (!v.ok) {
        const parsed = RejectReason.safeParse(v.reason);
        return { accepted: false, reason: parsed.success ? parsed.data : 'claim-mismatch' };
      }
      const runId = `run-${a.submissions.length}`;
      a.ghosts[runId] = {
        runId, mode: body.mode, board: body.mode === 'daily' ? body.date ?? '' : body.levelId, levelId: body.levelId,
        seed: body.seed ?? def.seed, assist: body.assist, masks: body.masks, name: body.player.name, ticks: v.summary.ticks,
      };
      a.board = [{
        rank: 1, runId, ownerId: body.player.id, playerTag: 'aaaaaaaaaaaa', name: body.player.name,
        score: v.summary.ticks, ticks: v.summary.ticks,
        shards: v.summary.shards, deaths: v.summary.deaths, cleared: v.summary.cleared, height: v.summary.height,
        createdAt: '2026-09-06T00:00:00.000Z',
      }];
      return {
        accepted: true, runId, rank: 1, total: 1, score: v.summary.ticks, personalBest: true,
        summary: { ...v.summary },
      };
    },
    async leaderboard(q): Promise<LeaderboardResponse> {
      if (a.failWith) throw a.failWith;
      a.lbQueries.push(q);
      const entries = a.board.slice(0, q.limit ?? 20).map(({ ownerId, ...e }) => ({ ...e, you: ownerId === q.playerId }));
      return { mode: q.mode, board: q.board, total: a.board.length, entries };
    },
    async ghost(runId): Promise<GhostResponse> {
      const g = a.ghosts[runId];
      if (!g) throw new ApiError('not found', 404, 'not-found');
      return g;
    },
    async health() {
      a.healthCalls++;
      return { ok: true as const, version: 'test', uptime: 1, ...(a.healthSim !== undefined ? { simVersion: a.healthSim, genVersion: GEN_VERSION } : {}) };
    },
  };
  return a;
}

/** A telemetry sink that just records what the shell reports. */
interface FakeTelemetry extends TelemetryPort {
  events: { t: TelemetryName; d?: TelemetryData }[];
  screens: string[];
  flushes: string[];
  names(): TelemetryName[];
  of(t: TelemetryName): TelemetryData[];
}
function fakeTelemetry(): FakeTelemetry {
  const f: FakeTelemetry = {
    events: [], screens: [], flushes: [],
    track(t, d) { f.events.push(d ? { t, d } : { t }); },
    screen(name) { f.screens.push(name); f.events.push({ t: 'screen', d: { screen: name } }); },
    flush(reason) { f.flushes.push(reason ?? 'manual'); },
    names() { return f.events.map((e) => e.t); },
    of(t) { return f.events.filter((e) => e.t === t).map((e) => e.d ?? {}); },
  };
  return f;
}

function makeScenes(
  levels: LevelDef[],
  opts: {
    assist?: boolean; echoWorld?: boolean; echoSelf?: boolean; now?: () => number; makeDaily?: (seed: number) => LevelDef;
    /** Race links (P3-3): the origin the shell shares and the share / clipboard fakes (default: nothing available). */
    origin?: string; share?: ShareEnv;
    /** Share card (P3-4): canvas / share / clipboard fakes (default: nothing available). */
    card?: CardEnv;
  } = {},
) {
  const renderer = fakeRenderer();
  const audio = fakeAudio();
  const ui = fakeUI();
  const input = fakeInput();
  const api = fakeApi(levels);
  const tele = fakeTelemetry();
  const newer: (number | null)[] = [];
  const { save, timers, storage } = makeSave();
  save.settings.assist = !!opts.assist;
  save.settings.echoSelf = opts.echoSelf ?? true;
  save.settings.echoWorld = opts.echoWorld ?? false;
  const scenes = new Scenes({
    renderer, audio, ui, input, api, save, levels, build: 'test', randomSeed: () => 777, random: () => 0.5,
    telemetry: tele, telemetryEnv: { uaFamily: 'desktop', dpr: 2, hwConcurrency: 8 },
    onServerNewer: (v) => { newer.push(v); },
    origin: opts.origin ?? 'https://clawd.test',
    ...(opts.share ? { share: opts.share } : {}),
    ...(opts.card ? { card: opts.card } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.makeDaily ? { makeDaily: opts.makeDaily } : {}),
  });
  return { scenes, renderer, audio, ui, input, api, save, timers, storage, tele, newer };
}

/** Advance frames at 60 Hz until `until()` or the frame budget is spent. Returns frames run. */
function runFrames(scenes: Scenes, until: () => boolean, max = 3000): number {
  let n = 0;
  while (n < max && !until()) { scenes.frame(1 / 60); n++; }
  return n;
}

// ================================================================ loop
describe('planTicks / TickScheduler', () => {
  it('ORs the latched bits into the first tick only', () => {
    const masks = planTicks(IN.RIGHT, IN.JUMP, 4);
    expect(masks).toEqual([IN.RIGHT | IN.JUMP, IN.RIGHT, IN.RIGHT, IN.RIGHT]);
  });

  it('yields exactly one JUMP edge for a latched tap when fed to the sim', () => {
    const sim = new Sim(openRoom());
    for (let i = 0; i < 80; i++) sim.step(0);           // through the intro, settled on the floor
    expect(sim.state.phase).toBe('play');
    let jumps = 0;
    for (const m of planTicks(0, IN.JUMP, 6)) {
      sim.step(m);
      for (const ev of sim.drainEvents()) if (ev.type === 'jump') jumps++;
    }
    expect(jumps).toBe(1);
    expect(planTicks(IN.LEFT, IN.DASH, 0)).toEqual([]);
  });

  it('turns 60 Hz frames into two 120 Hz ticks each and carries a latched press across an empty frame', () => {
    const s = new TickScheduler();
    const rest = { hitstop: 0, timeScale: 1 };
    let total = 0;
    for (let i = 0; i < 60; i++) total += s.plan(1 / 60, 0, 0, rest).length;
    expect(total).toBe(120);
    // hitstop: nothing runs, but the tap is not lost
    expect(s.plan(1 / 60, 0, IN.JUMP, { hitstop: 0.05, timeScale: 1 })).toEqual([]);
    const after = s.plan(1 / 60, IN.RIGHT, 0, rest);
    expect(after.length).toBeGreaterThan(0);
    expect(after[0]).toBe(IN.RIGHT | IN.JUMP);
    expect(after.slice(1).every((m) => m === IN.RIGHT)).toBe(true);
  });

  it('runs fewer ticks under slow motion and caps a stall', () => {
    const s = new TickScheduler();
    let slow = 0;
    for (let i = 0; i < 60; i++) slow += s.plan(1 / 60, 0, 0, { hitstop: 0, timeScale: 0.5 }).length;
    expect(slow).toBeGreaterThanOrEqual(58);
    expect(slow).toBeLessThanOrEqual(62);
    const s2 = new TickScheduler();
    const stall = s2.plan(1.5, 0, 0, { hitstop: 0, timeScale: 1 });
    expect(stall.length).toBeLessThanOrEqual(MAX_STEPS_PER_FRAME);
    expect(stall.length).toBe(6);            // 1/20 s clamp → 6 ticks
    expect(s2.acc).toBe(0);
  });
});

// ================================================================ fx
describe('FxBus', () => {
  it('reacts to a relic with hitstop + slow-mo and decays back to rest', () => {
    const fx = new FxBus({ random: () => 0.5 });
    fx.reset(0);
    expect(fx.atRest()).toBe(true);
    fx.onEvent({ type: 'relic', x: 0, y: 0, n: 1, total: 1 });
    expect(fx.hitstop).toBeGreaterThan(0);
    expect(fx.timeScale).toBeLessThan(0.5);
    expect(fx.state().flash).toBeGreaterThan(0);
    for (let i = 0; i < 60 * 4; i++) fx.update(1 / 60);
    expect(fx.atRest()).toBe(true);
    const st = fx.state();
    expect(Math.abs(st.zoom - 1)).toBeLessThan(0.01);
    expect(st.shakeX).toBe(0);
    expect(st.flash).toBe(0);
  });

  it('honours the shake scale and the photosensitivity toggle', () => {
    const fx = new FxBus({ random: () => 1 });
    fx.applySettings({ shake: 0, flashes: false });
    fx.onEvent({ type: 'death', x: 0, y: 0, cause: 'pit', deaths: 1 });
    expect(fx.state().shakeX).toBe(0);
    expect(fx.state().flash).toBeLessThanOrEqual(0.12);
    const loud = new FxBus({ random: () => 1 });
    loud.onEvent({ type: 'death', x: 0, y: 0, cause: 'pit', deaths: 1 });
    expect(loud.state().shakeX).toBeGreaterThan(0);
  });

  it('fades to black after a death and clears on respawn', () => {
    const fx = new FxBus();
    fx.reset(0);
    fx.onEvent({ type: 'death', x: 0, y: 0, cause: 'spike', deaths: 1 });
    for (let i = 0; i < 120; i++) fx.update(1 / 120);   // 1 s of dying
    expect(fx.state().fade).toBeGreaterThan(0.2);
    fx.onEvent({ type: 'respawn', x: 0, y: 0 });
    for (let i = 0; i < 240; i++) fx.update(1 / 120);
    expect(fx.state().fade).toBeLessThan(0.05);
  });
});

// ================================================================ camera
describe('Camera', () => {
  const player = (x: number, y: number, grounded = true): PlayerState => ({
    x, y, w: 11, h: 15, vx: 0, vy: 0, facing: 1, grounded, onWall: 0, jumps: 0, dashT: 0, dashDirX: 0, dashDirY: 0,
    dashReady: true, dashCd: 0, stomping: false, hp: 3, invuln: 0, dead: false, deadT: 0, inWater: false, pose: 'idle', t: 0,
  });

  it('clamps to the level and centres a level smaller than the view', () => {
    const cam = new Camera();
    cam.reset(player(0, 0));
    for (let i = 0; i < 200; i++) cam.update(1 / 60, player(0, 0), { pxW: 2000, pxH: 1000 }, 512, 288, 1);
    expect(cam.x).toBeCloseTo(256, 3);
    expect(cam.y).toBeCloseTo(144, 3);
    const small = new Camera();
    small.update(1 / 60, player(50, 50), { pxW: 300, pxH: 200 }, 512, 288, 1);
    expect(small.x).toBe(150);
    expect(small.y).toBe(100);
    expect(small.view(1)).toEqual({ camX: 150, camY: 100, zoom: 1 });
  });

  it('locks to the ground line while airborne and follows the feet once landed', () => {
    const cam = new Camera();
    const level = { pxW: 4000, pxH: 4000 };
    cam.reset(player(1000, 1000));
    for (let i = 0; i < 120; i++) cam.update(1 / 60, player(1000, 1000), level, 512, 288, 1);
    const yGround = cam.y;
    // a short hop stays inside the dead zone: the camera does not chase it
    for (let i = 0; i < 30; i++) cam.update(1 / 60, player(1000, 970, false), level, 512, 288, 1);
    expect(Math.abs(cam.y - yGround)).toBeLessThan(1);
    // landing much higher moves the ground line
    for (let i = 0; i < 240; i++) cam.update(1 / 60, player(1000, 600), level, 512, 288, 1);
    expect(cam.y).toBeLessThan(yGround - 300);
  });
});

// ================================================================ save
describe('Save', () => {
  it('starts from defaults with a valid player id and the default name', () => {
    const { save } = makeSave();
    expect(save.settings.v).toBe(1);
    expect(save.settings.binds).toEqual(BINDS);
    expect(save.progress.player.name).toBe(DEFAULT_NAME);
    expect(PlayerRef.safeParse(save.progress.player).success).toBe(true);
    expect(newPlayerId()).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });

  it('seeds reduced-motion settings only on a first run', () => {
    const { save } = makeSave(new MemStorage(), { reducedMotion: true });
    expect(save.settings.shake).toBe(0);
    expect(save.settings.flashes).toBe(false);
    const storage = new MemStorage();
    storage.setItem(SETTINGS_KEY, JSON.stringify({ v: 1, shake: 0.7, flashes: true }));
    const again = makeSave(storage, { reducedMotion: true }).save;
    expect(again.settings.shake).toBe(0.7);
    expect(again.settings.flashes).toBe(true);
  });

  it('deep-merges stored documents over the defaults and repairs bad values', () => {
    const storage = new MemStorage();
    storage.setItem(SETTINGS_KEY, JSON.stringify({ v: 1, master: 0.3, quality: 'ultra', binds: { jump: ['KeyJ'] }, extra: 1 }));
    storage.setItem(PROGRESS_KEY, JSON.stringify({
      v: 1, levels: { t1: { done: true, bestTicks: 100 } }, player: { id: 'bad id!', name: '' },
    }));
    const { save } = makeSave(storage);
    expect(save.settings.master).toBe(0.3);
    expect(save.settings.quality).toBe('auto');
    expect(save.settings.binds.jump).toEqual(['KeyJ']);
    expect(save.settings.binds.left).toEqual(BINDS.left);
    expect(save.progress.levels.t1.done).toBe(true);
    expect(save.progress.levels.t1.bestShards).toBe(0);
    expect(save.progress.player.id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(save.progress.player.name).toBe(DEFAULT_NAME);
    expect(deepMerge({ a: { b: 1, c: 2 }, d: [1] }, { a: { b: 5 }, d: [2, 3] })).toEqual({ a: { b: 5, c: 2 }, d: [2, 3] });
  });

  it('debounces writes and keeps the player identity across a progress reset', () => {
    const { save, storage, timers } = makeSave();
    const before = storage.writes;
    save.levelRecord('t1').done = true;
    save.saveProgress();
    save.saveProgress();
    expect(storage.writes).toBe(before);
    expect(timers.pending()).toBe(1);
    timers.fire();
    expect(storage.writes).toBe(before + 1);
    expect(JSON.parse(storage.getItem(PROGRESS_KEY)!).levels.t1.done).toBe(true);
    const id = save.progress.player.id;
    save.progress.player.name = '테스터';
    save.resetProgress();
    expect(save.progress.levels).toEqual({});
    expect(save.progress.player.id).toBe(id);
    expect(save.progress.player.name).toBe('테스터');
    expect(JSON.parse(storage.getItem(PROGRESS_KEY)!).levels).toEqual({});
  });

  it('caches the daily seed per UTC date, immediately, and only hands back today\'s', () => {
    const { save, storage } = makeSave();
    expect(save.cachedDaily('2026-09-06')).toBeNull();
    save.cacheDaily({ date: '2026-09-06', seed: 12345, levelId: 'daily', expiresAt: '2026-09-07T00:00:00.000Z' });
    expect(JSON.parse(storage.getItem(DAILY_CACHE_KEY)!)).toEqual({ date: '2026-09-06', seed: 12345, expiresAt: '2026-09-07T00:00:00.000Z' });
    expect(save.cachedDaily('2026-09-06')).toEqual({ date: '2026-09-06', seed: 12345, levelId: 'daily', expiresAt: '2026-09-07T00:00:00.000Z' });
    expect(save.cachedDaily('2026-09-07')).toBeNull();
    // a fresh Save over the same storage sees it; garbage does not parse
    expect(makeSave(storage).save.cachedDaily('2026-09-06')?.seed).toBe(12345);
    storage.setItem(DAILY_CACHE_KEY, JSON.stringify({ date: '2026-09-06', seed: 'x', expiresAt: '2026-09-07T00:00:00.000Z' }));
    expect(makeSave(storage).save.cachedDaily('2026-09-06')).toBeNull();
    storage.setItem(DAILY_CACHE_KEY, '{');
    expect(makeSave(storage).save.cachedDaily('2026-09-06')).toBeNull();
    expect(utcDateStr(Date.parse('2026-09-06T23:59:59.000Z'))).toBe('2026-09-06');
    expect(utcDateStr(Date.parse('2026-09-07T00:00:00.000Z'))).toBe('2026-09-07');
  });
});

// ================================================================ api
describe('Api', () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('parses responses and builds query strings', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const api = new Api({
      base: 'https://x.test', fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        if (String(url).includes('/api/daily')) return json({ date: '2026-09-06', seed: 7, levelId: 'daily', expiresAt: 'x' });
        return json({ mode: 'story', board: 't1', total: 0, entries: [] });
      },
    });
    const d = await api.daily();
    expect(d.seed).toBe(7);
    const lb = await api.leaderboard({ mode: 'story', board: 't1', limit: 5, playerId: 'abcdefghij' });
    expect(lb.entries).toEqual([]);
    expect(calls[1].url).toBe('https://x.test/api/leaderboard?mode=story&board=t1&limit=5&playerId=abcdefghij');
  });

  it('returns a rejected RunResponse from a 422 and throws ApiError otherwise', async () => {
    const submit: RunSubmit = {
      player: { id: 'abcdefghij', name: '클로드' }, mode: 'story', levelId: 't1', assist: false, masks: 'AAEA',
      claim: { ticks: 10, shards: 0, deaths: 0, cleared: true, height: 0 }, client: { build: 'test' },
    };
    const rejected = new Api({ fetch: async () => json({ accepted: false, reason: 'claim-mismatch' }, 422) });
    const r = await rejected.submitRun(submit);
    expect(r.accepted).toBe(false);
    if (!r.accepted) expect(r.reason).toBe('claim-mismatch');

    const limited = new Api({ fetch: async () => json({ error: 'rate-limited' }, 429) });
    await expect(limited.submitRun(submit)).rejects.toBeInstanceOf(ApiError);
    await limited.submitRun(submit).catch((e: ApiError) => {
      expect(e.status).toBe(429);
      expect(e.reason).toBe('rate-limited');
    });

    const garbage = new Api({ fetch: async () => json({ nope: true }) });
    await garbage.daily().catch((e: ApiError) => {
      expect(e).toBeInstanceOf(ApiError);
      expect(e.reason).toBe('bad-response');
    });
  });

  it('aborts a hung request after the timeout', async () => {
    const api = new Api({
      timeoutMs: 20,
      fetch: (_url, init) => new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
      }),
    });
    const err = await api.health().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).reason).toBe('timeout');
    expect((err as ApiError).status).toBe(0);
  });
});

// ================================================================ echo
describe('Echo', () => {
  it('stays in lockstep with a live sim driven by the scheduler', () => {
    const def = flatRoom();
    const rec = new Sim(def);
    const masks: number[] = [];
    while (!rec.finished && masks.length < 4000) { masks.push(IN.RIGHT); rec.step(IN.RIGHT); }
    expect(rec.finished).toBe(true);
    const log = Uint8Array.from(masks);

    const live = new Sim(def);
    const echo = new Echo(def, log, def.seed, false, '#fff', '나');
    const sched = new TickScheduler();
    const rest = { hitstop: 0, timeScale: 1 };
    for (let f = 0; f < 200; f++) {
      for (const m of sched.plan(1 / 60, IN.RIGHT, 0, rest)) { live.step(m); echo.step(); }
      expect(echo.tick).toBe(live.state.tick);
    }
    expect(echo.view()?.alpha).toBe(ECHO_ALPHA);
    expect(echo.view()?.label).toBe('나');
    // the echo reproduces the recording exactly
    expect(echo.sim.state.player.x).toBe(live.state.player.x);
    // and after the recording ends it fades out then reports done
    echo.syncTo(log.length + 200);
    expect(echo.done).toBe(true);
    expect(echo.view()).toBeNull();
  });

  it('can catch up to a live tick after loading late', () => {
    const def = flatRoom();
    const echo = new Echo(def, Uint8Array.from([IN.RIGHT, IN.RIGHT, IN.RIGHT]), def.seed, false, '#fff');
    echo.syncTo(500);
    expect(echo.tick).toBe(500);
  });
});

// ================================================================ shot
describe('shot harness', () => {
  it('parses the query string and ignores pages without the flag', () => {
    expect(parseShotQuery(new URLSearchParams('frames=10'))).toBeNull();
    const spec = parseShotQuery(new URLSearchParams('shot=t1&frames=240&hold=right,jump&pulse=jump:26,dash:60&alt=30&bot=wall&at=100,200&ui=select'));
    expect(spec).not.toBeNull();
    expect(spec!.target).toBe('t1');
    expect(spec!.frames).toBe(240);
    expect([...spec!.hold]).toEqual(['right', 'jump']);
    expect(spec!.pulse).toEqual([{ a: 'jump', n: 26 }, { a: 'dash', n: 60 }]);
    expect(spec!.alt).toBe(30);
    expect(spec!.bot).toBe('wall');
    expect(spec!.at).toEqual([100, 200]);
    expect(spec!.ui).toBe('select');
    expect(parseShotQuery(new URLSearchParams('shot'))!.target).toBe('title');
    expect(parseShotQuery(new URLSearchParams('shot=t1&frames=99999'))!.frames).toBe(3000);
  });

  it('scripts held, pulsed and alternating input', () => {
    const idle: PlayerState = {
      x: 0, y: 0, w: 11, h: 15, vx: 0, vy: 0, facing: 1, grounded: true, onWall: 0, jumps: 0, dashT: 0, dashDirX: 0, dashDirY: 0,
      dashReady: true, dashCd: 0, stomping: false, hp: 3, invuln: 0, dead: false, deadT: 0, inWater: false, pose: 'idle', t: 0,
    };
    const s = new ShotScript(parseShotQuery(new URLSearchParams('shot=t1&hold=right&pulse=jump:26'))!);
    expect(s.mask(1, idle)).toBe(IN.RIGHT);
    expect(s.mask(26, idle) & IN.JUMP).toBe(IN.JUMP);
    expect(s.mask(27, idle) & IN.JUMP).toBe(IN.JUMP);
    expect(s.mask(29, idle) & IN.JUMP).toBe(0);
    const alt = new ShotScript(parseShotQuery(new URLSearchParams('shot=t1&hold=right&alt=10'))!);
    expect(alt.mask(5, idle) & IN.RIGHT).toBe(IN.RIGHT);
    expect(alt.mask(15, idle) & IN.LEFT).toBe(IN.LEFT);
    expect(alt.mask(15, idle) & IN.RIGHT).toBe(0);
    const bot = new ShotScript(parseShotQuery(new URLSearchParams('shot=t1&bot=wall'))!);
    const m1 = bot.mask(1, idle);
    expect(m1 & IN.JUMP).toBe(IN.JUMP);                             // grounded: jump (and aim right)
    expect(m1 & IN.RIGHT).toBe(IN.RIGHT);
    const wall: PlayerState = { ...idle, grounded: false, onWall: 1 };
    expect(bot.mask(2, wall) & IN.JUMP).toBe(0);                    // stuck to the target wall: release first…
    const m = bot.mask(3, wall);
    expect(m & IN.JUMP).toBe(IN.JUMP);                              // …then a fresh press edge
    expect(m & IN.LEFT).toBe(IN.LEFT);                            // and reverse away from the right wall
  });

  it('a wall bot actually climbs the shaft room through the sim', () => {
    const def = shaftRoom();
    const sim = new Sim(def);
    const s = new ShotScript(parseShotQuery(new URLSearchParams('shot=shaft&bot=wall'))!);
    const y0 = sim.state.player.y;
    for (let i = 1; i <= 600; i++) sim.step(s.mask(i, sim.state.player));
    expect(sim.state.stats.wallJumps).toBeGreaterThanOrEqual(2);
    expect(sim.state.player.y).toBeLessThan(y0 - 16);
  });
});

// ================================================================ scenes
describe('Scenes', () => {
  it('boots to the title with the title track and draws the backdrop', () => {
    const { scenes, ui, audio, renderer } = makeScenes([flatRoom()]);
    scenes.bootSync();
    expect(ui.screen).toBe('title');
    expect(audio.track).toBe('title');
    expect(ui.selectRefreshes).toBeGreaterThan(0);
    scenes.frame(1 / 60);
    expect(renderer.titleDraws).toBe(1);
    expect(renderer.draws).toBe(0);
  });

  it('plays a story zone to the goal, records a verifiable replay, submits and shows the result', async () => {
    const def = flatRoom();
    const { scenes, ui, audio, renderer, input, api, save, timers } = makeScenes([def]);
    scenes.bootSync();
    ui.emit({ type: 'start', levelId: 'flat' });
    expect(ui.screen).toBe('play');
    expect(scenes.run).not.toBeNull();
    expect(renderer.setLevelCalls).toBe(1);
    expect(audio.track).toBe('tidepool');
    expect(ui.banners).toContain(def.name);
    expect(save.progress.lastLevel).toBe('flat');

    input.heldMask = IN.RIGHT;
    const frames = runFrames(scenes, () => scenes.run!.sim.finished);
    expect(scenes.run!.sim.state.phase).toBe('clear');
    expect(frames).toBeLessThan(1500);
    const sim = scenes.run!.sim;
    const summary = sim.summary();
    expect(summary.cleared).toBe(true);
    // 60 Hz frames → exactly two ticks each
    expect(sim.state.tick).toBe(frames * 2);
    // the HUD was fed every frame (plus once at start) and the world drawn every frame
    expect(ui.huds.length).toBe(frames + 1);
    expect(renderer.draws).toBe(frames);
    expect(renderer.lastView!.camX).toBeGreaterThan(0);
    expect(audio.events.some((e) => e.type === 'goal')).toBe(true);

    // the result appears after the clear animation, while the sim keeps animating
    expect(ui.screen).toBe('play');
    runFrames(scenes, () => ui.screen === 'result', 200);
    expect(ui.screen).toBe('result');
    expect(ui.result).not.toBeNull();
    expect(ui.result!.summary.ticks).toBe(summary.ticks);
    expect(ui.result!.personalBest).toBe(true);
    expect(ui.result!.stars).toBeGreaterThanOrEqual(1);
    expect(ui.result!.nextLevelId).toBeUndefined();

    // progress
    const rec = save.progress.levels.flat;
    expect(rec.done).toBe(true);
    expect(rec.bestTicks).toBe(summary.ticks);
    expect(rec.masks).toBeTruthy();
    expect(save.progress.totals.shards).toBe(summary.shards);
    timers.fire();

    // the submission: the recording replays to the claimed summary
    await scenes.settle();
    expect(api.submissions.length).toBe(1);
    const body = api.submissions[0];
    expect(body.mode).toBe('story');
    expect(body.levelId).toBe('flat');
    expect(body.assist).toBe(false);
    expect(body.claim.ticks).toBe(summary.ticks);
    expect(body.player.id).toBe(save.progress.player.id);
    expect(body.client.build).toBe('test');
    // every submission names the sim / generator version it ran (the server refuses a mismatch)
    expect(body.sim).toBe(SIM_VERSION);
    expect(body.gen).toBe(GEN_VERSION);
    const masks = decodeMasks(body.masks);
    expect(masks.length).toBeLessThanOrEqual(sim.state.tick);
    const v = verifyReplay(def, { v: SIM_VERSION, levelId: 'flat', seed: def.seed, assist: false, masks }, body.claim);
    expect(v.ok).toBe(true);
    expect(ui.result!.submit.state).toBe('accepted');
    expect(ui.result!.submit.rank).toBe(1);
    expect(ui.result!.leaderboard?.entries.length).toBe(1);
    expect(save.progress.levels.flat.runId).toBe('run-1');
    expect(encodeMasks(masks)).toBe(rec.masks);

    // quit returns to zone select and drops the run
    ui.emit({ type: 'quit' });
    expect(scenes.run).toBeNull();
    expect(ui.screen).toBe('select');
    expect(audio.track).toBe('title');
  });

  it('does not submit assist runs but still records progress', async () => {
    const def = flatRoom();
    const { scenes, ui, input, api, save } = makeScenes([def], { assist: true });
    scenes.bootSync();
    ui.emit({ type: 'start', levelId: 'flat' });
    input.heldMask = IN.RIGHT;
    runFrames(scenes, () => ui.screen === 'result');
    await scenes.settle();
    expect(api.submissions.length).toBe(0);
    expect(ui.result!.submit.state).toBe('idle');
    expect(save.progress.levels.flat.done).toBe(true);
    expect(ui.result!.summary.cleared).toBe(true);
  });

  it('marks the submission offline when the server is unreachable', async () => {
    const def = flatRoom();
    const { scenes, ui, input, api } = makeScenes([def]);
    api.failWith = new TypeError('fetch failed');
    scenes.bootSync();
    ui.emit({ type: 'start', levelId: 'flat' });
    input.heldMask = IN.RIGHT;
    runFrames(scenes, () => ui.screen === 'result');
    await scenes.settle();
    expect(ui.result!.submit.state).toBe('offline');
  });

  it('freezes the sim while a menu is up, resumes cleanly and restarts', () => {
    const { scenes, ui, input, audio } = makeScenes([flatRoom()]);
    scenes.bootSync();
    ui.emit({ type: 'start', levelId: 'flat' });
    input.heldMask = IN.RIGHT;
    runFrames(scenes, () => scenes.run!.sim.state.tick >= 120);
    const tick = scenes.run!.sim.state.tick;
    ui.setScreen('pause');                     // the UI shows the pause screen itself
    scenes.frame(1 / 60);
    scenes.frame(1 / 60);
    expect(scenes.run!.sim.state.tick).toBe(tick);
    expect(audio.muffled).toBe(true);
    ui.emit({ type: 'resume' });
    expect(ui.screen).toBe('play');
    expect(audio.muffled).toBe(false);
    scenes.frame(1 / 60);
    expect(scenes.run!.sim.state.tick).toBe(tick + 2);
    const before = scenes.run!.sim;
    ui.emit({ type: 'restart' });
    expect(scenes.run!.sim).not.toBe(before);
    expect(scenes.run!.sim.state.tick).toBe(0);
    expect(input.resets).toBeGreaterThan(0);
  });

  it('runs the self echo in lockstep on the next attempt and the world echo from the board', async () => {
    const def = flatRoom();
    const { scenes, ui, input, api, save } = makeScenes([def], { echoSelf: true, echoWorld: true });
    scenes.bootSync();
    ui.emit({ type: 'start', levelId: 'flat' });
    input.heldMask = IN.RIGHT;
    runFrames(scenes, () => ui.screen === 'result');
    await scenes.settle();
    expect(save.progress.levels.flat.masks).toBeTruthy();

    // we hold the top spot ourselves: the server flags the row `you`, so no world echo doubles the self echo
    ui.emit({ type: 'retry' });
    await scenes.settle();
    expect(scenes.run!.echoes.length).toBe(1);
    expect(scenes.run!.echoes[0].label).toBe('나');
    // every board query carries our player id so the server can flag the row; ids never come back
    expect(api.lbQueries.length).toBeGreaterThan(0);
    for (const q of api.lbQueries) expect(q.playerId).toBe(save.progress.player.id);

    // a different player holds the top spot now
    api.board[0] = { ...api.board[0], ownerId: 'someone-else-1', playerTag: 'bbbbbbbbbbbb', name: '라이벌' };
    api.ghosts[api.board[0].runId] = { ...api.ghosts[api.board[0].runId], name: '라이벌' };

    ui.emit({ type: 'retry' });
    expect(ui.screen).toBe('play');
    await scenes.settle();
    const run = scenes.run!;
    expect(run.echoes.length).toBe(2);
    input.heldMask = 0;
    runFrames(scenes, () => run.sim.state.tick >= 300);
    for (const e of run.echoes) expect(e.tick).toBe(run.sim.state.tick);
    const labels = run.echoes.map((e) => e.label);
    // no row of our own on that board → the median entry (the only one) runs as the 라이벌
    expect(labels).toContain('라이벌 · 라이벌');
    // the echo query asks for the whole top 50 so the rival can be picked client-side
    expect(api.lbQueries.some((q) => q.limit === 50)).toBe(true);
  });

  it('runs the daily tower from the server seed and reports a tide game over', async () => {
    const tide = tideRoom();
    const ui = fakeUI();
    const input = fakeInput();
    const api = fakeApi([flatRoom()]);
    const { save } = makeSave();
    // the daily generator is swapped for the tiny tide room so the tide reaches the player quickly
    const s2 = new Scenes({
      renderer: fakeRenderer(), audio: fakeAudio(), ui, input, api, save, levels: [flatRoom()], build: 'test',
      makeDaily: () => ({ ...tide, id: 'daily' }), randomSeed: () => 1,
    });
    api.levels.daily = { ...tide, id: 'daily' };
    s2.bootSync();
    ui.emit({ type: 'openDaily' });
    await s2.settle();
    expect(ui.dailyCalls.at(-1)?.[2]).toBe('ok');
    ui.emit({ type: 'daily' });
    expect(ui.screen).toBe('play');
    expect(s2.run!.mode).toBe('daily');
    expect(s2.run!.daily?.seed).toBe(12345);
    expect(s2.run!.sim.seed).toBe(12345);
    input.heldMask = 0;
    runFrames(s2, () => ui.screen === 'over', 6000);
    expect(ui.screen).toBe('over');
    expect(ui.over!.summary.cleared).toBe(false);
    await s2.settle();
    expect(api.submissions.length).toBe(1);
    expect(api.submissions[0].mode).toBe('daily');
    expect(api.submissions[0].date).toBe('2026-09-06');
    expect(api.submissions[0].seed).toBe(12345);
    expect(api.submissions[0].claim.cleared).toBe(false);
    expect(save.progress.daily['2026-09-06']).toBeTruthy();
    expect(save.progress.daily['2026-09-06'].seed).toBe(12345);
    expect(ui.result?.submit.state).toBe('accepted');
  });

  /** A Scenes wired to the tiny tide room as the daily generator. */
  function tideScenes(opts: { echoWorld?: boolean } = {}) {
    const tide = tideRoom();
    const ui = fakeUI();
    const input = fakeInput();
    const api = fakeApi([flatRoom()]);
    const { save } = makeSave();
    save.settings.echoWorld = opts.echoWorld ?? false;
    const scenes = new Scenes({
      renderer: fakeRenderer(), audio: fakeAudio(), ui, input, api, save, levels: [flatRoom()], build: 'test',
      makeDaily: () => ({ ...tide, id: 'daily' }), randomSeed: () => 1,
    });
    api.levels.daily = { ...tide, id: 'daily' };
    scenes.bootSync();
    return { scenes, ui, input, api, save };
  }
  const DAILY: DailyResponse = { date: '2026-09-06', seed: 12345, levelId: 'daily', expiresAt: '2026-09-07T00:00:00.000Z' };

  it('a daily started offline stays offline through restart and retry: no board, no ghost, no submission', async () => {
    const { scenes, ui, api } = tideScenes({ echoWorld: true });
    scenes.startDaily(DAILY, { offline: true });
    expect(scenes.run!.offline).toBe(true);
    expect(scenes.run!.eligible).toBe(false);
    await scenes.settle();
    expect(api.lbQueries.length).toBe(0);

    ui.emit({ type: 'restart' });
    const restarted = scenes.run!;
    expect(restarted.offline).toBe(true);
    expect(restarted.eligible).toBe(false);
    expect(restarted.daily?.seed).toBe(12345);
    runFrames(scenes, () => ui.screen === 'over', 6000);
    await scenes.settle();
    expect(api.submissions.length).toBe(0);
    expect(api.lbQueries.length).toBe(0);
    expect(restarted.view?.submit.state).toBe('idle');

    ui.emit({ type: 'retry' });
    expect(scenes.run!.offline).toBe(true);
    runFrames(scenes, () => ui.screen === 'over', 6000);
    await scenes.settle();
    expect(api.submissions.length).toBe(0);
    expect(api.lbQueries.length).toBe(0);

    // the same daily started with the server is online again
    scenes.startDaily(DAILY);
    expect(scenes.run!.offline).toBe(false);
    expect(scenes.run!.eligible).toBe(true);
  });

  /**
   * After the intro, press jump and hold it for `holdFrames` frames (0 = a bare
   * tap, which is a sub-tile hop), then wait for the tide. Returns the summary.
   */
  function hopUntilOver(scenes: Scenes, ui: FakeUI, input: FakeInput, holdFrames: number): RunSummary {
    runFrames(scenes, () => scenes.run!.sim.state.phase === 'play');
    input.latchedMask = IN.JUMP;
    input.heldMask = holdFrames > 0 ? IN.JUMP : 0;
    let n = 0;
    runFrames(scenes, () => ++n > holdFrames, holdFrames + 1);
    input.heldMask = 0;
    runFrames(scenes, () => ui.screen === 'over', 6000);
    return scenes.run!.summary!;
  }

  it('records tide heights as whole tiles; a run that displays no higher is not a personal best', async () => {
    const { scenes, ui, input, save } = tideScenes();
    scenes.startDaily(DAILY, { offline: true });
    // a bare tap is a sub-tile hop: it displays as 0 and must never be a record
    const tap = hopUntilOver(scenes, ui, input, 0);
    expect(tap.height).toBeGreaterThan(0);
    expect(tap.height).toBeLessThan(1);
    const rec = save.progress.daily['2026-09-06'];
    expect(rec.height).toBe(0);
    expect(scenes.run!.view!.personalBest).toBe(false);
    expect(ui.over!.best).toBe(0);

    // a full jump: a fractional height of a few tiles, stored as its floor
    ui.emit({ type: 'retry' });
    const full = hopUntilOver(scenes, ui, input, 20);
    expect(full.height).toBeGreaterThan(1);
    expect(Number.isInteger(full.height)).toBe(false);
    expect(save.progress.daily['2026-09-06'].height).toBe(Math.floor(full.height));
    expect(scenes.run!.view!.personalBest).toBe(true);
    const best = save.progress.daily['2026-09-06'].height;

    // the same jump again displays the same tile count: a tie, not a record; the floor is unchanged
    ui.emit({ type: 'retry' });
    const again = hopUntilOver(scenes, ui, input, 20);
    expect(Math.floor(again.height)).toBe(best);
    expect(scenes.run!.view!.personalBest).toBe(false);
    expect(save.progress.daily['2026-09-06'].height).toBe(best);
    expect(ui.over!.best).toBe(best);
    await scenes.settle();
  });

  it('records endless heights as whole tiles', () => {
    const tide = tideRoom();
    const ui = fakeUI();
    const input = fakeInput();
    const { save } = makeSave();
    const scenes = new Scenes({
      renderer: fakeRenderer(), audio: fakeAudio(), ui, input, api: fakeApi([flatRoom()]), save, levels: [flatRoom()],
      build: 'test', makeEndless: () => ({ ...tide, id: 'endless' }), randomSeed: () => 1,
    });
    scenes.bootSync();
    ui.emit({ type: 'endless' });
    const tap = hopUntilOver(scenes, ui, input, 0);
    expect(tap.height).toBeGreaterThan(0);
    expect(tap.height).toBeLessThan(1);
    expect(save.progress.endless.bestHeight).toBe(0);
    expect(scenes.run!.view!.personalBest).toBe(false);
    ui.emit({ type: 'retry' });
    const full = hopUntilOver(scenes, ui, input, 20);
    expect(Number.isInteger(full.height)).toBe(false);
    expect(save.progress.endless.bestHeight).toBe(Math.floor(full.height));
    expect(scenes.run!.view!.personalBest).toBe(true);
  });

  it('never records more than MAX_TICKS masks', () => {
    const { scenes, ui } = makeScenes([openRoom()]);
    scenes.bootSync();
    ui.emit({ type: 'start', levelId: 'open' });
    const run = scenes.run!;
    for (let i = 0; i < MAX_TICKS + 10; i++) scenes.tick(0);
    expect(run.masks.length).toBe(MAX_TICKS);
    expect(run.sim.state.tick).toBe(MAX_TICKS + 10);
    expect(run.eligible).toBe(false);
  });

  // ---------------------------------------------------------------- P1-2 free failure
  it('a death fades to black fast and the fade clears within 20 frames of the respawn', () => {
    const { scenes, ui, input, renderer } = makeScenes([pitRoom()]);
    scenes.bootSync();
    ui.emit({ type: 'start', levelId: 'pit' });
    expect(DEATH_FADE_AT).toBeCloseTo(0.25);
    expect(FADE_IN_HALF).toBeCloseTo(0.06);
    input.heldMask = IN.RIGHT;
    // run to the fall into the pit
    runFrames(scenes, () => renderer.events.some((e) => e.type === 'death'));
    expect(renderer.events.some((e) => e.type === 'death')).toBe(true);
    expect(scenes.fx.fade).toBeLessThan(0.05);
    // dying: the fade reaches black before the sim respawns
    let peak = 0;
    let respawnAt = -1;
    for (let f = 0; f < 240 && respawnAt < 0; f++) {
      scenes.frame(1 / 60);
      peak = Math.max(peak, scenes.fx.fade);
      if (renderer.events.some((e) => e.type === 'respawn')) respawnAt = f;
    }
    expect(respawnAt).toBeGreaterThanOrEqual(0);
    expect(peak).toBeGreaterThanOrEqual(0.9);
    // fading back in: control-clear within 20 frames of the respawn event
    let clearAfter = -1;
    for (let f = 1; f <= 20 && clearAfter < 0; f++) {
      scenes.frame(1 / 60);
      if (scenes.fx.fade < 0.05) clearAfter = f;
    }
    expect(clearAfter).toBeGreaterThan(0);
    expect(clearAfter).toBeLessThanOrEqual(20);
  });

  it('a tapped or held restart bind (IN.RETRY) is recorded in the mask log exactly like any other input', () => {
    const { scenes, ui, input } = makeScenes([openRoom()]);
    scenes.bootSync();
    ui.emit({ type: 'start', levelId: 'open' });
    const run = scenes.run!;
    runFrames(scenes, () => run.sim.state.phase === 'play');
    const before = run.masks.length;
    // a tap: one press edge in the log, on the first tick of the frame only
    input.latchedMask = IN.RETRY;
    scenes.frame(1 / 60);
    const tap = [...run.masks.bytes().slice(before)];
    expect(tap.length).toBe(2);
    expect(tap[0] & IN.RETRY).toBe(IN.RETRY);
    expect(tap[1] & IN.RETRY).toBe(0);
    // a hold: every tick carries the bit (the sim derives a single edge from it)
    const mid = run.masks.length;
    input.heldMask = IN.RETRY | IN.RIGHT;
    scenes.frame(1 / 60);
    scenes.frame(1 / 60);
    input.heldMask = 0;
    const held = [...run.masks.bytes().slice(mid)];
    expect(held.length).toBe(4);
    for (const m of held) expect(m & IN.RETRY).toBe(IN.RETRY);
    // the recording survives the wire format
    const back = decodeMasks(encodeMasks(run.masks.bytes()));
    expect(back[before] & IN.RETRY).toBe(IN.RETRY);
    expect(IN.RETRY & IN_ALL).toBe(IN.RETRY);
    // a tap during hitstop is carried to the next frame that runs ticks
    scenes.fx.stop(0.05);
    const stopped = run.masks.length;
    input.latchedMask = IN.RETRY;
    scenes.frame(1 / 60);
    expect(run.masks.length).toBe(stopped);
    runFrames(scenes, () => run.masks.length > stopped, 10);
    expect(run.masks.bytes()[stopped] & IN.RETRY).toBe(IN.RETRY);
  });

  // ---------------------------------------------------------------- P1-5 guide echo + re-hints
  it('the bundled t1 guide replays on the current sim: no deaths, past the first pit, checkpoint reached', () => {
    const t1 = REAL_LEVELS[0];
    expect(t1.id).toBe('t1');
    expect(GUIDE_T1.v).toBe(SIM_VERSION);
    const masks = guideFor(t1)!;
    expect(masks).not.toBeNull();
    expect(masks.length).toBe(GUIDE_T1.ticks);
    expect(masks.length).toBeLessThan(120 * 16);
    const sim = new Sim(t1, { seed: t1.seed });
    let checkpoint = false;
    for (const m of masks) {
      sim.step(m);
      for (const ev of sim.drainEvents()) if (ev.type === 'checkpoint') checkpoint = true;
    }
    expect(sim.state.stats.deaths).toBe(0);
    expect(sim.state.player.hp).toBe(3);
    expect(sim.state.player.x).toBeGreaterThan(47 * TILE);   // the first lethal pit spans tiles 41–46
    expect(sim.state.stats.jumps).toBeGreaterThanOrEqual(2);
    expect(checkpoint).toBe(true);
    // through the verifier: an intact log for this sim version that simply does not finish the zone
    const v = verifyReplay(t1, { v: SIM_VERSION, levelId: 't1', seed: t1.seed, assist: false, masks });
    expect(v.reason).toBe('not-finished');
    expect(v.summary.deaths).toBe(0);
    // a stale recording is refused, never shown
    expect(guideFor({ ...t1, rev: 99 })).toBeNull();
    expect(guideFor(t1, t1.seed + 1)).toBeNull();
    expect(guideFor({ id: 'nope', seed: 1 })).toBeNull();
  });

  it('a first play of t1 gets one 길잡이 echo after GUIDE_DELAY that leaves at the first checkpoint, and never again', () => {
    const { scenes, ui, input, api, save } = makeScenes(REAL_LEVELS, { echoSelf: true, echoWorld: false });
    scenes.bootSync();
    ui.emit({ type: 'start', levelId: 't1' });
    const run = scenes.run!;
    expect(run.echoes).toHaveLength(0);
    runFrames(scenes, () => run.t >= GUIDE_DELAY - 0.2, 400);
    expect(run.echoes).toHaveLength(0);
    runFrames(scenes, () => run.echoes.length > 0, 60);
    expect(run.echoes).toHaveLength(1);
    expect(run.echoes[0].label).toBe(GUIDE_LABEL);
    expect(run.guide).toBe(run.echoes[0]);
    // lockstep with the live sim from the moment it appeared
    const at = run.sim.state.tick;
    runFrames(scenes, () => run.sim.state.tick >= at + 60);
    expect(run.guide!.tick).toBe(run.sim.state.tick - at);
    expect(run.guide!.view()?.label).toBe(GUIDE_LABEL);
    // the guide's inputs are its own: the live mask log stays the player's
    expect(run.masks.bytes().every((m) => m === 0)).toBe(true);
    // the player reaches the checkpoint (tile 49): the guide is gone
    scenes.teleport(47 * TILE + 8, 16 * TILE);   // on the far lip of the first pit (tiles 41–46)
    input.heldMask = IN.RIGHT;
    runFrames(scenes, () => run.guide === null, 600);
    expect(run.guide).toBeNull();
    expect(run.echoes.some((e) => e.label === GUIDE_LABEL)).toBe(false);
    expect(ui.toasts).toContain('기록 지점');
    input.heldMask = 0;
    // a restart of the same zone, or a later visit, shows no guide
    ui.emit({ type: 'restart' });
    const again = scenes.run!;
    runFrames(scenes, () => again.t >= GUIDE_DELAY + 1, 600);
    expect(again.echoes.some((e) => e.label === GUIDE_LABEL)).toBe(false);
    expect(save.progress.seen.t1).toBe(true);
    expect(api.submissions).toHaveLength(0);
  });

  it('two pit deaths in one checkpoint segment bring the double-jump hint back; spikes bring the dash hint', () => {
    const { scenes, ui, input, renderer } = makeScenes([pitRoom()]);
    scenes.bootSync();
    ui.emit({ type: 'start', levelId: 'pit' });
    input.heldMask = IN.RIGHT;
    const deaths = () => renderer.events.filter((e) => e.type === 'death').length;
    runFrames(scenes, () => deaths() >= 1);
    runFrames(scenes, () => scenes.run!.sim.state.phase === 'play', 300);
    expect(ui.hints.filter((h) => h === REHINT_PIT)).toHaveLength(0);
    runFrames(scenes, () => deaths() >= REHINT_DEATHS);
    expect(deaths()).toBe(REHINT_DEATHS);
    let n = 0;
    runFrames(scenes, () => ++n > (HINT_DELAY + 0.2) * 60, 1000);
    expect(ui.hints.filter((h) => h === REHINT_PIT)).toHaveLength(1);
    expect(ui.toasts.filter((t) => t === '심연').length).toBeGreaterThanOrEqual(2);

    const spikes = makeScenes([spikeRoom()]);
    spikes.scenes.bootSync();
    spikes.ui.emit({ type: 'start', levelId: 'spikes' });
    spikes.input.heldMask = IN.RIGHT;
    const spikeDeaths = () => spikes.renderer.events.filter((e) => e.type === 'death' && e.cause === 'spike').length;
    runFrames(spikes.scenes, () => spikeDeaths() >= REHINT_DEATHS, 6000);
    expect(spikeDeaths()).toBe(REHINT_DEATHS);
    let k = 0;
    runFrames(spikes.scenes, () => ++k > (HINT_DELAY + 0.2) * 60, 1000);
    expect(spikes.ui.hints.filter((h) => h === REHINT_HAZARD)).toHaveLength(1);
    expect(spikes.ui.hints.filter((h) => h === REHINT_PIT)).toHaveLength(0);
  });

  // ---------------------------------------------------------------- P1-4 first clear → the tower
  it('the very first clear returns to the tower with the next zone reported as unlocked; later clears go straight on', async () => {
    const first = flatRoom();
    const second = { ...openRoom(), id: 'second', name: '두 번째' };
    const { scenes, ui, input } = makeScenes([first, second]);
    scenes.bootSync();
    ui.emit({ type: 'start', levelId: 'flat' });
    expect(scenes.run!.firstEver).toBe(true);
    input.heldMask = IN.RIGHT;
    runFrames(scenes, () => ui.screen === 'result');
    expect(ui.result!.nextLevelId).toBe('second');
    expect(ui.result!.unlocked).toEqual({ levelId: 'second', name: '두 번째' });
    expect(ui.unlockCalls.at(-1)).toEqual(new Set(['second']));
    ui.emit({ type: 'next' });
    expect(scenes.run).toBeNull();
    expect(ui.screen).toBe('select');
    await scenes.settle();

    // second clear of the same zone: nothing new opens, and 다음 구역 starts the next zone directly
    ui.emit({ type: 'start', levelId: 'flat' });
    expect(scenes.run!.firstEver).toBe(false);
    runFrames(scenes, () => ui.screen === 'result');
    expect(ui.result!.unlocked).toBeUndefined();
    expect(ui.unlockCalls.at(-1)).toEqual(new Set());
    ui.emit({ type: 'next' });
    expect(ui.screen).toBe('play');
    expect(scenes.run!.def.id).toBe('second');
    await scenes.settle();
  });

  // ---------------------------------------------------------------- P1-6 goal under the HUD
  it('forwards the renderer\'s goalScreen to the UI every drawn frame', () => {
    const { scenes, ui, renderer } = makeScenes([flatRoom()]);
    scenes.bootSync();
    ui.emit({ type: 'start', levelId: 'flat' });
    scenes.frame(1 / 60);
    expect(ui.goalScreens.at(-1)).toBeNull();
    const g = { x: 900, y: 40, onScreen: true };
    (renderer as { goalScreen: typeof g | null }).goalScreen = g;
    scenes.frame(1 / 60);
    expect(ui.goalScreens.at(-1)).toBe(g);
  });

  it('applies settings, names and echo toggles from the UI', () => {
    const { scenes, ui, save, timers, input } = makeScenes([flatRoom()]);
    scenes.bootSync();
    ui.emit({ type: 'setName', name: '새이름' });
    expect(save.progress.player.name).toBe('새이름');
    const binds: Binds = { ...BINDS, jump: ['KeyJ'] };
    ui.emit({ type: 'rebind', binds });
    expect(save.settings.binds.jump).toEqual(['KeyJ']);
    save.settings.echoWorld = true;
    ui.emit({ type: 'toggleEcho', which: 'world', on: true });
    timers.fire();
    expect(timers.pending()).toBe(0);
    ui.emit({ type: 'start', levelId: 'flat' });
    ui.emit({ type: 'resetProgress' });
    expect(save.progress.levels).toEqual({});
    expect(scenes.run).not.toBeNull();
    void input;
    void DT;
  });
});

// ================================================================ offline queue + daily cache
describe('Scenes offline queue', () => {
  const NOW = Date.parse('2026-09-06T12:00:00.000Z');
  const DAILY: DailyResponse = { date: '2026-09-06', seed: 12345, levelId: 'daily', expiresAt: '2026-09-07T00:00:00.000Z' };

  function queuedScenes(levels: LevelDef[], opts: { storage?: MemStorage; daily?: boolean } = {}) {
    const ui = fakeUI();
    const input = fakeInput();
    const api = fakeApi(levels);
    const { save, timers, storage } = makeSave(opts.storage ?? new MemStorage());
    save.settings.echoWorld = false;
    const queue = new SubmitQueue({ storage, now: () => NOW });
    const tide = tideRoom();
    const scenes = new Scenes({
      renderer: fakeRenderer(), audio: fakeAudio(), ui, input, api, save, queue, levels, build: 'test',
      randomSeed: () => 777, random: () => 0.5, now: () => NOW,
      ...(opts.daily ? { makeDaily: () => ({ ...tide, id: 'daily' }) } : {}),
    });
    if (opts.daily) api.levels.daily = { ...tide, id: 'daily' };
    return { scenes, ui, input, api, save, timers, storage, queue };
  }

  it('queues a story submission the server could not receive; flushQueue() sends it later, adopts the run id and settles the result line', async () => {
    const def = flatRoom();
    const { scenes, ui, input, api, save, storage, queue } = queuedScenes([def]);
    api.failWith = new TypeError('fetch failed');
    scenes.bootSync();
    ui.emit({ type: 'start', levelId: 'flat' });
    input.heldMask = IN.RIGHT;
    runFrames(scenes, () => ui.screen === 'result');
    await scenes.settle();
    expect(ui.result!.submit.state).toBe('queued');
    expect(api.submissions.length).toBe(0);
    expect(queue.size()).toBe(1);
    const stored = JSON.parse(storage.getItem(QUEUE_KEY)!) as { body: RunSubmit; mode: string; board: string; levelId: string; createdAt: number }[];
    expect(stored[0]).toMatchObject({ mode: 'story', board: 'flat', levelId: 'flat', createdAt: NOW });
    expect(stored[0].body.masks).toBe(save.progress.levels.flat.masks);
    expect(stored[0].body.claim.cleared).toBe(true);
    expect(save.progress.levels.flat.runId).toBeUndefined();

    // still unreachable: nothing goes out, nothing is lost
    expect(await scenes.flushQueue()).toEqual({ sent: 0, dropped: 0, kept: 1 });
    expect(ui.result!.submit.state).toBe('queued');
    expect(queue.size()).toBe(1);

    // the network is back
    api.failWith = null;
    expect(await scenes.flushQueue()).toEqual({ sent: 1, dropped: 0, kept: 0 });
    expect(api.submissions.length).toBe(1);
    expect(api.submissions[0].levelId).toBe('flat');
    expect(save.progress.levels.flat.runId).toBe('run-1');
    expect(ui.result!.submit.state).toBe('accepted');
    expect(ui.result!.submit.rank).toBe(1);
    expect(storage.getItem(QUEUE_KEY)).toBeNull();
    expect(await scenes.flushQueue()).toBeNull();
  });

  it('a daily run queued offline stays eligible and lands on the daily record when sent', async () => {
    const { scenes, ui, input, api, save, queue } = queuedScenes([flatRoom()], { daily: true });
    api.failWith = new ApiError('HTTP 503', 503, 'server-error');
    scenes.bootSync();
    scenes.startDaily(DAILY);
    expect(scenes.run!.offline).toBe(false);
    expect(scenes.run!.eligible).toBe(true);
    // climb a little so the run is a height record (its masks become the stored best), then let the tide come
    runFrames(scenes, () => scenes.run!.sim.state.phase === 'play');
    input.latchedMask = IN.JUMP;
    input.heldMask = IN.JUMP;
    let n = 0;
    runFrames(scenes, () => ++n > 12, 13);
    input.heldMask = 0;
    runFrames(scenes, () => ui.screen === 'over', 6000);
    await scenes.settle();
    expect(ui.result!.submit.state).toBe('queued');
    const item = queue.list()[0];
    expect(item).toMatchObject({ mode: 'daily', board: '2026-09-06', levelId: 'daily' });
    expect(item.body.seed).toBe(12345);
    expect(save.progress.daily['2026-09-06'].masks).toBe(item.body.masks);
    api.failWith = null;
    await scenes.flushQueue();
    expect(api.submissions.length).toBe(1);
    expect(api.submissions[0].mode).toBe('daily');
    expect(save.progress.daily['2026-09-06'].runId).toBe('run-1');
    expect(ui.result!.submit.state).toBe('accepted');
  });

  it('a queued run the server rejects is dropped without touching the record; a stale one never tags a newer best', async () => {
    const def = flatRoom();
    const { scenes, api, save, queue } = queuedScenes([def]);
    scenes.bootSync();
    const rec = save.levelRecord('flat');
    rec.done = true;
    rec.masks = 'NEWER-BEST';
    const player = { ...save.progress.player };
    const bogus = encodeMasks(new Uint8Array([0, 0, 0, 0]));
    queue.enqueue({
      player, mode: 'story', levelId: 'flat', assist: false, masks: bogus,
      claim: { ticks: 4, shards: 0, deaths: 0, cleared: true, height: 0 }, client: { build: 'test' },
    }, { mode: 'story', board: 'flat', levelId: 'flat' });
    // a genuine run whose masks no longer match the stored best
    const sim = new Sim(def, { seed: def.seed });
    const masks: InputMask[] = [];
    while (!sim.finished && masks.length < 5000) { sim.step(IN.RIGHT); masks.push(IN.RIGHT); }
    const s = sim.summary();
    queue.enqueue({
      player, mode: 'story', levelId: 'flat', assist: false, masks: encodeMasks(new Uint8Array(masks)),
      claim: { ticks: s.ticks, shards: s.shards, deaths: s.deaths, cleared: s.cleared, height: s.height }, client: { build: 'test' },
    }, { mode: 'story', board: 'flat', levelId: 'flat' });
    const r = await scenes.flushQueue();
    expect(r).toEqual({ sent: 2, dropped: 0, kept: 0 });
    expect(api.submissions.length).toBe(2);
    expect(rec.runId).toBeUndefined();
    expect(rec.masks).toBe('NEWER-BEST');
    expect(queue.size()).toBe(0);
  });

  it('boot() flushes what an earlier session left behind', async () => {
    const def = flatRoom();
    const storage = new MemStorage();
    // session one: play offline
    const first = queuedScenes([def], { storage });
    first.api.failWith = new TypeError('fetch failed');
    first.scenes.bootSync();
    first.ui.emit({ type: 'start', levelId: 'flat' });
    first.input.heldMask = IN.RIGHT;
    runFrames(first.scenes, () => first.ui.screen === 'result');
    await first.scenes.settle();
    first.timers.fire();
    expect(JSON.parse(storage.getItem(QUEUE_KEY)!)).toHaveLength(1);
    // session two: online again
    const second = queuedScenes([def], { storage });
    expect(second.queue.size()).toBe(1);
    await second.scenes.boot({ raf: async () => {}, wait: async () => {} });
    await second.scenes.settle();
    expect(second.api.submissions.length).toBe(1);
    expect(second.save.progress.levels.flat.runId).toBe('run-1');
    expect(second.queue.size()).toBe(0);
    expect(second.ui.screen).toBe('title');
  });

  it('without a queue an unreachable server still reads as offline', async () => {
    const def = flatRoom();
    const { scenes, ui, input, api } = makeScenes([def]);
    api.failWith = new TypeError('fetch failed');
    scenes.bootSync();
    ui.emit({ type: 'start', levelId: 'flat' });
    input.heldMask = IN.RIGHT;
    runFrames(scenes, () => ui.screen === 'result');
    await scenes.settle();
    expect(ui.result!.submit.state).toBe('offline');
    expect(await scenes.flushQueue()).toBeNull();
  });
});

describe('Scenes daily cache', () => {
  const NOW = Date.parse('2026-09-06T12:00:00.000Z');

  function dailyScenes(storage: MemStorage) {
    const ui = fakeUI();
    const input = fakeInput();
    const api = fakeApi([flatRoom()]);
    const { save } = makeSave(storage);
    const tide = tideRoom();
    const scenes = new Scenes({
      renderer: fakeRenderer(), audio: fakeAudio(), ui, input, api, save, levels: [flatRoom()], build: 'test',
      makeDaily: () => ({ ...tide, id: 'daily' }), randomSeed: () => 1, now: () => NOW,
    });
    api.levels.daily = { ...tide, id: 'daily' };
    scenes.bootSync();
    return { scenes, ui, api, save, storage };
  }
  const offlineDaily = async (): Promise<DailyResponse> => { throw new ApiError('network error', 0, 'network'); };

  it('caches the fetched seed and starts a real (eligible) daily from it when the server is unreachable', async () => {
    const storage = new MemStorage();
    const online = dailyScenes(storage);
    online.ui.emit({ type: 'openDaily' });
    await online.scenes.settle();
    expect(JSON.parse(storage.getItem(DAILY_CACHE_KEY)!)).toEqual({ date: '2026-09-06', seed: 12345, expiresAt: '2026-09-07T00:00:00.000Z' });

    // a later boot, offline
    const off = dailyScenes(storage);
    off.api.daily = offlineDaily;
    off.ui.emit({ type: 'openDaily' });
    await off.scenes.settle();
    const last = off.ui.dailyCalls.at(-1)!;
    expect(last[2]).toBe('error');
    expect(last[0]).toEqual({ date: '2026-09-06', seed: 12345, levelId: 'daily', expiresAt: '2026-09-07T00:00:00.000Z' });
    off.ui.emit({ type: 'daily' });
    expect(off.ui.screen).toBe('play');
    const run = off.scenes.run!;
    expect(run.mode).toBe('daily');
    expect(run.seed).toBe(12345);
    expect(run.daily).toEqual({ date: '2026-09-06', seed: 12345 });
    expect(run.offline).toBe(false);
    expect(run.eligible).toBe(true);
  });

  it('reports the missing seed when nothing is cached for today (or only another day)', async () => {
    const storage = new MemStorage();
    storage.setItem(DAILY_CACHE_KEY, JSON.stringify({ date: '2026-09-05', seed: 999, expiresAt: '2026-09-06T00:00:00.000Z' }));
    const { scenes, ui, api } = dailyScenes(storage);
    api.daily = offlineDaily;
    ui.emit({ type: 'openDaily' });
    await scenes.settle();
    expect(ui.dailyCalls.at(-1)).toEqual([null, null, 'error']);
    ui.emit({ type: 'daily' });
    expect(scenes.run).toBeNull();
    expect(ui.toasts).toContain('오늘의 탑을 아직 받지 못했다');
    expect(ui.screen).toBe('title');
  });

  it('keeps the seed already fetched this session when a refresh fails', async () => {
    const { scenes, ui, api } = dailyScenes(new MemStorage());
    ui.emit({ type: 'openDaily' });
    await scenes.settle();
    expect(ui.dailyCalls.at(-1)?.[2]).toBe('ok');
    api.daily = offlineDaily;
    ui.emit({ type: 'openDaily' });
    await scenes.settle();
    const last = ui.dailyCalls.at(-1)!;
    expect(last[2]).toBe('error');
    expect(last[0]?.seed).toBe(12345);
    expect(last[1]).not.toBeNull(); // the board fetched earlier stays on screen
  });
});

// ================================================================ Phase 1 shell: versions · telemetry · lifecycle
describe('Scenes · SIM_VERSION guard (P1-1)', () => {
  it('a sim-version rejection shows the reason, flags the UI as behind and asks for an update check', async () => {
    const def = flatRoom();
    const { scenes, ui, input, api, newer } = makeScenes([def]);
    scenes.bootSync();
    // a server that already runs the next sim refuses this build's replays
    api.submitRun = async (body) => { api.submissions.push(body); return { accepted: false, reason: 'sim-version' }; };
    ui.emit({ type: 'start', levelId: 'flat' });
    input.heldMask = IN.RIGHT;
    runFrames(scenes, () => ui.screen === 'result');
    await scenes.settle();
    expect(api.submissions.length).toBe(1);
    expect(ui.result!.submit).toEqual({ state: 'rejected', reason: 'sim-version' });
    expect(ui.versionBehind).toEqual([true]);
    expect(newer).toEqual([null]);
  });

  it('boot() compares /api/health.simVersion with the bundle without blocking: newer → update offered, same → nothing', async () => {
    const hooks = { raf: async () => {}, wait: async () => {} };
    const same = makeScenes([flatRoom()]);
    same.api.healthSim = SIM_VERSION;
    await same.scenes.boot(hooks);
    await same.scenes.settle();
    expect(same.api.healthCalls).toBe(1);
    expect(same.ui.versionBehind).toEqual([]);
    expect(same.newer).toEqual([]);

    const newer = makeScenes([flatRoom()]);
    newer.api.healthSim = SIM_VERSION + 1;
    await newer.scenes.boot(hooks);
    expect(newer.ui.screen).toBe('title'); // boot never waited on the network
    await newer.scenes.settle();
    expect(newer.ui.versionBehind).toEqual([true]);
    expect(newer.newer).toEqual([SIM_VERSION + 1]);

    // a pre-P1 server (no field) and a failing health check are both silent
    const legacy = makeScenes([flatRoom()]);
    await legacy.scenes.boot(hooks);
    await legacy.scenes.settle();
    expect(legacy.ui.versionBehind).toEqual([]);
    const down = makeScenes([flatRoom()]);
    down.api.health = async () => { throw new ApiError('network error', 0, 'network'); };
    await down.scenes.boot(hooks);
    await down.scenes.settle();
    expect(down.ui.versionBehind).toEqual([]);
    expect(down.ui.screen).toBe('title');
  });

  it('a daily issued by a newer sim / generator is not started: the update is offered instead', async () => {
    const { scenes, ui, api, newer } = makeScenes([flatRoom()]);
    scenes.bootSync();
    api.dailySim = SIM_VERSION + 1;
    ui.emit({ type: 'openDaily' });
    await scenes.settle();
    expect(newer).toEqual([SIM_VERSION + 1]);
    expect(ui.versionBehind).toEqual([true]);
    ui.emit({ type: 'daily' });
    expect(scenes.run).toBeNull();
    expect(ui.toasts.at(-1)).toMatch(/새 버전/);
    // the generator alone being ahead is the same situation
    const gen = makeScenes([flatRoom()]);
    gen.scenes.bootSync();
    gen.api.dailySim = SIM_VERSION;
    gen.api.dailyGen = GEN_VERSION + 1;
    gen.ui.emit({ type: 'openDaily' });
    await gen.scenes.settle();
    gen.ui.emit({ type: 'daily' });
    expect(gen.scenes.run).toBeNull();
    // matching versions start normally
    const ok = makeScenes([flatRoom()]);
    ok.scenes.bootSync();
    ok.api.dailySim = SIM_VERSION;
    ok.api.dailyGen = GEN_VERSION;
    ok.ui.emit({ type: 'openDaily' });
    await ok.scenes.settle();
    ok.ui.emit({ type: 'daily' });
    expect(ok.scenes.run?.mode).toBe('daily');
    expect(ok.ui.versionBehind).toEqual([]);
  });

  it('the self echo ignores stored masks from another SIM_VERSION and runs the versioned ones', async () => {
    const def = flatRoom();
    const stale = makeScenes([def], { echoSelf: true });
    stale.scenes.bootSync();
    stale.save.progress.levels.flat = { done: true, bestTicks: 100, bestShards: 0, stars: 1, relics: 0, deaths: 0, masks: encodeMasks(Uint8Array.from([2, 2, 2])) };
    stale.ui.emit({ type: 'start', levelId: 'flat' });
    await stale.scenes.settle();
    expect(stale.scenes.run!.echoes.length).toBe(0);

    const fresh = makeScenes([def], { echoSelf: true });
    fresh.scenes.bootSync();
    const rec: LevelRecord = { done: true, bestTicks: 100, bestShards: 0, stars: 1, relics: 0, deaths: 0 };
    markEcho(rec, encodeMasks(Uint8Array.from([2, 2, 2])));
    fresh.save.progress.levels.flat = rec;
    fresh.ui.emit({ type: 'start', levelId: 'flat' });
    await fresh.scenes.settle();
    expect(fresh.scenes.run!.echoes.length).toBe(1);
    expect(fresh.scenes.run!.echoes[0].label).toBe('나');
  });

  it('boot counts the UTC play day and reports the retention buckets on the boot event', async () => {
    let t = Date.UTC(2026, 8, 6, 12);
    const { scenes, save, tele } = makeScenes([flatRoom()], { now: () => t });
    scenes.bootSync();
    expect(save.progress.firstSeen).toBe(t);
    expect(save.progress.playDays).toBe(1);
    expect(save.progress.lastPlayDay).toBe('2026-09-06');
    const boot = tele.of('boot');
    expect(boot.length).toBe(1);
    expect(boot[0]).toMatchObject({ uaFamily: 'desktop', dpr: 2, hwConcurrency: 8, daysSinceFirstSeen: '0', daysPlayedBucket: '1' });
    // the next day, a second boot of the same save is a D1 return
    t += 86_400_000;
    const again = new Scenes({
      renderer: fakeRenderer(), audio: fakeAudio(), ui: fakeUI(), input: fakeInput(), api: fakeApi([flatRoom()]), save,
      levels: [flatRoom()], telemetry: tele, now: () => t,
    });
    again.bootSync();
    expect(save.progress.playDays).toBe(2);
    expect(tele.of('boot')[1]).toMatchObject({ daysSinceFirstSeen: '1', daysPlayedBucket: '2-6' });
  });
});

describe('Scenes · telemetry hooks (P1-3)', () => {
  it('reports the funnel of a story run without any identity: screens, zone_start, death{tx,ty,checkpointIdx}, respawn, clear, result_shown, submit_result, quit', async () => {
    const def = pitRoom();
    const { scenes, ui, input, renderer, tele, save } = makeScenes([def]);
    scenes.bootSync();
    scenes.frame(1 / 60);
    expect(tele.screens).toEqual(['title']);
    ui.emit({ type: 'start', levelId: 'pit' });
    expect(tele.of('zone_start')).toEqual([{ levelId: 'pit', mode: 'story', restart: false }]);
    input.heldMask = IN.RIGHT;
    runFrames(scenes, () => renderer.events.some((e) => e.type === 'death'));
    const deathEv = renderer.events.find((e) => e.type === 'death') as Extract<SimEvent, { type: 'death' }>;
    const death = tele.of('death');
    expect(death.length).toBe(1);
    expect(death[0]).toEqual({
      levelId: 'pit', cause: 'pit', tx: Math.floor(deathEv.x / TILE), ty: Math.floor(deathEv.y / TILE), checkpointIdx: 0,
    });
    runFrames(scenes, () => renderer.events.some((e) => e.type === 'respawn'));
    const respawn = tele.of('respawn');
    expect(respawn.length).toBe(1);
    expect(respawn[0].levelId).toBe('pit');
    // the death → control gap the player felt, in wall ms (0.6 s of sim = 36 frames at 60 Hz)
    expect(respawn[0].ms).toBeGreaterThan(400);
    expect(respawn[0].ms).toBeLessThan(900);
    expect(tele.screens).toEqual(['title', 'play']);
    // quit mid-run
    ui.emit({ type: 'quit' });
    const quit = tele.of('quit');
    expect(quit.length).toBe(1);
    expect(quit[0]).toMatchObject({ levelId: 'pit', mode: 'story', finished: false });
    expect(typeof quit[0].t).toBe('number');
    scenes.frame(1 / 60);
    expect(tele.screens).toEqual(['title', 'play', 'select']);

    // a clear reports the summary and the verdict
    const flat = flatRoom();
    const s2 = makeScenes([flat]);
    s2.scenes.bootSync();
    s2.ui.emit({ type: 'start', levelId: 'flat' });
    s2.input.heldMask = IN.RIGHT;
    runFrames(s2.scenes, () => s2.ui.screen === 'result');
    await s2.scenes.settle();
    const clear = s2.tele.of('clear');
    expect(clear.length).toBe(1);
    expect(clear[0]).toMatchObject({ levelId: 'flat', deaths: 0 });
    expect(typeof clear[0].ticks).toBe('number');
    expect(typeof clear[0].shards).toBe('number');
    expect(s2.tele.of('result_shown')).toEqual([{ levelId: 'flat', kind: 'clear', mode: 'story' }]);
    expect(s2.tele.of('submit_result')).toEqual([{ accepted: true, mode: 'story', levelId: 'flat' }]);
    s2.ui.emit({ type: 'retry' });
    expect(s2.tele.of('retry')).toEqual([{ levelId: 'flat', mode: 'story', kind: 'retry' }]);
    expect(s2.tele.of('zone_start').at(-1)).toEqual({ levelId: 'flat', mode: 'story', restart: true });
    // nothing that identifies the player ever reaches the sink
    const blob = JSON.stringify(s2.tele.events);
    expect(blob).not.toContain(s2.save.progress.player.id);
    expect(blob).not.toContain(s2.save.progress.player.name);
    expect(blob).not.toContain(save.progress.player.id);
  });

  it('daily runs report daily_start / daily_over and the submission verdict', async () => {
    const tide = { ...tideRoom(), id: 'daily' };
    const { scenes, ui, input, api, tele } = makeScenes([flatRoom()], { makeDaily: () => tide });
    api.levels.daily = tide;
    scenes.bootSync();
    api.dailySim = SIM_VERSION;
    api.dailyGen = GEN_VERSION;
    ui.emit({ type: 'openDaily' });
    await scenes.settle();
    ui.emit({ type: 'daily' });
    expect(tele.of('daily_start')).toEqual([{ levelId: 'daily', mode: 'daily', restart: false }]);
    input.heldMask = 0;
    runFrames(scenes, () => ui.screen === 'over', 20_000);
    expect(tele.of('daily_over').length).toBe(1);
    expect(tele.of('result_shown').at(-1)).toMatchObject({ kind: 'over', mode: 'daily' });
    await scenes.settle();
    const sub = tele.of('submit_result');
    expect(sub.length).toBe(1);
    expect(sub[0].mode).toBe('daily');
    if (!sub[0].accepted) expect(typeof sub[0].reason).toBe('string');
  });
});

describe('Scenes · lifecycle (P1-7 · SW reload safety)', () => {
  it('menu screens draw the title backdrop at most 30 times a second', () => {
    const { scenes, renderer } = makeScenes([flatRoom()]);
    scenes.bootSync();
    for (let i = 0; i < 60; i++) scenes.frame(1 / 60);
    expect(renderer.titleDraws).toBeLessThanOrEqual(31);
    expect(renderer.titleDraws).toBeGreaterThanOrEqual(29);
    expect(MENU_FRAME_DT).toBeCloseTo(1 / 30);
    // a slower display still draws every frame
    const slow = makeScenes([flatRoom()]);
    slow.scenes.bootSync();
    for (let i = 0; i < 30; i++) slow.scenes.frame(1 / 30);
    expect(slow.renderer.titleDraws).toBe(30);
  });

  it('a lost gamepad pauses a live run with a toast, and does nothing outside play', () => {
    const { scenes, ui, input } = makeScenes([flatRoom()]);
    scenes.bootSync();
    scenes.gamepadLost();
    expect(ui.screen).toBe('title');
    ui.emit({ type: 'start', levelId: 'flat' });
    runFrames(scenes, () => scenes.run!.sim.state.phase === 'play');
    const tick = scenes.run!.sim.state.tick;
    scenes.gamepadLost();
    expect(ui.screen).toBe('pause');
    expect(ui.toasts).toContain('게임패드 연결이 끊겼다');
    input.heldMask = IN.RIGHT;
    for (let i = 0; i < 10; i++) scenes.frame(1 / 60);
    expect(scenes.run!.sim.state.tick).toBe(tick);
    // a second loss while already paused is silent
    const toasts = ui.toasts.length;
    scenes.gamepadLost();
    expect(ui.toasts.length).toBe(toasts);
  });

  it('the result timer keeps running while a menu is up, so a pause during the clear animation still lands on the result', () => {
    const { scenes, ui, input } = makeScenes([flatRoom()]);
    scenes.bootSync();
    ui.emit({ type: 'start', levelId: 'flat' });
    input.heldMask = IN.RIGHT;
    runFrames(scenes, () => scenes.run!.sim.finished);
    expect(scenes.run!.resultTimer).toBeGreaterThan(0);
    ui.show('pause');
    const before = scenes.run!.resultTimer;
    scenes.frame(1 / 60);
    expect(scenes.run!.resultTimer).toBeLessThan(before);
    runFrames(scenes, () => ui.screen === 'result', Math.ceil(RESULT_DELAY * 60) + 5);
    expect(ui.screen).toBe('result');
  });

  it('after a hidden → visible transition the next frame renders once and runs no catch-up ticks', () => {
    const { scenes, ui, input, renderer } = makeScenes([openRoom()]);
    scenes.bootSync();
    ui.emit({ type: 'start', levelId: 'open' });
    runFrames(scenes, () => scenes.run!.sim.state.phase === 'play');
    input.heldMask = IN.RIGHT;
    const tick = scenes.run!.sim.state.tick;
    const draws = renderer.draws;
    scenes.visibility(true);
    scenes.visibility(false);
    scenes.frame(0.25); // the long gap the rAF loop reports after the tab returns
    expect(scenes.run!.sim.state.tick).toBe(tick);
    expect(renderer.draws).toBe(draws + 1);
    // the frame after that runs normally
    scenes.frame(1 / 60);
    expect(scenes.run!.sim.state.tick).toBe(tick + 2);
    // hidden alone (no return yet) leaves the frame accounting untouched
    scenes.visibility(true);
    scenes.frame(1 / 60);
    expect(scenes.run!.sim.state.tick).toBe(tick + 4);
  });

  it('isBusy() is true from zone start until the result has settled; onRunEnd fires once per run', async () => {
    const def = flatRoom();
    const { scenes, ui, input } = makeScenes([def]);
    let ends = 0;
    scenes.onRunEnd(() => { ends++; });
    scenes.bootSync();
    expect(scenes.isBusy()).toBe(false);
    ui.emit({ type: 'start', levelId: 'flat' });
    expect(scenes.isBusy()).toBe(true);
    ui.show('pause');
    expect(scenes.isBusy()).toBe(true); // paused is still a run in progress
    ui.emit({ type: 'resume' });
    input.heldMask = IN.RIGHT;
    runFrames(scenes, () => ui.screen === 'result');
    // the result is up but the submission is still pending: not yet
    expect(scenes.run!.view!.submit.state).toBe('pending');
    expect(scenes.isBusy()).toBe(true);
    expect(ends).toBe(0);
    await scenes.settle();
    expect(scenes.run!.view!.submit.state).toBe('accepted');
    expect(scenes.isBusy()).toBe(false);
    expect(ends).toBe(1);
    ui.emit({ type: 'quit' });
    expect(ends).toBe(1);
    expect(scenes.isBusy()).toBe(false);
    // a quit mid-run ends the run too
    ui.emit({ type: 'start', levelId: 'flat' });
    expect(scenes.isBusy()).toBe(true);
    ui.emit({ type: 'quit' });
    expect(ends).toBe(2);
    expect(scenes.isBusy()).toBe(false);
    // assist runs (never submitted) end when the result shows
    const assist = makeScenes([def], { assist: true });
    let aEnds = 0;
    assist.scenes.onRunEnd(() => { aEnds++; });
    assist.scenes.bootSync();
    assist.ui.emit({ type: 'start', levelId: 'flat' });
    assist.input.heldMask = IN.RIGHT;
    runFrames(assist.scenes, () => assist.ui.screen === 'result');
    expect(aEnds).toBe(1);
    expect(assist.scenes.isBusy()).toBe(false);
  });
});

// ================================================================ Phase 2 (P2-2 · P2-3 · P2-5 · P2-6)
/** After the intro, hold jump for `holdFrames` frames (0 = a bare tap), then wait for the tide. Returns the summary. */
function hopOver(scenes: Scenes, ui: FakeUI, input: FakeInput, holdFrames: number): RunSummary {
  runFrames(scenes, () => scenes.run!.sim.state.phase === 'play');
  input.latchedMask = IN.JUMP;
  input.heldMask = holdFrames > 0 ? IN.JUMP : 0;
  let n = 0;
  runFrames(scenes, () => ++n > holdFrames, holdFrames + 1);
  input.heldMask = 0;
  runFrames(scenes, () => ui.screen === 'over', 6000);
  return scenes.run!.summary!;
}

const TODAY = '2026-09-06';
const YESTERDAY = '2026-09-05';
const Y_SEED = 777;

/** Endless and daily both generate the tiny tide room; endless seeds count up from 1000 so 새 탑 really differs. */
function tideShell(opts: { yesterday?: boolean; name?: string; echoWorld?: boolean } = {}) {
  const tide = tideRoom();
  const ui = fakeUI();
  const input = fakeInput();
  const api = fakeApi([flatRoom()]);
  api.levels.daily = { ...tide, id: 'daily' };
  if (opts.yesterday) {
    api.daily = async () => ({ date: TODAY, seed: 12345, levelId: 'daily', expiresAt: '2026-09-07T00:00:00.000Z', yesterday: { date: YESTERDAY, seed: Y_SEED } });
  }
  const { save, timers, storage } = makeSave();
  save.settings.echoWorld = opts.echoWorld ?? false;
  if (opts.name) save.progress.player.name = opts.name;
  let n = 0;
  const scenes = new Scenes({
    renderer: fakeRenderer(), audio: fakeAudio(), ui, input, api, save, levels: [flatRoom()], build: 'test',
    makeDaily: () => ({ ...tide, id: 'daily' }), makeEndless: () => ({ ...tide, id: 'endless' }), randomSeed: () => 1000 + n++,
    now: () => Date.parse('2026-09-06T12:00:00.000Z'),
  });
  scenes.bootSync();
  return { scenes, ui, input, api, save, timers, storage };
}

describe('Scenes · game-over comeback loop (P2-2)', () => {
  it('같은 탑 다시 keeps the seed and runs the best climb as the self echo; 새 탑 draws a fresh seed', async () => {
    const { scenes, ui, input, save, timers, storage } = tideShell();
    ui.emit({ type: 'endless' });
    const seed = scenes.run!.seed;
    expect(seed).toBe(1000);
    const full = hopOver(scenes, ui, input, 20);
    expect(Math.floor(full.height)).toBeGreaterThan(0);
    // the game-over screen of an endless run offers both ways back, no world best
    expect(ui.over!.extra).toEqual({ sameTowerAvailable: true });
    expect(ui.over!.best).toBe(0);
    // the best climb's replay is kept with its seed and sim version
    const e = save.progress.endless;
    expect(e.bestHeight).toBe(Math.floor(full.height));
    expect(e.bestMasks).toBeTruthy();
    expect(e.bestSeed).toBe(seed);
    expect(e.bestSim).toBe(SIM_VERSION);
    expect(e.bestMasks!.length).toBeLessThanOrEqual(MAX_MASKS_B64);
    expect(decodeMasks(e.bestMasks!).length).toBeGreaterThan(0);
    timers.fire();
    const reloaded = new Save({ storage, defaultBinds: BINDS, schedule: () => 0, cancel: () => {} });
    expect(reloaded.progress.endless.bestSeed).toBe(seed);
    expect(reloaded.progress.endless.bestMasks).toBe(e.bestMasks);

    // 같은 탑 다시: the same seed, one self echo in lockstep, and the previous best on the over screen
    ui.emit({ type: 'sameTower' });
    expect(ui.screen).toBe('play');
    const same = scenes.run!;
    expect(same.mode).toBe('endless');
    expect(same.seed).toBe(seed);
    expect(same.sim.seed).toBe(seed);
    expect(same.prevBestHeight).toBe(Math.floor(full.height));
    await scenes.settle();
    expect(same.echoes).toHaveLength(1);
    expect(same.echoes[0].label).toBe('나');
    runFrames(scenes, () => same.sim.state.tick >= 200);
    expect(same.echoes[0].tick).toBe(same.sim.state.tick);
    // a lower climb on the same tower is no record: the replay stays
    input.latchedMask = 0;
    runFrames(scenes, () => ui.screen === 'over', 6000);
    expect(scenes.run!.view!.personalBest).toBe(false);
    expect(save.progress.endless.bestMasks).toBe(e.bestMasks);

    // 새 탑: a different seed, and the best replay does not fit it → no self echo
    ui.emit({ type: 'newTower' });
    const fresh = scenes.run!;
    expect(fresh.seed).not.toBe(seed);
    expect(fresh.seed).toBe(1001);
    await scenes.settle();
    expect(fresh.echoes).toHaveLength(0);
    expect(save.progress.endless.runs).toBe(3);
  });

  it('a stale (other SIM_VERSION) or oversized endless replay is not kept as the self echo', async () => {
    const { scenes, ui, input, save } = tideShell();
    save.progress.endless = { bestHeight: 0, bestShards: 0, runs: 0, bestMasks: encodeMasks(Uint8Array.from([16, 16, 16])), bestSeed: 1000, bestSim: SIM_VERSION - 1 };
    ui.emit({ type: 'endless' });
    expect(scenes.run!.seed).toBe(1000);
    await scenes.settle();
    expect(scenes.run!.echoes).toHaveLength(0);
    // a record climb replaces the stale entry with the current version
    hopOver(scenes, ui, input, 20);
    expect(save.progress.endless.bestSim).toBe(SIM_VERSION);
    expect(save.progress.endless.bestSeed).toBe(1000);
  });

  it('a daily game over carries the world best from the board and keeps the single retry (the same tower)', async () => {
    const { scenes, ui, input, api } = tideShell();
    api.board = [{
      rank: 1, runId: 'run-x', ownerId: 'someone-else-1', playerTag: 'bbbbbbbbbbbb', name: '라이벌', score: 1, ticks: 9000,
      shards: 2, deaths: 0, cleared: false, height: 120.6, createdAt: '2026-09-06T00:00:00.000Z',
    }];
    ui.emit({ type: 'openDaily' });
    await scenes.settle();
    expect(scenes.dailyLb?.entries[0]?.height).toBe(120.6);
    ui.emit({ type: 'daily' });
    hopOver(scenes, ui, input, 20);
    expect(ui.over!.extra).toEqual({ sameTowerAvailable: false, worldBest: 120 });
    // sameTower on a daily is the same daily
    const before = scenes.run!;
    ui.emit({ type: 'sameTower' });
    expect(scenes.run).not.toBe(before);
    expect(scenes.run!.mode).toBe('daily');
    expect(scenes.run!.daily).toEqual(before.daily);
    await scenes.settle();
  });
});

describe('Scenes · daily streak and yesterday\'s tower (P2-3)', () => {
  it("fetches yesterday's board once per day (boot / daily screen), 재도전 climbs yesterday's seed and submits under yesterday's date", async () => {
    const { scenes, ui, input, api, save } = tideShell({ yesterday: true });
    ui.emit({ type: 'openDaily' });
    await scenes.settle();
    expect(scenes.daily?.date).toBe(TODAY);
    expect(scenes.yesterday).toMatchObject({ date: YESTERDAY, seed: Y_SEED });
    expect(scenes.yesterday!.lb).not.toBeNull();
    const yq = api.lbQueries.filter((q) => q.board === YESTERDAY);
    expect(yq).toHaveLength(1);
    expect(yq[0]).toMatchObject({ mode: 'daily', limit: 1, playerId: save.progress.player.id });
    expect(ui.yesterdays.at(-1)).toMatchObject({ date: YESTERDAY, seed: Y_SEED });
    // opening the screen again the same day does not ask again
    ui.emit({ type: 'openDaily' });
    await scenes.settle();
    expect(api.lbQueries.filter((q) => q.board === YESTERDAY)).toHaveLength(1);

    ui.emit({ type: 'retryYesterday' });
    expect(ui.screen).toBe('play');
    const run = scenes.run!;
    expect(run.mode).toBe('daily');
    expect(run.daily).toEqual({ date: YESTERDAY, seed: Y_SEED });
    expect(run.sim.seed).toBe(Y_SEED);
    expect(run.eligible).toBe(true);
    expect(scenes.daily?.date).toBe(TODAY);                 // today's daily is untouched
    expect(save.progress.daily[YESTERDAY]).toBeTruthy();    // starting is already a 도전
    expect(save.progress.daily[YESTERDAY].seed).toBe(Y_SEED);
    // a restart mid-climb stays on yesterday's tower
    ui.emit({ type: 'restart' });
    expect(scenes.run!.daily).toEqual({ date: YESTERDAY, seed: Y_SEED });
    expect(scenes.daily?.date).toBe(TODAY);
    hopOver(scenes, ui, input, 20);
    await scenes.settle();
    const sub = api.submissions.at(-1)!;
    expect(sub.mode).toBe('daily');
    expect(sub.date).toBe(YESTERDAY);
    expect(sub.seed).toBe(Y_SEED);
    expect(scenes.run!.view!.submit.state).toBe('accepted');
    // the board that came back is yesterday's: it lands on the yesterday row, not on today's board
    expect(scenes.dailyLb?.board).toBe(TODAY);
    expect(scenes.yesterday!.lb?.board).toBe(YESTERDAY);
    expect(save.progress.daily[YESTERDAY].rank).toBe(1);
    expect(ui.yesterdays.at(-1)!.lb?.board).toBe(YESTERDAY);

    // today's climb: the streak now spans both days
    ui.emit({ type: 'quit' });
    expect(ui.screen).toBe('daily');
    ui.emit({ type: 'daily' });
    expect(scenes.run!.daily).toEqual({ date: TODAY, seed: 12345 });
    hopOver(scenes, ui, input, 0);
    await scenes.settle();
    expect(streakFor(save.progress.daily, TODAY)).toBe(2);
    expect(api.submissions.at(-1)!.date).toBe(TODAY);
  });

  it('boot() loads yesterday in the background; without a seed 재도전 only explains itself', async () => {
    const booted = tideShell({ yesterday: true });
    await booted.scenes.boot({ raf: async () => {}, wait: async () => {} });
    expect(booted.ui.screen).toBe('title');
    await booted.scenes.settle();
    expect(booted.scenes.daily?.date).toBe(TODAY);
    expect(booted.scenes.yesterday).toMatchObject({ date: YESTERDAY, seed: Y_SEED });
    expect(booted.api.lbQueries.filter((q) => q.board === YESTERDAY)).toHaveLength(1);
    // opening the daily screen afterwards reuses it
    booted.ui.emit({ type: 'openDaily' });
    await booted.scenes.settle();
    expect(booted.api.lbQueries.filter((q) => q.board === YESTERDAY)).toHaveLength(1);

    // a pre-P2 server sends no yesterday: the date is still known (local UTC), the seed is not, so nothing starts
    const legacy = tideShell();
    legacy.ui.emit({ type: 'openDaily' });
    await legacy.scenes.settle();
    expect(legacy.scenes.yesterday).toMatchObject({ date: YESTERDAY, seed: null });
    legacy.ui.emit({ type: 'retryYesterday' });
    expect(legacy.scenes.run).toBeNull();
    expect(legacy.ui.toasts.at(-1)).toContain('어제의 탑');
  });
});

describe('Scenes · inline name onboarding (P2-5)', () => {
  it('the first eligible clear with the default name asks for a name on the result screen before submitting, and the body carries it', async () => {
    const def = flatRoom();
    const { scenes, ui, input, api, save } = makeScenes([def]);
    let askedAtSubmissions = -1;
    ui.askNameInline = async () => { ui.nameAsks++; askedAtSubmissions = api.submissions.length; return ' 바다거북 '; };
    scenes.bootSync();
    expect(save.progress.player.name).toBe(DEFAULT_NAME);
    ui.emit({ type: 'start', levelId: 'flat' });
    input.heldMask = IN.RIGHT;
    runFrames(scenes, () => scenes.run!.sim.finished);
    // nothing goes out during the clear animation: the run waits for the prompt
    expect(api.submissions).toHaveLength(0);
    expect(scenes.run!.pendingSubmit).toBeTruthy();
    expect(ui.nameAsks).toBe(0);
    runFrames(scenes, () => ui.screen === 'result', 200);
    expect(ui.nameAsks).toBe(1);
    expect(scenes.run!.view!.submit.state).toBe('pending');
    expect(scenes.isBusy()).toBe(true);
    await scenes.settle();
    expect(askedAtSubmissions).toBe(0);
    expect(api.submissions).toHaveLength(1);
    expect(api.submissions[0].player.name).toBe('바다거북');
    expect(save.progress.player.name).toBe('바다거북');
    expect(save.progress.seen[NAME_ASKED_KEY]).toBe(true);
    expect(ui.result!.submit.state).toBe('accepted');
    expect(scenes.isBusy()).toBe(false);
  });

  it('건너뛰기 stores and submits 클로드 #xxxx (stable hash of the id); the second eligible clear does not ask again', async () => {
    const def = flatRoom();
    const { scenes, ui, input, api, save, timers, storage } = makeScenes([def]);
    ui.nameAnswer = null;
    scenes.bootSync();
    ui.emit({ type: 'start', levelId: 'flat' });
    input.heldMask = IN.RIGHT;
    runFrames(scenes, () => ui.screen === 'result');
    await scenes.settle();
    expect(ui.nameAsks).toBe(1);
    const name = save.progress.player.name;
    expect(name).toMatch(/^클로드 #[0-9a-f]{4}$/);
    expect(name).toBe(fallbackName(save.progress.player.id));
    expect(api.submissions[0].player.name).toBe(name);
    expect(ui.result!.submit.state).toBe('accepted');
    timers.fire();
    expect((JSON.parse(storage.getItem(PROGRESS_KEY)!) as Progress).player.name).toBe(name);
    expect((JSON.parse(storage.getItem(PROGRESS_KEY)!) as Progress).seen[NAME_ASKED_KEY]).toBe(true);
    // the next eligible clear goes straight out
    ui.emit({ type: 'retry' });
    runFrames(scenes, () => ui.screen === 'result');
    await scenes.settle();
    expect(ui.nameAsks).toBe(1);
    expect(api.submissions).toHaveLength(2);
    expect(api.submissions[1].player.name).toBe(name);

    // a player who already chose a name is never asked; an ineligible (assist) run neither
    const named = makeScenes([def]);
    named.save.progress.player.name = '새이름';
    named.scenes.bootSync();
    named.ui.emit({ type: 'start', levelId: 'flat' });
    named.input.heldMask = IN.RIGHT;
    runFrames(named.scenes, () => named.ui.screen === 'result');
    await named.scenes.settle();
    expect(named.ui.nameAsks).toBe(0);
    expect(named.api.submissions[0].player.name).toBe('새이름');
    const assist = makeScenes([def], { assist: true });
    assist.scenes.bootSync();
    assist.ui.emit({ type: 'start', levelId: 'flat' });
    assist.input.heldMask = IN.RIGHT;
    runFrames(assist.scenes, () => assist.ui.screen === 'result');
    await assist.scenes.settle();
    expect(assist.ui.nameAsks).toBe(0);
    expect(assist.save.progress.player.name).toBe(DEFAULT_NAME);
    expect(assist.save.progress.seen[NAME_ASKED_KEY]).toBeUndefined();
  });

  it('a UI without the prompt, or an invalid answer, falls back to the hashed default name; a daily game over asks too', async () => {
    const bare = makeScenes([flatRoom()]);
    delete (bare.ui as Partial<FakeUI>).askNameInline;
    bare.scenes.bootSync();
    bare.ui.emit({ type: 'start', levelId: 'flat' });
    bare.input.heldMask = IN.RIGHT;
    runFrames(bare.scenes, () => bare.ui.screen === 'result');
    await bare.scenes.settle();
    expect(bare.api.submissions[0].player.name).toBe(fallbackName(bare.save.progress.player.id));

    const bad = makeScenes([flatRoom()]);
    bad.ui.nameAnswer = 'x<y';
    bad.scenes.bootSync();
    bad.ui.emit({ type: 'start', levelId: 'flat' });
    bad.input.heldMask = IN.RIGHT;
    runFrames(bad.scenes, () => bad.ui.screen === 'result');
    await bad.scenes.settle();
    expect(bad.api.submissions[0].player.name).toBe(fallbackName(bad.save.progress.player.id));

    // the daily's tide-over is an eligible submission as well
    const daily = tideShell();
    daily.ui.nameAnswer = '조류';
    daily.ui.emit({ type: 'openDaily' });
    await daily.scenes.settle();
    daily.ui.emit({ type: 'daily' });
    hopOver(daily.scenes, daily.ui, daily.input, 20);
    expect(daily.ui.nameAsks).toBe(1);
    await daily.scenes.settle();
    expect(daily.api.submissions[0].player.name).toBe('조류');
    expect(daily.save.progress.player.name).toBe('조류');
  });
});

describe('Scenes · stuck detector → assist offer (P2-6)', () => {
  it(`the ${ASSIST_OFFER_DEATHS}th death in a zone offers assist once; the next death and a restart do not; 다시 묻지 않기 marks the zone`, () => {
    const { scenes, ui, input, renderer, save } = makeScenes([pitRoom()]);
    scenes.bootSync();
    ui.emit({ type: 'start', levelId: 'pit' });
    input.heldMask = IN.RIGHT;
    const deaths = () => renderer.events.filter((e) => e.type === 'death').length;
    runFrames(scenes, () => ui.offers.length >= 1, 30_000);
    expect(ui.offers).toEqual(['테스트 pit']);
    expect(deaths()).toBe(ASSIST_OFFER_DEATHS);
    expect(save.progress.levels.pit.sessionDeaths).toBe(ASSIST_OFFER_DEATHS);
    expect(ui.screen).toBe('assist');
    // the run is frozen under the offer
    const tick = scenes.run!.sim.state.tick;
    scenes.frame(1 / 60);
    expect(scenes.run!.sim.state.tick).toBe(tick);
    ui.emit({ type: 'assistDecline', never: false });
    expect(ui.screen).toBe('play');
    expect(save.progress.seen[assistSeenKey('pit')]).toBeUndefined();
    expect(save.settings.assist).toBe(false);
    runFrames(scenes, () => deaths() >= ASSIST_OFFER_DEATHS + 2, 5000);
    expect(ui.offers).toHaveLength(1);
    // a restart keeps the install's count: no re-offer
    ui.emit({ type: 'restart' });
    expect(scenes.run!.sim.state.tick).toBe(0);
    renderer.events.length = 0;
    runFrames(scenes, () => deaths() >= 3, 5000);
    expect(ui.offers).toHaveLength(1);
    expect(save.progress.levels.pit.sessionDeaths).toBe(ASSIST_OFFER_DEATHS + 5);
    // the next multiple asks again; 다시 묻지 않기 ends it for this zone
    save.progress.levels.pit.sessionDeaths = 2 * ASSIST_OFFER_DEATHS - 1;
    runFrames(scenes, () => ui.offers.length >= 2, 5000);
    expect(ui.offers).toHaveLength(2);
    ui.emit({ type: 'assistDecline', never: true });
    expect(save.progress.seen[assistSeenKey('pit')]).toBe(true);
    expect(ui.screen).toBe('play');
    save.progress.levels.pit.sessionDeaths = 3 * ASSIST_OFFER_DEATHS - 1;
    runFrames(scenes, () => (save.progress.levels.pit.sessionDeaths ?? 0) >= 3 * ASSIST_OFFER_DEATHS + 1, 5000);
    expect(ui.offers).toHaveLength(2);
  });

  it('다시 시작 turns assist on, saves it and restarts the zone in assist mode (no longer eligible); with assist already on nothing is offered', async () => {
    const { scenes, ui, input, renderer, save, timers, storage } = makeScenes([pitRoom()]);
    scenes.bootSync();
    save.progress.levels.pit = { done: false, bestTicks: 0, bestShards: 0, stars: 0, relics: 0, deaths: 0, sessionDeaths: ASSIST_OFFER_DEATHS - 1 };
    ui.emit({ type: 'start', levelId: 'pit' });
    const before = scenes.run!;
    expect(before.eligible).toBe(true);
    input.heldMask = IN.RIGHT;
    runFrames(scenes, () => ui.offers.length >= 1, 5000);
    expect(renderer.events.filter((e) => e.type === 'death')).toHaveLength(1);
    ui.emit({ type: 'assistAccept' });
    expect(save.settings.assist).toBe(true);
    timers.fire();
    expect((JSON.parse(storage.getItem(SETTINGS_KEY)!) as Settings).assist).toBe(true);
    const after = scenes.run!;
    expect(after).not.toBe(before);
    expect(after.def.id).toBe('pit');
    expect(after.sim.assist).toBe(true);
    expect(after.sim.state.tick).toBe(0);
    expect(after.eligible).toBe(false);
    expect(after.echoSafe).toBe(false);
    expect(ui.screen).toBe('play');
    // deaths keep counting, but assist is on: no second offer
    save.progress.levels.pit.sessionDeaths = 2 * ASSIST_OFFER_DEATHS - 1;
    runFrames(scenes, () => (save.progress.levels.pit.sessionDeaths ?? 0) >= 2 * ASSIST_OFFER_DEATHS, 5000);
    expect(ui.offers).toHaveLength(1);

    const assisted = makeScenes([pitRoom()], { assist: true });
    assisted.scenes.bootSync();
    assisted.save.progress.levels.pit = { done: false, bestTicks: 0, bestShards: 0, stars: 0, relics: 0, deaths: 0, sessionDeaths: ASSIST_OFFER_DEATHS - 1 };
    assisted.ui.emit({ type: 'start', levelId: 'pit' });
    assisted.input.heldMask = IN.RIGHT;
    runFrames(assisted.scenes, () => (assisted.save.progress.levels.pit.sessionDeaths ?? 0) >= ASSIST_OFFER_DEATHS, 5000);
    expect(assisted.ui.offers).toHaveLength(0);
    // deaths outside story (the daily) never count
    const daily = tideShell();
    daily.ui.emit({ type: 'openDaily' });
    await daily.scenes.settle();
    daily.ui.emit({ type: 'daily' });
    hopOver(daily.scenes, daily.ui, daily.input, 0);
    expect(daily.ui.offers).toHaveLength(0);
    expect(daily.save.progress.levels.daily).toBeUndefined();
    await daily.scenes.settle();
  });
});

// ================================================================ P2-4 rival echo · live splits · death marks · segment bests
describe('Scenes · rival echo, live splits, death marks and segment bests (P2-4)', () => {
  /** A ghost recording: `lead` idle ticks, then RIGHT for `hold` ticks. */
  const ghostMasks = (lead: number, hold: number): string => {
    const m = new Uint8Array(lead + hold);
    m.fill(IN.RIGHT, lead);
    return encodeMasks(m);
  };

  /**
   * A cleared board of ranks 1..n on `def` (rank k = 4000 + 60k ticks, name `주자k`,
   * runId `run-rk`), every entry with a decodable ghost. `yoursRank` marks one row
   * as ours (the server flags it `you`, exactly like the real route).
   */
  function seedBoard(api: FakeApi, def: LevelDef, n: number, ownerId: string, yoursRank?: number, masks = ghostMasks(0, 900)): void {
    api.board = [];
    for (let k = 1; k <= n; k++) {
      const runId = `run-r${k}`;
      const ticks = 4000 + 60 * k;
      api.board.push({
        rank: k, runId, ownerId: k === yoursRank ? ownerId : `other-${k}`, playerTag: String(k).padStart(12, 'a'), name: `주자${k}`,
        score: ticks, ticks, shards: 0, deaths: 0, cleared: true, height: 0, createdAt: '2026-09-06T00:00:00.000Z',
      });
      api.ghosts[runId] = { runId, mode: 'story', board: def.id, levelId: def.id, seed: def.seed, assist: false, masks, name: `주자${k}`, ticks };
    }
  }

  /** Record every ghost fetch. */
  function spyGhosts(api: FakeApi): string[] {
    const calls: string[] = [];
    const orig = api.ghost.bind(api);
    api.ghost = async (id) => { calls.push(id); return orig(id); };
    return calls;
  }

  it('pickWorldEcho: rank−1 above ours, the chaser when we lead, the upper median without a row, the leader in top mode', () => {
    const mk = (rank: number, you = false): LeaderboardEntry => ({
      rank, runId: `r${rank}`, playerTag: 'aaaaaaaaaaaa', you, name: `n${rank}`, score: rank, ticks: rank, shards: 0, deaths: 0,
      cleared: true, height: 0, createdAt: '',
    });
    const lb = (entries: LeaderboardEntry[], yours?: LeaderboardEntry): LeaderboardResponse => ({ mode: 'story', board: 't1', total: entries.length, entries, yours });
    const ten = Array.from({ length: 10 }, (_, i) => mk(i + 1, i + 1 === 7));
    expect(pickWorldEcho(lb(ten), 'rival')).toMatchObject({ kind: 'rival', entry: { rank: 6 } });
    // `yours` outside the listed rows still anchors the pick (rank 12 → the closest listed above is rank 10)
    expect(pickWorldEcho(lb(Array.from({ length: 10 }, (_, i) => mk(i + 1)), mk(12, true)), 'rival')).toMatchObject({ entry: { rank: 10 } });
    // we lead: the closest chaser
    expect(pickWorldEcho(lb(Array.from({ length: 5 }, (_, i) => mk(i + 1, i === 0))), 'rival')).toMatchObject({ entry: { rank: 2 } });
    // alone on the board: nothing (the self echo already runs)
    expect(pickWorldEcho(lb([mk(1, true)]), 'rival')).toBeNull();
    expect(pickWorldEcho(lb([mk(1, true)]), 'top')).toBeNull();
    // no row of ours: the upper median (10 → rank 6, 9 → rank 5, 1 → rank 1)
    expect(pickWorldEcho(lb(Array.from({ length: 10 }, (_, i) => mk(i + 1))), 'rival')).toMatchObject({ entry: { rank: 6 } });
    expect(pickWorldEcho(lb(Array.from({ length: 9 }, (_, i) => mk(i + 1))), 'rival')).toMatchObject({ entry: { rank: 5 } });
    expect(pickWorldEcho(lb([mk(1)]), 'rival')).toMatchObject({ entry: { rank: 1 } });
    // top mode ignores our rank
    expect(pickWorldEcho(lb(ten), 'top')).toMatchObject({ kind: 'top', entry: { rank: 1 } });
    expect(pickWorldEcho(lb([]), 'rival')).toBeNull();
    expect(worldEchoLabel('rival', '바다')).toBe('라이벌 · 바다');
    expect(worldEchoLabel('top', '바다')).toBe('1위 · 바다');
  });

  it('fmtSplit / fmtVersus keep two decimals and an explicit sign; 0 is even', () => {
    expect(fmtSplit(101)).toEqual({ text: '+0.84s', sign: 1 });
    expect(fmtSplit(-144)).toEqual({ text: '−1.20s', sign: -1 });
    expect(fmtSplit(0)).toEqual({ text: '±0.00s', sign: 0 });
    expect(fmtVersus('라이벌', -74)).toMatchObject({ text: '라이벌보다 0.62s 빠름', secs: '0.62s', sign: -1 });
    expect(fmtVersus('1위', 144)).toMatchObject({ text: '1위보다 1.20s 느림', sign: 1 });
    expect(fmtVersus('라이벌', 0)).toMatchObject({ text: '라이벌과 같은 기록', sign: 0 });
  });

  it('a board 1..10 with our row at rank 7 → the ghost of rank 6 runs as 라이벌 · 이름 (limit 50, our player id on the query)', async () => {
    const def = flatRoom();
    const { scenes, ui, api, save } = makeScenes([def], { echoWorld: true, echoSelf: false });
    scenes.bootSync();
    seedBoard(api, def, 10, save.progress.player.id, 7);
    const ghosts = spyGhosts(api);
    ui.emit({ type: 'start', levelId: 'flat' });
    await scenes.settle();
    expect(ghosts).toEqual(['run-r6']);
    const run = scenes.run!;
    expect(run.echoes.map((e) => e.label)).toEqual(['라이벌 · 주자6']);
    expect(run.worldEcho).toBe(run.echoes[0]);
    expect(run.rival).toEqual({ kind: 'rival', name: '주자6', ticks: 4000 + 60 * 6 });
    const q = api.lbQueries.at(-1)!;
    expect(q.limit).toBe(50);
    expect(q.playerId).toBe(save.progress.player.id);
    expect(q.board).toBe('flat');
  });

  it('without a row of ours → the median entry; 1위 mode → the leader labelled 1위 · 이름; leading ourselves → the chaser', async () => {
    const def = flatRoom();
    const median = makeScenes([def], { echoWorld: true, echoSelf: false });
    median.scenes.bootSync();
    seedBoard(median.api, def, 9, median.save.progress.player.id);
    const medianGhosts = spyGhosts(median.api);
    median.ui.emit({ type: 'start', levelId: 'flat' });
    await median.scenes.settle();
    expect(medianGhosts).toEqual(['run-r5']);
    expect(median.scenes.run!.echoes.map((e) => e.label)).toEqual(['라이벌 · 주자5']);

    const top = makeScenes([def], { echoWorld: true, echoSelf: false });
    top.scenes.bootSync();
    expect(echoWorldMode(top.save.settings)).toBe('rival');   // the default
    setEchoWorldMode(top.save.settings, 'top');
    seedBoard(top.api, def, 10, top.save.progress.player.id, 7);
    const topGhosts = spyGhosts(top.api);
    top.ui.emit({ type: 'start', levelId: 'flat' });
    await top.scenes.settle();
    expect(topGhosts).toEqual(['run-r1']);
    expect(top.scenes.run!.echoes.map((e) => e.label)).toEqual(['1위 · 주자1']);
    expect(top.scenes.run!.rival?.kind).toBe('top');

    const lead = makeScenes([def], { echoWorld: true, echoSelf: false });
    lead.scenes.bootSync();
    seedBoard(lead.api, def, 4, lead.save.progress.player.id, 1);
    const leadGhosts = spyGhosts(lead.api);
    lead.ui.emit({ type: 'start', levelId: 'flat' });
    await lead.scenes.settle();
    expect(leadGhosts).toEqual(['run-r2']);
  });

  it('an empty board falls back to the bundled 목표 echo, which then feeds the splits as the world echo', async () => {
    const t1 = REAL_LEVELS[0];
    if (!(t1.id in GOAL_ECHOES)) return;
    const { scenes, ui, api } = makeScenes(REAL_LEVELS, { echoWorld: true, echoSelf: false });
    scenes.bootSync();
    api.board = [];
    ui.emit({ type: 'start', levelId: t1.id });
    await scenes.settle();
    const run = scenes.run!;
    expect(run.echoes.map((e) => e.label)).toEqual([GOAL_LABEL]);
    expect(run.worldEcho).toBe(run.echoes[0]);
    expect(run.rival).toBeNull();
  });

  it('a checkpoint shows the split chip against the world echo on that frame and hides it SPLIT_SECONDS later; behind reads +, ahead −', async () => {
    const def = checkpointRoom();
    // the rival sets off at once; the player waits 40 frames (80 ticks) before holding RIGHT
    const { scenes, ui, api, input, save } = makeScenes([def], { echoWorld: true, echoSelf: false });
    scenes.bootSync();
    seedBoard(api, def, 1, save.progress.player.id, undefined, ghostMasks(0, 2400));
    ui.emit({ type: 'start', levelId: 'checkpoint' });
    await scenes.settle();
    const run = scenes.run!;
    const echo = run.worldEcho!;
    expect(echo.label).toBe('라이벌 · 주자1');
    for (let i = 0; i < 40; i++) scenes.frame(1 / 60);
    input.heldMask = IN.RIGHT;
    runFrames(scenes, () => run.checkpoints >= 1, 2000);
    expect(run.checkpoints).toBe(1);
    // the chip arrived in the frame of the event, with the exact gap in ticks
    const [key, myTick] = [...run.cpTicks.entries()][0];
    const [cx, cy] = key.split(',').map(Number);
    const echoTick = echo.checkpointTick(cx, cy);
    expect(echoTick).not.toBeNull();
    expect(myTick).toBeGreaterThan(echoTick!);
    const shown = ui.splits.at(-1)!;
    expect(shown).toEqual({ text: fmtSplit(myTick - echoTick!).text, sign: 1 });
    expect(shown.text).toMatch(/^\+\d+\.\d{2}s$/);
    // one frame later it is still up; after SPLIT_SECONDS it is gone
    const before = ui.splits.length;
    scenes.frame(1 / 60);
    expect(ui.splits.length).toBe(before);
    let frames = 0;
    runFrames(scenes, () => ui.splits.length > before || ++frames > 200, 400);
    expect(ui.splits.at(-1)).toEqual({ text: null, sign: undefined });
    expect(frames).toBeGreaterThanOrEqual(Math.floor(SPLIT_SECONDS * 60) - 2);
    expect(frames).toBeLessThanOrEqual(Math.ceil(SPLIT_SECONDS * 60) + 2);

    // the echo has not reached the pillar → '—'; when it gets there later, the player's lead shows as a − split
    const late = makeScenes([def], { echoWorld: true, echoSelf: false });
    late.scenes.bootSync();
    seedBoard(late.api, def, 1, late.save.progress.player.id, undefined, ghostMasks(240, 2400));
    late.ui.emit({ type: 'start', levelId: 'checkpoint' });
    await late.scenes.settle();
    late.input.heldMask = IN.RIGHT;
    const lateRun = late.scenes.run!;
    runFrames(late.scenes, () => lateRun.checkpoints >= 1, 2000);
    expect(late.ui.splits.at(-1)).toEqual({ text: SPLIT_NONE, sign: 0 });
    const lateEcho = lateRun.worldEcho!;
    runFrames(late.scenes, () => lateEcho.checkpointsPassed >= 1, 2000);
    const ahead = late.ui.splits.at(-1)!;
    expect(ahead.sign).toBe(-1);
    expect(ahead.text).toMatch(/^−\d+\.\d{2}s$/);
  });

  it('with no world echo the split is read against the self echo (own best); 세계 메아리 off never shows one without a self echo', async () => {
    const def = checkpointRoom();
    const { scenes, ui, input } = makeScenes([def], { echoWorld: false, echoSelf: true });
    scenes.bootSync();
    ui.emit({ type: 'start', levelId: 'checkpoint' });
    input.heldMask = IN.RIGHT;
    runFrames(scenes, () => ui.screen === 'result');
    await scenes.settle();
    expect(ui.splits.filter((s) => s.text !== null)).toHaveLength(0);
    // second attempt: the self echo of the clear runs; waiting 30 frames makes us slower at the pillar
    ui.emit({ type: 'retry' });
    await scenes.settle();
    const run = scenes.run!;
    expect(run.selfEcho).not.toBeNull();
    expect(run.worldEcho).toBeNull();
    input.heldMask = 0;
    for (let i = 0; i < 30; i++) scenes.frame(1 / 60);
    input.heldMask = IN.RIGHT;
    runFrames(scenes, () => run.checkpoints >= 1, 2000);
    const shown = ui.splits.at(-1)!;
    expect(shown.sign).toBe(1);
    expect(shown.text).toMatch(/^\+\d+\.\d{2}s$/);
  });

  it('keeps the last five death marks per zone session — across respawns and a restart — and counts deaths per segment', async () => {
    const def = pitRoom();
    const { scenes, ui, input, renderer } = makeScenes([def]);
    scenes.bootSync();
    ui.emit({ type: 'start', levelId: 'pit' });
    expect(renderer.deathMarks).toEqual([]);
    input.heldMask = IN.RIGHT;
    const deaths = () => renderer.events.filter((e) => e.type === 'death').length;
    runFrames(scenes, () => deaths() >= 3, 6000);
    const run = scenes.run!;
    expect(run.session.marks).toHaveLength(3);
    expect(renderer.deathMarks).toHaveLength(3);
    // a pit death is marked at the level's floor line, inside the level
    for (const m of renderer.deathMarks) expect(m.y).toBeLessThanOrEqual(run.sim.level.pxH);
    // the marks survive the respawns in between
    runFrames(scenes, () => run.sim.state.phase === 'play', 300);
    expect(renderer.deathMarks).toHaveLength(3);
    runFrames(scenes, () => deaths() >= DEATH_MARKS_MAX + 2, 12000);
    expect(run.session.marks).toHaveLength(DEATH_MARKS_MAX);
    expect(renderer.deathMarks).toHaveLength(DEATH_MARKS_MAX);
    // all in segment 0 (no checkpoint reached)
    const rows = ui.segmentCalls.at(-1)!;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ idx: 0, deaths: DEATH_MARKS_MAX + 2, best: null, current: true });
    // a full restart keeps the zone session: same marks, same counts, handed to the renderer again
    const before = renderer.deathMarks;
    ui.emit({ type: 'restart' });
    await scenes.settle();
    expect(scenes.run).not.toBe(run);
    expect(scenes.run!.session).toBe(run.session);
    expect(renderer.deathMarks).toEqual(before);
    expect(ui.segmentCalls.at(-1)![0].deaths).toBe(DEATH_MARKS_MAX + 2);
    // the split chip was reset on the restart
    expect(ui.splits.at(-1)).toEqual({ text: null, sign: undefined });
    // another zone has its own session
    const other = makeScenes([def, { ...flatRoom(), id: 'flat2' }]);
    other.scenes.bootSync();
    other.ui.emit({ type: 'start', levelId: 'flat2' });
    expect(other.renderer.deathMarks).toEqual([]);
  });

  it('records segment bests (ticks) per checkpoint segment on a clear, keeps the faster one, and lists them on the pause rows', async () => {
    const def = checkpointRoom();
    const { scenes, ui, input, save } = makeScenes([def]);
    scenes.bootSync();
    ui.emit({ type: 'start', levelId: 'checkpoint' });
    // two segments: start → C, C → G; the current one is highlighted
    expect(ui.segmentCalls.at(-1)).toEqual([
      { idx: 0, deaths: 0, best: null, current: true },
      { idx: 1, deaths: 0, best: null, current: false },
    ]);
    input.heldMask = IN.RIGHT;
    runFrames(scenes, () => ui.screen === 'result');
    await scenes.settle();
    const first = [...segmentBests(save.progress.levels.checkpoint)];
    expect(first).toHaveLength(2);
    // segment 0 runs from tick 0 to the pillar, segment 1 from the pillar to the goal (the sim keeps ticking through the clear animation)
    expect(first[0]).toBe([...scenes.run!.cpTicks.values()][0]);
    expect(first[1]).toBeGreaterThan(0);
    expect(first[0] + first[1]).toBeLessThanOrEqual(scenes.run!.sim.state.tick);
    const rows = ui.segmentCalls.at(-1)!;
    expect(rows.map((r) => r.best)).toEqual(first);
    expect(rows[1].current).toBe(true);

    // a slower second run (waits 30 frames) changes nothing
    ui.emit({ type: 'retry' });
    input.heldMask = 0;
    for (let i = 0; i < 30; i++) scenes.frame(1 / 60);
    input.heldMask = IN.RIGHT;
    runFrames(scenes, () => ui.screen === 'result');
    await scenes.settle();
    expect([...segmentBests(save.progress.levels.checkpoint)]).toEqual(first);

    // assist runs never write segment bests
    const assisted = makeScenes([def], { assist: true });
    assisted.scenes.bootSync();
    assisted.ui.emit({ type: 'start', levelId: 'checkpoint' });
    assisted.input.heldMask = IN.RIGHT;
    runFrames(assisted.scenes, () => assisted.ui.screen === 'result');
    await assisted.scenes.settle();
    expect(segmentBests(assisted.save.progress.levels.checkpoint)).toEqual([]);
  });

  it('the result screen gets the 라이벌보다 comparison (our ticks − theirs) only when a world echo was raced', async () => {
    const def = flatRoom();
    const { scenes, ui, api, input, save } = makeScenes([def], { echoWorld: true, echoSelf: false });
    scenes.bootSync();
    seedBoard(api, def, 3, save.progress.player.id);
    ui.emit({ type: 'start', levelId: 'flat' });
    await scenes.settle();
    expect(scenes.run!.rival).toEqual({ kind: 'rival', name: '주자2', ticks: 4000 + 120 });
    input.heldMask = IN.RIGHT;
    runFrames(scenes, () => ui.screen === 'result');
    const summary = ui.result!.summary;
    const v = ui.versusCalls.at(-1)!;
    expect(v).toEqual({ label: '라이벌', deltaTicks: summary.ticks - (4000 + 120) });
    expect(fmtVersus(v.label, v.deltaTicks).text).toMatch(/^라이벌보다 \d+\.\d{2}s (빠름|느림)$/);
    // the versus row is set before the result is shown
    expect(ui.versusCalls.length).toBeGreaterThan(0);
    await scenes.settle();

    // no board → no rival → the row is cleared
    const alone = makeScenes([def], { echoWorld: true, echoSelf: false });
    alone.scenes.bootSync();
    alone.ui.emit({ type: 'start', levelId: 'flat' });
    await alone.scenes.settle();
    alone.input.heldMask = IN.RIGHT;
    runFrames(alone.scenes, () => alone.ui.screen === 'result');
    expect(alone.ui.versusCalls.at(-1)).toBeNull();
    await alone.scenes.settle();
  });
});

// ================================================================ Phase 3 A (P3-5 · P3-8)
/** Play `def` (a flat room) to the result screen and settle the submission. */
async function clearFlat(s: ReturnType<typeof makeScenes>): Promise<void> {
  s.ui.emit({ type: 'start', levelId: 'flat' });
  s.input.heldMask = IN.RIGHT;
  runFrames(s.scenes, () => s.ui.screen === 'result');
  await s.scenes.settle();
  s.input.heldMask = 0;
}

describe('Scenes · progress transfer (P3-5)', () => {
  it('export → import round trip: the other device gets the records, the run id and the player identity — never the replay', async () => {
    const def = flatRoom();
    const a = makeScenes([def]);
    a.scenes.bootSync();
    await clearFlat(a);
    a.ui.emit({ type: 'quit' });
    const aRec = a.save.progress.levels.flat;
    expect(aRec.masks).toBeTruthy();
    expect(aRec.runId).toBe('run-1');

    // device A: 다른 기기로 옮기기
    a.ui.emit({ type: 'transferExport' });
    await a.scenes.settle();
    expect(a.ui.transferCodes).toEqual([{ code: 'ABCDEFGH', expiresAt: '2026-09-13T00:00:00.000Z' }]);
    expect(a.ui.transferStatuses.at(-1)).toEqual({ text: TRANSFER_KR.created, kind: 'ok' });
    expect(a.ui.toasts).toContain(TRANSFER_KR.created);
    const body = a.api.transferCreates[0];
    expect(body.player).toEqual({ id: a.save.progress.player.id, name: a.save.progress.player.name });
    expect(JSON.stringify(body.progress)).not.toContain('masks');
    expect(JSON.stringify(body.progress)).not.toContain(aRec.masks!);
    expect(jsonBytes(body)).toBeLessThanOrEqual(MAX_TRANSFER_BYTES);
    // nothing changed locally
    expect(a.save.progress.levels.flat.masks).toBe(aRec.masks);

    // device B: a fresh install pointed at the same server
    const bSave = makeSave();
    const bUi = fakeUI();
    const bIdBefore = bSave.save.progress.player.id;
    const b = new Scenes({ renderer: fakeRenderer(), audio: fakeAudio(), ui: bUi, input: fakeInput(), api: a.api, save: bSave.save, levels: [def], build: 'test' });
    b.bootSync();
    const refreshes = bUi.selectRefreshes;
    bUi.emit({ type: 'transferImport', code: 'ABCDEFGH' });
    await b.settle();
    expect(bUi.transferStatuses.map((s) => s.kind)).toEqual(['busy', 'ok']);
    expect(bUi.transferStatuses.at(-1)!.text).toContain(TRANSFER_KR.imported);
    expect(bUi.toasts).toContain(TRANSFER_KR.imported);
    expect(bUi.selectRefreshes).toBe(refreshes + 1);
    const p = bSave.save.progress;
    expect(p.player.id).toBe(a.save.progress.player.id);
    expect(p.player.id).not.toBe(bIdBefore);
    expect(p.player.name).toBe(a.save.progress.player.name);
    expect(p.levels.flat.done).toBe(true);
    expect(p.levels.flat.bestTicks).toBe(aRec.bestTicks);
    expect(p.levels.flat.stars).toBe(aRec.stars);
    expect(p.levels.flat.runId).toBe('run-1');
    expect(p.levels.flat.masks).toBeUndefined();
    expect(p.totals.shards).toBe(a.save.progress.totals.shards);
    // written through at once, not debounced
    const stored = JSON.parse(bSave.storage.getItem(PROGRESS_KEY)!) as Progress;
    expect(stored.player.id).toBe(a.save.progress.player.id);
    expect(stored.levels.flat.masks).toBeUndefined();

    // the code was one-time: a second redeem is refused
    bUi.emit({ type: 'transferImport', code: 'ABCDEFGH' });
    await b.settle();
    expect(bUi.transferStatuses.at(-1)).toEqual({ text: TRANSFER_KR.gone, kind: 'error' });
    expect(bUi.toasts.at(-1)).toBe('이미 사용된 코드다');
  });

  it('import keeps the better local record and its replay when the snapshot is slower; the identity still moves', async () => {
    const def = flatRoom();
    const a = makeScenes([def]);
    a.scenes.bootSync();
    await clearFlat(a);
    a.ui.emit({ type: 'quit' });
    // A's record is made slow before the export
    a.save.progress.levels.flat.bestTicks += 5000;
    a.ui.emit({ type: 'transferExport' });
    await a.scenes.settle();

    const b = makeScenes([def]);
    b.scenes.bootSync();
    await clearFlat(b);
    b.ui.emit({ type: 'quit' });
    const bRec = { ...b.save.progress.levels.flat };
    // B redeems A's code through A's fake server
    const bScenes = new Scenes({ renderer: fakeRenderer(), audio: fakeAudio(), ui: b.ui, input: b.input, api: a.api, save: b.save, levels: [def], build: 'test' });
    bScenes.bootSync();
    b.ui.emit({ type: 'transferImport', code: 'ABCDEFGH' });
    await bScenes.settle();
    expect(b.save.progress.player.id).toBe(a.save.progress.player.id);
    expect(b.save.progress.levels.flat.bestTicks).toBe(bRec.bestTicks);
    expect(b.save.progress.levels.flat.masks).toBe(bRec.masks);
    expect(b.save.progress.levels.flat.runId).toBe(bRec.runId);
  });

  it('errors: 400 → 코드가 틀렸다, offline → 서버에 닿지 않는다, mid-run → refused, a server without the endpoints → 지원하지 않는다', async () => {
    const def = flatRoom();
    const s = makeScenes([def]);
    s.scenes.bootSync();
    // a code that is not even shaped like one never reaches the API
    s.ui.emit({ type: 'transferImport', code: 'abc' });
    await s.scenes.settle();
    expect(s.ui.transferStatuses.at(-1)).toEqual({ text: TRANSFER_KR.badCode, kind: 'error' });
    // the server refuses the check character → 400
    const realGet = s.api.transferGet;
    s.api.transferGet = async () => { throw new ApiError('bad code', 400, 'bad-code'); };
    s.ui.emit({ type: 'transferImport', code: 'ABCDEFGH' });
    await s.scenes.settle();
    expect(s.ui.transferStatuses.at(-1)).toEqual({ text: '코드가 틀렸다', kind: 'error' });
    expect(s.ui.toasts.at(-1)).toBe('코드가 틀렸다');
    // offline, both directions
    s.api.transferGet = realGet;
    s.api.failWith = new TypeError('fetch failed');
    s.ui.emit({ type: 'transferImport', code: 'ABCDEFGH' });
    await s.scenes.settle();
    expect(s.ui.transferStatuses.at(-1)).toEqual({ text: '서버에 닿지 않는다', kind: 'error' });
    s.ui.emit({ type: 'transferExport' });
    await s.scenes.settle();
    expect(s.ui.transferStatuses.at(-1)).toEqual({ text: '서버에 닿지 않는다', kind: 'error' });
    expect(s.ui.transferCodes).toEqual([]);
    s.api.failWith = null;
    // a 413 on export
    s.api.transferCreate = async () => { throw new ApiError('too large', 413, 'too-long'); };
    s.ui.emit({ type: 'transferExport' });
    await s.scenes.settle();
    expect(s.ui.transferStatuses.at(-1)).toEqual({ text: TRANSFER_KR.tooBig, kind: 'error' });
    // mid-run imports are refused before any request
    s.ui.emit({ type: 'start', levelId: 'flat' });
    let gets = 0;
    s.api.transferGet = async () => { gets++; throw new ApiError('gone', 410, 'gone'); };
    s.ui.emit({ type: 'transferImport', code: 'ABCDEFGH' });
    await s.scenes.settle();
    expect(gets).toBe(0);
    expect(s.ui.transferStatuses.at(-1)).toEqual({ text: TRANSFER_KR.inRun, kind: 'error' });
    s.ui.emit({ type: 'quit' });

    // a server (or fake) without the transfer endpoints
    const bare = makeScenes([def]);
    delete (bare.api as Partial<FakeApi>).transferCreate;
    delete (bare.api as Partial<FakeApi>).transferGet;
    bare.scenes.bootSync();
    bare.ui.emit({ type: 'transferExport' });
    bare.ui.emit({ type: 'transferImport', code: 'ABCDEFGH' });
    await bare.scenes.settle();
    expect(bare.ui.transferStatuses.filter((t) => t.text === TRANSFER_KR.unsupported)).toHaveLength(2);

    // the pure mapping
    expect(transferErrorText(new ApiError('x', 410, 'gone'), 'import')).toBe('이미 사용된 코드다');
    expect(transferErrorText(new ApiError('x', 400, 'bad-code'), 'import')).toBe('코드가 틀렸다');
    expect(transferErrorText(new ApiError('x', 404, 'not-found'), 'import')).toBe('코드가 틀렸다');
    expect(transferErrorText(new ApiError('x', 400, 'bad-request'), 'export')).toBe(TRANSFER_KR.createFailed);
    expect(transferErrorText(new ApiError('x', 429, 'rate-limited'), 'export')).toBe(TRANSFER_KR.busyRate);
    expect(transferErrorText(new ApiError('x', 0, 'network'), 'import')).toBe('서버에 닿지 않는다');
    expect(transferErrorText(new ApiError('x', 503, 'server-error'), 'export')).toBe('서버에 닿지 않는다');
    expect(transferErrorText(new TypeError('fetch failed'), 'import')).toBe('서버에 닿지 않는다');
    expect(transferErrorText(new ApiError('x', 418, 'teapot'), 'import')).toBe(TRANSFER_KR.importFailed);
  });

  it('asks navigator.storage.persist() once per install, after the first story clear, and remembers it in progress.seen', async () => {
    const def = flatRoom();
    const persist = vi.fn(() => Promise.resolve(true));
    const { save, storage, timers } = makeSave();
    const ui = fakeUI(); const input = fakeInput(); const api = fakeApi([def]);
    const scenes = new Scenes({ renderer: fakeRenderer(), audio: fakeAudio(), ui, input, api, save, levels: [def], build: 'test', persistStorage: persist });
    scenes.bootSync();
    expect(persist).not.toHaveBeenCalled();
    const s = { scenes, ui, input, api, save, storage, timers } as unknown as ReturnType<typeof makeScenes>;
    await clearFlat(s);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(save.progress.seen[PERSIST_ASKED_KEY]).toBe(true);
    ui.emit({ type: 'quit' });
    await clearFlat(s);
    expect(persist).toHaveBeenCalledTimes(1);
    ui.emit({ type: 'quit' });

    // a refusing / throwing platform is harmless, and a save already asked is never asked again
    save.flush();
    const again = makeSave(storage);
    const throwing = vi.fn(() => { throw new Error('no storage api'); });
    const s2 = new Scenes({ renderer: fakeRenderer(), audio: fakeAudio(), ui: fakeUI(), input: fakeInput(), api, save: again.save, levels: [def], build: 'test', persistStorage: throwing });
    s2.bootSync();
    expect(again.save.progress.seen[PERSIST_ASKED_KEY]).toBe(true);
    const fresh = makeSave();
    const rejecting = vi.fn(() => Promise.reject(new Error('denied')));
    const s3ui = fakeUI(); const s3in = fakeInput();
    const s3 = new Scenes({ renderer: fakeRenderer(), audio: fakeAudio(), ui: s3ui, input: s3in, api, save: fresh.save, levels: [def], build: 'test', persistStorage: rejecting });
    s3.bootSync();
    await clearFlat({ scenes: s3, ui: s3ui, input: s3in } as unknown as ReturnType<typeof makeScenes>);
    expect(rejecting).toHaveBeenCalledTimes(1);
    expect(fresh.save.progress.seen[PERSIST_ASKED_KEY]).toBe(true);
    expect(throwing).not.toHaveBeenCalled();
  });
});

// ================================================================ P3-3 race links
describe('Scenes · race links (P3-3)', () => {
  /** A ghost recording: `lead` idle ticks, then RIGHT for `hold` ticks. */
  const ghostMasks = (lead: number, hold: number): string => {
    const m = new Uint8Array(lead + hold);
    m.fill(IN.RIGHT, lead);
    return encodeMasks(m);
  };
  /** A friend's accepted run on `def`, served by the fake GET /api/ghost. */
  function friend(api: FakeApi, def: LevelDef, over: Partial<GhostResponse> = {}): GhostResponse {
    const g: GhostResponse = {
      runId: 'run-friend', mode: 'story', board: def.id, levelId: def.id, seed: def.seed, assist: false,
      masks: ghostMasks(0, 900), name: '친구A', ticks: 900, ...over,
    };
    api.ghosts[g.runId] = g;
    return g;
  }

  it("a race link starts the ghost's zone with the friend's echo alone, a banner and race_link_open; the result row compares against the friend", async () => {
    const def = flatRoom();
    const { scenes, ui, api, input, tele, save } = makeScenes([def], { echoWorld: true, echoSelf: false });
    scenes.bootSync();
    // a board with a rival the world echo WOULD pick — the friend takes its place
    api.board = [{
      rank: 1, runId: 'run-r1', ownerId: 'other-1', playerTag: 'a'.repeat(12), name: '주자1', score: 4060, ticks: 4060,
      shards: 0, deaths: 0, cleared: true, height: 0, createdAt: '2026-09-06T00:00:00.000Z',
    }];
    api.ghosts['run-r1'] = { runId: 'run-r1', mode: 'story', board: def.id, levelId: def.id, seed: def.seed, assist: false, masks: ghostMasks(0, 900), name: '주자1', ticks: 4060 };
    friend(api, def);
    expect(await scenes.startRace('run-friend')).toBe(true);
    expect(ui.screen).toBe('play');
    const run = scenes.run!;
    expect(run.race).toEqual({ runId: 'run-friend', name: '친구A', ticks: 900 });
    expect(run.raceLocked).toBe(false);
    expect(run.eligible).toBe(true);
    expect(run.echoes.map((e) => e.label)).toEqual(['경주 · 친구A']);
    expect(run.echoes[0].color).toBe(RACE_COLOR);
    expect(run.raceEcho).toBe(run.echoes[0]);
    expect(ui.banners.at(-1)).toBe('친구A의 메아리와 경주한다');
    expect(tele.of('race_link_open')).toEqual([{ levelId: 'flat', mode: 'story', fresh: true, locked: false }]);
    await scenes.settle();
    // the board's rival stays away: the friend is the rival of this run
    expect(run.echoes).toHaveLength(1);
    expect(api.lbQueries).toHaveLength(0);
    // the friend runs in lockstep and reaches the renderer
    scenes.frame(1 / 60);
    expect(scenes.frame(1 / 60)).toBeUndefined();
    expect(run.echoes[0].tick).toBe(run.sim.state.tick);
    expect(ui.huds.length).toBeGreaterThan(0);

    input.heldMask = IN.RIGHT;
    runFrames(scenes, () => ui.screen === 'result');
    const summary = ui.result!.summary;
    expect(summary.cleared).toBe(true);
    expect(ui.versusCalls.at(-1)).toEqual({ label: '친구A', deltaTicks: summary.ticks - 900 });
    expect(fmtVersus('친구A', summary.ticks - 900).text).toMatch(/^친구A보다 \d+\.\d{2}s (빠름|느림)$/);
    await scenes.settle();
    expect(ui.result!.submit.state).toBe('accepted');
    expect(scenes.raceUrl()).toBe('https://clawd.test/?race=run-1&z=flat');
    expect(save.progress.levels.flat.done).toBe(true);

    // a retry keeps racing the same friend (no banner again); quitting ends the race
    ui.emit({ type: 'retry' });
    expect(scenes.run!.race?.runId).toBe('run-friend');
    expect(scenes.run!.echoes.map((e) => e.label)).toEqual(['경주 · 친구A']);
    ui.emit({ type: 'quit' });
    expect(ui.screen).toBe('select');
    ui.emit({ type: 'start', levelId: 'flat' });
    expect(scenes.run!.race).toBeNull();
    expect(scenes.run!.echoes.some((e) => e.label?.startsWith('경주'))).toBe(false);
    await scenes.settle();
  });

  it('a locked zone can be raced once: no record, no submission, no unlock, no 다음 구역, and 이어하기 never points at it', async () => {
    const first = flatRoom();
    const second: LevelDef = { ...flatRoom(), id: 'flat2', name: '둘째 방' };
    const { scenes, ui, api, input, save, tele } = makeScenes([first, second]);
    scenes.bootSync();
    friend(api, second, { runId: 'run-locked' });
    expect(await scenes.startRace('run-locked')).toBe(true);
    const run = scenes.run!;
    expect(run.def.id).toBe('flat2');
    expect(run.raceLocked).toBe(true);
    expect(run.eligible).toBe(false);
    expect(save.progress.lastLevel).toBeNull();
    expect(tele.of('race_link_open')[0]).toMatchObject({ levelId: 'flat2', locked: true });
    input.heldMask = IN.RIGHT;
    runFrames(scenes, () => ui.screen === 'result');
    await scenes.settle();
    expect(ui.result!.summary.cleared).toBe(true);
    expect(ui.result!.submit.state).toBe('idle');
    expect(ui.result!.nextLevelId).toBeUndefined();
    expect(api.submissions).toHaveLength(0);
    expect(save.progress.levels.flat2).toBeUndefined();
    expect(save.progress.totals).toEqual({ deaths: 0, shards: 0 });
    expect(ui.unlockCalls.at(-1)?.size ?? 0).toBe(0);
    // the friend's ghost still gives the comparison row; nothing to share
    expect(ui.versusCalls.at(-1)?.label).toBe('친구A');
    expect(scenes.raceUrl()).toBeNull();
    // 다음 구역 from a locked race returns to the tower
    ui.emit({ type: 'next' });
    expect(scenes.run).toBeNull();
    expect(ui.screen).toBe('select');
  });

  it('a daily race is submittable for today / yesterday and a local, non-submitting run for an older tower', async () => {
    const daily: LevelDef = { ...flatRoom(), id: 'daily', name: '데일리' };
    const now = Date.UTC(2026, 8, 6, 12);
    const { scenes, ui, api, tele } = makeScenes([flatRoom()], { makeDaily: () => daily, now: () => now });
    scenes.bootSync();
    friend(api, daily, { runId: 'run-old', mode: 'daily', board: '2026-08-20', seed: 4242 });
    expect(await scenes.startRace('run-old')).toBe(true);
    let run = scenes.run!;
    expect(run.mode).toBe('daily');
    expect(run.daily).toEqual({ date: '2026-08-20', seed: 4242 });
    expect(run.offline).toBe(true);
    expect(run.eligible).toBe(false);
    expect(run.race?.name).toBe('친구A');
    expect(run.echoes.map((e) => e.label)).toEqual(['경주 · 친구A']);
    expect(ui.toasts).toContain(RACE_KR.staleDaily);
    expect(tele.of('race_link_open').at(-1)).toEqual({ levelId: 'daily', mode: 'daily', fresh: false, locked: false });
    expect(scenes.daily).toBeNull();          // a past tower never becomes "today's"

    friend(api, daily, { runId: 'run-y', mode: 'daily', board: '2026-09-05', seed: 777 });
    expect(await scenes.startRace('run-y')).toBe(true);
    run = scenes.run!;
    expect(run.offline).toBe(false);
    expect(run.eligible).toBe(true);
    expect(run.daily).toEqual({ date: '2026-09-05', seed: 777 });
    expect(tele.of('race_link_open').at(-1)).toMatchObject({ fresh: true });
    expect(scenes.daily).toBeNull();          // yesterday's either

    friend(api, daily, { runId: 'run-t', mode: 'daily', board: '2026-09-06', seed: 99 });
    expect(await scenes.startRace('run-t')).toBe(true);
    expect(scenes.run!.offline).toBe(false);
    expect(scenes.daily?.seed).toBe(99);      // today's: the shell adopts the server's seed as today's daily
    await scenes.settle();
  });

  it('a missing ghost, a network failure, a bad id or an unknown zone leave the menus alone with a toast', async () => {
    const def = flatRoom();
    const { scenes, ui, api } = makeScenes([def]);
    scenes.bootSync();
    expect(await scenes.startRace('run-nope')).toBe(false);
    expect(ui.toasts.at(-1)).toBe(RACE_KR.notFound);
    expect(scenes.run).toBeNull();
    expect(await scenes.startRace('<bad id>')).toBe(false);
    api.ghost = async () => { throw new ApiError('network error', 0, 'network'); };
    expect(await scenes.startRace('run-x')).toBe(false);
    expect(ui.toasts.at(-1)).toBe(RACE_KR.offline);
    api.ghost = async (id) => ({ runId: id, mode: 'story', board: 'zz', levelId: 'zz', seed: 1, assist: false, masks: ghostMasks(0, 10), name: 'x', ticks: 10 });
    expect(await scenes.startRace('run-zz')).toBe(false);
    expect(ui.toasts.at(-1)).toBe(RACE_KR.badZone);
    expect(ui.screen).toBe('title');
    expect(scenes.run).toBeNull();
  });

  it('메아리 링크 공유: the Web Share API when there is one, else the clipboard with a toast; share_click carries the outcome', async () => {
    const def = flatRoom();
    const shared: ShareData[] = [];
    const copied: string[] = [];
    const a = makeScenes([def], { share: { share: async (d) => { shared.push(d); }, writeText: async (t) => { copied.push(t); } } });
    a.scenes.bootSync();
    // nothing accepted yet: refused with a toast, no event
    a.ui.emit({ type: 'shareEcho' });
    await a.scenes.settle();
    expect(a.ui.toasts.at(-1)).toBe(RACE_KR.notShareable);
    expect(a.tele.of('share_click')).toEqual([]);
    await clearFlat(a);
    expect(a.ui.result!.submit.state).toBe('accepted');
    a.ui.emit({ type: 'shareEcho' });
    await a.scenes.settle();
    expect(shared).toHaveLength(1);
    expect(shared[0].url).toBe('https://clawd.test/?race=run-1&z=flat');
    expect(shared[0].text).toContain(a.save.progress.player.name);
    expect(copied).toEqual([]);
    expect(a.ui.toasts.at(-1)).toBe(RACE_KR.shared);
    expect(a.tele.of('share_click')).toEqual([{ levelId: 'flat', mode: 'story', via: 'shared' }]);

    // no navigator.share: the clipboard, and the toast says so
    const b = makeScenes([def], { share: { writeText: async (t) => { copied.push(t); } } });
    b.scenes.bootSync();
    await clearFlat(b);
    b.ui.emit({ type: 'shareEcho' });
    await b.scenes.settle();
    expect(copied).toEqual(['https://clawd.test/?race=run-1&z=flat']);
    expect(b.ui.toasts.at(-1)).toBe(RACE_KR.copied);
    expect(b.tele.of('share_click').at(-1)).toMatchObject({ via: 'copied' });

    // nothing available at all (Node, a locked-down browser)
    const c = makeScenes([def], { share: {} });
    c.scenes.bootSync();
    await clearFlat(c);
    c.ui.emit({ type: 'shareEcho' });
    await c.scenes.settle();
    expect(c.ui.toasts.at(-1)).toBe(RACE_KR.shareFailed);
    expect(c.tele.of('share_click').at(-1)).toMatchObject({ via: 'failed' });
  });
});

describe('Scenes · haptics dispatch (P3-8)', () => {
  it('hands every sim event to the haptics port and applies the setting at boot and on settingsChanged', async () => {
    const def = flatRoom();
    const seen: SimEvent[] = [];
    const applied: (boolean | undefined)[] = [];
    const haptics: HapticsPort = { onEvent(ev) { seen.push(ev); }, applySettings(s) { applied.push(s.haptics); } };
    const { save } = makeSave();
    save.settings.haptics = true;
    const ui = fakeUI(); const input = fakeInput(); const api = fakeApi([def]); const audio = fakeAudio();
    const scenes = new Scenes({ renderer: fakeRenderer(), audio, ui, input, api, save, levels: [def], build: 'test', haptics });
    scenes.bootSync();
    expect(applied).toEqual([true]);
    ui.emit({ type: 'start', levelId: 'flat' });
    input.heldMask = IN.RIGHT;
    runFrames(scenes, () => ui.screen === 'result');
    await scenes.settle();
    // the same stream the audio engine saw, in the same order
    expect(seen.map((e) => e.type)).toEqual(audio.events.map((e) => e.type));
    expect(seen.some((e) => e.type === 'goal')).toBe(true);
    save.settings.haptics = false;
    ui.emit({ type: 'settingsChanged' });
    expect(applied.at(-1)).toBe(false);
  });
});

// ================================================================ P3-4 share card · install card · deep links
describe('Scenes · share card, install card and ?go= deep links (P3-4)', () => {
  /** A CardEnv over a recording canvas: the texts drawn, the shares and copies made. */
  function fakeCard(parts: { share?: boolean; files?: boolean; clipboard?: boolean; canvas?: boolean } = {}) {
    const shared: CardShareData[] = [];
    const copied: string[] = [];
    const texts: string[] = [];
    const ctx = new Proxy({} as CanvasRenderingContext2D, {
      get(_t, key: string) {
        if (key === 'measureText') return () => ({ width: 10 });
        if (key === 'fillText') return (t: string) => { texts.push(t); };
        if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => ({ addColorStop() { /* stop */ } });
        return () => undefined;
      },
      set() { return true; },
    });
    const env: CardEnv = {
      makeFile: (blob, name, type) => new File([blob], name, { type }),
      ...(parts.canvas === false ? {} : {
        createCanvas: () => ({
          width: 0, height: 0, getContext: () => ctx,
          toBlob(cb: (b: Blob | null) => void) { cb(new Blob(['png'], { type: 'image/png' })); },
        }),
      }),
      ...(parts.share ? { share: async (d: CardShareData) => { shared.push(d); }, canShare: (d: CardShareData) => (d.files ? !!parts.files : true) } : {}),
      ...(parts.clipboard ? { writeText: async (t: string) => { copied.push(t); } } : {}),
    };
    return { env, shared, copied, texts };
  }

  it('공유: the card PNG travels with the race link once the record is accepted; toast and share_click carry the outcome', async () => {
    const def = flatRoom();
    const card = fakeCard({ share: true, files: true, clipboard: true });
    const s = makeScenes([def], { card: card.env });
    let portraits = 0;
    s.renderer.drawPortrait = () => { portraits++; };
    s.scenes.bootSync();
    // nothing finished yet: a toast, no event
    s.ui.emit({ type: 'shareCard' });
    await s.scenes.settle();
    expect(s.ui.toasts.at(-1)).toBe(CARD_KR.noResult);
    expect(s.tele.of('share_click')).toEqual([]);
    expect(s.scenes.cardView()).toBeNull();
    await clearFlat(s);
    expect(s.ui.result!.submit.state).toBe('accepted');
    const view = s.scenes.cardView()!;
    expect(view).toMatchObject({
      biome: 'tidepool', zoneName: def.name, zoneEn: def.en, cleared: true, rank: s.ui.result!.summary.rank, stars: s.ui.result!.stars,
      world: { rank: 1, total: 1 }, playerName: s.save.progress.player.name, skin: s.save.settings.skin, url: 'https://clawd.test/?race=run-1&z=flat',
    });
    expect(view.timeText).toBe(fmtTime(s.ui.result!.summary.time));
    expect(view.height).toBeUndefined();
    s.ui.emit({ type: 'shareCard' });
    await s.scenes.settle();
    expect(card.shared).toHaveLength(1);
    expect(card.shared[0].url).toBe('https://clawd.test/?race=run-1&z=flat');
    expect(card.shared[0].files).toHaveLength(1);
    expect(card.shared[0].files![0].type).toBe('image/png');
    expect(card.shared[0].text).toContain(def.name);
    expect(card.texts).toContain(def.name);
    expect(card.texts).toContain(view.timeText);
    expect(card.texts).toContain('세계 1위 / 1명');
    expect(card.texts).toContain('https://clawd.test/?race=run-1&z=flat');
    // the portrait came from the renderer
    expect(portraits).toBe(1);
    expect(card.copied).toEqual([]);
    expect(s.ui.toasts.at(-1)).toBe(CARD_KR.files);
    expect(s.tele.of('share_click').at(-1)).toEqual({ levelId: 'flat', mode: 'story', via: 'files', kind: 'card' });
  });

  it('without an accepted record the card carries the site link; no files → link; no share → clipboard; nothing → 공유하지 못했다', async () => {
    const def = flatRoom();
    // assist runs are never submitted: the card still shares, pointing at the site
    const a = fakeCard({ share: true, files: true });
    const sa = makeScenes([def], { assist: true, card: a.env });
    sa.scenes.bootSync();
    await clearFlat(sa);
    expect(sa.ui.result!.submit.state).toBe('idle');
    sa.ui.emit({ type: 'shareCard' });
    await sa.scenes.settle();
    expect(a.shared[0].url).toBe('https://clawd.test/');
    expect(a.shared[0].files).toHaveLength(1);
    expect(a.texts).toContain('https://clawd.test/');
    expect(a.texts.some((t) => t.startsWith('세계'))).toBe(false);
    expect(sa.scenes.cardView()!.world).toBeNull();
    // a platform that takes no files gets the link
    const b = fakeCard({ share: true, files: false });
    const sb = makeScenes([def], { card: b.env });
    sb.scenes.bootSync();
    await clearFlat(sb);
    sb.ui.emit({ type: 'shareCard' });
    await sb.scenes.settle();
    expect(b.shared).toHaveLength(1);
    expect(b.shared[0].files).toBeUndefined();
    expect(sb.ui.toasts.at(-1)).toBe(CARD_KR.link);
    expect(sb.tele.of('share_click').at(-1)).toMatchObject({ via: 'link', kind: 'card' });
    // the clipboard
    const c = fakeCard({ clipboard: true });
    const sc = makeScenes([def], { card: c.env });
    sc.scenes.bootSync();
    await clearFlat(sc);
    sc.ui.emit({ type: 'shareCard' });
    await sc.scenes.settle();
    expect(c.copied).toEqual(['https://clawd.test/?race=run-1&z=flat']);
    expect(sc.ui.toasts.at(-1)).toBe(CARD_KR.clipboard);
    // nothing at all (Node, a locked-down browser)
    const d = fakeCard({ canvas: false });
    const sd = makeScenes([def], { card: d.env });
    sd.scenes.bootSync();
    await clearFlat(sd);
    sd.ui.emit({ type: 'shareCard' });
    await sd.scenes.settle();
    expect(sd.ui.toasts.at(-1)).toBe(CARD_KR.failed);
    expect(sd.tele.of('share_click').at(-1)).toMatchObject({ via: 'failed' });
  });

  it('a game over shares the tide card: the height is the figure, the link is the site', async () => {
    const tide = tideRoom();
    const card = fakeCard({ share: true, files: true });
    const ui = fakeUI(); const input = fakeInput(); const api = fakeApi([flatRoom()]);
    const { save } = makeSave();
    const scenes = new Scenes({
      renderer: fakeRenderer(), audio: fakeAudio(), ui, input, api, save, levels: [flatRoom()], build: 'test',
      makeEndless: () => ({ ...tide, id: 'endless' }), randomSeed: () => 1000, origin: 'https://clawd.test', card: card.env,
    });
    scenes.bootSync();
    ui.emit({ type: 'endless' });
    const summary = hopOver(scenes, ui, input, 12);
    expect(ui.screen).toBe('over');
    expect(ui.installCards.at(-1)).toBe(false);
    const view = scenes.cardView()!;
    expect(view.cleared).toBe(false);
    expect(view.height).toBe(Math.floor(summary.height));
    expect(view.url).toBe('https://clawd.test/');
    expect(view.zoneName).toBe(tide.name);
    ui.emit({ type: 'shareCard' });
    await scenes.settle();
    expect(card.shared).toHaveLength(1);
    expect(card.texts).toContain(String(Math.floor(summary.height)));
    expect(card.texts).toContain('도달 높이');
    expect(ui.toasts.at(-1)).toBe(CARD_KR.files);
  });

  it('install card: allowed on a story clear until three 나중에 (persisted and repaired), never on a locked race or a daily', async () => {
    const def = flatRoom();
    const s = makeScenes([def]);
    s.scenes.bootSync();
    expect(s.ui.installCards).toEqual([]);
    await clearFlat(s);
    expect(s.ui.installCards.at(-1)).toBe(true);
    expect(s.ui.shown.at(-1)).toBe('result');
    s.ui.emit({ type: 'installCardDismiss' });
    expect(s.save.progress.installCardDismissed).toBe(1);
    expect(s.ui.installCards.at(-1)).toBe(false);
    for (let n = 2; n <= INSTALL_CARD_MAX_DISMISS; n++) {
      s.ui.emit({ type: 'quit' });
      await clearFlat(s);
      expect(s.ui.installCards.at(-1)).toBe(true);
      s.ui.emit({ type: 'installCardDismiss' });
      expect(s.save.progress.installCardDismissed).toBe(n);
    }
    s.ui.emit({ type: 'quit' });
    await clearFlat(s);
    expect(s.ui.installCards.at(-1)).toBe(false);
    // persisted through the save and repaired on load
    s.save.flush();
    const again = makeSave(s.storage);
    expect(again.save.progress.installCardDismissed).toBe(INSTALL_CARD_MAX_DISMISS);
    expect(repairProgress({ installCardDismissed: -2 }, defaultProgress('p')).installCardDismissed).toBeUndefined();
    expect(repairProgress({ installCardDismissed: 'x' }, defaultProgress('p')).installCardDismissed).toBeUndefined();
    expect(repairProgress({ installCardDismissed: 2.7 }, defaultProgress('p')).installCardDismissed).toBe(2);
    expect(repairProgress({}, defaultProgress('p')).installCardDismissed).toBeUndefined();

    // a locked zone raced through a link is not the player's clear
    const first = flatRoom();
    const second: LevelDef = { ...flatRoom(), id: 'flat2', name: '둘째 방' };
    const r = makeScenes([first, second]);
    r.scenes.bootSync();
    r.api.ghosts['run-locked'] = {
      runId: 'run-locked', mode: 'story', board: 'flat2', levelId: 'flat2', seed: second.seed, assist: false,
      masks: encodeMasks(new Uint8Array(900).fill(IN.RIGHT)), name: '친구A', ticks: 900,
    };
    expect(await r.scenes.startRace('run-locked')).toBe(true);
    r.input.heldMask = IN.RIGHT;
    runFrames(r.scenes, () => r.ui.screen === 'result');
    await r.scenes.settle();
    expect(r.ui.installCards.at(-1)).toBe(false);

    // a daily clear is not a story clear
    const daily: LevelDef = { ...flatRoom(), id: 'daily', name: '데일리' };
    const d = makeScenes([flatRoom()], { makeDaily: () => daily });
    d.scenes.bootSync();
    d.scenes.startDaily({ date: '2026-09-06', seed: 7, levelId: 'daily', expiresAt: '2026-09-07T00:00:00.000Z' });
    d.input.heldMask = IN.RIGHT;
    runFrames(d.scenes, () => d.ui.screen === 'result');
    await d.scenes.settle();
    expect(d.ui.result!.summary.cleared).toBe(true);
    expect(d.ui.installCards.at(-1)).toBe(false);
  });

  it('go(): daily opens the daily screen and fetches the tower; endless starts a climb; ignored mid-run', async () => {
    const def = flatRoom();
    const s = makeScenes([def]);
    s.scenes.bootSync();
    expect(s.ui.screen).toBe('title');
    expect(s.scenes.go('daily')).toBe(true);
    expect(s.ui.screen).toBe('daily');
    await s.scenes.settle();
    expect(s.scenes.daily).not.toBeNull();
    expect(s.ui.dailyCalls.length).toBeGreaterThan(0);
    expect(s.scenes.run).toBeNull();
    const s2 = makeScenes([def]);
    s2.scenes.bootSync();
    expect(s2.scenes.go('endless')).toBe(true);
    expect(s2.scenes.run?.mode).toBe('endless');
    expect(s2.ui.screen).toBe('play');
    expect(s2.scenes.go('daily')).toBe(false);   // mid-run: nothing changes
    expect(s2.scenes.run?.mode).toBe('endless');
    expect(s2.ui.screen).toBe('play');
  });
});
