// @vitest-environment happy-dom
/**
 * Behavioural tests for the DOM UI against the real template, driven by a fake
 * InputPort. Nothing here touches the Sim, the renderer or the network.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  Binds, HudState, InputPort, MenuAction, Progress, ResultView, Settings, TouchState, UIAction,
} from '../../src/client/contracts.js';
import type { LevelDef, RunSummary } from '../../src/sim/types.js';
import type { LeaderboardResponse } from '../../src/shared/protocol.js';
import { UI } from '../../src/client/ui/ui.js';
import { renderLeaderboard } from '../../src/client/ui/leaderboard.js';
import { findBindConflict } from '../../src/client/ui/settings.js';
import { LIVE_INTERVAL, fmtTime } from '../../src/client/ui/hud.js';
import { validateName } from '../../src/client/ui/screens.js';

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

function makeLb(): LeaderboardResponse {
  const mk = (rank: number, name: string, playerId: string, ticks: number): LeaderboardResponse['entries'][number] => ({
    rank, runId: `run-${rank}`, playerId, name, score: ticks, ticks, shards: 20, deaths: 0, cleared: true, height: 0,
    createdAt: '2026-09-06T00:00:00.000Z',
  });
  return {
    mode: 'daily', board: '2026-09-06', total: 41,
    entries: [mk(1, '바다', 'p-1', 3900), mk(2, '클로드', 'abcdefgh-1234', 4100), mk(3, 'Kim', 'p-3', 4300)],
    yours: mk(2, '클로드', 'abcdefgh-1234', 4100),
  };
}

function setup(): { ui: UI; input: FakeInput; actions: UIAction[]; settings: Settings } {
  mountTemplate();
  const input = makeInput();
  const actions: UIAction[] = [];
  const settings = makeSettings();
  const ui = new UI({ document, input, defaultBinds: BINDS, skins: { clawd: { name: 'Clawd', kr: '클로드' }, azure: { name: 'Azure', kr: '남빛' } } });
  ui.on((a) => actions.push(a));
  ui.applySettings(settings);
  return { ui, input, actions, settings };
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
    ui.refreshSelect(makeProgress(), LEVELS);
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
    ui.show('play');
    input.queue.push('restart');
    ui.frame(1 / 60, input);
    expect(actions.at(-1)).toEqual({ type: 'restart' });
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
});

describe('UI zone select', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('renders three tiers and locks zones whose predecessor is not done', () => {
    const { ui } = setup();
    ui.refreshSelect(makeProgress(['t1']), LEVELS);
    expect(document.querySelectorAll('#sel-tiers .tier')).toHaveLength(3);
    const cards = [...document.querySelectorAll<HTMLButtonElement>('#sel-tiers .card')];
    expect(cards).toHaveLength(9);
    const byId = Object.fromEntries(cards.map((c) => [c.dataset.id, c]));
    expect(byId.t1.disabled).toBe(false);
    expect(byId.t2.disabled).toBe(false);
    expect(byId.t3.disabled).toBe(true);
    expect(byId.s1.disabled).toBe(true);
    expect(byId.t3.querySelector('.card__lock')).not.toBeNull();
    expect(byId.t1.querySelector('.card__lock')).toBeNull();
    expect(byId.t1.querySelectorAll('.star.on')).toHaveLength(3);
    expect($('#sel-progress').textContent).toContain('1 / 9');
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
    const { ui } = setup();
    ui.refreshSelect(makeProgress(['t1']), LEVELS);
    const cont = $<HTMLButtonElement>('#title-menu [data-act="continue"]');
    expect(cont.hidden).toBe(false);
    expect($('#continue-note').textContent).toContain('첫 물결');
    expect($('#title-name').textContent).toBe('클로드');
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
    lb.yours = { ...lb.entries[0], rank: 27, playerId: 'me-9', name: '나', runId: 'run-me' };
    renderLeaderboard($('#host'), lb, { status: 'ok', playerId: 'me-9' });
    const you = $('#host tr.is-you');
    expect(you.querySelector('.lb__rank')!.textContent).toBe('27');
    expect($('#host').querySelector('tr.lb__gap')).not.toBeNull();
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
    expect($('#res-submit').textContent).toContain('검증 불일치');
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

  it('showOver reports the height and best height', () => {
    const { ui, actions } = setup();
    ui.show('play');
    ui.showOver(makeSummary({ cleared: false, height: 63.4, levelId: 'endless' }), 63.4);
    expect(ui.screen).toBe('over');
    expect($('#over-rows').textContent).toContain('63');
    expect($('#over-rows').textContent).toContain('신기록');
    $('#scr-over [data-act="retry"]').click();
    expect(actions.at(-1)).toEqual({ type: 'retry' });
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
