/**
 * Ceremonies (P3-9) — the choreographed moments around a clear: the result
 * screen's staged reveal (rank → stars → medals → board), the one-time
 * '층 돌파' vista card between a tier's last clear and its result, and the
 * ending screen after the whole tower is climbed.
 *
 * Everything here is data and pure helpers plus a tiny frame-driven timeline:
 * no DOM, no timers. The UI owns the elements (ui.ts) and advances the
 * timelines from its frame(); the shell decides when a ceremony is due
 * (scenes.ts) and records it in Progress. Both are tested headless against
 * this module. `drawEndingSky` is the one drawing routine — a procedural night
 * sky on a plain 2D context, no assets.
 */
import type { BiomeId, LevelDef } from '../../sim/types.js';
import { BIOMES, BIOME_ORDER } from '../../shared/biomes.js';
import type { Progress, ResultView } from '../contracts.js';

// ---------------------------------------------------------------- timeline
export interface TimelineStep<S extends string> { stage: S; at: number }

/**
 * Stages fired at fixed seconds from `start()`, advanced by `update(dt)` from
 * the render loop. `instant` (prefers-reduced-motion, the capture harness)
 * jumps straight to the last stage. `skip()` also jumps to the last stage and
 * fires only that stage's handler — the sounds of the stages skipped over stay
 * silent on purpose.
 */
export class Timeline<S extends string> {
  t = 0;
  private next = 0;
  private started = false;

  constructor(
    private readonly steps: readonly TimelineStep<S>[],
    private readonly onStage: (stage: S) => void,
    private readonly instant = false,
  ) {
    if (!steps.length) throw new Error('timeline needs at least one step');
  }

  /** The last stage fired, or null before start(). */
  get stage(): S | null { return this.next > 0 ? this.steps[this.next - 1].stage : null; }
  get done(): boolean { return this.next >= this.steps.length; }
  get running(): boolean { return this.started && !this.done; }

  start(): this {
    this.started = true;
    this.t = 0;
    this.next = 0;
    if (this.instant) this.skip();
    else this.update(0);
    return this;
  }

  update(dt: number): void {
    if (!this.started || this.done) return;
    this.t += Number.isFinite(dt) && dt > 0 ? dt : 0;
    while (!this.done && this.steps[this.next].at <= this.t + 1e-9) {
      const s = this.steps[this.next++];
      this.onStage(s.stage);
    }
  }

  /** Jump to the final stage (its handler only). */
  skip(): void {
    this.started = true;
    if (this.done) return;
    const last = this.steps[this.steps.length - 1];
    this.next = this.steps.length;
    this.t = Math.max(this.t, last.at);
    this.onStage(last.stage);
  }
}

/** `prefers-reduced-motion: reduce` on a window-like object; false without matchMedia. */
export function prefersReducedMotion(win: { matchMedia?(query: string): { matches: boolean } } | null | undefined): boolean {
  try { return !!win && typeof win.matchMedia === 'function' && win.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

// ---------------------------------------------------------------- clear (result) reveal
export type ClearStage = 'rank' | 'stars' | 'medals' | 'board' | 'done';
export const CLEAR_STAGES: readonly ClearStage[] = ['rank', 'stars', 'medals', 'board', 'done'];
/** Seconds from the result modal landing: the rank tile first, the stars pop, the medal row, then the board and the menu. */
export const CLEAR_TIMELINE: readonly TimelineStep<ClearStage>[] = [
  { stage: 'rank', at: 0 },
  { stage: 'stars', at: 0.55 },
  { stage: 'medals', at: 1.1 },
  { stage: 'board', at: 1.45 },
  { stage: 'done', at: 1.8 },
];

/** Whether `stage` is at or past `min` in the clear order. */
export function stageAtLeast(stage: ClearStage, min: ClearStage): boolean {
  return CLEAR_STAGES.indexOf(stage) >= CLEAR_STAGES.indexOf(min);
}

/** Zone medals (LevelRecord.medals) in display order with their Korean labels; unknown ids are ignored. */
export const MEDAL_ORDER = ['nodeath', 'par', 'shards', 'relic'] as const;
export type MedalId = (typeof MEDAL_ORDER)[number];
export const MEDAL_KR: Readonly<Record<MedalId, string>> = {
  nodeath: '무사 통과', par: '목표 시간 안', shards: '파편 전부', relic: '유물 회수',
};

export function medalsOf(rec: { medals?: readonly string[] } | undefined | null): MedalId[] {
  const have = new Set(rec?.medals ?? []);
  return MEDAL_ORDER.filter((m) => have.has(m));
}

// ---------------------------------------------------------------- tier break
export type TierStage = 'in' | 'line' | 'next' | 'out' | 'done';
/** Seconds the vista card stays up on its own (any key or tap skips it). */
export const TIER_CARD_S = 3.0;
export const TIER_TIMELINE: readonly TimelineStep<TierStage>[] = [
  { stage: 'in', at: 0 },
  { stage: 'line', at: 0.55 },
  { stage: 'next', at: 1.35 },
  { stage: 'out', at: TIER_CARD_S - 0.45 },
  { stage: 'done', at: TIER_CARD_S },
];
export const ROMAN: readonly string[] = ['I', 'II', 'III', 'IV', 'V'];

/** The card's steps: under reduced motion the text is all up at once and only the dwell (and its end) remains. */
export function tierTimeline(reduced: boolean): readonly TimelineStep<TierStage>[] {
  if (!reduced) return TIER_TIMELINE;
  return TIER_TIMELINE.map((s) => (s.stage === 'out' || s.stage === 'done' ? s : { stage: s.stage, at: 0 }));
}

/** One Korean line per tier, read as the tier's last zone falls (해라체). */
export const TIER_LINES: Readonly<Record<BiomeId, string>> = {
  tidepool: '조수가 물러난 자리에 첫 발자국을 남겼다.',
  stormspire: '번개 사이를 지나 탑의 허리를 넘었다.',
  voidreef: '공허의 끝에서 메아리가 되돌아왔다.',
};
/** What the card promises after the last tier (only shown when the ending has already played). */
export const TIER_NEXT_SUMMIT = '정점 너머 · 메아리와 다시 겨룬다';

export interface TierCardView {
  biome: BiomeId;
  /** 1-based tier number and its roman numeral. */
  floor: number;
  roman: string;
  kr: string;
  en: string;
  line: string;
  /** "다음: II층 폭풍 첨탑" — the next tier's name, or the summit line after the last. */
  next: string;
  /** Biome palette for the card's gradient and accent. */
  sky: readonly string[];
  accent: string;
  ridge: string;
}

export function tierCardView(biome: BiomeId): TierCardView {
  const i = Math.max(0, BIOME_ORDER.indexOf(biome));
  const b = BIOMES[biome];
  const nextId = BIOME_ORDER[i + 1];
  return {
    biome, floor: i + 1, roman: ROMAN[i] ?? String(i + 1), kr: b.kr, en: b.name, line: TIER_LINES[biome],
    next: nextId ? `다음: ${ROMAN[i + 1] ?? String(i + 2)}층 ${BIOMES[nextId].kr}` : TIER_NEXT_SUMMIT,
    sky: b.sky, accent: b.accent, ridge: b.ridge[2],
  };
}

type Done = Pick<Progress, 'levels'>;

/** Every zone of `biome` in `levels` is cleared (false for a biome with no zones). */
export function tierComplete(levels: readonly Pick<LevelDef, 'id' | 'biome'>[], progress: Done, biome: BiomeId): boolean {
  const zones = levels.filter((l) => l.biome === biome);
  return zones.length > 0 && zones.every((l) => !!progress.levels[l.id]?.done);
}

/** Every story zone is cleared (false without zones). */
export function towerComplete(levels: readonly Pick<LevelDef, 'id'>[], progress: Done): boolean {
  return levels.length > 0 && levels.every((l) => !!progress.levels[l.id]?.done);
}

// ---------------------------------------------------------------- ending
export type EndingStage = 'sky' | 'title' | 'line1' | 'line2' | 'line3' | 'totals' | 'done';
export const ENDING_TIMELINE: readonly TimelineStep<EndingStage>[] = [
  { stage: 'sky', at: 0 },
  { stage: 'title', at: 0.7 },
  { stage: 'line1', at: 1.5 },
  { stage: 'line2', at: 2.5 },
  { stage: 'line3', at: 3.5 },
  { stage: 'totals', at: 4.5 },
  { stage: 'done', at: 5.3 },
];

/** The ending's steps: under reduced motion everything is up at once (the screen itself stays until the player acts). */
export function endingTimeline(reduced: boolean): readonly TimelineStep<EndingStage>[] {
  return reduced ? ENDING_TIMELINE.map((s) => ({ stage: s.stage, at: 0 })) : ENDING_TIMELINE;
}

/** The three-line ending (해라체). */
export const ENDING_LINES: readonly [string, string, string] = [
  '정점에 선 클로드의 발밑으로 탑 전체가 잠들었다.',
  '지나온 층마다 남긴 발걸음이 메아리가 되어 아래에서 올라온다.',
  '탑은 끝났지만, 메아리는 언제든 다시 오를 이를 기다린다.',
];
/** The one-line story hook the title carries after the ending. */
export const TITLE_HOOK = '정점을 본 메아리가 탑 아래에서 기다린다';

export interface EndingTotals {
  zones: number;
  stars: number; maxStars: number;
  relics: number; maxRelics: number;
  deaths: number;
  /** Sum of the best clear ticks of every zone. */
  ticks: number;
}

export interface EndingView {
  /** The last zone's result (its submission line rides along on the ending screen). */
  result: ResultView;
  lines: readonly string[];
  totals: EndingTotals;
}

/** Relics a zone holds, from its rows (the legend's 'R'). */
function relicsIn(def: Pick<LevelDef, 'rows'>): number {
  let n = 0;
  for (const row of def.rows) for (let i = 0; i < row.length; i++) if (row[i] === 'R') n++;
  return n;
}

/** Totals over the story zones: stars, relics, deaths and the sum of the best clears. */
export function endingTotals(progress: Done, levels: readonly Pick<LevelDef, 'id' | 'rows'>[]): EndingTotals {
  let stars = 0, relics = 0, deaths = 0, ticks = 0, maxRelics = 0;
  for (const l of levels) {
    const rec = progress.levels[l.id];
    maxRelics += relicsIn(l);
    if (!rec) continue;
    stars += Math.min(3, Math.max(0, rec.stars | 0));
    relics += Math.max(0, rec.relics | 0);
    deaths += Math.max(0, rec.deaths | 0);
    ticks += Math.max(0, rec.bestTicks | 0);
  }
  return { zones: levels.length, stars, maxStars: levels.length * 3, relics, maxRelics, deaths, ticks };
}

export function endingView(progress: Done, levels: readonly Pick<LevelDef, 'id' | 'rows'>[], result: ResultView): EndingView {
  return { result, lines: ENDING_LINES, totals: endingTotals(progress, levels) };
}

// ---------------------------------------------------------------- ending sky
/** Where Clawd stands on the ending sky (feet), as a fraction of the canvas: the right third, clear of the centred card. */
export const SUMMIT = { x: 0.82, y: 0.74 } as const;

/** A tiny LCG, so the star field is the same picture every night. */
function lcg(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

/**
 * Procedural night sky for the ending screen: a deep gradient, a seeded star
 * field twinkling with `t`, a thin moon, two dark ridge lines and the summit
 * peak Clawd stands on. Draws into the whole `w × h` box; the caller paints
 * Clawd at `SUMMIT` afterwards.
 */
export function drawEndingSky(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, seed = 7): void {
  ctx.save();
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#02030A');
  sky.addColorStop(0.55, '#07112A');
  sky.addColorStop(1, '#0E2446');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  // stars: 160 seeded points, a slow twinkle each
  const rnd = lcg(seed);
  for (let i = 0; i < 160; i++) {
    const x = rnd() * w, y = rnd() * h * 0.78;
    const r = 0.4 + rnd() * 1.3;
    const ph = rnd() * Math.PI * 2;
    const tw = 0.55 + 0.45 * Math.sin(t * (0.8 + rnd() * 1.6) + ph);
    ctx.fillStyle = `rgba(${200 + Math.round(rnd() * 55)},${215 + Math.round(rnd() * 40)},255,${(0.35 + 0.65 * tw).toFixed(3)})`;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }

  // a thin moon, top right, with a soft halo
  const mx = w * 0.78, my = h * 0.2, mr = Math.min(w, h) * 0.05;
  const halo = ctx.createRadialGradient(mx, my, mr * 0.6, mx, my, mr * 4);
  halo.addColorStop(0, 'rgba(207,251,244,0.22)');
  halo.addColorStop(1, 'rgba(207,251,244,0)');
  ctx.fillStyle = halo;
  ctx.fillRect(mx - mr * 4, my - mr * 4, mr * 8, mr * 8);
  ctx.fillStyle = '#E9FBF7';
  ctx.beginPath(); ctx.arc(mx, my, mr, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#07112A';
  ctx.beginPath(); ctx.arc(mx + mr * 0.42, my - mr * 0.18, mr * 0.86, 0, Math.PI * 2); ctx.fill();

  // two ridge lines, far and near
  const ridge = (base: number, amp: number, col: string, k: number): void => {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(0, h);
    const n = 24;
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      const y = h * base - amp * (0.5 + 0.5 * Math.sin(u * 6.1 * k + k)) - amp * 0.4 * Math.sin(u * 17 * k);
      ctx.lineTo(u * w, y);
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fill();
  };
  ridge(0.84, h * 0.09, '#071121', 1.3);
  ridge(0.9, h * 0.07, '#04091A', 2.1);

  // the summit: a dark peak whose tip is where Clawd stands
  const sx = w * SUMMIT.x, sy = h * SUMMIT.y;
  const peak = ctx.createLinearGradient(0, sy, 0, h);
  peak.addColorStop(0, '#1A2E4A');
  peak.addColorStop(1, '#04070F');
  ctx.fillStyle = peak;
  ctx.beginPath();
  ctx.moveTo(sx - w * 0.3, h);
  ctx.lineTo(sx - w * 0.12, sy + h * 0.14);
  ctx.lineTo(sx - w * 0.04, sy + h * 0.03);
  ctx.lineTo(sx - w * 0.016, sy + 1);
  ctx.lineTo(sx + w * 0.018, sy + 1);
  ctx.lineTo(sx + w * 0.05, sy + h * 0.04);
  ctx.lineTo(sx + w * 0.15, sy + h * 0.18);
  ctx.lineTo(sx + w * 0.34, h);
  ctx.closePath();
  ctx.fill();
  // rim light along the summit's left edge
  ctx.strokeStyle = 'rgba(127,227,214,0.35)';
  ctx.lineWidth = Math.max(1, h * 0.003);
  ctx.beginPath();
  ctx.moveTo(sx - w * 0.12, sy + h * 0.14);
  ctx.lineTo(sx - w * 0.04, sy + h * 0.03);
  ctx.lineTo(sx - w * 0.016, sy + 1);
  ctx.stroke();

  // ground fog
  const fog = ctx.createLinearGradient(0, h * 0.7, 0, h);
  fog.addColorStop(0, 'rgba(8,48,74,0)');
  fog.addColorStop(1, 'rgba(8,48,74,0.55)');
  ctx.fillStyle = fog;
  ctx.fillRect(0, h * 0.7, w, h * 0.3);
  ctx.restore();
}
