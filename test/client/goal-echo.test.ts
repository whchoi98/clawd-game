/**
 * Goal echo (P2-1): when the world echo cannot be shown — the board is empty,
 * the player is offline or the API fails — and 세계 메아리 is on, the shell runs
 * the zone's bundled developer clear as one '목표' ghost. With a board entry the
 * world echo loads instead. `?shot=<id>&ghost=par` forces the goal echo so a
 * capture renders exactly one ghost.
 *
 * Scenes is driven through minimal fake ports (see shell.test.ts for the full
 * harness — this file stays independent of it).
 */
import { describe, expect, it } from 'vitest';
import { IN, SIM_VERSION } from '../../src/sim/types.js';
import type { InputMask, LevelDef, RunSummary, SimEvent } from '../../src/sim/types.js';
import { LEVELS } from '../../src/sim/levels.generated.js';
import { GOAL_ECHOES } from '../../src/sim/echoes.generated.js';
import { decodeMasks, verifyReplay } from '../../src/sim/replay.js';
import type { DailyResponse, GhostResponse, LeaderboardEntry, LeaderboardQuery, LeaderboardResponse, RunResponse, RunSubmit } from '../../src/shared/protocol.js';
import type {
  ApiPort, AudioPort, Binds, GhostView, HudState, InputPort, MenuAction, Progress, RendererPort, ResultView, Screen, TouchState, UIAction,
} from '../../src/client/contracts.js';
import { Save, type StorageLike } from '../../src/client/save.js';
import { ApiError } from '../../src/client/net/api.js';
import { GOAL_COLOR, GOAL_LABEL, goalEchoFor, goalMasksFor } from '../../src/client/echo/goal.js';
import { Scenes, type ShellUI } from '../../src/client/scenes.js';
import { parseShotQuery, runShot } from '../../src/client/shot.js';

const SOLVED = LEVELS.filter((l) => l.id in GOAL_ECHOES);
const T1 = LEVELS[0];
const T1_SOLVED = T1.id in GOAL_ECHOES;

const BINDS: Binds = {
  left: ['ArrowLeft'], right: ['ArrowRight'], up: ['ArrowUp'], down: ['ArrowDown'], jump: ['Space'], dash: ['ShiftLeft'],
  pause: ['Escape'], confirm: ['Enter'], cancel: ['Escape'], restart: ['KeyR'],
};

// ---------------------------------------------------------------- fakes
class MemStorage implements StorageLike {
  private readonly map = new Map<string, string>();
  getItem(k: string): string | null { return this.map.get(k) ?? null; }
  setItem(k: string, v: string): void { this.map.set(k, v); }
  removeItem(k: string): void { this.map.delete(k); }
}

interface FakeRenderer extends RendererPort { lastGhosts: GhostView[]; draws: number }
function fakeRenderer(): FakeRenderer {
  const r: FakeRenderer = {
    lastGhosts: [], draws: 0, goalScreen: null,
    setLevel() {}, draw(_s, _v, _f, ghosts) { r.draws++; r.lastGhosts = ghosts; }, onEvent() {}, drawTitle() {}, drawPortrait() {}, resize() {},
    viewW: 512, viewH: 288, fps: 60, qualityTier: 'high', applySettings() {}, clearParticles() {},
    skins: { clawd: { name: 'CLAWD', kr: '클로드' } },
  };
  return r;
}

function fakeAudio(): AudioPort {
  return { init() {}, unlock() {}, running: true, ready: true, applySettings() {}, onEvent() {}, setTrack() {}, setIntensity() {}, ui() {}, suspend() {}, resume() {} };
}

interface FakeUI extends ShellUI { emit(a: UIAction): void }
function fakeUI(): FakeUI {
  let scr: Screen = 'boot';
  const cbs: ((a: UIAction) => void)[] = [];
  const touch: TouchState = { active: false, x: 0, y: 0, jump: false, dash: false, jumpPressed: false, dashPressed: false };
  return {
    on(cb) { cbs.push(cb); }, show(s) { scr = s; }, get screen() { return scr; }, frame() {}, hud(_h: HudState) {}, hint() {}, toast() {},
    refreshSelect(_p: Progress, _l: LevelDef[]) {}, setDaily(_d: DailyResponse | null, _lb: LeaderboardResponse | null) {},
    showResult(_v: ResultView) { scr = 'result'; }, updateResult() {}, showOver(_s: RunSummary) { scr = 'over'; },
    applySettings() {}, touch, setPortraitPainter() {}, emit(a) { for (const cb of cbs) cb(a); },
  };
}

function fakeInput(): InputPort & { heldMask: InputMask } {
  const touch: TouchState = { active: false, x: 0, y: 0, jump: false, dash: false, jumpPressed: false, dashPressed: false };
  const i = {
    heldMask: 0 as InputMask, poll() {}, held() { return i.heldMask; }, takeLatched() { return 0; }, takeMenu(): MenuAction[] { return []; },
    menuHeld() { return false; }, setBinds() {}, capture() {}, reset() {}, lastDevice: 'keyboard' as const, touch, keyLabel(c: string) { return c; },
  };
  return i;
}

/** A board with `entries` rows and matching ghosts; `fail` makes every call throw (offline). */
function fakeApi(opts: { entries?: (LeaderboardEntry & { masks: string; seed: number })[]; fail?: boolean } = {}) {
  const calls = { leaderboard: 0, ghost: 0 };
  const api: ApiPort = {
    async daily(): Promise<DailyResponse> { throw new ApiError('offline', 0, 'offline'); },
    async submitRun(_b: RunSubmit): Promise<RunResponse> { throw new ApiError('offline', 0, 'offline'); },
    async leaderboard(q: LeaderboardQuery): Promise<LeaderboardResponse> {
      calls.leaderboard++;
      if (opts.fail) throw new ApiError('offline', 0, 'offline');
      const entries = (opts.entries ?? []).map(({ masks: _m, seed: _s, ...e }) => e);
      return { mode: q.mode, board: q.board, total: entries.length, entries };
    },
    async ghost(runId: string): Promise<GhostResponse> {
      calls.ghost++;
      const e = (opts.entries ?? []).find((x) => x.runId === runId);
      if (!e) throw new ApiError('not found', 404, 'not-found');
      return { runId, mode: 'story', board: T1.id, levelId: T1.id, seed: e.seed, assist: false, masks: e.masks, name: e.name, ticks: e.ticks };
    },
    async health() { return { ok: true as const, version: 'test', uptime: 1 }; },
  };
  return { api, calls };
}

function makeScenes(api: ApiPort, settings: { echoWorld: boolean; echoSelf?: boolean } = { echoWorld: true }) {
  const renderer = fakeRenderer();
  const ui = fakeUI();
  const input = fakeInput();
  const save = new Save({ storage: new MemStorage(), defaultBinds: BINDS, schedule: () => 1, cancel: () => {} });
  save.settings.echoWorld = settings.echoWorld;
  save.settings.echoSelf = settings.echoSelf ?? false;
  const scenes = new Scenes({ renderer, audio: fakeAudio(), ui, input, api, save, levels: LEVELS, build: 'test', randomSeed: () => 1, random: () => 0.5 });
  scenes.bootSync();
  return { scenes, renderer, ui, input, save };
}

/** Enough of a Document for runShot: the stamp lands on documentElement.dataset. */
function fakeDoc() {
  const dataset: Record<string, string> = {};
  const doc = {
    documentElement: { dataset },
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
  } as unknown as Document;
  return { doc, dataset };
}

// ---------------------------------------------------------------- goal.ts
describe('goalEchoFor', () => {
  it('builds an echo labelled 목표 in the goal colour for every zone with a current recording, and replays it to a clear', () => {
    expect(SOLVED.length).toBeGreaterThan(0);
    for (const def of SOLVED) {
      const echo = goalEchoFor(def);
      expect(echo, def.id).not.toBeNull();
      expect(echo!.label).toBe(GOAL_LABEL);
      expect(echo!.color).toBe(GOAL_COLOR);
      expect(echo!.sim.seed).toBe(def.seed);
      const v = verifyReplay(def, { v: SIM_VERSION, levelId: def.id, seed: def.seed, assist: false, masks: echo!.masks });
      expect(v.ok && v.summary.cleared && v.summary.deaths === 0, def.id).toBe(true);
      expect(echo!.masks).toEqual(decodeMasks(GOAL_ECHOES[def.id].masks));
    }
    // the label and colour are overridable (a rival-style caption, for instance)
    if (T1_SOLVED) {
      const custom = goalEchoFor(T1, '#123456', '기준')!;
      expect(custom.label).toBe('기준');
      expect(custom.color).toBe('#123456');
    }
  });

  it('refuses a zone without a recording and a recording from another sim / rev / seed', () => {
    expect(goalEchoFor({ ...T1, id: 'nope' })).toBeNull();
    expect(goalMasksFor({ id: 'nope', seed: 1 })).toBeNull();
    if (!T1_SOLVED) return;
    expect(goalMasksFor(T1)).not.toBeNull();
    expect(goalMasksFor({ ...T1, rev: (T1.rev ?? 0) + 1 })).toBeNull();
    expect(goalMasksFor(T1, T1.seed + 1)).toBeNull();
    expect(goalEchoFor({ ...T1, seed: T1.seed + 1 })).toBeNull();
  });
});

// ---------------------------------------------------------------- loadEchoes fallback
describe('Scenes.loadEchoes with the goal echo', () => {
  it('empty board → exactly one echo, labelled 목표, stepping in lockstep with the live sim', async () => {
    if (!T1_SOLVED) return;
    const { api, calls } = fakeApi({ entries: [] });
    const { scenes, ui, input, renderer } = makeScenes(api);
    ui.emit({ type: 'start', levelId: T1.id });
    await scenes.settle();
    const run = scenes.run!;
    expect(calls.leaderboard).toBe(1);
    expect(calls.ghost).toBe(0);
    expect(run.echoes.map((e) => e.label)).toEqual([GOAL_LABEL]);
    input.heldMask = IN.RIGHT;
    for (let i = 0; i < 90; i++) scenes.frame(1 / 60);
    expect(run.echoes[0].tick).toBe(run.sim.state.tick);
    expect(renderer.lastGhosts.length).toBe(1);
    expect(renderer.lastGhosts[0].label).toBe(GOAL_LABEL);
    expect(renderer.lastGhosts[0].color).toBe(GOAL_COLOR);
  });

  it('a board with an entry → the world echo is loaded instead and no 목표 echo appears', async () => {
    if (!T1_SOLVED) return;
    const top = {
      rank: 1, runId: 'run-rival', playerTag: 'bbbbbbbbbbbb', you: false, name: '라이벌', score: 900, ticks: 900, shards: 3, deaths: 0,
      cleared: true, height: 0, createdAt: '2026-09-06T00:00:00.000Z', masks: GOAL_ECHOES[T1.id].masks, seed: T1.seed,
    };
    const { api, calls } = fakeApi({ entries: [top] });
    const { scenes, ui } = makeScenes(api);
    ui.emit({ type: 'start', levelId: T1.id });
    await scenes.settle();
    expect(calls.ghost).toBe(1);
    // the only entry is the median → it runs as the 라이벌 (P2-4 label: kind · name)
    expect(scenes.run!.echoes.map((e) => e.label)).toEqual(['라이벌 · 라이벌']);
  });

  it('offline (API error) → the goal echo stands in; with 세계 메아리 off nothing is added', async () => {
    if (!T1_SOLVED) return;
    const down = makeScenes(fakeApi({ fail: true }).api);
    down.ui.emit({ type: 'start', levelId: T1.id });
    await down.scenes.settle();
    expect(down.scenes.run!.echoes.map((e) => e.label)).toEqual([GOAL_LABEL]);

    const off = makeScenes(fakeApi({ entries: [] }).api, { echoWorld: false });
    off.ui.emit({ type: 'start', levelId: T1.id });
    await off.scenes.settle();
    expect(off.scenes.run!.echoes).toEqual([]);
  });

  it('the ghost of the top entry not matching this zone falls back to the goal echo, and the goal echo is never doubled', async () => {
    if (!T1_SOLVED) return;
    const wrong = {
      rank: 1, runId: 'run-x', playerTag: 'cccccccccccc', you: false, name: '엉뚱', score: 900, ticks: 900, shards: 3, deaths: 0,
      cleared: true, height: 0, createdAt: '2026-09-06T00:00:00.000Z', masks: 'AAA=', seed: T1.seed,
    };
    const { api } = fakeApi({ entries: [wrong] });
    // the fake ghost route reports t1 for every run; point it at another zone by starting t2 with a t1 ghost
    const t2 = LEVELS[1];
    const { scenes, ui } = makeScenes(api);
    ui.emit({ type: 'start', levelId: t2.id });
    await scenes.settle();
    const labels = scenes.run!.echoes.map((e) => e.label);
    if (t2.id in GOAL_ECHOES) expect(labels).toEqual([GOAL_LABEL]); else expect(labels).toEqual([]);
    // a restart reloads echoes: still one
    ui.emit({ type: 'restart' });
    await scenes.settle();
    expect(scenes.run!.echoes.filter((e) => e.label === GOAL_LABEL).length).toBe(t2.id in GOAL_ECHOES ? 1 : 0);
  });
});

// ---------------------------------------------------------------- ?shot=<id>&ghost=par
describe('?shot=<id>&ghost=par', () => {
  it('parses ghost / grid flags and defaults them off', () => {
    const spec = parseShotQuery(new URLSearchParams('shot=t1&ghost=par&grid=1'))!;
    expect(spec.ghost).toBe('par');
    expect(spec.grid).toBe(true);
    const plain = parseShotQuery(new URLSearchParams('shot=t1'))!;
    expect(plain.ghost).toBeNull();
    expect(plain.grid).toBe(false);
    expect(parseShotQuery(new URLSearchParams('shot=t1&ghost=world'))!.ghost).toBeNull();
    expect(parseShotQuery(new URLSearchParams('shot=t1&grid=true'))!.grid).toBe(true);
    expect(parseShotQuery(new URLSearchParams('shot=t1&grid=0'))!.grid).toBe(false);
  });

  it('renders exactly one ghost, labelled 목표, and stamps ghosts: 1', () => {
    if (!T1_SOLVED) return;
    const { api } = fakeApi({ fail: true });
    const { scenes, renderer, ui } = makeScenes(api, { echoWorld: false });
    const { doc, dataset } = fakeDoc();
    const spec = parseShotQuery(new URLSearchParams(`shot=${T1.id}&ghost=par&frames=90&hold=right`))!;
    const out = runShot(spec, { scenes, renderer, ui, doc, levels: LEVELS, build: 'test' });
    expect(out.error).toBeUndefined();
    expect(out.ghosts).toBe(1);
    expect(out.ghostLabels).toEqual([GOAL_LABEL]);
    expect(out.grid).toBe(false);
    expect(renderer.lastGhosts).toHaveLength(1);
    expect(renderer.lastGhosts[0].label).toBe(GOAL_LABEL);
    expect(scenes.run!.echoes[0].tick).toBe(scenes.run!.sim.state.tick);
    expect(JSON.parse(dataset.shot as string).ghosts).toBe(1);
  });

  it('without the flag a capture draws no ghost; with grid=1 on a stage-less renderer it stamps grid: true and no stats', () => {
    const { api } = fakeApi({ fail: true });
    const { scenes, renderer, ui } = makeScenes(api, { echoWorld: false });
    const { doc } = fakeDoc();
    const plain = runShot(parseShotQuery(new URLSearchParams(`shot=${T1.id}&frames=30`))!, { scenes, renderer, ui, doc, levels: LEVELS, build: 'test' });
    expect(plain.ghosts).toBe(0);
    expect(renderer.lastGhosts).toHaveLength(0);
    const grid = runShot(parseShotQuery(new URLSearchParams(`shot=${T1.id}&frames=30&grid=1`))!, { scenes, renderer, ui, doc, levels: LEVELS, build: 'test' });
    expect(grid.error).toBeUndefined();
    expect(grid.grid).toBe(true);
    expect(grid.gridStats).toBeNull();
  });
});

void (0 as unknown as SimEvent);
