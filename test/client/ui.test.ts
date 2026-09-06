// @vitest-environment happy-dom
/**
 * Behavioural tests for the DOM UI against the real template, driven by a fake
 * InputPort. Nothing here touches the Sim, the renderer or the network (the
 * webfont link the loader appends is never fetched: CSS file loading is turned
 * off in that suite).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Binds, HudState, InputPort, MenuAction, Progress, ResultView, Settings, TouchState, UIAction,
} from '../../src/client/contracts.js';
import type { LevelDef, RunSummary } from '../../src/sim/types.js';
import { RejectReason } from '../../src/shared/protocol.js';
import type { LeaderboardResponse } from '../../src/shared/protocol.js';
import {
  HUD_TOPRIGHT_H, HUD_TOPRIGHT_W, IOS_HINT_DISMISSED_KEY, NAG_DISMISSED_KEY, REASON_KR, RESTART_HOLD_S, UI, reasonKr,
} from '../../src/client/ui/ui.js';
import {
  HINT_TOKENS, REHINT_HAZARD, REHINT_PIT, hasRawKeyName, hintFor, renderHint, tokenGlyph,
} from '../../src/client/ui/hints.js';
import { LEVELS as REAL_LEVELS } from '../../src/sim/levels.generated.js';
import { PHONE_MAX_SHORT_SIDE, isPhoneViewport, wantsRotatePrompt } from '../../src/client/ui/touch.js';
import { renderLeaderboard } from '../../src/client/ui/leaderboard.js';
import { findBindConflict } from '../../src/client/ui/settings.js';
import { LIVE_INTERVAL, fmtTicks, fmtTime } from '../../src/client/ui/hud.js';
import { echoWorldMode, setEchoWorldMode } from '../../src/client/save.js';
import { validateName } from '../../src/client/ui/screens.js';
import { Input } from '../../src/client/input/index.js';
import { FONTS_HREF, loadFonts } from '../../src/client/fonts.js';

// ------------------------------------------------------------------ fixtures
// happy-dom replaces the global URL, so resolve the template path with node:url/path.
const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(here, '../../public/index.html'), 'utf8');
function mountTemplate(): void {
  const body = html.slice(html.indexOf('<body>') + '<body>'.length, html.lastIndexOf('</body>'));
  document.body.innerHTML = body;
}

const BINDS: Binds = {
  left: ['ArrowLeft', 'KeyA'], right: ['ArrowRight', 'KeyD'], up: ['ArrowUp', 'KeyW'], down: ['ArrowDown', 'KeyS'],
  jump: ['Space', 'KeyZ'], dash: ['ShiftLeft', 'KeyX'], pause: ['Escape', 'KeyP'],
  confirm: ['Enter', 'Space'], cancel: ['Escape', 'Backspace'], restart: ['KeyR'],
};

function makeSettings(): Settings {
  return {
    v: 1, master: 0.8, music: 0.6, sfx: 0.9, shake: 1, bloom: true, grain: true, quality: 'auto',
    flashes: true, showTimer: true, skin: 'clawd', assist: false, invincible: false,
    echoSelf: true, echoWorld: false, binds: structuredClone(BINDS),
  };
}

interface FakeInput extends InputPort {
  queue: MenuAction[];
  heldSet: Set<MenuAction>;
  captured: ((code: string | null) => void) | null;
  binds: Binds | null;
}
function makeInput(): FakeInput {
  const touch: TouchState = { active: false, x: 0, y: 0, jump: false, dash: false, jumpPressed: false, dashPressed: false };
  const fi: FakeInput = {
    queue: [], heldSet: new Set(), captured: null, binds: null,
    poll() {}, held() { return 0; }, takeLatched() { return 0; },
    takeMenu() { return fi.queue.splice(0); },
    menuHeld(a) { return fi.heldSet.has(a); },
    setBinds(b) { fi.binds = b; },
    capture(cb) { fi.captured = cb; },
    reset() {},
    lastDevice: 'keyboard',
    touch,
    keyLabel(code) { return code.replace(/^Key/, ''); },
  };
  return fi;
}

const ZONES: [string, string, LevelDef['biome']][] = [
  ['t1', '첫 물결', 'tidepool'], ['t2', '해초 숲', 'tidepool'], ['t3', '소금 굴뚝', 'tidepool'],
  ['s1', '비의 계단', 'stormspire'], ['s2', '스위치 회랑', 'stormspire'], ['s3', '번개 첨탑', 'stormspire'],
  ['v1', '결정 다리', 'voidreef'], ['v2', '상승 기류', 'voidreef'], ['v3', '메아리의 정점', 'voidreef'],
];
const LEVELS: LevelDef[] = ZONES.map(([id, name, biome], i) => ({
  id, name, en: id.toUpperCase(), biome, par: 45 + i * 10, seed: i + 1, hint: '힌트', rows: ['P.......G', '#########'],
}));

function makeProgress(done: string[] = []): Progress {
  const levels: Progress['levels'] = {};
  for (const id of done) levels[id] = { done: true, bestTicks: 5400, bestShards: 20, stars: 3, relics: 1, deaths: 0 };
  return {
    v: 1, levels, endless: { bestHeight: 0, bestShards: 0, runs: 0 }, daily: {},
    totals: { deaths: 0, shards: 0 }, seen: {}, lastLevel: done.at(-1) ?? null,
    player: { id: 'abcdefgh-1234', name: '클로드' },
  };
}

/** A save with t1 cleared and no zone in progress: the title menu shows neither 이어하기 nor 바로 시작 (탑 오르기 comes first). */
function settledProgress(): Progress {
  const p = makeProgress(['t1']);
  p.lastLevel = null;
  return p;
}

function makeHud(over: Partial<HudState> = {}): HudState {
  return {
    hp: 3, maxHp: 3, shards: 0, totalShards: 20, relics: 0, totalRelics: 1, time: 0, showTimer: true,
    levelName: '첫 물결', biomeName: '조수 웅덩이', combo: 0, dashReady: true, assist: false, ...over,
  };
}

function makeSummary(over: Partial<RunSummary> = {}): RunSummary {
  return {
    levelId: 't1', cleared: true, ticks: 4800, time: 40, shards: 18, totalShards: 20, relics: 1, totalRelics: 1,
    deaths: 1, par: 45, rank: 'A', height: 0, ...over,
  };
}

/** Entries carry an opaque playerTag and a server-set `you` flag — never a raw player id. */
function makeLb(): LeaderboardResponse {
  const mk = (rank: number, name: string, you: boolean, ticks: number): LeaderboardResponse['entries'][number] => ({
    rank, runId: `run-${rank}`, playerTag: String(rank).padStart(12, '0'), you, name, score: ticks, ticks, shards: 20,
    deaths: 0, cleared: true, height: 0, createdAt: '2026-09-06T00:00:00.000Z',
  });
  return {
    mode: 'daily', board: '2026-09-06', total: 41,
    entries: [mk(1, '바다', false, 3900), mk(2, '클로드', true, 4100), mk(3, 'Kim', false, 4300)],
    yours: mk(2, '클로드', true, 4100),
  };
}

function setup(): { ui: UI; input: FakeInput; actions: UIAction[]; settings: Settings; sounds: string[] } {
  mountTemplate();
  const input = makeInput();
  const actions: UIAction[] = [];
  const sounds: string[] = [];
  const settings = makeSettings();
  const ui = new UI({
    document, input, defaultBinds: BINDS, skins: { clawd: { name: 'Clawd', kr: '클로드' }, azure: { name: 'Azure', kr: '남빛' } },
    audio: { ui: (n) => { sounds.push(n); }, init() {} },
  });
  ui.on((a) => actions.push(a));
  ui.applySettings(settings);
  return { ui, input, actions, settings, sounds };
}

const $ = <T extends Element = HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
};
const active = (s: string) => $(`#scr-${s}`).classList.contains('is-active');

// ------------------------------------------------------------------ tests
describe('UI screens', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('starts on boot and show() swaps the active base screen', () => {
    const { ui } = setup();
    expect(ui.screen).toBe('boot');
    expect(active('boot')).toBe(true);
    ui.show('title');
    expect(ui.screen).toBe('title');
    expect(active('title')).toBe(true);
    expect(active('boot')).toBe(false);
    ui.show('select');
    expect(active('select')).toBe(true);
    expect(active('title')).toBe(false);
    expect(document.querySelectorAll('.screen.is-active')).toHaveLength(1);
  });

  it('modals stack over the base and a base show() clears them', () => {
    const { ui } = setup();
    ui.show('play');
    ui.show('pause');
    expect(ui.screen).toBe('pause');
    expect(active('play')).toBe(true);
    expect(active('pause')).toBe(true);
    ui.show('settings');
    expect(ui.screen).toBe('settings');
    expect(active('pause')).toBe(true);
    // showing a modal already in the stack pops everything above it
    ui.show('pause');
    expect(ui.screen).toBe('pause');
    expect(active('settings')).toBe(false);
    ui.show('play');
    expect(ui.screen).toBe('play');
    expect(active('pause')).toBe(false);
  });

  it('boot() fills the progress bar without inline markup', () => {
    const { ui } = setup();
    ui.boot(0.5, '레벨 로드…');
    expect($('#boot-fill').style.width).toBe('50%');
    expect($('#boot-hint').textContent).toBe('레벨 로드…');
  });
});

describe('UI menu navigation', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('moves a cursor with takeMenu() edges and confirms by clicking', () => {
    const { ui, input, actions } = setup();
    ui.refreshSelect(settledProgress(), LEVELS);
    ui.show('title');
    const items = [...document.querySelectorAll<HTMLElement>('#title-menu .menu__item')].filter((b) => !b.hidden);
    expect(items[0].classList.contains('is-cursor')).toBe(true);
    input.queue.push('down');
    ui.frame(1 / 60, input);
    expect(items[0].classList.contains('is-cursor')).toBe(false);
    expect(items[1].classList.contains('is-cursor')).toBe(true);
    input.queue.push('up', 'up');
    ui.frame(1 / 60, input);
    // wrapped to the last item of the title screen (the name chip)
    expect(document.querySelectorAll('#scr-title .is-cursor')).toHaveLength(1);
    input.queue.push('down');
    ui.frame(1 / 60, input);
    expect(items[0].classList.contains('is-cursor')).toBe(true);
    input.queue.push('confirm');
    ui.frame(1 / 60, input);
    expect(actions.at(-1)).toEqual({ type: 'openSelect' });
  });

  it('repeats while a direction is held, after a delay', () => {
    const { ui, input } = setup();
    ui.refreshSelect(makeProgress(), LEVELS);
    ui.show('title');
    const items = [...document.querySelectorAll<HTMLElement>('#title-menu .menu__item')].filter((b) => !b.hidden);
    input.queue.push('down');
    input.heldSet.add('down');
    ui.frame(1 / 60, input);
    expect(items[1].classList.contains('is-cursor')).toBe(true);
    // 0.1 s later: still inside the initial repeat delay
    ui.frame(0.1, input);
    expect(items[1].classList.contains('is-cursor')).toBe(true);
    // well past the delay: at least one repeat
    ui.frame(0.4, input);
    expect(items[1].classList.contains('is-cursor')).toBe(false);
    input.heldSet.clear();
    const at = document.querySelector('#scr-title .is-cursor');
    ui.frame(0.5, input);
    expect(document.querySelector('#scr-title .is-cursor')).toBe(at);
  });

  it('hovering a menu item moves the cursor there', () => {
    const { ui } = setup();
    ui.show('title');
    const items = [...document.querySelectorAll<HTMLElement>('#title-menu .menu__item')].filter((b) => !b.hidden);
    items[2].dispatchEvent(new PointerEvent('pointerenter', { bubbles: false }));
    expect(items[2].classList.contains('is-cursor')).toBe(true);
    expect(items[0].classList.contains('is-cursor')).toBe(false);
  });

  it('cancel on the select screen goes back to the title and emits back', () => {
    const { ui, input, actions } = setup();
    ui.refreshSelect(makeProgress(), LEVELS);
    ui.show('select');
    input.queue.push('cancel');
    ui.frame(1 / 60, input);
    expect(ui.screen).toBe('title');
    expect(actions.at(-1)).toEqual({ type: 'back' });
  });

  it('pause edge during play opens the pause screen; resume comes from the menu', () => {
    const { ui, input, actions } = setup();
    ui.show('play');
    ui.hud(makeHud({ time: 12.5, shards: 4 }));
    input.queue.push('pause');
    ui.frame(1 / 60, input);
    expect(ui.screen).toBe('pause');
    expect($('#pause-stats').textContent).toContain('0:12.50');
    input.queue.push('confirm'); // cursor rests on 계속하기
    ui.frame(1 / 60, input);
    expect(actions.at(-1)).toEqual({ type: 'resume' });
    // a tap of the restart bind is the sim's IN.RETRY (checkpoint retry): the UI emits nothing
    ui.show('play');
    const n = actions.length;
    input.queue.push('restart');
    ui.frame(1 / 60, input);
    expect(actions.length).toBe(n);
  });

  it('holding the restart bind for RESTART_HOLD_S during play restarts the zone exactly once per hold', () => {
    const { ui, input, actions } = setup();
    ui.show('play');
    expect(RESTART_HOLD_S).toBeCloseTo(0.6);
    input.queue.push('restart');
    input.heldSet.add('restart');
    ui.frame(1 / 60, input);
    ui.frame(0.3, input);
    expect(actions.filter((a) => a.type === 'restart')).toHaveLength(0);
    ui.frame(0.3, input);                       // ≥ 0.6 s held
    expect(actions.filter((a) => a.type === 'restart')).toHaveLength(1);
    ui.frame(0.5, input);
    ui.frame(0.5, input);                       // still held: no repeat
    expect(actions.filter((a) => a.type === 'restart')).toHaveLength(1);
    input.heldSet.clear();
    ui.frame(1 / 60, input);                    // release resets
    input.heldSet.add('restart');
    ui.frame(0.35, input);
    ui.frame(0.35, input);
    expect(actions.filter((a) => a.type === 'restart')).toHaveLength(2);
    // one stalled frame never counts as a whole hold
    input.heldSet.clear();
    ui.frame(1 / 60, input);
    input.heldSet.add('restart');
    ui.frame(5, input);
    expect(actions.filter((a) => a.type === 'restart')).toHaveLength(2);
    // a short hold never fires, and neither does a hold outside play
    input.heldSet.clear();
    ui.frame(1 / 60, input);
    input.heldSet.add('restart');
    ui.frame(0.4, input);
    input.heldSet.clear();
    ui.frame(1 / 60, input);
    expect(actions.filter((a) => a.type === 'restart')).toHaveLength(2);
    ui.show('pause');
    input.heldSet.add('restart');
    ui.frame(1, input);
    expect(actions.filter((a) => a.type === 'restart')).toHaveLength(2);
  });

  it('clicking a data-act button emits the mapped action', () => {
    const { ui, actions } = setup();
    ui.show('title');
    $('#title-menu [data-act="endless"]').click();
    expect(actions.at(-1)).toEqual({ type: 'endless' });
    $('#title-menu [data-act="openDaily"]').click();
    expect(actions.at(-1)).toEqual({ type: 'openDaily' });
    expect(ui.screen).toBe('daily');
  });
});

describe('UI HUD', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('renders hearts, shards and relics from HudState', () => {
    const { ui } = setup();
    ui.show('play');
    ui.hud(makeHud({ hp: 2, shards: 7, relics: 1, time: 61.25 }));
    const hearts = document.querySelectorAll('#hud-hearts .heart');
    expect(hearts).toHaveLength(3);
    expect(document.querySelectorAll('#hud-hearts .heart.off')).toHaveLength(1);
    expect($('#hud-shards').textContent).toBe('7');
    expect($('#hud-shards-total').textContent).toBe('/20');
    expect($('#hud-relics').textContent).toBe('1');
    expect($('#hud-timer').textContent).toBe('1:01.25');
    expect($('#hud-level').textContent).toContain('첫 물결');
    expect($('#hud-height').hidden).toBe(true);
    ui.hud(makeHud({ height: 37.8, totalRelics: 0, showTimer: false }));
    expect($('#hud-height').hidden).toBe(false);
    expect($('#hud-height-n').textContent).toBe('37');
    expect($('#hud-relic-chip').hidden).toBe(true);
    expect($('#hud-timer').hidden).toBe(true);
  });

  it('throttles the live region to one update per LIVE_INTERVAL', () => {
    const { ui, input } = setup();
    ui.show('play');
    const sr = $('#hud-sr');
    ui.hud(makeHud({ shards: 1 }));
    expect(sr.textContent).toBe('파편 1 / 20');
    ui.hud(makeHud({ shards: 2 }));
    ui.hud(makeHud({ shards: 3 }));
    expect(sr.textContent).toBe('파편 1 / 20');
    ui.frame(LIVE_INTERVAL / 2, input);
    expect(sr.textContent).toBe('파편 1 / 20');
    ui.frame(LIVE_INTERVAL, input);
    expect(sr.textContent).toBe('파편 3 / 20');
    expect(LIVE_INTERVAL).toBeGreaterThanOrEqual(0.25);
  });

  it('hint() and toast() write DOM text', () => {
    const { ui, input } = setup();
    ui.show('play');
    ui.hint('대시로 결정을 통과하자');
    expect($('#hud-hint').hidden).toBe(false);
    expect($('#hud-hint').textContent).toBe('대시로 결정을 통과하자');
    ui.hint(null);
    expect($('#hud-hint').hidden).toBe(true);
    ui.toast('기록 지점');
    expect($('#hud-toast').textContent).toBe('기록 지점');
    expect($('#hud-toast').classList.contains('show')).toBe(true);
    ui.frame(3, input);
    expect($('#hud-toast').classList.contains('show')).toBe(false);
  });

  it('fmtTime pads minutes, seconds and centiseconds', () => {
    expect(fmtTime(0)).toBe('0:00.00');
    expect(fmtTime(65.5)).toBe('1:05.50');
    expect(fmtTime(-3)).toBe('0:00.00');
  });

  it('renders hint templates for the device last used and re-renders when it changes', () => {
    const { ui, input, settings } = setup();
    ui.show('play');
    ui.hint('{move} 이동 · {jump} 점프 · {dash} 대시');
    const hint = $('#hud-hint');
    expect(hint.hidden).toBe(false);
    // the fake keyLabel strips 'Key'; arrows and Space come from binds slot 0
    expect(hint.textContent).toBe('ArrowLeft ArrowRight 이동 · Space 점프 · Shift 대시');
    (input as { lastDevice: string }).lastDevice = 'touch';
    ui.frame(1 / 60, input);
    expect(hint.textContent).toBe('왼쪽 스틱 이동 · JUMP 점프 · DASH 대시');
    expect(hint.textContent).not.toMatch(/Shift|Space|←|→/);
    (input as { lastDevice: string }).lastDevice = 'gamepad';
    ui.frame(1 / 60, input);
    expect(hint.textContent).toContain('Ⓐ 점프');
    expect(hint.textContent).toContain('Ⓧ 대시');
    // a rebind shows up in the keyboard glyphs
    (input as { lastDevice: string }).lastDevice = 'keyboard';
    settings.binds.jump = ['KeyJ'];
    ui.frame(1 / 60, input);
    expect(hint.textContent).toContain('J 점프');
    ui.hint(null);
    expect(hint.hidden).toBe(true);
    ui.hint('토큰 없는 힌트');
    expect(hint.textContent).toBe('토큰 없는 힌트');
  });

  it('setGoalScreen hides the zone chip only while the goal sits under the HUD\'s top-right block', () => {
    const { ui } = setup();
    ui.show('play');
    ui.hud(makeHud());
    const level = $('#hud-level');
    const w = window.innerWidth;
    expect(w).toBeGreaterThan(HUD_TOPRIGHT_W);
    expect(level.hidden).toBe(false);
    ui.setGoalScreen({ x: w - HUD_TOPRIGHT_W / 2, y: HUD_TOPRIGHT_H / 2, onScreen: true });
    expect(level.hidden).toBe(true);
    ui.setGoalScreen({ x: w - HUD_TOPRIGHT_W / 2, y: HUD_TOPRIGHT_H + 40, onScreen: true });
    expect(level.hidden).toBe(false);
    ui.setGoalScreen({ x: w - HUD_TOPRIGHT_W - 30, y: 20, onScreen: true });
    expect(level.hidden).toBe(false);
    ui.setGoalScreen({ x: w - 10, y: 10, onScreen: false });   // off screen: the renderer draws a beacon instead
    expect(level.hidden).toBe(false);
    ui.setGoalScreen({ x: w - 10, y: 10, onScreen: true });
    expect(level.hidden).toBe(true);
    ui.setGoalScreen(null);
    expect(level.hidden).toBe(false);
    // a new run starts with the chip visible
    ui.setGoalScreen({ x: w - 10, y: 10, onScreen: true });
    ui.show('title');
    ui.show('play');
    expect(level.hidden).toBe(false);
  });
});

describe('hint templates (hints.ts)', () => {
  const DEVICES = ['keyboard', 'gamepad', 'touch'] as const;

  it('hintFor renders every shipped zone for every device; touch never names a key', () => {
    expect(REAL_LEVELS).toHaveLength(9);
    for (const def of REAL_LEVELS) {
      expect(def.hint, def.id).toBeTruthy();
      expect(hasRawKeyName(def.hint!), `${def.id} hint carries a raw key name`).toBe(false);
      for (const device of DEVICES) {
        const text = hintFor(def, device);
        expect(text, `${def.id}/${device}`).toBeTruthy();
        expect(text).not.toMatch(/\{(move|jump|dash|stomp|down)\}/);
        expect(text).toMatch(/[가-힣]/);
      }
      expect(hintFor(def, 'touch')).not.toMatch(/Shift|Space|←|→/);
    }
    const t1 = REAL_LEVELS[0];
    expect(hintFor(t1, 'keyboard')).toBe('← → 이동 · Space 점프 · 공중에서 Space 한 번 더 — 2단 점프');
    expect(hintFor(t1, 'touch')).toBe('왼쪽 스틱 이동 · JUMP 점프 · 공중에서 JUMP 한 번 더 — 2단 점프');
    expect(hintFor(t1, 'gamepad')).toBe('왼쪽 스틱 이동 · Ⓐ 점프 · 공중에서 Ⓐ 한 번 더 — 2단 점프');
    expect(hintFor({ hint: undefined }, 'touch')).toBe('');
  });

  it('keyboard glyphs follow the current binds and the settings labels; modifiers lose their side', () => {
    const binds: Binds = { ...BINDS, left: ['KeyA'], right: ['KeyD'], jump: ['KeyZ'], dash: ['ControlLeft'], down: ['KeyS'] };
    const keyLabel = (c: string) => c.replace(/^Key/, '');
    expect(renderHint('{move}/{jump}/{dash}/{down}/{stomp}', 'keyboard', { binds, keyLabel })).toBe('A D/Z/Ctrl/S/S');
    expect(tokenGlyph('dash', 'keyboard')).toBe('Shift');
    expect(tokenGlyph('move', 'keyboard')).toBe('← →');
    expect(tokenGlyph('stomp', 'gamepad')).toBe('↓');
    expect(tokenGlyph('down', 'touch')).toBe('스틱 아래');
    expect(renderHint('{unknown} stays', 'touch')).toBe('{unknown} stays');
    expect(HINT_TOKENS).toEqual(['move', 'jump', 'dash', 'stomp', 'down']);
  });

  it('the re-hint templates are token-only 해라체 lines', () => {
    for (const t of [REHINT_PIT, REHINT_HAZARD]) {
      expect(hasRawKeyName(t)).toBe(false);
      expect(t).toMatch(/\{(jump|dash)\}/);
      expect(renderHint(t, 'touch')).not.toMatch(/Shift|Space|←|→/);
      expect(t).not.toMatch(/(요|니다|세요)$/);
    }
    expect(renderHint(REHINT_PIT, 'keyboard')).toContain('2단 점프');
  });

  it('hasRawKeyName flags the legacy key spellings and passes token templates', () => {
    for (const bad of ['← → 이동', 'SHIFT 대시', 'Shift 대시', 'Space 점프', 'A/D 이동', 'R 재시작', '↓ 스톰프']) {
      expect(hasRawKeyName(bad), bad).toBe(true);
    }
    for (const ok of ['{move} 이동 · {jump} 점프', 'DASH 버튼', 'JUMP', '0.4초 — 멈추지 말 것', '수정에서 수정으로 RUN']) {
      expect(hasRawKeyName(ok), ok).toBe(false);
    }
  });
});

describe('UI zone select', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('renders three tiers; clearing a zone opens the next two within the tier, the next tier stays locked', () => {
    const { ui } = setup();
    ui.refreshSelect(makeProgress(['t1']), LEVELS);
    expect(document.querySelectorAll('#sel-tiers .tier')).toHaveLength(3);
    const cards = [...document.querySelectorAll<HTMLButtonElement>('#sel-tiers .card')];
    expect(cards).toHaveLength(9);
    const byId = Object.fromEntries(cards.map((c) => [c.dataset.id, c]));
    expect(byId.t1.disabled).toBe(false);
    expect(byId.t2.disabled).toBe(false);
    expect(byId.t3.disabled).toBe(false);
    expect(byId.s1.disabled).toBe(true);
    expect(byId.s1.querySelector('.card__lock')).not.toBeNull();
    expect(byId.t3.querySelector('.card__lock')).toBeNull();
    expect(byId.t1.querySelector('.card__lock')).toBeNull();
    expect(byId.t1.querySelectorAll('.star.on')).toHaveLength(3);
    expect($('#sel-progress').textContent).toContain('1 / 9');
    expect($('#sel-progress').textContent).toContain('3 해금');
    // the cursor's default is the next challenge: the first open zone not yet cleared
    expect(byId.t2.hasAttribute('data-default')).toBe(true);
  });

  it('P2-6 · t3 done opens s1 and s2 (the tier boundary needs the previous zone itself); a fresh save opens t1 only', () => {
    const { ui } = setup();
    ui.refreshSelect(makeProgress(['t1', 't2', 't3']), LEVELS);
    const disabled = (id: string) => $<HTMLButtonElement>(`#sel-tiers .card[data-id="${id}"]`).disabled;
    expect(disabled('s1')).toBe(false);
    expect(disabled('s2')).toBe(false);
    expect(disabled('s3')).toBe(true);
    expect(disabled('v1')).toBe(true);
    // only t2 cleared (t3 not): s1 waits for t3 even though it is two steps past t2
    ui.refreshSelect(makeProgress(['t1', 't2']), LEVELS);
    expect(disabled('t3')).toBe(false);
    expect(disabled('s1')).toBe(true);
    ui.refreshSelect(makeProgress(), LEVELS);
    expect(disabled('t1')).toBe(false);
    expect(disabled('t2')).toBe(true);
    expect(disabled('t3')).toBe(true);
  });

  it('a click on an unlocked card starts that zone; locked cards do nothing', () => {
    const { ui, actions } = setup();
    ui.refreshSelect(makeProgress(['t1']), LEVELS);
    ui.show('select');
    $('#sel-tiers .card[data-id="t2"]').click();
    expect(actions.at(-1)).toEqual({ type: 'start', levelId: 't2' });
    const n = actions.length;
    $('#sel-tiers .card[data-id="v1"]').click();
    expect(actions.length).toBe(n);
  });

  it('the cursor starts on the newest unlocked zone and moves across tiers', () => {
    const { ui, input } = setup();
    ui.refreshSelect(makeProgress(['t1', 't2', 't3']), LEVELS);
    ui.show('select');
    expect($('#sel-tiers .card[data-id="s1"]').classList.contains('is-cursor')).toBe(true);
    input.queue.push('up');
    ui.frame(1 / 60, input);
    expect($('#sel-tiers .card[data-id="t1"]').classList.contains('is-cursor')).toBe(true);
    input.queue.push('right');
    ui.frame(1 / 60, input);
    expect($('#sel-tiers .card[data-id="t2"]').classList.contains('is-cursor')).toBe(true);
  });

  it('updates the title continue entry and the name chip', () => {
    const { ui, actions } = setup();
    ui.refreshSelect(makeProgress(['t1']), LEVELS);
    const cont = $<HTMLButtonElement>('#title-menu [data-act="continue"]');
    expect(cont.hidden).toBe(false);
    expect(cont.textContent).toContain('이어하기');
    expect(cont.textContent).not.toContain('바로 시작');
    expect($('#continue-note').textContent).toContain('첫 물결');
    expect($('#title-name').textContent).toBe('클로드');
    ui.show('title');
    cont.click();
    expect(actions.at(-1)).toEqual({ type: 'start', levelId: 't1' });
  });

  it('a fresh save starts straight in: the first title entry reads 바로 시작 · <first zone> and one confirm starts it', () => {
    const { ui, input, actions } = setup();
    ui.refreshSelect(makeProgress(), LEVELS);           // lastLevel null, nothing done
    ui.show('title');
    const cont = $<HTMLButtonElement>('#title-menu [data-act="continue"]');
    expect(cont.hidden).toBe(false);
    expect(cont.textContent).toContain('바로 시작 · 첫 물결');
    expect(cont.classList.contains('is-cursor')).toBe(true);    // the cursor rests on it
    input.queue.push('confirm');
    ui.frame(1 / 60, input);
    expect(actions.at(-1)).toEqual({ type: 'start', levelId: 't1' });
    expect(ui.screen).toBe('title');                            // select was skipped
    // once a zone was played (lastLevel set) or cleared, the entry is the plain 이어하기 again
    const played = makeProgress();
    played.lastLevel = 't1';
    ui.refreshSelect(played, LEVELS);
    expect(cont.textContent).toContain('이어하기');
    expect(cont.textContent).not.toContain('바로 시작');
    const cleared = makeProgress(['t1']);
    cleared.lastLevel = null;
    ui.refreshSelect(cleared, LEVELS);
    expect(cont.hidden).toBe(true);
  });

  it('marks a zone this clear opened: is-unlocking on its card, data-default on it, one unlock sound when select shows', () => {
    const { ui, sounds } = setup();
    ui.show('play');
    ui.refreshSelect(makeProgress(['t1']), LEVELS, new Set(['t2']));
    const t2 = $('#sel-tiers .card[data-id="t2"]');
    expect(t2.classList.contains('is-unlocking')).toBe(true);
    expect(t2.hasAttribute('data-default')).toBe(true);
    expect($('#sel-tiers .card[data-id="t1"]').classList.contains('is-unlocking')).toBe(false);
    expect(sounds.filter((s) => s === 'unlock')).toHaveLength(0);   // not while the run is still on screen
    // the shell rebuilds the tower on the way back to select: the card still animates
    ui.refreshSelect(makeProgress(['t1']), LEVELS);
    expect($('#sel-tiers .card[data-id="t2"]').classList.contains('is-unlocking')).toBe(true);
    ui.show('select');
    expect(sounds.filter((s) => s === 'unlock')).toHaveLength(1);
    // subsequent rebuilds and visits are quiet and plain
    ui.refreshSelect(makeProgress(['t1']), LEVELS);
    expect($('#sel-tiers .card[data-id="t2"]').classList.contains('is-unlocking')).toBe(false);
    ui.show('title');
    ui.show('select');
    expect(sounds.filter((s) => s === 'unlock')).toHaveLength(1);
    // opening a zone while already on select sounds right away, once
    ui.refreshSelect(makeProgress(['t1', 't2']), LEVELS, new Set(['t3']));
    expect(sounds.filter((s) => s === 'unlock')).toHaveLength(2);
    expect($('#sel-tiers .card[data-id="t3"]').classList.contains('is-unlocking')).toBe(true);
    ui.refreshSelect(makeProgress(['t1', 't2']), LEVELS, new Set());
    expect(sounds.filter((s) => s === 'unlock')).toHaveLength(2);
  });

  it('echo toggles mutate settings and emit toggleEcho', () => {
    const { ui, actions, settings } = setup();
    ui.refreshSelect(makeProgress(), LEVELS);
    ui.show('select');
    const world = $('#sel-echoes [data-echo="world"]');
    expect(world.getAttribute('aria-checked')).toBe('false');
    world.click();
    expect(settings.echoWorld).toBe(true);
    expect(world.getAttribute('aria-checked')).toBe('true');
    expect(actions.at(-1)).toEqual({ type: 'toggleEcho', which: 'world', on: true });
  });
});

describe('UI daily screen', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('shows loading, then date / seed / my record and the board', () => {
    const { ui } = setup();
    const progress = makeProgress();
    progress.daily['2026-09-06'] = { bestTicks: 4100, cleared: true, height: 150, seed: 0xdeadbeef };
    ui.refreshSelect(progress, LEVELS);
    ui.show('daily');
    ui.setDaily(null, null, 'loading');
    expect($('#daily-status').textContent).toContain('불러오는 중');
    ui.setDaily({ date: '2026-09-06', seed: 0xdeadbeef, levelId: 'daily', expiresAt: '2026-09-07T00:00:00.000Z' }, makeLb(), 'ok');
    expect($('#daily-date').textContent).toContain('2026');
    expect($('#daily-date').textContent).toContain('9월');
    expect($('#daily-seed').textContent).toBe('DEADBEEF');
    expect($('#daily-mine').textContent).toContain(fmtTime(4100 / 120));
    expect(document.querySelectorAll('#daily-lb tbody tr.lb__row')).toHaveLength(3);
    expect($('#daily-lb tr.is-you .lb__name').textContent).toBe('클로드');
    expect($('#daily-lb').textContent).toContain('내 순위');
    expect($('#daily-lb').textContent).toContain('2위');
  });

  it('error state reads as offline and refresh requests the board', () => {
    const { ui, actions } = setup();
    ui.show('daily');
    ui.setDaily({ date: '2026-09-06', seed: 1, levelId: 'daily', expiresAt: '2026-09-07T00:00:00.000Z' }, null, 'error');
    expect($('#daily-lb').textContent).toContain('오프라인');
    $('#scr-daily [data-act="refreshLb"]').click();
    expect(actions.at(-1)).toEqual({ type: 'requestLeaderboard', mode: 'daily', board: '2026-09-06' });
    $('#scr-daily [data-act="daily"]').click();
    expect(actions.at(-1)).toEqual({ type: 'daily' });
  });
});

describe('leaderboard renderer', () => {
  beforeEach(() => { document.body.innerHTML = '<div id="host"></div>'; });

  it('renders rows and highlights yours', () => {
    const host = $('#host');
    renderLeaderboard(host, makeLb(), { status: 'ok' });
    const rows = host.querySelectorAll('tbody tr.lb__row');
    expect(rows).toHaveLength(3);
    expect(rows[0].querySelector('.lb__rank')!.textContent).toBe('1');
    expect(rows[0].querySelector('.lb__time')!.textContent).toBe(fmtTime(3900 / 120));
    expect(rows[1].classList.contains('is-you')).toBe(true);
    expect(rows[0].classList.contains('is-you')).toBe(false);
  });

  it('appends your row after a gap when you are outside the top', () => {
    const lb = makeLb();
    for (const e of lb.entries) e.you = false;
    lb.yours = { ...lb.entries[0], rank: 27, playerTag: 'abcdefabcdef', you: true, name: '나', runId: 'run-me' };
    renderLeaderboard($('#host'), lb, { status: 'ok' });
    const you = $('#host tr.is-you');
    expect(you.querySelector('.lb__rank')!.textContent).toBe('27');
    expect($('#host').querySelectorAll('tr.is-you')).toHaveLength(1);
    expect($('#host').querySelector('tr.lb__gap')).not.toBeNull();
  });

  it('highlights only the row the server flagged as you (no player id in the response)', () => {
    const lb = makeLb();
    delete lb.yours;
    renderLeaderboard($('#host'), lb, { status: 'ok' });
    const rows = [...$('#host').querySelectorAll('tbody tr.lb__row')];
    expect(rows.map((r) => r.classList.contains('is-you'))).toEqual([false, true, false]);
    expect($('#host').innerHTML).not.toContain('abcdefgh-1234');
  });

  it('escapes names as text and shows tide heights for unfinished runs', () => {
    const lb = makeLb();
    lb.entries[0].name = '<img src=x onerror=alert(1)>';
    lb.entries[2].cleared = false;
    lb.entries[2].height = 88.7;
    renderLeaderboard($('#host'), lb, { status: 'ok' });
    expect($('#host').querySelector('img')).toBeNull();
    expect($('#host tbody tr:nth-child(1) .lb__name').textContent).toBe('<img src=x onerror=alert(1)>');
    expect($('#host tbody tr:nth-child(3) .lb__time').textContent).toContain('88');
  });

  it('shows empty / loading / error notes', () => {
    renderLeaderboard($('#host'), null, { status: 'loading' });
    expect($('#host').textContent).toContain('불러오는 중');
    renderLeaderboard($('#host'), null, { status: 'error' });
    expect($('#host').textContent).toContain('오프라인');
    renderLeaderboard($('#host'), { mode: 'story', board: 't1', total: 0, entries: [] }, { status: 'ok' });
    expect($('#host').textContent).toContain('아직 기록이 없');
  });
});

describe('UI result and over screens', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  function view(over: Partial<ResultView> = {}): ResultView {
    return { summary: makeSummary(), levelName: '첫 물결', personalBest: true, stars: 2, submit: { state: 'pending' }, nextLevelId: 't2', ...over };
  }

  it('shows the rank, rows, stars and the pending submission', () => {
    const { ui } = setup();
    ui.show('play');
    ui.showResult(view());
    expect(ui.screen).toBe('result');
    expect($('#res-rank').textContent).toBe('A');
    expect($('#res-rank').dataset.rank).toBe('A');
    expect($('#res-rows').textContent).toContain(fmtTime(40));
    expect($('#res-rows').textContent).toContain('신기록');
    expect($('#res-rows').textContent).toContain('18 / 20');
    expect(document.querySelectorAll('#res-stars .star.on')).toHaveLength(2);
    expect($('#res-submit').hidden).toBe(false);
    expect($('#res-submit').textContent).toContain('전송 중');
    expect($<HTMLButtonElement>('#scr-result [data-act="next"]').hidden).toBe(false);
  });

  it('updateResult rewrites the submission line in place', () => {
    const { ui } = setup();
    ui.show('play');
    ui.showResult(view());
    ui.updateResult(view({ submit: { state: 'accepted', rank: 3, total: 41 }, leaderboard: makeLb() }));
    expect($('#res-submit').textContent).toContain('세계 3위');
    expect(document.querySelectorAll('#res-lb tbody tr.lb__row')).toHaveLength(3);
    ui.updateResult(view({ submit: { state: 'rejected', reason: 'claim-mismatch' } }));
    expect($('#res-submit').textContent).toContain('거절됨');
    expect($('#res-submit').textContent).toContain(REASON_KR['claim-mismatch']);
    ui.updateResult(view({ submit: { state: 'rejected', reason: 'rate-limited' } }));
    expect($('#res-submit').textContent).toContain('요청이 너무 잦다');
    ui.updateResult(view({ submit: { state: 'offline' } }));
    expect($('#res-submit').textContent).toContain('오프라인');
    ui.updateResult(view({ submit: { state: 'idle' } }));
    expect($('#res-submit').hidden).toBe(true);
  });

  it('hides the next button when there is no next zone', () => {
    const { ui } = setup();
    ui.show('play');
    ui.showResult(view({ nextLevelId: undefined }));
    expect($<HTMLButtonElement>('#scr-result [data-act="next"]').hidden).toBe(true);
  });

  it('shows "다음 구역 해금: <name>" only when the clear opened a zone, and pops the rank letter', () => {
    const { ui } = setup();
    ui.show('play');
    ui.showResult(view());
    const row = $('#res-unlock');
    expect(row.hidden).toBe(true);
    expect(row.textContent).toBe('');
    ui.showResult(view({ unlocked: { levelId: 't2', name: '해초 숲' } }));
    expect(row.hidden).toBe(false);
    expect(row.textContent).toBe('다음 구역 해금: 해초 숲');
    expect($('#res-rank').classList.contains('pop')).toBe(true);
    ui.showResult(view({ nextLevelId: 't2', unlocked: undefined }));
    expect(row.hidden).toBe(true);
  });

  it('showOver reports the height and best height', () => {
    const { ui, actions } = setup();
    ui.show('play');
    ui.showOver(makeSummary({ cleared: false, height: 63.4, levelId: 'endless' }), 50);
    expect(ui.screen).toBe('over');
    expect($('#over-rows').textContent).toContain('63');
    expect($('#over-rows').textContent).toContain('신기록');
    $('#scr-over [data-act="retry"]').click();
    expect(actions.at(-1)).toEqual({ type: 'retry' });
  });

  it('compares tide heights as whole tiles: a sub-tile climb or a tie is never a record', () => {
    const { ui } = setup();
    ui.show('play');
    // 0.7 tiles displays as 0 — it must not read 신기록 against a best of 0
    ui.showOver(makeSummary({ cleared: false, height: 0.7, levelId: 'endless' }), 0);
    expect($('#over-rows').textContent).not.toContain('신기록');
    expect($('#over-rows .res__row b').textContent).toBe('0');
    // 63.9 floors to 63: the same displayed height as the stored best is a tie
    ui.showOver(makeSummary({ cleared: false, height: 63.9, levelId: 'endless' }), 63);
    expect($('#over-rows').textContent).not.toContain('신기록');
    expect($('#over-rows').textContent).toContain('63');
    // 64.1 floors to 64 > 63: a record, and the best row shows the new floor
    ui.showOver(makeSummary({ cleared: false, height: 64.1, levelId: 'endless' }), 63.8);
    expect($('#over-rows').textContent).toContain('신기록');
    const values = [...document.querySelectorAll('#over-rows .res__row b')].map((b) => b.textContent);
    expect(values[0]).toBe('64');
    expect(values[1]).toBe('64');
  });
});

describe('rejection reasons', () => {
  it('translates every RejectReason in the protocol enum, in 해라체', () => {
    for (const reason of RejectReason.options) {
      const text = REASON_KR[reason];
      expect(text, reason).toBeTruthy();
      expect(reasonKr(reason)).toBe(text);
      expect(text).not.toMatch(/(요|니다|세요)$/);
    }
    expect(reasonKr('bad-masks')).toBe('입력 기록이 손상됐다');
    expect(reasonKr('duplicate')).toBe('이미 접수된 기록이다');
    // transport-level reasons from ApiError still read as Korean; unknown strings pass through
    expect(reasonKr('timeout')).not.toBe('timeout');
    expect(reasonKr('what-is-this')).toBe('what-is-this');
    expect(reasonKr(undefined)).toBe('알 수 없는 이유');
  });
});

describe('UI settings', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('a toggle flips the setting and emits settingsChanged', () => {
    const { ui, actions, settings } = setup();
    ui.show('settings');
    const sw = $('#pane-av [data-key="bloom"]');
    expect(sw.getAttribute('aria-checked')).toBe('true');
    sw.click();
    expect(settings.bloom).toBe(false);
    expect(actions.at(-1)).toEqual({ type: 'settingsChanged' });
  });

  it('a slider writes its value back', () => {
    const { ui, settings } = setup();
    ui.show('settings');
    const range = $<HTMLInputElement>('#pane-av input[type=range][data-key="music"]');
    range.value = '0.3';
    range.dispatchEvent(new Event('input', { bubbles: true }));
    expect(settings.music).toBeCloseTo(0.3);
  });

  it('rebinding accepts a free key and refuses a conflicting one', () => {
    const { ui, input, actions, settings } = setup();
    ui.show('settings');
    $('#set-tabs [data-tab="ctrl"]').click();
    const dashBtn = $<HTMLButtonElement>('#pane-ctrl [data-bind="dash"][data-slot="0"]');
    dashBtn.click();
    expect(input.captured).not.toBeNull();
    expect(dashBtn.classList.contains('listening')).toBe(true);
    // KeyZ belongs to jump → refused, binds untouched
    input.captured!('KeyZ');
    expect(settings.binds.dash[0]).toBe('ShiftLeft');
    expect(dashBtn.classList.contains('bindbtn--clash')).toBe(true);
    expect(dashBtn.textContent).toContain('중복');
    expect(actions.some((a) => a.type === 'rebind')).toBe(false);
    // KeyC is free → accepted
    dashBtn.click();
    input.captured!('KeyC');
    expect(settings.binds.dash[0]).toBe('KeyC');
    const rb = actions.at(-1);
    expect(rb?.type).toBe('rebind');
    if (rb?.type === 'rebind') expect(rb.binds.dash[0]).toBe('KeyC');
    expect(dashBtn.textContent).toBe('C');
  });

  it('findBindConflict ignores confirm/cancel and the same action', () => {
    expect(findBindConflict(BINDS, 'dash', 'KeyZ')).toBe('jump');
    expect(findBindConflict(BINDS, 'jump', 'KeyZ')).toBeNull();
    expect(findBindConflict(BINDS, 'dash', 'Enter')).toBeNull();
    expect(findBindConflict(BINDS, 'dash', 'KeyC')).toBeNull();
  });

  it('menu navigation is suspended while a rebind capture is listening', () => {
    const { ui, input } = setup();
    ui.show('settings');
    $('#set-tabs [data-tab="ctrl"]').click();
    $('#pane-ctrl [data-bind="jump"][data-slot="0"]').click();
    const before = document.querySelector('#scr-settings .is-cursor');
    input.queue.push('down', 'down');
    ui.frame(1 / 60, input);
    expect(document.querySelector('#scr-settings .is-cursor')).toBe(before);
    input.captured!(null); // Escape → cancelled
    expect($('#pane-ctrl [data-bind="jump"][data-slot="0"]').textContent).toBe('Space');
  });

  it('progress reset needs two presses', () => {
    const { ui, actions } = setup();
    ui.show('settings');
    $('#set-tabs [data-tab="data"]').click();
    const wipe = $('#pane-data [data-act="resetProgress"]');
    wipe.click();
    expect(actions.some((a) => a.type === 'resetProgress')).toBe(false);
    wipe.click();
    expect(actions.at(-1)).toEqual({ type: 'resetProgress' });
  });
});

describe('UI name entry', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('validates 1–12 characters and allows Korean', () => {
    expect(validateName('')).not.toBeNull();
    expect(validateName('클로드')).toBeNull();
    expect(validateName('가나다라마바사아자차카타')).toBeNull();
    expect(validateName('가나다라마바사아자차카타파')).not.toBeNull();
    expect(validateName('a<b')).not.toBeNull();
    expect(validateName('  ')).not.toBeNull();
    // the game speaks 해라체, not 해요체 / 합쇼체
    for (const bad of ['', '가나다라마바사아자차카타파', 'a<b']) {
      expect(validateName(bad)).not.toMatch(/(요|니다|세요)/);
      expect(validateName(bad)).toMatch(/다( \(.*\))?$/);
    }
  });

  it('Escape inside the text field closes the dialog without a second cancel', () => {
    const { ui, actions } = setup();
    ui.refreshSelect(makeProgress(), LEVELS);
    ui.show('title');
    ui.show('name');
    const inp = $<HTMLInputElement>('#name-input');
    inp.focus();
    expect(document.activeElement).toBe(inp);
    const before = actions.length;
    const e = new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true, cancelable: true });
    inp.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(ui.screen).toBe('title');
    expect(actions.slice(before)).toEqual([{ type: 'back' }]);
    expect(document.activeElement).not.toBe(inp);
    // gameplay keys typed into the field still bubble (the input layer ignores editable targets itself)
    ui.show('name');
    const seen: string[] = [];
    const spy = (ev: Event) => seen.push((ev as KeyboardEvent).code);
    window.addEventListener('keydown', spy);
    $<HTMLInputElement>('#name-input').dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
    window.removeEventListener('keydown', spy);
    expect(seen).toEqual(['KeyW']);
  });

  it('confirms a valid name, refuses an invalid one', () => {
    const { ui, actions } = setup();
    ui.refreshSelect(makeProgress(), LEVELS);
    ui.show('title');
    $('#title-menu [data-act="name"], #scr-title [data-act="name"]').click();
    expect(ui.screen).toBe('name');
    const inp = $<HTMLInputElement>('#name-input');
    expect(inp.value).toBe('클로드');
    inp.value = 'x<y';
    $('#scr-name [data-act="nameOk"]').click();
    expect($('#name-err').hidden).toBe(false);
    expect(ui.screen).toBe('name');
    inp.value = ' 바다거북 ';
    $('#scr-name [data-act="nameOk"]').click();
    expect(actions.at(-1)).toEqual({ type: 'setName', name: '바다거북' });
    expect(ui.screen).toBe('title');
    expect($('#title-name').textContent).toBe('바다거북');
  });
});

describe('UI touch controls', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('virtual stick and buttons write TouchState with press edges', () => {
    const { ui } = setup();
    const pad = $('#tpad-move');
    pad.dispatchEvent(new PointerEvent('pointerdown', { clientX: 80, clientY: 0, pointerId: 3, bubbles: true }));
    expect(ui.touch.active).toBe(true);
    expect(ui.touch.x).toBeGreaterThan(0.5);
    pad.dispatchEvent(new PointerEvent('pointerup', { clientX: 80, clientY: 0, pointerId: 3, bubbles: true }));
    expect(ui.touch.active).toBe(false);
    expect(ui.touch.x).toBe(0);

    const jump = $('[data-touch="jump"]');
    jump.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 4, bubbles: true }));
    expect(ui.touch.jump).toBe(true);
    expect(ui.touch.jumpPressed).toBe(true);
    ui.touch.jumpPressed = false; // the input layer consumes the edge
    jump.dispatchEvent(new PointerEvent('pointerup', { pointerId: 4, bubbles: true }));
    expect(ui.touch.jump).toBe(false);
    expect(ui.touch.jumpPressed).toBe(false);
  });

  it('touch controls stay hidden on a pointer device', () => {
    const { ui } = setup();
    ui.show('play');
    expect($('#hud-touch').hidden).toBe(true);
    expect($('#nag-rotate').hidden).toBe(true);
  });
});

describe('UI rotate prompt', () => {
  const size = { w: window.innerWidth, h: window.innerHeight };
  beforeEach(() => {
    document.body.innerHTML = '';
    try { sessionStorage.clear(); } catch { /* no storage */ }
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    (window as unknown as { innerWidth: number }).innerWidth = size.w;
    (window as unknown as { innerHeight: number }).innerHeight = size.h;
  });

  function portraitPhone(): void {
    (window as unknown as { innerWidth: number }).innerWidth = 400;
    (window as unknown as { innerHeight: number }).innerHeight = 860;
  }

  it('shows on a portrait touch device and "그래도 계속" dismisses it for the session', () => {
    portraitPhone();
    const { ui } = setup();
    // a real finger makes the device coarse
    document.dispatchEvent(new Event('touchstart'));
    const nag = $('#nag-rotate');
    expect(nag.hidden).toBe(false);
    // the prompt's button is not part of the menu cursor
    ui.show('title');
    expect(document.querySelector('.nag__skip.is-cursor')).toBeNull();
    $('#nag-rotate [data-act="dismissNag"]').click();
    expect(nag.hidden).toBe(true);
    expect(sessionStorage.getItem(NAG_DISMISSED_KEY)).toBe('1');
    // a rotation re-check keeps it hidden
    window.dispatchEvent(new Event('orientationchange'));
    vi.advanceTimersByTime(200);
    expect(nag.hidden).toBe(true);
    // and the next UI in the same session never shows it
    const again = new UI({ document, input: makeInput(), defaultBinds: BINDS });
    document.dispatchEvent(new Event('touchstart'));
    expect($('#nag-rotate').hidden).toBe(true);
    void again;
  });

  it('is re-checked on orientationchange, not on plain resize', () => {
    portraitPhone();
    setup();
    document.dispatchEvent(new Event('touchstart'));
    const nag = $('#nag-rotate');
    expect(nag.hidden).toBe(false);
    // landscape now: a bare resize (soft keyboard, URL bar) does not touch the prompt…
    (window as unknown as { innerWidth: number }).innerWidth = 860;
    (window as unknown as { innerHeight: number }).innerHeight = 400;
    window.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(200);
    expect(nag.hidden).toBe(false);
    // …the orientation change does
    window.dispatchEvent(new Event('orientationchange'));
    vi.advanceTimersByTime(200);
    expect(nag.hidden).toBe(true);
  });

  it('leaves an upright tablet alone: only phones (short side under 600 px) are asked to rotate', () => {
    // iPad Pro 11 portrait
    (window as unknown as { innerWidth: number }).innerWidth = 834;
    (window as unknown as { innerHeight: number }).innerHeight = 1194;
    setup();
    document.dispatchEvent(new Event('touchstart'));
    expect($('#nag-rotate').hidden).toBe(true);
    expect(isPhoneViewport(window)).toBe(false);
    expect(wantsRotatePrompt(window)).toBe(false);
    // iPhone 14 portrait
    (window as unknown as { innerWidth: number }).innerWidth = 390;
    (window as unknown as { innerHeight: number }).innerHeight = 664;
    expect(isPhoneViewport(window)).toBe(true);
    expect(wantsRotatePrompt(window)).toBe(true);
    window.dispatchEvent(new Event('orientationchange'));
    vi.advanceTimersByTime(200);
    expect($('#nag-rotate').hidden).toBe(false);
    // the same phone in landscape is fine
    (window as unknown as { innerWidth: number }).innerWidth = 664;
    (window as unknown as { innerHeight: number }).innerHeight = 390;
    expect(wantsRotatePrompt(window)).toBe(false);
    expect(PHONE_MAX_SHORT_SIDE).toBe(600);
    expect(isPhoneViewport(null)).toBe(false);
  });
});

describe('UI PWA surfaces', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    try { localStorage.clear(); } catch { /* no storage */ }
  });

  it('showUpdate reveals the bar on menus, hides it during play, and 새로고침 applies once', () => {
    const { ui } = setup();
    const bar = $('#upbar');
    expect(bar.hidden).toBe(true);
    let applied = 0;
    ui.show('play');
    ui.showUpdate(() => { applied++; });
    expect(bar.hidden).toBe(true);           // never over a live run
    ui.show('pause');
    expect(bar.hidden).toBe(false);          // but the pause menu is fine
    ui.show('play');
    expect(bar.hidden).toBe(true);
    ui.show('title');
    expect(bar.hidden).toBe(false);
    expect(bar.textContent).toContain('새 버전이 준비됐다');
    // the bar's button is not part of the menu cursor
    expect(document.querySelector('#upbar .is-cursor')).toBeNull();
    expect(document.querySelector('#title-menu .is-cursor')).not.toBeNull();
    $('#upbar [data-act="applyUpdate"]').click();
    expect(applied).toBe(1);
    expect(bar.hidden).toBe(true);
    $('#upbar [data-act="applyUpdate"]').click();
    expect(applied).toBe(1);
  });

  it('setInstallable toggles the title entry and the button calls the install callback', () => {
    mountTemplate();
    let prompts = 0;
    const input = makeInput();
    const ui = new UI({ document, input, defaultBinds: BINDS, onInstall: () => { prompts++; } });
    ui.applySettings(makeSettings());
    ui.refreshSelect(settledProgress(), LEVELS);
    ui.show('title');
    const btn = $<HTMLButtonElement>('#title-menu [data-act="install"]');
    expect(btn.hidden).toBe(true);
    expect(document.querySelectorAll('#title-menu .menu__item.is-cursor')).toHaveLength(1);
    ui.setInstallable(true);
    expect(btn.hidden).toBe(false);
    expect(btn.textContent).toContain('홈 화면에 추가');
    // the newly visible entry joined the cursor path: five downs from 탑 오르기 land on it
    input.queue.push('down', 'down', 'down', 'down', 'down');
    ui.frame(1 / 60, input);
    expect(btn.classList.contains('is-cursor')).toBe(true);
    btn.click();
    expect(prompts).toBe(1);
    ui.setInstallable(false);
    expect(btn.hidden).toBe(true);
    expect(btn.classList.contains('is-cursor')).toBe(false);
  });

  it('setIosHint shows the share-sheet hint until it is dismissed, and remembers the dismissal', () => {
    const { ui } = setup();
    const hint = $('#ios-hint');
    expect(hint.hidden).toBe(true);
    ui.setIosHint(true);
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toContain('공유 → 홈 화면에 추가');
    $('#ios-hint [data-act="dismissIos"]').click();
    expect(hint.hidden).toBe(true);
    expect(localStorage.getItem(IOS_HINT_DISMISSED_KEY)).toBe('1');
    ui.setIosHint(true);
    expect(hint.hidden).toBe(true);
    const again = new UI({ document, input: makeInput(), defaultBinds: BINDS });
    again.setIosHint(true);
    expect($('#ios-hint').hidden).toBe(true);
    again.setIosHint(false);
    expect($('#ios-hint').hidden).toBe(true);
  });

  it('setOffline shows the badge and flags the shell', () => {
    const { ui } = setup();
    const badge = $('#offline-badge');
    expect(badge.hidden).toBe(true);
    ui.setOffline(true);
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe('오프라인');
    expect($('#ui').classList.contains('is-offline')).toBe(true);
    ui.setOffline(false);
    expect(badge.hidden).toBe(true);
    expect($('#ui').classList.contains('is-offline')).toBe(false);
  });

  it('a queued submission reads as offline-and-pending on the result screen', () => {
    const { ui } = setup();
    ui.show('play');
    ui.showResult({ summary: makeSummary(), levelName: '첫 물결', personalBest: true, stars: 2, submit: { state: 'queued' } });
    const line = $('#res-submit');
    expect(line.hidden).toBe(false);
    expect(line.className).toContain('submit--queued');
    expect(line.textContent).toBe('오프라인 · 온라인이 되면 보낸다');
  });

  it('the daily screen says the seed is missing when offline with nothing cached, or offline with a stored seed', () => {
    const { ui } = setup();
    ui.show('daily');
    ui.setDaily(null, null, 'error');
    expect($('#daily-date').textContent).toBe('오프라인 · 오늘의 시드를 아직 받지 못했다');
    expect($('#daily-status').textContent).toBe('오프라인');
    expect($<HTMLButtonElement>('#scr-daily [data-act="daily"]').disabled).toBe(true);
    ui.setDaily({ date: '2026-09-06', seed: 1, levelId: 'daily', expiresAt: '2026-09-07T00:00:00.000Z' }, null, 'error');
    expect($('#daily-date').textContent).toContain('2026년 9월 6일');
    expect($('#daily-status').textContent).toContain('오프라인');
    expect($<HTMLButtonElement>('#scr-daily [data-act="daily"]').disabled).toBe(false);
  });
});

describe('UI with the real input layer', () => {
  let input: Input;
  beforeEach(() => { document.body.innerHTML = ''; });
  afterEach(() => { input?.dispose(); });

  function realSetup(): { ui: UI; actions: UIAction[] } {
    mountTemplate();
    input = new Input({ binds: BINDS });
    const actions: UIAction[] = [];
    const ui = new UI({ document, input, defaultBinds: BINDS });
    ui.on((a) => actions.push(a));
    ui.applySettings(makeSettings());
    ui.refreshSelect(settledProgress(), LEVELS);
    return { ui, actions };
  }

  it('Enter on a DOM-focused button fires exactly one action, through the cursor', () => {
    const { ui, actions } = realSetup();
    ui.show('title');
    const items = [...document.querySelectorAll<HTMLElement>('#title-menu .menu__item')].filter((b) => !b.hidden);
    // Tab users: focus moves the cursor
    items[2].focus();
    expect(items[2].classList.contains('is-cursor')).toBe(true);
    expect(items[0].classList.contains('is-cursor')).toBe(false);
    const e = new KeyboardEvent('keydown', { code: 'Enter', key: 'Enter', bubbles: true, cancelable: true });
    items[2].dispatchEvent(e);
    // the browser's default (a synthesized click on the focused button) is suppressed…
    expect(e.defaultPrevented).toBe(true);
    // …so the frame's confirm edge is the one and only activation
    input.poll();
    ui.frame(1 / 60, input);
    expect(actions).toEqual([{ type: 'endless' }]);
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Enter', bubbles: true }));
  });

  it('a pointer click does not leave the button focused', () => {
    const { ui, actions } = realSetup();
    ui.show('title');
    const btn = $<HTMLButtonElement>('#title-menu [data-act="openSettings"]');
    btn.focus();
    btn.click();
    expect(actions.at(-1)).toEqual({ type: 'openSettings' });
    expect(document.activeElement).not.toBe(btn);
  });

  it('keeps native Enter for the name field', () => {
    const { ui } = realSetup();
    ui.show('title');
    ui.show('name');
    const inp = $<HTMLInputElement>('#name-input');
    inp.focus();
    const e = new KeyboardEvent('keydown', { code: 'Enter', key: 'Enter', bubbles: true, cancelable: true });
    inp.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    input.poll();
    expect(input.takeMenu()).toEqual([]);
  });
});

describe('webfont loader', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    // happy-dom would otherwise fetch the appended stylesheet for real
    try {
      (window as unknown as { happyDOM?: { settings?: { disableCSSFileLoading?: boolean } } }).happyDOM!.settings!.disableCSSFileLoading = true;
    } catch { /* not happy-dom */ }
  });

  it('injects the Google Fonts stylesheet once and only from fonts.googleapis.com', () => {
    expect(FONTS_HREF.startsWith('https://fonts.googleapis.com/css2?')).toBe(true);
    expect(FONTS_HREF).toContain('family=Outfit');
    expect(FONTS_HREF).toContain('family=Noto+Sans+KR');
    expect(FONTS_HREF).toContain('display=swap');
    const link = loadFonts(document);
    expect(link).not.toBeNull();
    expect(link!.rel).toBe('stylesheet');
    expect(link!.href).toBe(FONTS_HREF);
    expect(loadFonts(document)).toBe(link);
    expect(document.head.querySelectorAll('link[rel="stylesheet"]')).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ P2-2 game-over comeback loop
describe('UI game-over comeback (P2-2)', () => {
  beforeEach(() => { document.body.innerHTML = ''; });
  const over = (height: number, levelId = 'endless') => makeSummary({ cleared: false, height, levelId, shards: 4, time: 33 });

  it('the progress bar toward the personal best: --pct = h / best and 신기록까지 N칸', () => {
    const { ui } = setup();
    ui.show('play');
    ui.showOver(over(40), 50);
    const bar = $('#over-bar');
    expect(bar.style.getPropertyValue('--pct')).toBe('0.8');
    expect(bar.getAttribute('aria-valuenow')).toBe('80');
    expect(bar.classList.contains('is-best')).toBe(false);
    // a tie is one tile short of a record
    expect($('#over-bar-text').textContent).toBe('신기록까지 11칸');
    ui.showOver(over(50.9), 50);
    expect($('#over-bar').style.getPropertyValue('--pct')).toBe('1');
    expect($('#over-bar-text').textContent).toBe('신기록까지 1칸');
    // beaten: full bar, gold, 신기록!
    ui.showOver(over(64.2), 63.8);
    expect($('#over-bar').style.getPropertyValue('--pct')).toBe('1');
    expect($('#over-bar').classList.contains('is-best')).toBe(true);
    expect($('#over-bar-text').textContent).toBe('신기록!');
    // no best yet and no climb: an empty bar
    ui.showOver(over(0.4), 0);
    expect($('#over-bar').style.getPropertyValue('--pct')).toBe('0');
    expect($('#over-bar-text').textContent).toBe('신기록까지 1칸');
  });

  it('endless (sameTowerAvailable) offers 같은 탑 다시 / 새 탑 instead of 다시 도전, and both emit', () => {
    const { ui, actions } = setup();
    ui.show('play');
    ui.showOver(over(40), 50, { sameTowerAvailable: true });
    const same = $<HTMLButtonElement>('#scr-over [data-act="sameTower"]');
    const fresh = $<HTMLButtonElement>('#scr-over [data-act="newTower"]');
    const retry = $<HTMLButtonElement>('#scr-over [data-act="retry"]');
    expect(same.hidden).toBe(false);
    expect(fresh.hidden).toBe(false);
    expect(retry.hidden).toBe(true);
    // the cursor starts on the primary (same tower) entry
    expect(same.classList.contains('is-cursor')).toBe(true);
    same.click();
    expect(actions.at(-1)).toEqual({ type: 'sameTower' });
    fresh.click();
    expect(actions.at(-1)).toEqual({ type: 'newTower' });
    // a daily game over keeps the single 다시 도전 (the same tower by definition)
    ui.showOver(over(40, 'daily'), 50);
    expect(same.hidden).toBe(true);
    expect(fresh.hidden).toBe(true);
    expect(retry.hidden).toBe(false);
    expect(retry.classList.contains('is-cursor')).toBe(true);
  });

  it('a daily game over shows the 내 최고 높이 · 세계 최고 row, also when the board arrives later', () => {
    const { ui } = setup();
    ui.show('play');
    ui.showOver(over(40, 'daily'), 63, { worldBest: 120.7 });
    const row = $('#over-best');
    expect(row.querySelector('span')!.textContent).toBe('내 최고 높이 · 세계 최고');
    expect(row.querySelector('b')!.textContent).toBe('63 · 120');
    // without a world best the row is the plain personal best …
    ui.showOver(over(70, 'daily'), 63);
    expect($('#over-best span').textContent).toBe('최고 높이');
    expect($('#over-best b').textContent).toBe('70');
    // … until updateResult brings the board (its top height is the world best)
    const lb = makeLb();
    lb.entries[0] = { ...lb.entries[0], cleared: false, height: 95.2 };
    ui.updateResult({ summary: over(70, 'daily'), levelName: '데일리', personalBest: true, stars: 0, submit: { state: 'accepted', rank: 2, total: 41 }, leaderboard: lb });
    expect($('#over-best span').textContent).toBe('내 최고 높이 · 세계 최고');
    expect($('#over-best b').textContent).toBe('70 · 95');
    expect($('#over-submit').textContent).toContain('세계 2위');
  });
});

// ------------------------------------------------------------------ P2-3 daily streak · 7-day strip · yesterday
describe('UI daily streak and yesterday (P2-3)', () => {
  beforeEach(() => { document.body.innerHTML = ''; });
  const TODAY = { date: '2026-09-06', seed: 0xdeadbeef, levelId: 'daily' as const, expiresAt: '2026-09-07T00:00:00.000Z' };
  function streakProgress(): Progress {
    const p = makeProgress();
    p.daily['2026-09-04'] = { bestTicks: 0, cleared: false, height: 31, seed: 4 };
    p.daily['2026-09-05'] = { bestTicks: 5200, cleared: true, height: 0, seed: 5, rank: 7 };
    p.daily['2026-09-06'] = { bestTicks: 4100, cleared: true, height: 150, seed: 0xdeadbeef };
    p.daily['2026-08-30'] = { bestTicks: 0, cleared: false, height: 3, seed: 1 };   // outside the strip
    return p;
  }

  it('renders a 7-day strip, oldest → today, with 미도전 / 도전 / 클리어 states, the rank when known, and the streak badge', () => {
    const { ui } = setup();
    ui.refreshSelect(streakProgress(), LEVELS);
    ui.show('daily');
    ui.setDaily(TODAY, makeLb(), 'ok');
    const cells = [...document.querySelectorAll<HTMLElement>('.daily__week .daily__day')];
    expect(cells).toHaveLength(7);
    expect(cells.map((c) => c.dataset.date)).toEqual(['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06']);
    expect(cells.map((c) => c.dataset.state)).toEqual(['none', 'none', 'none', 'none', 'tried', 'cleared', 'cleared']);
    expect(cells[6].classList.contains('is-today')).toBe(true);
    expect(cells.filter((c) => c.classList.contains('is-today'))).toHaveLength(1);
    expect(cells[6].querySelector('small')!.textContent).toBe('오늘');
    expect(cells[4].querySelector('small')!.textContent).toBe('4');
    // ranks: the stored one on the 5th, today's from the live board (yours = 2위)
    expect(cells[5].querySelector('b')!.textContent).toBe('7위');
    expect(cells[6].querySelector('b')!.textContent).toBe('2위');
    expect(cells[4].querySelector('b')!.textContent).toBe('·');
    expect(cells[0].querySelector('b')!.textContent).toBe('');
    expect(cells[5].getAttribute('aria-label')).toBe('9월 5일 · 클리어 · 세계 7위');
    const badge = $('#daily-streak');
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe('3일 연속');
    expect($('#daily-mine').textContent).toContain(fmtTime(4100 / 120));
    // no streak → no badge; no attempt today
    const fresh = makeProgress();
    ui.refreshSelect(fresh, LEVELS);
    expect($('#daily-streak').hidden).toBe(true);
    expect($('#daily-mine').textContent).toBe('오늘 미도전');
    expect(document.querySelectorAll('.daily__week .daily__day[data-state="none"]')).toHaveLength(7);
  });

  it("shows 어제의 탑 · 세계 N위 / M명 when our row exists, the 재도전 entry when the seed is known, 확정 once the board is closed", () => {
    const { ui, actions } = setup();
    ui.refreshSelect(streakProgress(), LEVELS);
    ui.show('daily');
    ui.setDaily(TODAY, null, 'ok');
    const row = $('#daily-yday');
    const btn = $<HTMLButtonElement>('#scr-daily [data-act="retryYesterday"]');
    expect(row.hidden).toBe(true);
    expect(btn.hidden).toBe(true);
    const ylb = makeLb();
    ylb.board = '2026-09-05';
    ylb.yours = { ...ylb.yours!, rank: 12 };
    ylb.total = 300;
    ui.setYesterday({ date: '2026-09-05', seed: 5, lb: ylb });
    expect(row.hidden).toBe(false);
    expect(row.textContent).toBe('어제의 탑 · 세계 12위 / 300명');
    expect(row.querySelector('.daily__badge--final')).toBeNull();
    expect(btn.hidden).toBe(false);
    btn.click();
    expect(actions.at(-1)).toEqual({ type: 'retryYesterday' });
    // the strip's yesterday cell now reads the live rank
    expect($('.daily__week .daily__day[data-date="2026-09-05"] b').textContent).toBe('12위');
    // no row of ours on the board: still a row (we did not climb), no seed → no retry entry
    ui.setYesterday({ date: '2026-09-05', seed: null, lb: { ...ylb, yours: undefined } });
    expect(row.textContent).toContain('어제의 탑');
    expect(row.textContent).toContain('300명');
    expect(btn.hidden).toBe(true);
    // two days old (the app stayed open past midnight): 확정, and no retry
    ui.setDaily({ ...TODAY, date: '2026-09-07' }, null, 'ok');
    ui.setYesterday({ date: '2026-09-05', seed: 5, lb: ylb });
    expect(row.textContent).toContain('9월 5일의 탑 · 세계 12위 / 300명');
    expect(row.querySelector('.daily__badge--final')!.textContent).toBe('확정');
    expect(btn.hidden).toBe(true);
    ui.setYesterday(null);
    expect(row.hidden).toBe(true);
  });

  it('the title 데일리 타워 subtitle is dynamic: 오늘 미도전 · N일 연속 / 오늘 클리어 · 세계 N위 / 오늘 높이 N', () => {
    const { ui } = setup();
    const note = $('#daily-note');
    ui.refreshSelect(makeProgress(), LEVELS);
    expect(note.textContent).toBe('매일 바뀌는 탑 · 세계 순위');
    const p = streakProgress();
    ui.setDaily(TODAY, null, 'ok');
    delete p.daily['2026-09-06'];
    ui.refreshSelect(p, LEVELS);
    expect(note.textContent).toBe('오늘 미도전 · 2일 연속');
    p.daily['2026-09-06'] = { bestTicks: 0, cleared: false, height: 42.7, seed: 0xdeadbeef };
    ui.refreshSelect(p, LEVELS);
    expect(note.textContent).toBe('오늘 높이 42 · 3일 연속');
    p.daily['2026-09-06'] = { bestTicks: 4100, cleared: true, height: 150, seed: 0xdeadbeef };
    ui.refreshSelect(p, LEVELS);
    expect(note.textContent).toBe('오늘 클리어 · 3일 연속');
    ui.setDaily(TODAY, makeLb(), 'ok');   // our row: 2위
    expect(note.textContent).toBe('오늘 클리어 · 세계 2위');
  });
});

// ------------------------------------------------------------------ P2-5 inline name prompt
describe('UI inline name prompt (P2-5)', () => {
  beforeEach(() => { document.body.innerHTML = ''; });
  const resultView = (): ResultView => ({ summary: makeSummary(), levelName: '첫 물결', personalBest: true, stars: 2, submit: { state: 'pending' }, nextLevelId: 't2' });

  it('sits inside the result modal, hides the submission line, and resolves with a confirmed valid name', async () => {
    const { ui } = setup();
    ui.refreshSelect(makeProgress(), LEVELS);
    ui.show('play');
    ui.showResult(resultView());
    const p = ui.askNameInline();
    const box = $('#scr-result #name-inline');
    expect(box.closest('.modal')).toBe($('#scr-result .modal'));
    expect($('#res-submit').hidden).toBe(true);
    const inp = $<HTMLInputElement>('#name-inline-input');
    expect(document.activeElement).toBe(inp);
    inp.value = 'x<y';
    $('#name-inline [data-act="nameInlineOk"]').click();
    expect($('#name-inline-err').hidden).toBe(false);
    expect(document.getElementById('name-inline')).not.toBeNull();
    inp.value = ' 바다거북 ';
    $('#name-inline [data-act="nameInlineOk"]').click();
    await expect(p).resolves.toBe('바다거북');
    expect(document.getElementById('name-inline')).toBeNull();
    expect($('#res-submit').hidden).toBe(false);      // the pending line is back
    expect($('#title-name').textContent).toBe('바다거북');
    expect(ui.screen).toBe('result');
  });

  it('건너뛰기, Escape, and leaving the screen resolve null; Enter in the field confirms', async () => {
    const { ui, input } = setup();
    ui.refreshSelect(makeProgress(), LEVELS);
    ui.show('play');
    ui.showResult(resultView());
    const skip = ui.askNameInline();
    $('#name-inline [data-act="nameInlineSkip"]').click();
    await expect(skip).resolves.toBeNull();
    // Escape inside the field
    const esc = ui.askNameInline();
    $<HTMLInputElement>('#name-inline-input').dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true, cancelable: true }));
    await expect(esc).resolves.toBeNull();
    // a menu confirm edge while the field has focus submits the typed name
    const enter = ui.askNameInline();
    $<HTMLInputElement>('#name-inline-input').value = '거북';
    input.queue.push('confirm');
    ui.frame(1 / 60, input);
    await expect(enter).resolves.toBe('거북');
    // retrying (the shell shows play) while the prompt is up is a skip
    const gone = ui.askNameInline();
    ui.show('play');
    await expect(gone).resolves.toBeNull();
    expect(document.getElementById('name-inline')).toBeNull();
    // and on the game-over modal it works the same way
    ui.showOver(makeSummary({ cleared: false, height: 12, levelId: 'daily' }), 0);
    const overP = ui.askNameInline();
    expect($('#scr-over #name-inline')).not.toBeNull();
    $('#name-inline [data-act="nameInlineSkip"]').click();
    await expect(overP).resolves.toBeNull();
    // without a result / over modal on top there is nothing to ask in
    ui.show('title');
    await expect(ui.askNameInline()).resolves.toBeNull();
  });
});

// ------------------------------------------------------------------ P2-6 assist offer
describe('UI assist offer (P2-6)', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('offerAssist opens the modal over play with the zone name and the three answers emit their actions', () => {
    const { ui, actions, input } = setup();
    ui.refreshSelect(makeProgress(), LEVELS);
    ui.show('play');
    ui.offerAssist('해초 숲');
    expect(ui.screen).toBe('assist');
    expect(active('play')).toBe(true);
    expect($('#assist-lead').textContent).toContain('해초 숲');
    expect($('#assist-lead').textContent).toContain('보조 모드로 이 구역을 다시 시작할까? 기록은 순위표에 오르지 않는다 · 설정에서 언제든 끈다');
    expect($('#scr-assist [data-act="assistAccept"]').classList.contains('is-cursor')).toBe(true);
    $('#scr-assist [data-act="assistAccept"]').click();
    expect(actions.at(-1)).toEqual({ type: 'assistAccept' });
    $('#scr-assist [data-act="assistDecline"]').click();
    expect(actions.at(-1)).toEqual({ type: 'assistDecline', never: false });
    $('#scr-assist [data-act="assistNever"]').click();
    expect(actions.at(-1)).toEqual({ type: 'assistDecline', never: true });
    // cancel (Escape / B) is 이번엔 괜찮다
    input.queue.push('cancel');
    ui.frame(1 / 60, input);
    expect(actions.at(-1)).toEqual({ type: 'assistDecline', never: false });
    // the shell answers by showing play again
    ui.show('play');
    expect(ui.screen).toBe('play');
    expect(active('assist')).toBe(false);
  });
});

describe('UI rival echo surfaces (P2-4)', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  const plainView = (): ResultView => ({ summary: makeSummary(), levelName: '첫 물결', personalBest: false, stars: 1, submit: { state: 'idle' } });

  it('#res-vs-world reads 라이벌보다 0.62s 빠름 / 1위보다 1.20s 느림 — two decimals, a sign class — and hides without a rival', () => {
    const { ui } = setup();
    ui.show('play');
    ui.setVersus({ label: '라이벌', deltaTicks: -74 });
    ui.showResult(plainView());
    const row = $('#res-vs-world');
    expect(row.hidden).toBe(false);
    expect(row.textContent).toBe('라이벌보다 0.62s 빠름');
    expect(row.querySelector('b')!.textContent).toBe('0.62s');
    expect(row.dataset.sign).toBe('-1');
    expect(row.classList.contains('is-ahead')).toBe(true);
    ui.setVersus({ label: '1위', deltaTicks: 144 });
    expect(row.textContent).toBe('1위보다 1.20s 느림');
    expect(row.dataset.sign).toBe('1');
    expect(row.classList.contains('is-behind')).toBe(true);
    expect(row.classList.contains('is-ahead')).toBe(false);
    // 1 tick rounds to 0.01 s, still two decimals
    ui.setVersus({ label: '라이벌', deltaTicks: 1 });
    expect(row.textContent).toBe('라이벌보다 0.01s 느림');
    ui.setVersus({ label: '라이벌', deltaTicks: 0 });
    expect(row.textContent).toBe('라이벌과 같은 기록');
    expect(row.dataset.sign).toBe('0');
    ui.setVersus(null);
    expect(row.hidden).toBe(true);
    expect(row.textContent).toBe('');
    // a later showResult without a versus keeps it hidden; updateResult leaves it alone
    ui.showResult(plainView());
    expect(row.hidden).toBe(true);
    ui.setVersus({ label: '라이벌', deltaTicks: -74 });
    ui.updateResult({ ...plainView(), submit: { state: 'accepted', rank: 3, total: 41 } });
    expect(row.hidden).toBe(false);
  });

  it('split() shows the HUD chip with a sign class, hides it on null, and a fresh play screen resets it', () => {
    const { ui } = setup();
    ui.show('play');
    const chip = $('#hud-split');
    expect(chip.hidden).toBe(true);
    ui.split('+0.84s', 1);
    expect(chip.hidden).toBe(false);
    expect(chip.textContent).toBe('+0.84s');
    expect(chip.classList.contains('is-behind')).toBe(true);
    expect(chip.dataset.sign).toBe('1');
    ui.split('−1.20s', -1);
    expect(chip.classList.contains('is-ahead')).toBe(true);
    expect(chip.classList.contains('is-behind')).toBe(false);
    ui.split('—', 0);
    expect(chip.classList.contains('is-even')).toBe(true);
    expect(chip.textContent).toBe('—');
    ui.split(null);
    expect(chip.hidden).toBe(true);
    expect(chip.textContent).toBe('');
    ui.split('+0.10s', 1);
    ui.show('title');
    ui.show('play');
    expect(chip.hidden).toBe(true);
  });

  it('segments() fills the pause screen with 구간 rows — deaths, the best time or —, the current one marked — and repaints while paused', () => {
    const { ui } = setup();
    ui.show('play');
    ui.segments([
      { idx: 0, deaths: 3, best: 1500, current: false },
      { idx: 1, deaths: 0, best: null, current: true },
    ]);
    ui.show('pause');
    const rows = [...document.querySelectorAll<HTMLElement>('#pause-segs .segrow')];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('구간 1');
    expect(rows[0].textContent).toContain('쓰러짐 3');
    expect(rows[0].textContent).toContain(fmtTicks(1500));
    expect(rows[0].classList.contains('is-current')).toBe(false);
    expect(rows[0].querySelector('em')!.classList.contains('is-hot')).toBe(true);
    expect(rows[1].textContent).toContain('구간 2');
    expect(rows[1].textContent).toContain('—');
    expect(rows[1].classList.contains('is-current')).toBe(true);
    expect(rows[1].querySelector('em')!.classList.contains('is-hot')).toBe(false);
    // rows pushed while the pause is up repaint it
    ui.segments([{ idx: 0, deaths: 4, best: 1500, current: true }]);
    expect(document.querySelectorAll('#pause-segs .segrow')).toHaveLength(1);
    expect($('#pause-segs').textContent).toContain('쓰러짐 4');
    ui.segments(null);
    ui.show('play');
    ui.show('pause');
    expect(document.querySelectorAll('#pause-segs .segrow')).toHaveLength(0);
    // the classic stats are still there
    expect($('#pause-stats').textContent).toContain('경과');
  });

  it('settings offer 세계 메아리 = 라이벌 / 1위 (default 라이벌); a click writes echoWorldMode and emits settingsChanged; sync reads it back', () => {
    const { ui, settings, actions } = setup();
    const seg = document.querySelector<HTMLElement>('#pane-av .seg[aria-label="세계 메아리"]');
    expect(seg).not.toBeNull();
    const rival = seg!.querySelector<HTMLButtonElement>('button[data-value="rival"]')!;
    const top = seg!.querySelector<HTMLButtonElement>('button[data-value="top"]')!;
    expect(rival.textContent).toBe('라이벌');
    expect(top.textContent).toBe('1위');
    expect(rival.getAttribute('aria-checked')).toBe('true');
    expect(top.getAttribute('aria-checked')).toBe('false');
    top.click();
    expect(echoWorldMode(settings)).toBe('top');
    expect(top.getAttribute('aria-checked')).toBe('true');
    expect(rival.getAttribute('aria-checked')).toBe('false');
    expect(actions.at(-1)).toEqual({ type: 'settingsChanged' });
    setEchoWorldMode(settings, 'rival');
    ui.applySettings(settings);
    expect(rival.getAttribute('aria-checked')).toBe('true');
    expect(top.getAttribute('aria-checked')).toBe('false');
  });
});
