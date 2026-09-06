/**
 * Shell tests: the tick scheduler, the fx bus, the camera, the save layer, the
 * API client, echoes and the scene machine — all headless. `Scenes` is driven
 * through fake ports (renderer / audio / ui / input / api), so the whole flow
 * "start → run right → goal → progress → submit → result" runs in Node, and the
 * recorded mask log is replayed through `verifyReplay` exactly as the server
 * would.
 */
import { describe, expect, it } from 'vitest';
import { DT, IN, MAX_TICKS } from '../../src/sim/types.js';
import type {
  InputMask, LevelDef, PlayerState, RunSummary, SimEvent,
} from '../../src/sim/types.js';
import { Sim } from '../../src/sim/sim.js';
import { decodeMasks, encodeMasks, verifyReplay } from '../../src/sim/replay.js';
import { PlayerRef, RejectReason } from '../../src/shared/protocol.js';
import type {
  DailyResponse, GhostResponse, LeaderboardEntry, LeaderboardQuery, LeaderboardResponse, RunResponse, RunSubmit,
} from '../../src/shared/protocol.js';
import type {
  ApiPort, AudioPort, Binds, FxState, GhostView, HudState, InputPort, MenuAction, RendererPort, ResultView,
  Screen, Settings, TouchState, UIAction, WorldView,
} from '../../src/client/contracts.js';
import { MAX_STEPS_PER_FRAME, TickScheduler, planTicks } from '../../src/client/loop.js';
import { FxBus } from '../../src/client/fx.js';
import { Camera } from '../../src/client/camera.js';
import {
  DEFAULT_NAME, PROGRESS_KEY, SETTINGS_KEY, Save, deepMerge, newPlayerId, type StorageLike,
} from '../../src/client/save.js';
import { Api, ApiError } from '../../src/client/net/api.js';
import { ECHO_ALPHA, Echo } from '../../src/client/echo/echo.js';
import { Scenes, RESULT_DELAY, type ShellUI } from '../../src/client/scenes.js';
import { ShotScript, parseShotQuery } from '../../src/client/shot.js';
import { flatRoom, openRoom, shaftRoom, tideRoom } from '../fixtures/levels.js';

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
}
function fakeRenderer(): FakeRenderer {
  const r: FakeRenderer = {
    setLevelCalls: 0, draws: 0, titleDraws: 0, events: [], lastView: null, lastGhosts: [], lastFx: null, lastDt: 0,
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
    events: [] as SimEvent[], track: null as string | null, intensity: 0, muffled: false, inits: 0, ready: true,
    init() { a.inits++; },
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

interface FakeUI extends ShellUI {
  cbs: ((a: UIAction) => void)[]; shown: Screen[]; result: ResultView | null; over: { summary: RunSummary; best: number } | null;
  huds: HudState[]; hints: (string | null)[]; toasts: string[]; banners: string[];
  dailyCalls: [DailyResponse | null, LeaderboardResponse | null, string][]; selectRefreshes: number;
  emit(a: UIAction): void; setScreen(s: Screen): void;
}
function fakeUI(): FakeUI {
  let scr: Screen = 'boot';
  const touch: TouchState = { active: false, x: 0, y: 0, jump: false, dash: false, jumpPressed: false, dashPressed: false };
  const u: FakeUI = {
    cbs: [], shown: [], result: null, over: null, huds: [], hints: [], toasts: [], banners: [], dailyCalls: [], selectRefreshes: 0,
    on(cb) { u.cbs.push(cb); },
    show(s) { scr = s; u.shown.push(s); },
    get screen() { return scr; },
    frame() {},
    hud(h) { u.huds.push(h); },
    hint(t) { u.hints.push(t); },
    toast(t) { u.toasts.push(t); },
    banner(t) { u.banners.push(t); },
    refreshSelect() { u.selectRefreshes++; },
    setDaily(d, lb, status) { u.dailyCalls.push([d, lb, status]); },
    showResult(v) { u.result = v; scr = 'result'; u.shown.push('result'); },
    updateResult(v) { u.result = v; },
    showOver(s, best) { u.over = { summary: s, best }; scr = 'over'; u.shown.push('over'); },
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
}
function fakeApi(levels: LevelDef[]): FakeApi {
  const a: FakeApi = {
    submissions: [], lbQueries: [], ghosts: {}, failWith: null, board: [],
    levels: Object.fromEntries(levels.map((l) => [l.id, l])),
    async daily(): Promise<DailyResponse> {
      return { date: '2026-09-06', seed: 12345, levelId: 'daily', expiresAt: '2026-09-07T00:00:00.000Z' };
    },
    async submitRun(body): Promise<RunResponse> {
      if (a.failWith) throw a.failWith;
      a.submissions.push(body);
      const def = a.levels[body.levelId];
      const masks = decodeMasks(body.masks);
      const v = verifyReplay(def, { v: 1, levelId: body.levelId, seed: body.seed ?? def.seed, assist: body.assist, masks }, body.claim);
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
    async health() { return { ok: true as const, version: 'test', uptime: 1 }; },
  };
  return a;
}

function makeScenes(levels: LevelDef[], opts: { assist?: boolean; echoWorld?: boolean; echoSelf?: boolean } = {}) {
  const renderer = fakeRenderer();
  const audio = fakeAudio();
  const ui = fakeUI();
  const input = fakeInput();
  const api = fakeApi(levels);
  const { save, timers } = makeSave();
  save.settings.assist = !!opts.assist;
  save.settings.echoSelf = opts.echoSelf ?? true;
  save.settings.echoWorld = opts.echoWorld ?? false;
  const scenes = new Scenes({
    renderer, audio, ui, input, api, save, levels, build: 'test', randomSeed: () => 777, random: () => 0.5,
  });
  return { scenes, renderer, audio, ui, input, api, save, timers };
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
    const masks = decodeMasks(body.masks);
    expect(masks.length).toBeLessThanOrEqual(sim.state.tick);
    const v = verifyReplay(def, { v: 1, levelId: 'flat', seed: def.seed, assist: false, masks }, body.claim);
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
    expect(labels).toContain('라이벌');
    expect(api.lbQueries.some((q) => q.limit === 1)).toBe(true);
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
