/** Pure views over existing medal and skin rules. Callers own persistence and run lifecycle. */
import type { LevelDef } from '../sim/types.js';
import type { LevelRecord, Progress, Settings } from './contracts.js';
import type { GoalId, GoalPreference } from './goal-settings.js';
import {
  AZURE_STARS, CORAL_MEDALS, EMBER_TIER, FROST_TIER, NOVA_S_RANKS, SKIN_RULES,
  availableSkins, countRankAtLeast, medalsFor, skinHint, tierReached, totalMedals, totalStars, type SkinId,
} from './unlocks.js';
import { MEDAL_KR } from './ui/ceremony.js';

export const GOAL_DESCRIPTIONS: Readonly<Record<GoalId, string>> = Object.freeze({
  nodeath: '한 번도 쓰러지지 않고 클리어',
  par: '목표 시간 이내에 클리어',
  shards: '구역의 파편을 전부 모아 클리어',
  relic: '유물을 회수하고 클리어',
});

const RECOMMENDATION_ORDER: readonly GoalId[] = ['relic', 'shards', 'par', 'nodeath'];

/** Attainable categories in medal display order; o/R are the level's collectible spawns. */
export function availableGoals(def: LevelDef): GoalId[] {
  const goals: GoalId[] = ['nodeath'];
  if (Number.isFinite(def.par) && def.par > 0) goals.push('par');
  if (def.rows.some((row) => row.includes('o'))) goals.push('shards');
  if (def.rows.some((row) => row.includes('R'))) goals.push('relic');
  return goals;
}

/** Automatic targets start after the first clear and only consider explicitly earned medals. */
export function resolveGoal(def: LevelDef, rec: LevelRecord | undefined, pref: GoalPreference = 'auto'): GoalId | null {
  if (pref === 'free') return null;
  const available = availableGoals(def);
  if (pref !== 'auto') return available.includes(pref) ? pref : null;
  if (!rec?.done) return null;
  return RECOMMENDATION_ORDER.find((id) => available.includes(id) && !rec.medals?.includes(id)) ?? null;
}

export interface GoalSnapshot {
  cleared: boolean;
  finished: boolean;
  /** Cumulative run seconds, retained across checkpoint retries. */
  time: number;
  ticks: number;
  par: number;
  /** Cumulative run deaths, retained across checkpoint retries. */
  deaths: number;
  shards: number;
  totalShards: number;
  relics: number;
  /** Local goal recordability (Scenes: !run.raceLocked); assisted clears may record goals. */
  eligible: boolean;
}

export interface GoalView {
  id: GoalId;
  label: string;
  detail: string;
  progress: number | null;
  /** Completion describes the goal conditions; practice determines whether they can be recorded. */
  state: 'active' | 'ready' | 'missed' | 'complete';
  practice: boolean;
}

function fraction(current: number, target: number): number {
  if (!Number.isFinite(current) || !Number.isFinite(target) || target <= 0) return 0;
  return Math.max(0, Math.min(1, current / target));
}

function countText(value: number): string {
  return Number.isFinite(value) ? String(Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value)))) : '—';
}

function timeText(value: number): string {
  return Number.isFinite(value) && value >= 0 ? `${Math.min(Number.MAX_SAFE_INTEGER, value).toFixed(1)}초` : '—';
}

/** Evaluate one snapshot without awarding anything or keeping state between attempts. */
export function evaluateGoal(id: GoalId | null, s: GoalSnapshot): GoalView | null {
  if (id === null) return null;

  let progress: number | null;
  let metric: string;
  let missed = false;
  let ready = false;
  switch (id) {
    case 'nodeath':
      progress = null;
      metric = `쓰러짐 ${countText(s.deaths)}회`;
      missed = s.deaths > 0;
      break;
    case 'par':
      progress = Number.isFinite(s.time) && Number.isFinite(s.par) && s.par > 0
        ? 1 - fraction(s.time, s.par) : 0;
      metric = `${timeText(s.time)} / ${timeText(s.par)}`;
      missed = s.time > s.par;
      break;
    case 'shards':
      progress = fraction(s.shards, s.totalShards);
      metric = `파편 ${countText(s.shards)} / ${countText(s.totalShards)}개`;
      ready = s.totalShards > 0 && s.shards >= s.totalShards;
      break;
    case 'relic':
      progress = fraction(s.relics, 1);
      metric = `유물 ${countText(s.relics)}개 회수`;
      ready = s.relics > 0;
      break;
  }

  // The live collection checks only signal readiness. Finished clears use the award authority.
  const state: GoalView['state'] = s.finished
    ? (medalsFor(s).includes(id) ? 'complete' : 'missed')
    : missed ? 'missed' : ready ? 'ready' : 'active';
  const practice = !s.eligible;
  let detail: string;
  switch (state) {
    case 'active':
      detail = `${metric} · ${GOAL_DESCRIPTIONS[id]}`;
      break;
    case 'ready':
      detail = `${metric} · 수집 완료, 클리어하면 달성한다`;
      break;
    case 'missed':
      detail = `목표 미달성 · ${metric} · 처음부터 다시 도전한다`;
      break;
    case 'complete':
      detail = `${practice ? '연습 목표 달성' : '메달 획득'} · ${metric}`;
      break;
  }
  if (practice) detail = `기록 없는 도전 · ${detail}`;
  return { id, label: MEDAL_KR[id], detail, progress, state, practice };
}

export interface SkinMilestone {
  id: SkinId;
  available: boolean;
  current: number;
  target: number;
  unit: string;
  hint: string;
}

/** Exact counters stay independent of availability, including recorded and grandfathered skins. */
export function skinMilestones(progress: Progress, settings: Settings, levels: readonly LevelDef[]): SkinMilestone[] {
  const available = availableSkins(progress, settings, levels);
  const sRanks = countRankAtLeast(progress, 'S');
  const metrics: Record<SkinId, Pick<SkinMilestone, 'current' | 'target' | 'unit'>> = {
    clawd: { current: 1, target: 1, unit: '기본' },
    rabbit: { current: 1, target: 1, unit: '기본' },
    robot: { current: 1, target: 1, unit: '기본' },
    azure: { current: totalStars(progress, levels), target: AZURE_STARS, unit: '별' },
    ember: { current: Number(tierReached(levels, progress, EMBER_TIER)), target: 1, unit: '진입' },
    void: { current: sRanks, target: 1, unit: 'S 등급' },
    coral: { current: totalMedals(progress, levels), target: CORAL_MEDALS, unit: '메달' },
    frost: { current: Number(tierReached(levels, progress, FROST_TIER)), target: 1, unit: '진입' },
    gold: { current: levels.filter((def) => progress.levels[def.id]?.done).length, target: levels.length, unit: '구역' },
    nova: { current: sRanks, target: NOVA_S_RANKS, unit: 'S 등급' },
  };
  return SKIN_RULES.map(({ id }) => ({
    id, available: available.has(id), ...metrics[id], hint: skinHint(id, levels) ?? '처음부터 사용 가능',
  }));
}
