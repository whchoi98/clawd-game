// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { ObjectivePanel } from '../../src/client/ui/objective.js';
import type { GoalPreference } from '../../src/client/goal-settings.js';
import type { LevelDef } from '../../src/sim/types.js';

const def: LevelDef = { id: 't1', name: '물가', en: 'Pool', biome: 'tidepool', seed: 1, par: 45, rows: ['P.o.R.G', '#######'] };

describe('objective controls and feedback', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="picker"></div><div id="hud-objective" hidden></div><div id="res-objective" hidden></div>';
  });
  it('exposes a compact picker and sends an explicit preference without mutating a record', () => {
    const choices: [string, GoalPreference][] = [];
    const panel = new ObjectivePanel(document, (level, pref) => choices.push([level, pref]), () => {});
    const record = { done: true, bestTicks: 6000, bestShards: 0, stars: 1, relics: 0, deaths: 1, medals: [] };
    panel.picker('picker', def, record, 'auto');
    document.querySelector<HTMLButtonElement>('.goal-picker__toggle')!.click();
    const button = document.querySelector<HTMLButtonElement>('[data-goal-choice="shards"]')!;
    expect(button.closest<HTMLElement>('.goal-picker__body')!.hidden).toBe(false);
    button.click();
    expect(choices).toEqual([['t1', 'shards']]);
    expect(record.medals).toEqual([]);
  });
  it('restores a picker button after its controlled preference is updated', () => {
    const panel = new ObjectivePanel(document, () => {}, () => {});
    panel.picker('picker', def, undefined, 'auto');
    document.querySelector<HTMLButtonElement>('.goal-picker__toggle')!.click();
    document.querySelector<HTMLButtonElement>('[data-goal-choice="par"]')!.focus();
    panel.picker('picker', def, undefined, 'par');
    expect((document.activeElement as HTMLElement).dataset.goalChoice).toBe('par');
    expect(document.activeElement?.getAttribute('aria-pressed')).toBe('true');
  });
  it('shows readiness independently of completion and removes an obsolete goal', () => {
    const panel = new ObjectivePanel(document, () => {}, () => {});
    panel.live({ id: 'shards', label: '파편 전부', detail: '도착하면 달성', progress: 1, state: 'ready', practice: false });
    const hud = document.getElementById('hud-objective')!;
    expect(hud.hidden).toBe(false);
    expect(hud.dataset.state).toBe('ready');
    expect(hud.textContent).toContain('도착하면 달성');
    panel.live(null);
    expect(hud.hidden).toBe(true);
  });
  it('renders a next-goal action without granting a reward and labels unrecorded practice', () => {
    const panel = new ObjectivePanel(document, () => {}, () => {});
    panel.result({
      objective: { id: 'nodeath', label: '무사 통과', detail: '연습 목표 달성', progress: 1, state: 'complete', practice: true },
      nextGoal: { id: 'par', label: '목표 시간 안', detail: '45초 안에 도착' },
    });
    const root = document.getElementById('res-objective')!;
    expect(root.textContent).toContain('연습');
    expect(root.querySelector<HTMLButtonElement>('[data-act="retryGoal"]')!.dataset.goal).toBe('par');
    panel.result({});
    expect(root.hidden).toBe(true);
  });
});
