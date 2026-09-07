/**
 * Zone medals, rank bookkeeping and skin unlocks (P3-6) — pure rules over a
 * finished run and the Progress document. No DOM, no timers, no I/O: the shell
 * (scenes.ts) applies these to the save, the UI (ui.ts / settings.ts) reads
 * them to paint medal slots, rank letters, totals and the skin picker.
 *
 * Medals per zone (LevelRecord.medals, unordered, never lost once earned):
 *   nodeath · a clear without a single death
 *   par     · a clear inside the zone's par time
 *   shards  · every shard of the zone collected on the clear
 *   relic   · the zone's relic collected on the clear
 *
 * Skins: 'clawd' is always there; 'azure' (AMAZONI / 아마조니) opens at
 * AZURE_STARS stars across the tower, 'ember' when the storm tier is reached
 * (any stormspire zone unlocked), 'void' at the first S rank. A skin already
 * selected in the settings stays available whatever the rules say
 * (grandfathering: a save that predates the rules keeps its look).
 */
import type { LevelDef, Rank, RunSummary } from '../sim/types.js';
import type { BiomeId } from '../sim/types.js';
import type { LevelRecord, Progress, Settings } from './contracts.js';
import { bestRankOf, unlockedZones } from './save.js';
import { MEDAL_ORDER, type MedalId } from './ui/ceremony.js';

// ---------------------------------------------------------------- medals
export const MEDALS_PER_ZONE = MEDAL_ORDER.length;
export const STARS_PER_ZONE = 3;

const MEDAL_SET: ReadonlySet<string> = new Set(MEDAL_ORDER);

export function isMedalId(v: unknown): v is MedalId {
  return typeof v === 'string' && MEDAL_SET.has(v);
}

/** The medals a finished run earns: none for an unfinished run. */
export function medalsFor(s: Pick<RunSummary, 'cleared' | 'deaths' | 'time' | 'par' | 'shards' | 'totalShards' | 'relics'>): MedalId[] {
  if (!s.cleared) return [];
  const out: MedalId[] = [];
  if (s.deaths === 0) out.push('nodeath');
  if (s.time <= s.par) out.push('par');
  if (s.totalShards > 0 && s.shards >= s.totalShards) out.push('shards');
  if (s.relics > 0) out.push('relic');
  return out;
}

/** Union of two medal lists in display order, unknown ids dropped. */
export function mergeMedals(existing: readonly string[] | undefined, earned: readonly string[]): MedalId[] {
  const have = new Set<string>([...(existing ?? []), ...earned]);
  return MEDAL_ORDER.filter((m) => have.has(m));
}

/** The medals of `earned` the record did not hold yet. */
export function newMedals(existing: readonly string[] | undefined, earned: readonly string[]): MedalId[] {
  const have = new Set<string>(existing ?? []);
  return MEDAL_ORDER.filter((m) => earned.includes(m) && !have.has(m));
}

// ---------------------------------------------------------------- ranks
/** Ranks from worst to best. */
export const RANK_ORDER: readonly Rank[] = ['C', 'B', 'A', 'S'];

export function isRank(v: unknown): v is Rank {
  return typeof v === 'string' && (RANK_ORDER as readonly string[]).includes(v);
}

/** The better of two ranks (null = none). */
export function betterRank(a: Rank | null | undefined, b: Rank | null | undefined): Rank | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return RANK_ORDER.indexOf(a) >= RANK_ORDER.indexOf(b) ? a : b;
}

// ---------------------------------------------------------------- totals
type Levels = readonly Pick<LevelDef, 'id' | 'biome'>[];
type Records = Pick<Progress, 'levels'>;

/** Stars earned across the story zones (each capped at STARS_PER_ZONE). */
export function totalStars(progress: Records, levels: Levels): number {
  let n = 0;
  for (const l of levels) n += Math.min(STARS_PER_ZONE, Math.max(0, (progress.levels[l.id]?.stars ?? 0) | 0));
  return n;
}

/** Medals earned across the story zones (known ids only, no duplicates). */
export function totalMedals(progress: Records, levels: Levels): number {
  let n = 0;
  for (const l of levels) n += mergeMedals(progress.levels[l.id]?.medals, []).length;
  return n;
}

/** The denominators of the select header: LEVELS × 3 stars, LEVELS × 4 medals — a new zone widens both automatically. */
export function maxStars(levels: Levels): number { return levels.length * STARS_PER_ZONE; }
export function maxMedals(levels: Levels): number { return levels.length * MEDALS_PER_ZONE; }

/** "별 N/36 · 메달 N/48" for the select header. */
export function totalsText(progress: Records, levels: Levels): string {
  return `별 ${totalStars(progress, levels)}/${maxStars(levels)} · 메달 ${totalMedals(progress, levels)}/${maxMedals(levels)}`;
}

/** Any zone of `biome` is open (the tier was reached). */
export function tierReached(levels: Levels, progress: Records, biome: BiomeId): boolean {
  const open = unlockedZones(levels, progress);
  return levels.some((l) => l.biome === biome && open.has(l.id));
}

/** Some zone record holds `rank` or better. */
export function anyRankAtLeast(progress: Records, rank: Rank): boolean {
  const min = RANK_ORDER.indexOf(rank);
  for (const rec of Object.values(progress.levels)) {
    const r = bestRankOf(rec as LevelRecord);
    if (r && RANK_ORDER.indexOf(r) >= min) return true;
  }
  return false;
}

// ---------------------------------------------------------------- skins
export type SkinId = 'clawd' | 'azure' | 'ember' | 'void';
export const DEFAULT_SKIN: SkinId = 'clawd';
/** Stars across the tower that open 'azure' (AMAZONI). */
export const AZURE_STARS = 6;
/** The tier whose reach opens 'ember'. */
export const EMBER_TIER: BiomeId = 'stormspire';

export interface SkinRule {
  id: SkinId;
  /** Korean unlock hint for the locked picker entry ('' for the free skin). */
  hint: string;
  unlocked(progress: Records, levels: Levels): boolean;
}

export const SKIN_RULES: readonly SkinRule[] = [
  { id: 'clawd', hint: '', unlocked: () => true },
  { id: 'azure', hint: `별 ${AZURE_STARS}개`, unlocked: (p, levels) => totalStars(p, levels) >= AZURE_STARS },
  { id: 'ember', hint: '2층 진입', unlocked: (p, levels) => tierReached(levels, p, EMBER_TIER) },
  { id: 'void', hint: '첫 S 등급', unlocked: (p) => anyRankAtLeast(p, 'S') },
];

const SKIN_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
export function isSkinId(v: unknown): v is string {
  return typeof v === 'string' && SKIN_ID_RE.test(v);
}

/** The unlock hint for a skin id, null for the free skin or an id without a rule. */
export function skinHint(id: string): string | null {
  const rule = SKIN_RULES.find((r) => r.id === id);
  return rule && rule.hint ? rule.hint : null;
}

/** Skins whose rule is met right now (rule order). */
export function skinsUnlockedBy(progress: Records, levels: Levels): SkinId[] {
  return SKIN_RULES.filter((r) => r.unlocked(progress, levels)).map((r) => r.id);
}

/**
 * Skins the player may pick: the free one, every skin the rules grant now,
 * every skin already recorded in Progress.unlockedSkins (a rule that later
 * tightens never takes a skin back), and the skin currently selected in the
 * settings (grandfathering).
 */
export function availableSkins(progress: Records & Pick<Progress, 'unlockedSkins'> | null, settings: Pick<Settings, 'skin'> | null, levels: Levels): Set<string> {
  const out = new Set<string>([DEFAULT_SKIN]);
  if (progress) {
    for (const id of skinsUnlockedBy(progress, levels)) out.add(id);
    for (const id of progress.unlockedSkins ?? []) if (isSkinId(id)) out.add(id);
  }
  if (settings && isSkinId(settings.skin)) out.add(settings.skin);
  return out;
}

export function skinAvailable(id: string, progress: Records & Pick<Progress, 'unlockedSkins'> | null, settings: Pick<Settings, 'skin'> | null, levels: Levels): boolean {
  return availableSkins(progress, settings, levels).has(id);
}

/**
 * Record every skin the rules grant now in Progress.unlockedSkins (mutated);
 * returns the ids that were not recorded before — the ones to announce.
 */
export function syncUnlockedSkins(progress: Records & Pick<Progress, 'unlockedSkins'>, levels: Levels): SkinId[] {
  const have = new Set<string>((progress.unlockedSkins ?? []).filter(isSkinId));
  const fresh: SkinId[] = [];
  for (const id of skinsUnlockedBy(progress, levels)) {
    if (id === DEFAULT_SKIN || have.has(id)) continue;
    have.add(id);
    fresh.push(id);
  }
  if (fresh.length) progress.unlockedSkins = [...new Set([...(progress.unlockedSkins ?? []).filter(isSkinId), ...fresh])];
  return fresh;
}

/** The skin to draw: the selected one when available, else the free one. */
export function effectiveSkin(progress: Records & Pick<Progress, 'unlockedSkins'> | null, settings: Pick<Settings, 'skin'>, levels: Levels): string {
  return skinAvailable(settings.skin, progress, settings, levels) ? settings.skin : DEFAULT_SKIN;
}

// ---------------------------------------------------------------- world rank
/** Ranks past this are reported by GET /api/me as capped (`rankCapped`, rank = RANK_CAP + 1): shown as "1000위 밖". */
export const RANK_CAP = 1000;

/** '12위' / '1000위 밖' — a rank past RANK_CAP was not counted to the end. */
export function fmtWorldRank(rank: number): string {
  if (!Number.isFinite(rank) || rank < 1) return '—';
  return rank > RANK_CAP ? `${RANK_CAP.toLocaleString('ko-KR')}위 밖` : `${Math.floor(rank).toLocaleString('ko-KR')}위`;
}

/** '세계 12위' — the card / result badge. */
export function worldRankText(rank: number): string {
  return `세계 ${fmtWorldRank(rank)}`;
}
