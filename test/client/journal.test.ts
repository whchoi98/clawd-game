// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import type { LevelRecord, Progress, Settings } from '../../src/client/contracts.js';
import type { GoalPreference } from '../../src/client/goal-settings.js';
import { SKINS } from '../../src/client/render/clawd.js';
import { defaultLevelRecord, defaultProgress, defaultSettings } from '../../src/client/save.js';
import { medalsFor } from '../../src/client/unlocks.js';
import { MEDAL_KR, MEDAL_ORDER } from '../../src/client/ui/ceremony.js';
import { JournalPanel } from '../../src/client/ui/journal.js';
import { el, Navigator } from '../../src/client/ui/screens.js';
import { BIOMES } from '../../src/shared/biomes.js';
import { LEVELS } from '../../src/sim/levels.generated.js';
import type { LevelDef } from '../../src/sim/types.js';

const first = LEVELS[0];
const level = (id: string): LevelDef => LEVELS.find((def) => def.id === id)!;

/** A saved ordinary/par clear or a perfect clear, using the real medal rules. */
function cleared(def: LevelDef = first, perfect = false): LevelRecord {
  const totalShards = [...def.rows.join('')].filter((cell) => cell === 'o').length;
  const shards = perfect ? totalShards : 0;
  const relics = perfect ? [...def.rows.join('')].filter((cell) => cell === 'R').length : 0;
  const deaths = perfect ? 0 : 1;
  return {
    ...defaultLevelRecord(), done: true, bestTicks: def.par * 120,
    bestShards: shards, relics, deaths, stars: perfect ? 3 : 2,
    medals: medalsFor({ cleared: true, deaths, time: def.par, par: def.par, shards, totalShards, relics }),
  };
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

let body: HTMLElement;
let modal: HTMLElement;
let outside: HTMLButtonElement;
let close: HTMLButtonElement;
let panel: JournalPanel;
let progress: Progress;
let settings: Settings;
let goals: [string, GoalPreference][];
let equips: string[];

beforeEach(() => {
  outside = el(document, 'button', {}, '수첩 열기');
  close = el(document, 'button', {}, '수첩 닫기');
  body = el(document, 'div', { id: 'journal-body' });
  modal = el(document, 'section', { id: 'scr-journal', role: 'dialog', 'aria-label': '도전 수첩' }, body, close);
  document.body.replaceChildren(outside, modal);
  progress = defaultProgress('journal-player');
  settings = defaultSettings();
  goals = [];
  equips = [];
  panel = new JournalPanel({
    doc: document, portrait: () => null,
    onGoal: (id, preference) => goals.push([id, preference]),
    onEquip: (skin) => equips.push(skin),
  });
});

function update(levels: readonly LevelDef[] = LEVELS): void {
  panel.update(progress, settings, levels, SKINS);
}

function keyed(key: string): HTMLButtonElement {
  const button = [...body.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.dataset.journalKey === key);
  expect(button, `Missing journal action ${key}`).toBeDefined();
  return button!;
}

const goal = (id: string, preference: GoalPreference) => keyed(`goal:${id}:${preference}`);
const skin = (id: string) => keyed(`skin:${id}`);
const zone = (id: string) => goal(id, 'auto').closest<HTMLElement>('[data-journal-zone]')!;
const skinCard = (id: string) => skin(id).closest<HTMLElement>('[data-journal-skin]')!;

describe('journal goals', () => {
  it('counts saved story accomplishments and groups every real zone by its biome', () => {
    progress.levels.t1 = cleared();
    progress.levels.removed = cleared(first, true);
    update();

    expect(body.querySelector('.journal__summary')?.textContent).toContain('클리어 구역 1 / 16');
    expect(body.querySelector('.journal__summary')?.textContent).toContain('메달 1 / 64');
    expect(body.querySelector('.journal__summary')?.textContent).toContain('모습 1 / 8');
    expect(body.querySelectorAll('[data-journal-biome]')).toHaveLength(4);
    expect(body.querySelectorAll('[data-journal-zone]')).toHaveLength(16);
    for (const def of LEVELS) {
      const card = zone(def.id);
      expect(card.textContent).toContain(def.name);
      const group = card.closest<HTMLElement>('[data-journal-biome]')!;
      expect(group.dataset.journalBiome).toBe(def.biome);
      expect(group.textContent).toContain(BIOMES[def.biome].kr);
      for (const medal of MEDAL_ORDER) {
        const button = goal(def.id, medal);
        expect(button.textContent).toContain(MEDAL_KR[medal]);
        expect(button.getAttribute('aria-label')).toContain(def.name);
        expect(button.getAttribute('aria-label')).toContain(MEDAL_KR[medal]);
        expect(button.closest('[data-row]')).not.toBeNull();
      }
    }
  });

  it('shows earned local medals and saved goals while assist options are enabled', () => {
    progress.levels.t1 = cleared();
    settings.assist = true;
    settings.invincible = true;
    settings.goalTargets = { t1: 'relic' };
    update();

    expect(goal('t1', 'par').textContent).toContain('획득');
    expect(goal('t1', 'par').textContent).not.toContain('미획득');
    expect(goal('t1', 'par').getAttribute('aria-pressed')).toBe('false');
    expect(goal('t1', 'nodeath').textContent).toContain('미획득');
    expect(goal('t1', 'relic').getAttribute('aria-pressed')).toBe('true');
    expect(goal('t1', 'relic').textContent).toContain('고정');
    expect(goal('t1', 'relic').textContent).toContain('미획득');
    expect(goal('t1', 'par').textContent).toContain(`${first.par}초`);
  });

  it('keeps a saved goal on a locked zone visible but refuses both native and dispatched clicks', () => {
    settings.goalTargets = { s1: 'relic' };
    update();
    const card = zone('s1');
    expect(card.textContent).toContain(`${level('t4').name} 클리어 후 해금`);
    expect(goal('s1', 'relic').getAttribute('aria-pressed')).toBe('true');
    for (const button of card.querySelectorAll<HTMLButtonElement>('button')) {
      expect(button.disabled).toBe(true);
      expect(button.getAttribute('aria-label')).toContain('해금');
      button.click();
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
    expect(goals).toEqual([]);
    expect(settings.goalTargets).toEqual({ s1: 'relic' });
  });

  it('allows goals on a saved cleared zone even when its predecessors have no records', () => {
    progress.levels.s1 = cleared(level('s1'));
    settings.goalTargets = { s1: 'shards' };
    update();
    expect(goal('s1', 'shards').disabled).toBe(false);
    expect(goal('s1', 'shards').getAttribute('aria-pressed')).toBe('true');
    goal('s1', 'nodeath').click();
    expect(goals).toEqual([['s1', 'nodeath']]);
  });

  it('pins through the callback and toggles the same explicit pin back to free play', () => {
    progress.levels.t1 = cleared();
    panel = new JournalPanel({
      doc: document, portrait: () => null, onEquip: (id) => equips.push(id),
      onGoal: (id, preference) => {
        goals.push([id, preference]);
        settings = { ...settings, goalTargets: { ...settings.goalTargets, [id]: preference } };
        update();
      },
    });
    update();
    expect(body.textContent).toMatch(/다시.*자유/);
    goal('t1', 'relic').click();
    expect(goal('t1', 'relic').getAttribute('aria-pressed')).toBe('true');
    goal('t1', 'relic').click();
    expect(goals).toEqual([['t1', 'relic'], ['t1', 'free']]);
    expect(goal('t1', 'relic').getAttribute('aria-pressed')).toBe('false');
    expect(goal('t1', 'free').getAttribute('aria-pressed')).toBe('true');
  });

  it('lets the owner choose automatic or free play without treating a recommendation as an explicit pin', () => {
    delete settings.goalTargets; // Settings saved before goal preferences were introduced.
    progress.levels.t1 = cleared();
    update();
    expect(goal('t1', 'auto').getAttribute('aria-pressed')).toBe('true');
    expect(goal('t1', 'relic').getAttribute('aria-pressed')).toBe('false');
    expect(goal('t1', 'relic').textContent).toContain('자동 추천');
    goal('t1', 'relic').click();
    goal('t1', 'free').click();
    goal('t1', 'auto').click();
    expect(goals).toEqual([['t1', 'relic'], ['t1', 'free'], ['t1', 'auto']]);
    expect(settings.goalTargets).toBeUndefined();
  });

  it.each([
    ['shards', /o/g, '파편'],
    ['relic', /R/g, '유물'],
  ] as const)('disables a saved %s goal when that collectible category is empty', (medal, pattern, label) => {
    const empty: LevelDef = { ...first, rows: first.rows.map((row) => row.replace(pattern, '.')) };
    settings.goalTargets = { t1: medal };
    update([empty]);
    const button = goal('t1', medal);
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain(`${label}이 없는 구역`);
    expect(button.getAttribute('aria-label')).toContain(`${label}이 없는 구역`);
    button.click();
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(goals).toEqual([]);
    expect(goal('t1', 'nodeath').disabled).toBe(false);
    expect(goal('t1', 'free').disabled).toBe(false);
    expect(settings.goalTargets.t1).toBe(medal);
  });

  it('does not suggest a medal before the first clear or after full mastery', () => {
    const before = JSON.stringify(settings);
    update();
    expect(zone('t1').textContent).not.toContain('자동 추천');
    expect(body.querySelector('.journal__summary')?.textContent).toContain('메달 0 / 64');
    progress.levels.t1 = cleared(first, true);
    update();
    expect(zone('t1').textContent).not.toContain('자동 추천');
    expect(zone('t1').textContent).toContain('자유 도전');
    for (const medal of MEDAL_ORDER) expect(goal('t1', medal).textContent).not.toContain('미획득');
    expect(JSON.stringify(settings)).toBe(before);
  });

  it('gives every action a stable key and a Korean accessible name without global action attributes', () => {
    update();
    const buttons = [...body.querySelectorAll<HTMLButtonElement>('button')];
    expect(buttons).toHaveLength(104);
    const keys = buttons.map((button) => button.dataset.journalKey);
    expect(keys.every(Boolean)).toBe(true);
    expect(new Set(keys).size).toBe(buttons.length);
    for (const button of buttons) {
      expect(button.type).toBe('button');
      expect(button.getAttribute('aria-label')).toMatch(/[가-힣]/);
      expect(button.hasAttribute('data-act')).toBe(false);
    }
    progress.levels.t1 = cleared();
    update();
    expect([...body.querySelectorAll<HTMLButtonElement>('button')].map((button) => button.dataset.journalKey)).toEqual(keys);
  });
});

describe('journal skins', () => {
  it('shows real unlock hints and numeric progress for each locked appearance', () => {
    update();
    expect(body.querySelectorAll('[data-journal-skin]')).toHaveLength(8);
    expect(skin('clawd').textContent).toContain('착용 중');
    expect(skin('clawd').getAttribute('aria-pressed')).toBe('true');
    for (const [id, hint, target] of [
      ['azure', '별 6개', 6], ['ember', '2층 진입', 1], ['void', '첫 S 등급', 1],
      ['coral', '메달 12개', 12], ['frost', '4층 진입', 1],
      ['gold', '16구역 전부 클리어', 16], ['nova', 'S 등급 3개', 3],
    ] as const) {
      const button = skin(id);
      expect(button.disabled).toBe(true);
      expect(button.getAttribute('aria-label')).toContain(SKINS[id].kr);
      expect(skinCard(id).textContent).toContain(hint);
      expect(skinCard(id).textContent).toMatch(new RegExp(`0\\s*/\\s*${target}`));
      button.click();
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
    expect(equips).toEqual([]);
  });

  it('uses earned rules and preserves previously unlocked and currently equipped appearances', () => {
    progress.levels.t1 = cleared(first, true);
    progress.levels.t2 = cleared(level('t2'), true);
    progress.unlockedSkins = ['frost'];
    settings.skin = 'nova';
    update();
    for (const id of ['clawd', 'azure', 'frost', 'nova']) expect(skin(id).disabled).toBe(false);
    expect(skin('coral').disabled).toBe(true);
    expect(skin('nova').textContent).toContain('착용 중');
    expect(body.querySelector('.journal__summary')?.textContent).toContain('모습 4 / 8');
    skin('azure').click();
    expect(equips).toEqual(['azure']);
    update();
    expect(skin('nova').getAttribute('aria-pressed')).toBe('true');
    expect(skin('azure').getAttribute('aria-pressed')).toBe('false');
    expect(progress.unlockedSkins).toEqual(['frost']);
    expect(settings.skin).toBe('nova');
  });

  it('shows partial unlock progress without granting the appearance', () => {
    progress.levels.t1 = cleared();
    update();
    expect(skinCard('azure').textContent).toMatch(/2\s*\/\s*6/);
    expect(skinCard('coral').textContent).toMatch(/1\s*\/\s*12/);
    expect(skinCard('gold').textContent).toMatch(/1\s*\/\s*16/);
    expect(skin('azure').disabled).toBe(true);
    expect(progress.unlockedSkins).toBeUndefined();
  });
});

describe('journal refresh and ownership', () => {
  it('preserves the focused action and scroll so Navigator can continue along its goal row', () => {
    progress.levels.t1 = cleared();
    update();
    const nav = new Navigator(document, { onConfirm: (target) => target.click(), onCancel() {} });
    nav.refresh(modal);
    const selected = goal('t2', 'shards');
    selected.focus();
    nav.hover(selected);
    body.scrollTop = 320;
    body.scrollLeft = 12;
    modal.scrollTop = 48;
    settings = { ...settings, goalTargets: { t2: 'par' } };
    update();
    expect(document.activeElement).toBe(goal('t2', 'shards'));
    expect(body.scrollTop).toBe(320);
    expect(body.scrollLeft).toBe(12);
    expect(modal.scrollTop).toBe(48);
    nav.refresh(modal, true);
    expect(nav.current).toBe(goal('t2', 'shards'));
    expect(nav.move('right')).toBe(true);
    expect(document.activeElement).toBe(goal('t2', 'relic'));
    expect(nav.move('down')).toBe(true);
    expect(document.activeElement).toBe(goal('t3', 'relic'));
    expect(goals).toEqual([]);
  });

  it('keeps focus outside the body when another control owns it', () => {
    for (const target of [outside, close]) {
      target.focus();
      update();
      expect(goal('t1', 'auto').isConnected).toBe(true);
      expect(document.activeElement).toBe(target);
    }
  });

  it('moves focus to an enabled action when the previously focused zone becomes locked', () => {
    progress.levels.t1 = cleared();
    update();
    goal('t2', 'relic').focus();
    progress = defaultProgress('journal-player');
    update();
    const active = document.activeElement as HTMLButtonElement;
    expect(body.contains(active)).toBe(true);
    expect(active.isConnected).toBe(true);
    expect(active.disabled).toBe(false);
    expect(active.dataset.journalKey).toBeTruthy();
    const nav = new Navigator(document, { onConfirm: (target) => target.click(), onCancel() {} });
    nav.refresh(modal);
    expect(nav.current).toBe(active);
  });

  it('keeps the newly equipped appearance focused and selected across subsequent refreshes', () => {
    progress.unlockedSkins = ['azure'];
    panel = new JournalPanel({
      doc: document, portrait: () => null, onGoal() {},
      onEquip: (id) => { equips.push(id); settings = { ...settings, skin: id }; update(); },
    });
    update();
    skin('azure').focus();
    skin('azure').click();
    update();
    expect(equips).toEqual(['azure']);
    expect(settings.skin).toBe('azure');
    expect(document.activeElement).toBe(skin('azure'));
    expect(skin('azure').disabled).toBe(false);
    expect(skin('azure').textContent).toContain('착용 중');
    expect(skin('azure').getAttribute('aria-pressed')).toBe('true');
  });

  it('does not mutate progress or settings while rendering or requesting goals and equipment', () => {
    progress.levels.t1 = cleared();
    progress.unlockedSkins = ['azure'];
    settings.goalTargets = { t1: 'par', s1: 'relic' };
    freeze(progress);
    freeze(settings);
    const before = JSON.stringify({ progress, settings });
    update();
    goal('t1', 'par').click();
    skin('azure').click();
    update();
    expect(goals).toEqual([['t1', 'free']]);
    expect(equips).toEqual(['azure']);
    expect(JSON.stringify({ progress, settings })).toBe(before);
    expect(goal('t1', 'par').getAttribute('aria-pressed')).toBe('true');
    expect(skin('clawd').getAttribute('aria-pressed')).toBe('true');
  });
});
