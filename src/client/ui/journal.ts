import type { LevelDef } from '../../sim/types.js';
import { BIOMES, BIOME_ORDER } from '../../shared/biomes.js';
import type { Progress, Settings } from '../contracts.js';
import type { GoalId, GoalPreference } from '../goal-settings.js';
import { availableGoals, resolveGoal, skinMilestones } from '../goals.js';
import { unlockedZones } from '../save.js';
import { availableSkins, maxMedals, skinHint, totalMedals } from '../unlocks.js';
import { campaignInfo, unlockHint } from './campaign.js';
import { MEDAL_KR, MEDAL_ORDER, medalsOf } from './ceremony.js';
import { el, isVisible, type Attrs, type Child } from './screens.js';

export interface JournalOptions {
  doc: Document;
  onGoal: (levelId: string, preference: GoalPreference) => void;
  onEquip: (skin: string) => void;
  portrait: () => ((ctx: CanvasRenderingContext2D, skin: string, size: number, t: number) => void) | null;
}

type SkinMilestone = ReturnType<typeof skinMilestones>[number];
const PORTRAIT_SIZE = 112;

/** A controlled view: only the owner applies goal preferences and equipment. */
export class JournalPanel {
  constructor(private readonly options: JournalOptions) {}

  update(progress: Progress, settings: Settings, levels: readonly LevelDef[], skins: Record<string, { name: string; kr: string }>): void {
    const { doc } = this.options;
    const body = doc.getElementById('journal-body');
    if (!body) return;

    const active = doc.activeElement as HTMLElement | null;
    const ownedFocus = !!active && body.contains(active);
    const focusedKey = ownedFocus ? active.dataset.journalKey : undefined;
    const focusedZone = ownedFocus ? active.closest<HTMLElement>('[data-journal-zone]')?.dataset.journalZone : undefined;
    const oldButtons = [...body.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const focusedIndex = Math.max(0, oldButtons.indexOf(active as HTMLButtonElement));
    // The shell may put the scrollbar on the body, its modal, or the page.
    const scroll: { node: HTMLElement; top: number; left: number }[] = [];
    for (let node: HTMLElement | null = body; node; node = node.parentElement) {
      scroll.push({ node, top: node.scrollTop, left: node.scrollLeft });
    }

    const story = levels.filter((def) => !def.tide && def.id !== 'daily' && def.id !== 'endless');
    const open = unlockedZones(story, progress);
    const milestones = new Map<string, SkinMilestone>(skinMilestones(progress, settings, story).map((milestone) => [milestone.id, milestone]));
    const available = availableSkins(progress, settings, story);
    const skinEntries = Object.entries(skins);
    const canEquip = (id: string): boolean => milestones.get(id)?.available ?? available.has(id);
    const painter = this.options.portrait();
    const content = doc.createDocumentFragment();
    content.append(
      el(doc, 'div', { class: 'journal__summary', role: 'group', 'aria-label': '탐험 기록' },
        el(doc, 'p', { class: 'journal__stat' }, `클리어 구역 ${story.filter((def) => progress.levels[def.id]?.done).length} / ${story.length}`),
        el(doc, 'p', { class: 'journal__stat' }, `메달 ${totalMedals(progress, story)} / ${maxMedals(story)}`),
        el(doc, 'p', { class: 'journal__stat' }, `모습 ${skinEntries.filter(([id]) => canEquip(id)).length} / ${skinEntries.length}`)),
      el(doc, 'p', { class: 'journal__instructions' },
        '메달을 누르면 다음 도전의 목표로 고정한다. 고정한 메달을 다시 누르면 자유 도전으로 돌아간다. 자동은 첫 클리어 뒤에 아직 얻지 못한 메달을 추천한다.'),
      el(doc, 'p', { class: 'journal__controls' }, '방향키·십자키로 이동 · Enter·확인 버튼으로 선택'),
    );

    for (const biome of BIOME_ORDER) {
      const zones = story.filter((def) => def.biome === biome);
      if (!zones.length) continue;
      const heading = `journal-biome-${biome}`;
      content.append(el(doc, 'section', {
        class: 'journal__biome', 'data-journal-biome': biome, 'aria-labelledby': heading,
      },
      el(doc, 'h3', { class: 'journal__heading', id: heading }, BIOMES[biome].kr),
      ...zones.map((def) => this.zone(def, progress, settings, story, open.has(def.id)))));
    }

    content.append(el(doc, 'section', { class: 'journal__skins', 'aria-labelledby': 'journal-skins-title' },
      el(doc, 'h3', { class: 'journal__heading', id: 'journal-skins-title' }, '함께 오를 모습'),
      el(doc, 'div', { class: 'journal__gallery' },
        ...skinEntries.map(([id, skin]) => this.skin(
          id, skin.kr, settings.skin === id, canEquip(id), milestones.get(id), skinHint(id, story), painter,
        )))));
    body.replaceChildren(content);

    // Restoring the live key lets the shell's Navigator.refresh(root, true)
    // collect the replacement controls without losing the player's position.
    if (ownedFocus && body.isConnected && isVisible(body, doc.documentElement)) {
      const buttons = [...body.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
        .filter((button) => isVisible(button, body));
      const target = buttons.find((button) => button.dataset.journalKey === focusedKey)
        ?? (focusedZone ? buttons.find((button) => button.closest<HTMLElement>('[data-journal-zone]')?.dataset.journalZone === focusedZone) : undefined)
        ?? buttons[Math.min(focusedIndex, buttons.length - 1)]
        ?? body;
      if (target === body && !body.hasAttribute('tabindex')) body.tabIndex = -1;
      target.focus({ preventScroll: true });
    }
    for (const { node, top, left } of scroll) {
      node.scrollTop = top;
      node.scrollLeft = left;
    }
  }

  private zone(def: LevelDef, progress: Progress, settings: Settings, levels: readonly LevelDef[], open: boolean): HTMLElement {
    const { doc } = this.options;
    const record = progress.levels[def.id];
    const preference = settings.goalTargets?.[def.id] ?? 'auto';
    const possible = new Set(availableGoals(def));
    const resolved = open ? resolveGoal(def, record, preference) : null;
    const earned = new Set(medalsOf(record));
    const lock = open ? null : unlockHint(def, levels, progress);
    const info = campaignInfo(def);
    const criteria: Record<GoalId, string> = {
      nodeath: '쓰러짐 없이 클리어',
      par: `${def.par}초 안에 클리어`,
      shards: `파편 ${info.shards}개를 모두 모아 클리어`,
      relic: '유물을 하나 이상 모아 클리어',
    };
    const row = el(doc, 'div', { class: 'journal-zone__goals', 'data-row': '', role: 'group', 'aria-label': `${def.name} 도전 목표` });
    for (const [mode, name, detail] of [
      ['auto', '자동', '첫 클리어 뒤에 남은 메달을 추천한다'],
      ['free', '자유 도전', '메달 목표 없이 도전한다'],
    ] as const) {
      const selected = preference === mode;
      row.append(this.button({
        class: `journal-zone__mode${selected ? ' journal-zone__mode--selected' : ''}`,
        'data-journal-key': `goal:${def.id}:${mode}`,
        'aria-label': `${def.name} · ${name} · ${detail} · ${selected ? '선택됨' : '선택하기'}${lock ? ` · 잠김 · ${lock}` : ''}`,
        'aria-pressed': String(selected), 'aria-disabled': String(!open), disabled: !open,
      }, () => this.options.onGoal(def.id, mode),
      el(doc, 'span', { class: 'journal-zone__mode-name' }, name),
      selected && el(doc, 'small', { class: 'journal-zone__state' }, '선택됨')));
    }
    for (const medal of MEDAL_ORDER) {
      const explicit = preference === medal;
      const missing = !possible.has(medal)
        ? medal === 'shards' ? '파편이 없는 구역' : medal === 'relic' ? '유물이 없는 구역' : '이 구역에서는 선택할 수 없는 목표'
        : null;
      const reason = [lock, missing].filter(Boolean).join(' · ');
      const have = earned.has(medal);
      const suggested = preference === 'auto' && resolved === medal;
      const state = [
        have ? '획득' : '미획득',
        explicit ? reason ? '저장한 목표' : '고정한 목표' : suggested ? '자동 추천' : null,
      ].filter(Boolean).join(' · ');
      const action = reason ? `선택 불가 · ${reason}` : explicit ? '다시 선택하면 자유 도전' : '선택하면 목표로 고정';
      row.append(this.button({
        class: [
          'journal-zone__medal', `journal-zone__medal--${have ? 'earned' : 'unearned'}`,
          explicit && (reason ? 'journal-zone__medal--saved' : 'journal-zone__medal--pinned'),
          suggested && 'journal-zone__medal--suggested',
        ].filter(Boolean).join(' '),
        'data-journal-key': `goal:${def.id}:${medal}`,
        'aria-label': `${def.name} · ${MEDAL_KR[medal]} · ${criteria[medal]} · ${state} · ${action}`,
        'aria-pressed': String(explicit), 'aria-disabled': String(!!reason), disabled: !!reason,
      }, () => this.options.onGoal(def.id, explicit ? 'free' : medal),
      el(doc, 'span', { class: 'journal-zone__medal-name' }, MEDAL_KR[medal]),
      el(doc, 'small', { class: 'journal-zone__criteria' }, criteria[medal]),
      el(doc, 'span', { class: 'journal-zone__state' }, state),
      !!reason && el(doc, 'small', { class: 'journal-zone__reason' }, action)));
    }
    let target = '자유 도전';
    if (!open) target = `잠김 · ${lock}`;
    else if (resolved) target = `${preference === 'auto' ? '자동 추천' : '고정한 목표'} · ${MEDAL_KR[resolved]}`;
    else if (preference === 'auto' && !record?.done) target = '첫 클리어 뒤에 다음 목표를 추천한다.';
    else if (preference !== 'auto' && preference !== 'free') target = `저장한 목표: ${MEDAL_KR[preference]} · 선택할 수 없는 목표다. 자유 도전으로 진행한다.`;
    const heading = `journal-zone-${def.id}`;
    return el(doc, 'article', { class: 'journal__zone', 'data-journal-zone': def.id, 'aria-labelledby': heading },
      el(doc, 'div', { class: 'journal-zone__header' },
        el(doc, 'h4', { class: 'journal-zone__name', id: heading }, def.name),
        el(doc, 'span', { class: 'journal-zone__completion' }, record?.done ? '클리어' : '미클리어')),
      el(doc, 'p', { class: 'journal-zone__target' }, target), row);
  }

  private skin(
    id: string, name: string, selected: boolean, available: boolean,
    milestone: SkinMilestone | undefined, fallbackHint: string | null, painter: ReturnType<JournalOptions['portrait']>,
  ): HTMLElement {
    const { doc } = this.options;
    const hint = milestone?.hint || fallbackHint || '';
    const count = milestone ? `${milestone.current} / ${milestone.target} ${milestone.unit}` : '';
    const status = selected ? '착용 중' : available ? '착용하기' : '잠김';
    const heading = `journal-skin-${id}`;
    const card = el(doc, 'article', {
      class: `journal-skin__card${selected ? ' journal-skin__card--selected' : ''}${available ? '' : ' journal-skin__card--locked'}`,
      'data-journal-skin': id, 'aria-labelledby': heading,
    });
    if (painter) {
      const canvas = el(doc, 'canvas', {
        class: 'journal-skin__portrait', width: PORTRAIT_SIZE, height: PORTRAIT_SIZE,
        role: 'img', 'aria-label': `${name} 모습`,
      });
      const ctx = canvas.getContext('2d');
      if (ctx) {
        painter(ctx, id, PORTRAIT_SIZE, 0);
        card.append(canvas);
      }
    }
    card.append(
      el(doc, 'h4', { class: 'journal-skin__name', id: heading }, name),
      el(doc, 'p', { class: 'journal-skin__hint' }, available ? selected ? '지금 함께 오르는 모습' : '함께 오를 수 있는 모습' : hint || '아직 해금되지 않은 모습'),
    );
    if (!available && count) card.append(el(doc, 'p', { class: 'journal-skin__progress' }, count));
    card.append(this.button({
      class: 'journal-skin__equip', 'data-journal-key': `skin:${id}`,
      'aria-label': [name, status, !available && hint, !available && count].filter(Boolean).join(' · '),
      'aria-pressed': String(selected), 'aria-disabled': String(!available), disabled: !available,
    }, () => { if (!selected) this.options.onEquip(id); }, status));
    return card;
  }

  private button(attrs: Attrs, activate: () => void, ...children: Child[]): HTMLButtonElement {
    const button = el(this.options.doc, 'button', { type: 'button', ...attrs }, ...children);
    button.addEventListener('click', () => {
      if (!button.disabled && button.isConnected) activate();
    });
    return button;
  }
}
