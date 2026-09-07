/**
 * P3-6 — zone medals, rank bookkeeping and skin unlocks: the pure rules in
 * src/client/unlocks.ts plus the record helpers in save.ts they lean on.
 */
import { describe, expect, it } from 'vitest';
import type { LevelDef, RunSummary } from '../../src/sim/types.js';
import type { LevelRecord, Progress, Settings } from '../../src/client/contracts.js';
import {
  AZURE_STARS, RANK_CAP, SKIN_RULES, anyRankAtLeast, availableSkins, betterRank, effectiveSkin, fmtWorldRank, maxMedals, maxStars,
  medalsFor, mergeMedals, newMedals, skinAvailable, skinHint, skinsUnlockedBy, syncUnlockedSkins, tierReached, totalMedals, totalStars,
  totalsText, worldRankText,
} from '../../src/client/unlocks.js';
import {
  bestComboOf, bestRankOf, clearWorldRank, defaultProgress, recordBestCombo, recordBestRank, setWorldRank, worldRankOf,
} from '../../src/client/save.js';
import { MEDAL_ORDER } from '../../src/client/ui/ceremony.js';
import { withPersonalRow } from '../../src/client/echo/rival.js';
import type { LeaderboardResponse, MeResponse } from '../../src/shared/protocol.js';

const ZONES: [string, LevelDef['biome']][] = [
  ['t1', 'tidepool'], ['t2', 'tidepool'], ['t3', 'tidepool'],
  ['s1', 'stormspire'], ['s2', 'stormspire'], ['s3', 'stormspire'],
  ['v1', 'voidreef'], ['v2', 'voidreef'], ['v3', 'voidreef'],
];
const LEVELS = ZONES.map(([id, biome], i) => ({ id, name: id, en: id, biome, par: 60, seed: i, rows: ['P.G', '###'] })) as LevelDef[];

function summary(over: Partial<RunSummary> = {}): RunSummary {
  return {
    levelId: 't1', cleared: true, ticks: 4800, time: 40, shards: 11, totalShards: 11, relics: 1, totalRelics: 1,
    deaths: 0, par: 45, rank: 'S', height: 0, ...over,
  };
}

function rec(over: Partial<LevelRecord> = {}): LevelRecord {
  return { done: true, bestTicks: 5000, bestShards: 5, stars: 1, relics: 0, deaths: 3, ...over };
}

function progress(levels: Record<string, LevelRecord>, extra: Partial<Progress> = {}): Progress {
  return { ...defaultProgress('abcdefgh-1234'), levels, ...extra };
}

const settings = (skin: string): Pick<Settings, 'skin'> => ({ skin });

describe('unlocks · medals', () => {
  it('medalsFor: a perfect clear earns all four; each rule is independent; an unfinished run earns none', () => {
    expect(medalsFor(summary())).toEqual(['nodeath', 'par', 'shards', 'relic']);
    expect(medalsFor(summary({ deaths: 1 }))).toEqual(['par', 'shards', 'relic']);
    expect(medalsFor(summary({ time: 45.01 }))).toEqual(['nodeath', 'shards', 'relic']);
    expect(medalsFor(summary({ time: 45 }))).toContain('par');           // exactly par is inside par
    expect(medalsFor(summary({ shards: 10 }))).toEqual(['nodeath', 'par', 'relic']);
    expect(medalsFor(summary({ shards: 0, totalShards: 0 }))).not.toContain('shards');   // a zone without shards has no shard medal
    expect(medalsFor(summary({ relics: 0 }))).toEqual(['nodeath', 'par', 'shards']);
    expect(medalsFor(summary({ cleared: false }))).toEqual([]);
  });

  it('mergeMedals never loses an earned medal, orders and dedupes, drops junk; newMedals names only the additions', () => {
    expect(mergeMedals(['relic', 'bogus'], ['nodeath'])).toEqual(['nodeath', 'relic']);
    expect(mergeMedals(undefined, ['par', 'par'])).toEqual(['par']);
    expect(mergeMedals(['par', 'shards', 'nodeath', 'relic'], [])).toEqual([...MEDAL_ORDER]);
    expect(newMedals(['par'], ['par', 'relic'])).toEqual(['relic']);
    expect(newMedals(undefined, ['shards', 'nodeath'])).toEqual(['nodeath', 'shards']);
    expect(newMedals(['nodeath', 'par', 'shards', 'relic'], ['nodeath'])).toEqual([]);
  });

  it('totals count stars (capped at 3) and known medals over the zone list; the denominators are LEVELS × 3 and × 4', () => {
    const p = progress({
      t1: rec({ stars: 3, medals: ['nodeath', 'par'] }),
      t2: rec({ stars: 7, medals: ['bogus', 'relic', 'relic'] }),
      zz: rec({ stars: 3, medals: ['par'] }),   // not a story zone: ignored
    });
    expect(totalStars(p, LEVELS)).toBe(6);
    expect(totalMedals(p, LEVELS)).toBe(3);
    expect(maxStars(LEVELS)).toBe(27);
    expect(maxMedals(LEVELS)).toBe(36);
    expect(totalsText(p, LEVELS)).toBe('별 6/27 · 메달 3/36');
    // a fourth zone per tier widens both denominators automatically
    const wider = [...LEVELS, { ...LEVELS[0], id: 't4' }, { ...LEVELS[3], id: 's4' }, { ...LEVELS[6], id: 'v4' }];
    expect(maxStars(wider)).toBe(36);
    expect(maxMedals(wider)).toBe(48);
  });
});

describe('unlocks · rank · combo · world rank (save.ts record helpers)', () => {
  it('betterRank / recordBestRank keep the better letter (S > A > B > C) and report improvements', () => {
    expect(betterRank('A', 'S')).toBe('S');
    expect(betterRank('B', 'C')).toBe('B');
    expect(betterRank(null, 'C')).toBe('C');
    expect(betterRank(undefined, undefined)).toBeNull();
    const r = rec();
    expect(bestRankOf(r)).toBeNull();
    expect(recordBestRank(r, 'B')).toBe(true);
    expect(recordBestRank(r, 'C')).toBe(false);
    expect(recordBestRank(r, 'B')).toBe(false);
    expect(recordBestRank(r, 'S')).toBe(true);
    expect(bestRankOf(r)).toBe('S');
    expect(anyRankAtLeast(progress({ t1: r }), 'S')).toBe(true);
    expect(anyRankAtLeast(progress({ t1: rec({ bestRank: 'A' } as Partial<LevelRecord>) }), 'S')).toBe(false);
    expect(anyRankAtLeast(progress({}), 'C')).toBe(false);
  });

  it('recordBestCombo keeps the longer whole combo (a first combo counts); junk reads as 0', () => {
    const r = rec();
    expect(bestComboOf(r)).toBe(0);
    expect(recordBestCombo(r, 0)).toBe(false);
    expect(recordBestCombo(r, 5.9)).toBe(true);
    expect(bestComboOf(r)).toBe(5);
    expect(recordBestCombo(r, 5)).toBe(false);
    expect(recordBestCombo(r, 8)).toBe(true);
    expect(bestComboOf({ ...r, bestCombo: 'x' } as unknown as LevelRecord)).toBe(0);
  });

  it('world rank: stored whole, cleared when the best changes, formatted with the 1000위 밖 cap', () => {
    const r = rec();
    expect(worldRankOf(r)).toBeUndefined();
    expect(setWorldRank(r, 12.7)).toBe(true);
    expect(worldRankOf(r)).toBe(12);
    expect(setWorldRank(r, 12)).toBe(false);
    expect(setWorldRank(r, 0)).toBe(false);
    clearWorldRank(r);
    expect(worldRankOf(r)).toBeUndefined();
    expect(fmtWorldRank(1)).toBe('1위');
    expect(fmtWorldRank(RANK_CAP)).toBe('1,000위');
    expect(fmtWorldRank(RANK_CAP + 1)).toBe('1,000위 밖');
    expect(fmtWorldRank(0)).toBe('—');
    expect(worldRankText(7)).toBe('세계 7위');
  });
});

describe('unlocks · skins', () => {
  it('rule table: clawd free · azure at 6 stars (5 is not enough) · ember when a storm zone is open · void at the first S', () => {
    expect(SKIN_RULES.map((r) => r.id)).toEqual(['clawd', 'azure', 'ember', 'void']);
    expect(AZURE_STARS).toBe(6);
    const five = progress({ t1: rec({ stars: 3 }), t2: rec({ stars: 2 }) });
    const six = progress({ t1: rec({ stars: 3 }), t2: rec({ stars: 3 }) });
    expect(skinsUnlockedBy(five, LEVELS)).toEqual(['clawd']);
    expect(skinsUnlockedBy(six, LEVELS)).toEqual(['clawd', 'azure']);
    // ember: t3 cleared opens s1 (the storm tier is reached); t2 cleared alone does not
    expect(tierReached(LEVELS, progress({ t1: rec(), t2: rec() }), 'stormspire')).toBe(false);
    const storm = progress({ t1: rec({ stars: 1 }), t2: rec({ stars: 1 }), t3: rec({ stars: 1 }) });
    expect(tierReached(LEVELS, storm, 'stormspire')).toBe(true);
    expect(skinsUnlockedBy(storm, LEVELS)).toEqual(['clawd', 'ember']);
    // void: any zone record with an S
    const s = progress({ t1: rec({ stars: 1, bestRank: 'S' } as Partial<LevelRecord>) });
    expect(skinsUnlockedBy(s, LEVELS)).toEqual(['clawd', 'void']);
    expect(skinHint('azure')).toBe('별 6개');
    expect(skinHint('ember')).toBe('2층 진입');
    expect(skinHint('void')).toBe('첫 S 등급');
    expect(skinHint('clawd')).toBeNull();
    expect(skinHint('nope')).toBeNull();
  });

  it('availableSkins: rules ∪ Progress.unlockedSkins ∪ the selected skin (grandfathering); effectiveSkin falls back to clawd', () => {
    const none = progress({});
    expect([...availableSkins(none, settings('clawd'), LEVELS)]).toEqual(['clawd']);
    expect(skinAvailable('void', none, settings('clawd'), LEVELS)).toBe(false);
    // a save that already wears void keeps it whatever the rules say
    expect(skinAvailable('void', none, settings('void'), LEVELS)).toBe(true);
    expect(effectiveSkin(none, settings('void'), LEVELS)).toBe('void');
    // a recorded unlock survives a rule that would no longer grant it
    const kept = progress({}, { unlockedSkins: ['ember', 'not a skin!'] });
    expect([...availableSkins(kept, settings('clawd'), LEVELS)]).toEqual(['clawd', 'ember']);
    // no progress yet (the picker built before the save arrived): only the free skin and the selected one
    expect([...availableSkins(null, settings('azure'), LEVELS)]).toEqual(['clawd', 'azure']);
    expect(effectiveSkin(null, settings('ember'), LEVELS)).toBe('ember');
    expect(effectiveSkin(none, { skin: '' }, LEVELS)).toBe('clawd');
  });

  it('syncUnlockedSkins records the rules once and returns only the additions', () => {
    const p = progress({ t1: rec({ stars: 3 }), t2: rec({ stars: 3 }) });
    expect(syncUnlockedSkins(p, LEVELS)).toEqual(['azure']);
    expect(p.unlockedSkins).toEqual(['azure']);
    expect(syncUnlockedSkins(p, LEVELS)).toEqual([]);
    p.levels.t3 = rec({ stars: 0, bestRank: 'S' } as Partial<LevelRecord>);
    expect(syncUnlockedSkins(p, LEVELS)).toEqual(['ember', 'void']);
    expect(p.unlockedSkins).toEqual(['azure', 'ember', 'void']);
    // junk in the stored list is dropped on the way
    const junk = progress({}, { unlockedSkins: ['azure', 'BAD id', 'azure'] });
    expect(syncUnlockedSkins(junk, LEVELS)).toEqual([]);
    expect(junk.unlockedSkins).toEqual(['azure', 'BAD id', 'azure']);   // untouched without additions
    junk.levels.t1 = rec({ stars: 0, bestRank: 'S' } as Partial<LevelRecord>);
    expect(syncUnlockedSkins(junk, LEVELS)).toEqual(['void']);
    expect(junk.unlockedSkins).toEqual(['azure', 'void']);
  });
});

describe('withPersonalRow (public page + /api/me)', () => {
  const entry = (rank: number, runId: string, tag: string): LeaderboardResponse['entries'][number] => ({
    rank, runId, playerTag: tag.padStart(12, '0'), you: false, name: `p${rank}`, score: 4000 + rank, ticks: 4000 + rank, shards: 5, deaths: 0,
    cleared: true, height: 0, createdAt: '2026-09-06T00:00:00.000Z',
  });
  const page: LeaderboardResponse = { mode: 'story', board: 't1', total: 40, entries: [entry(1, 'r1', 'a'), entry(2, 'r2', 'b'), entry(3, 'r3', 'c')] };

  it('flags the entry sharing our run id (or tag) as `you`, sets `yours`, and takes the larger total', () => {
    const me: MeResponse = { mode: 'story', board: 't1', total: 41, yours: { ...entry(2, 'r2', 'b'), you: false } };
    const out = withPersonalRow(page, me);
    expect(out.entries.map((e) => e.you)).toEqual([false, true, false]);
    expect(out.yours).toMatchObject({ rank: 2, runId: 'r2', you: true });
    expect(out.total).toBe(41);
    // our row is outside the page: nothing flagged, yours still set (the table appends the gap row)
    const far: MeResponse = { mode: 'story', board: 't1', total: 40, yours: { ...entry(30, 'r30', 'z'), you: false }, rankCapped: false };
    const out2 = withPersonalRow(page, far);
    expect(out2.entries.every((e) => !e.you)).toBe(true);
    expect(out2.yours?.rank).toBe(30);
  });

  it('without a personal row, or for another board, the page comes back as it was (stale `you` flags cleared)', () => {
    expect(withPersonalRow(page, null)).toBe(page);
    expect(withPersonalRow(page, { mode: 'story', board: 't2', total: 3 })).toBe(page);
    const stale = { ...page, entries: [{ ...page.entries[0], you: true }, page.entries[1]] };
    const out = withPersonalRow(stale, { mode: 'story', board: 't1', total: 40 });
    expect(out.entries.map((e) => e.you)).toEqual([false, false]);
    expect(out.yours).toBeUndefined();
  });
});
