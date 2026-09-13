/** Controlled goal selection and read-only feedback. Awarding belongs to Scenes. */
import type { LevelRecord, ResultView } from '../contracts.js';
import type { LevelDef } from '../../sim/types.js';
import type { GoalPreference } from '../goal-settings.js';
import { availableGoals, GOAL_DESCRIPTIONS, resolveGoal, type GoalView } from '../goals.js';
import { MEDAL_KR } from './ceremony.js';
import { el } from './screens.js';

export class ObjectivePanel {
  private liveKey = '';
  private readonly pickerKeys = new Map<string, string>();

  constructor(
    private readonly doc: Document,
    private readonly onGoal: (levelId: string, preference: GoalPreference) => void,
    private readonly onLayout: () => void,
  ) {}

  picker(hostId: string, def: LevelDef, record: LevelRecord | undefined, preference: GoalPreference = 'auto'): void {
    const host = this.doc.getElementById(hostId);
    if (!host) return;
    const possible = availableGoals(def);
    const key = JSON.stringify([def.id, possible, record?.done, record?.medals, preference]);
    if (this.pickerKeys.get(hostId) === key) return;
    this.pickerKeys.set(hostId, key);
    const expanded = host.dataset.expanded === 'true';
    const focused = host.contains(this.doc.activeElement) ? this.doc.activeElement as HTMLElement : null;
    const focusChoice = focused?.dataset.goalChoice;
    const focusToggle = focused?.classList.contains('goal-picker__toggle');
    const resolved = resolveGoal(def, record, preference);
    const label = resolved ? MEDAL_KR[resolved] : '자유 등반';
    const toggle = el(this.doc, 'button', {
      class: 'goal-picker__toggle', type: 'button', 'aria-expanded': String(expanded),
      'aria-controls': `${hostId}-choices`,
    }, el(this.doc, 'span', {}, '이번 목표'), el(this.doc, 'b', {}, `${preference === 'auto' ? '자동 · ' : ''}${label}`),
    el(this.doc, 'i', { 'aria-hidden': 'true' }, '⌄'));
    const body = el(this.doc, 'div', { class: 'goal-picker__body', id: `${hostId}-choices`, hidden: !expanded });
    const button = (value: GoalPreference, title: string): HTMLButtonElement => {
      const b = el(this.doc, 'button', {
        class: `goal-picker__button${record?.medals?.includes(value) ? ' is-earned' : ''}`,
        type: 'button', 'data-goal-choice': value, 'aria-pressed': String(value === preference),
      }, title);
      b.addEventListener('click', () => this.onGoal(def.id, value));
      return b;
    };
    body.append(
      el(this.doc, 'div', { class: 'goal-picker__modes', 'data-row': '', role: 'group', 'aria-label': '목표 방식' },
        button('auto', '자동 추천'), button('free', '자유 등반')),
      el(this.doc, 'div', { class: 'goal-picker__medals', 'data-row': '', role: 'group', 'aria-label': '메달 목표' },
        ...possible.map((id) => button(id, MEDAL_KR[id]))),
      el(this.doc, 'p', { class: 'goal-picker__help' }, resolved ? GOAL_DESCRIPTIONS[resolved]
        : record?.done ? '목표를 정하지 않고 나만의 속도로 오른다.' : '첫 도전은 골까지. 완주한 뒤 다음 메달을 추천한다.'),
    );
    toggle.addEventListener('click', () => {
      body.hidden = !body.hidden;
      host.dataset.expanded = String(!body.hidden);
      toggle.setAttribute('aria-expanded', String(!body.hidden));
      this.onLayout();
    });
    host.classList.add('goal-picker');
    host.replaceChildren(toggle, body);
    if (focused) {
      const next = focusToggle ? toggle : [...host.querySelectorAll<HTMLElement>('[data-goal-choice]')]
        .find((node) => node.dataset.goalChoice === focusChoice);
      next?.focus({ preventScroll: true });
    }
  }

  live(view: GoalView | null): void {
    const root = this.doc.getElementById('hud-objective');
    if (!root) return;
    const key = view ? JSON.stringify([view.id, view.label, view.detail, view.state, view.practice,
      view.progress === null ? null : Math.round(view.progress * 100)]) : '';
    if (key === this.liveKey && root.hidden === !view) return;
    this.liveKey = key;
    root.hidden = view === null;
    if (!view) { root.replaceChildren(); delete root.dataset.state; return; }
    root.dataset.state = view.state;
    root.classList.toggle('is-practice', view.practice);
    const children = [
      el(this.doc, 'span', { class: 'objective__mark', 'aria-hidden': 'true' }, view.state === 'complete' ? '✓' : '◇'),
      el(this.doc, 'div', { class: 'objective__copy' },
        el(this.doc, 'b', {}, view.label),
        el(this.doc, 'span', {}, view.detail)),
    ];
    if (view.progress !== null) {
      const bar = el(this.doc, 'span', { class: 'objective__meter', 'aria-hidden': 'true' }, el(this.doc, 'i'));
      bar.style.setProperty('--goal-progress', String(Math.min(1, Math.max(0, view.progress))));
      children.push(bar);
    }
    root.replaceChildren(...children);
  }

  result(view: Pick<ResultView, 'objective' | 'nextGoal'>): void {
    const root = this.doc.getElementById('res-objective');
    if (!root) return;
    root.hidden = !view.objective && !view.nextGoal;
    const nodes: HTMLElement[] = [];
    const goal = view.objective;
    if (goal) {
      const status = goal.practice ? '기록 없는 도전'
        : goal.state === 'complete' ? '목표 달성' : '다음 도전에서 한 번 더';
      root.dataset.state = goal.state;
      nodes.push(el(this.doc, 'div', { class: 'res-objective__current' },
        el(this.doc, 'small', {}, status), el(this.doc, 'b', {}, goal.label),
        el(this.doc, 'span', {}, goal.detail)));
    } else delete root.dataset.state;
    if (view.nextGoal) {
      const next = view.nextGoal;
      nodes.push(el(this.doc, 'div', { class: 'res-objective__next' },
        el(this.doc, 'div', {}, el(this.doc, 'small', {}, '다음 도전'), el(this.doc, 'b', {}, next.label),
          el(this.doc, 'span', {}, next.detail)),
        el(this.doc, 'button', { class: 'res-objective__retry', type: 'button', 'data-act': 'retryGoal', 'data-goal': next.id },
          '이 목표로 다시 도전')));
    }
    root.replaceChildren(...nodes);
  }
}
