/**
 * P3-6 — zone medals, rank bookkeeping and skin unlocks: the pure rules in
 * src/client/unlocks.ts plus the record helpers in save.ts they lean on.
 */
import { describe, expect, it } from 'vitest';
import type { LevelDef, RunSummary } from '../../src/sim/types.js';
import type { LevelRecord, Progress, Settings } from '../../src/client/contracts.js';
import {
  AZURE_STARS, CORAL_MEDALS, FROST_TIER, NOVA_S_RANKS, RANK_CAP, SKIN_RULES, allZonesDone, anyRankAtLeast, availableSkins, betterRank,
  countRankAtLeast, effectiveSkin, fmtWorldRank, maxMedals, maxStars, medalsFor, mergeMedals, newMedals, skinAvailable, skinHint,
  skinsUnlockedBy, syncUnlockedSkins, tierReached, totalMedals, totalStars, totalsText, worldRankText,
} from '../../src/client/unlocks.js';
import { BIOME_ORDER } from '../../src/shared/biomes.js';
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
  it('makes cat, rabbit and robot available before progress or settings arrive', () => {
    expect([...availableSkins(null, null, [])]).toEqual(['clawd', 'rabbit', 'robot']);
    for (const id of ['clawd', 'rabbit', 'robot']) {
      expect(skinAvailable(id, null, settings('clawd'), LEVELS)).toBe(true);
      expect(skinHint(id, LEVELS)).toBeNull();
    }
  });

  it('offers only the three starters on a fresh save without awarding progress', () => {
    const p = progress({});
    const before = structuredClone(p);
    expect(skinsUnlockedBy(p, LEVELS)).toEqual(['clawd', 'rabbit', 'robot']);
    expect([...availableSkins(p, settings('clawd'), LEVELS)]).toEqual(['clawd', 'rabbit', 'robot']);
    expect(p).toEqual(before);
  });

  it('adds starters to a legacy save while retaining its selected and owned ids', () => {
    const p = progress({}, { unlockedSkins: ['azure', 'coral', 'legacy_skin'] });
    const s = settings('nova');
    const before = structuredClone({ p, s });
    expect([...availableSkins(p, s, LEVELS)]).toEqual([
      'clawd', 'rabbit', 'robot', 'azure', 'coral', 'legacy_skin', 'nova',
    ]);
    expect(effectiveSkin(p, s, LEVELS)).toBe('nova');
    expect({ p, s }).toEqual(before);
  });

  it.each<{ stage: string; records: Record<string, LevelRecord> }>([
    { stage: 'at boot', records: {} },
    { stage: 'after the first clear', records: { t1: Object.assign(rec({ stars: 2, medals: ['par'] }), { bestRank: 'A' }) } },
  ])('never records or announces free starters $stage', ({ records }) => {
    const p = progress(records);
    expect(skinsUnlockedBy(p, LEVELS)).toEqual(['clawd', 'rabbit', 'robot']);
    const before = structuredClone(p);
    expect(syncUnlockedSkins(p, LEVELS)).toEqual([]);
    expect(syncUnlockedSkins(p, LEVELS)).toEqual([]);
    expect(p.unlockedSkins).toBeUndefined();
    expect(p).toEqual(before);
  });

  it('rule table: three free starters · azure at 6 stars (5 is not enough) · ember when a storm zone is open · void at the first S', () => {
    expect(SKIN_RULES.map((r) => r.id)).toEqual(['clawd', 'rabbit', 'robot', 'azure', 'ember', 'void', 'coral', 'frost', 'gold', 'nova']);
    expect(AZURE_STARS).toBe(6);
    const five = progress({ t1: rec({ stars: 3 }), t2: rec({ stars: 2 }) });
    const six = progress({ t1: rec({ stars: 3 }), t2: rec({ stars: 3 }) });
    expect(skinsUnlockedBy(five, LEVELS)).toEqual(['clawd', 'rabbit', 'robot']);
    expect(skinsUnlockedBy(six, LEVELS)).toEqual(['clawd', 'rabbit', 'robot', 'azure']);
    // ember: t3 cleared opens s1 (the storm tier is reached); t2 cleared alone does not
    expect(tierReached(LEVELS, progress({ t1: rec(), t2: rec() }), 'stormspire')).toBe(false);
    const storm = progress({ t1: rec({ stars: 1 }), t2: rec({ stars: 1 }), t3: rec({ stars: 1 }) });
    expect(tierReached(LEVELS, storm, 'stormspire')).toBe(true);
    expect(skinsUnlockedBy(storm, LEVELS)).toEqual(['clawd', 'rabbit', 'robot', 'ember']);
    // void: any zone record with an S
    const s = progress({ t1: rec({ stars: 1, bestRank: 'S' } as Partial<LevelRecord>) });
    expect(skinsUnlockedBy(s, LEVELS)).toEqual(['clawd', 'rabbit', 'robot', 'void']);
    expect(skinHint('azure')).toBe('별 6개');
    expect(skinHint('ember')).toBe('2층 진입');
    expect(skinHint('void')).toBe('첫 S 등급');
    expect(skinHint('clawd')).toBeNull();
    expect(skinHint('nope')).toBeNull();
  });

  it('availableSkins: rules ∪ Progress.unlockedSkins ∪ the selected skin (grandfathering); effectiveSkin falls back to clawd', () => {
    const none = progress({});
    expect([...availableSkins(none, settings('clawd'), LEVELS)]).toEqual(['clawd', 'rabbit', 'robot']);
    expect(skinAvailable('void', none, settings('clawd'), LEVELS)).toBe(false);
    // a save that already wears void keeps it whatever the rules say
    expect(skinAvailable('void', none, settings('void'), LEVELS)).toBe(true);
    expect(effectiveSkin(none, settings('void'), LEVELS)).toBe('void');
    // a recorded unlock survives a rule that would no longer grant it
    const kept = progress({}, { unlockedSkins: ['ember', 'not a skin!'] });
    expect([...availableSkins(kept, settings('clawd'), LEVELS)]).toEqual(['clawd', 'rabbit', 'robot', 'ember']);
    // no progress yet (the picker built before the save arrived): the starters and the selected one
    expect([...availableSkins(null, settings('azure'), LEVELS)]).toEqual(['clawd', 'rabbit', 'robot', 'azure']);
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

// ================================================================ P5-2 · the four costume skins
describe('unlocks · Phase 5 skins: coral · frost · gold · nova (P5-2)', () => {
  /** The full tower once the summit lands: four zones per tier, the summit last. */
  const ZONES16: [string, LevelDef['biome']][] = [
    ['t1', 'tidepool'], ['t2', 'tidepool'], ['t3', 'tidepool'], ['t4', 'tidepool'],
    ['s1', 'stormspire'], ['s2', 'stormspire'], ['s3', 'stormspire'], ['s4', 'stormspire'],
    ['v1', 'voidreef'], ['v2', 'voidreef'], ['v3', 'voidreef'], ['v4', 'voidreef'],
    ['m1', 'summit'], ['m2', 'summit'], ['m3', 'summit'], ['m4', 'summit'],
  ];
  const LEVELS16 = ZONES16.map(([id, biome], i) => ({ id, name: id, en: id, biome, par: 60, seed: i, rows: ['P.G', '###'] })) as LevelDef[];
  /** The shipped tower: no summit zone yet. */
  const LEVELS12 = LEVELS16.slice(0, 12);
  const ALL4 = ['nodeath', 'par', 'shards', 'relic'] as const;
  const doneAll = (levels: LevelDef[], extra: Partial<LevelRecord> = {}) =>
    progress(Object.fromEntries(levels.map((l) => [l.id, rec({ stars: 1, ...extra })])));

  it('coral opens at CORAL_MEDALS medals across the tower: 11 is not enough, 12 is; junk medals do not count', () => {
    expect(CORAL_MEDALS).toBe(12);
    const eleven = progress({ t1: rec({ medals: [...ALL4] }), t2: rec({ medals: [...ALL4] }), t3: rec({ medals: ['nodeath', 'par', 'shards'] }) });
    const twelve = progress({ t1: rec({ medals: [...ALL4] }), t2: rec({ medals: [...ALL4] }), t3: rec({ medals: [...ALL4] }) });
    const junk = progress({ t1: rec({ medals: [...ALL4] }), t2: rec({ medals: [...ALL4] }), t3: rec({ medals: ['nodeath', 'par', 'shards', 'bogus'] }) });
    expect(totalMedals(eleven, LEVELS12)).toBe(11);
    expect(skinsUnlockedBy(eleven, LEVELS12)).not.toContain('coral');
    expect(skinsUnlockedBy(twelve, LEVELS12)).toContain('coral');
    expect(skinsUnlockedBy(junk, LEVELS12)).not.toContain('coral');
    expect(skinHint('coral')).toBe('메달 12개');
  });

  it('nova opens at NOVA_S_RANKS zones ranked S: two S (and any number of A) is not enough, three is; void still opens at the first', () => {
    expect(NOVA_S_RANKS).toBe(3);
    const S = (id: string) => [id, rec({ bestRank: 'S' } as Partial<LevelRecord>)] as const;
    const two = progress({ ...Object.fromEntries([S('t1'), S('t2')]), t3: rec({ bestRank: 'A' } as Partial<LevelRecord>), t4: rec({ bestRank: 'A' } as Partial<LevelRecord>) });
    const three = progress(Object.fromEntries([S('t1'), S('t2'), S('s1')]));
    expect(countRankAtLeast(two, 'S')).toBe(2);
    expect(countRankAtLeast(two, 'A')).toBe(4);
    expect(skinsUnlockedBy(two, LEVELS12)).toContain('void');
    expect(skinsUnlockedBy(two, LEVELS12)).not.toContain('nova');
    expect(skinsUnlockedBy(three, LEVELS12)).toContain('nova');
    expect(skinHint('nova')).toBe('S 등급 3개');
  });

  it('gold opens when every story zone is done: 15 of 16 is not enough, 16 is; the hint counts the zones it is given', () => {
    const fifteen = doneAll(LEVELS16.slice(0, 15));
    const sixteen = doneAll(LEVELS16);
    expect(allZonesDone(fifteen, LEVELS16)).toBe(false);
    expect(allZonesDone(sixteen, LEVELS16)).toBe(true);
    expect(allZonesDone(sixteen, [])).toBe(false);
    expect(skinsUnlockedBy(fifteen, LEVELS16)).not.toContain('gold');
    expect(skinsUnlockedBy(sixteen, LEVELS16)).toContain('gold');
    // the rule follows the zone list it is given: the shipped 12-zone tower fully done opens gold too
    expect(skinsUnlockedBy(doneAll(LEVELS12), LEVELS12)).toContain('gold');
    expect(skinsUnlockedBy(doneAll(LEVELS12), LEVELS16)).not.toContain('gold');
    // a zone recorded but not done does not count
    const almost = doneAll(LEVELS16);
    almost.levels.m4 = rec({ done: false });
    expect(skinsUnlockedBy(almost, LEVELS16)).not.toContain('gold');
    expect(skinHint('gold')).toBe('모든 구역 클리어');
    expect(skinHint('gold', LEVELS16)).toBe('16구역 전부 클리어');
    expect(skinHint('gold', LEVELS12)).toBe('12구역 전부 클리어');
    expect(skinHint('gold', [])).toBe('모든 구역 클리어');
    // the other hints ignore the zone list
    expect(skinHint('azure', LEVELS16)).toBe('별 6개');
    expect(skinHint('clawd', LEVELS16)).toBeNull();
  });

  it('frost opens when the summit tier is reached (a summit zone open); it is inert while the tower has no summit zone', () => {
    expect(FROST_TIER).toBe('summit');
    expect(BIOME_ORDER.length >= 4 ? BIOME_ORDER[3] : 'summit').toBe('summit');
    // v4 done opens m1 (the first summit zone): the tier is reached
    const v4 = doneAll(LEVELS16.slice(0, 12));
    expect(tierReached(LEVELS16, v4, 'summit')).toBe(true);
    expect(skinsUnlockedBy(v4, LEVELS16)).toContain('frost');
    // v3 done alone does not cross the tier boundary (no skip into a new tier)
    const v3 = doneAll(LEVELS16.slice(0, 11));
    expect(tierReached(LEVELS16, v3, 'summit')).toBe(false);
    expect(skinsUnlockedBy(v3, LEVELS16)).not.toContain('frost');
    // the shipped tower: everything done, still no summit zone to open → frost stays locked
    const shipped = doneAll(LEVELS12, { medals: [...ALL4], bestRank: 'S' } as Partial<LevelRecord>);
    expect(skinsUnlockedBy(shipped, LEVELS12)).toEqual(['clawd', 'rabbit', 'robot', 'azure', 'ember', 'void', 'coral', 'gold', 'nova']);
    expect(skinHint('frost')).toBe('4층 진입');
  });

  it('syncUnlockedSkins records the Phase 5 skins with the old ones and announces each once; the picker treats them like any skin', () => {
    const p = doneAll(LEVELS16, { medals: [...ALL4], bestRank: 'S' } as Partial<LevelRecord>);
    expect(syncUnlockedSkins(p, LEVELS16)).toEqual(['azure', 'ember', 'void', 'coral', 'frost', 'gold', 'nova']);
    expect(syncUnlockedSkins(p, LEVELS16)).toEqual([]);
    expect(p.unlockedSkins).toEqual(['azure', 'ember', 'void', 'coral', 'frost', 'gold', 'nova']);
    expect([...availableSkins(progress({}), settings('clawd'), LEVELS16)]).toEqual(['clawd', 'rabbit', 'robot']);
    expect(skinAvailable('gold', progress({}), settings('gold'), LEVELS16)).toBe(true);   // grandfathered
    expect(effectiveSkin(progress({}, { unlockedSkins: ['nova'] }), settings('nova'), LEVELS16)).toBe('nova');
    expect(effectiveSkin(progress({}), settings('frost'), LEVELS16)).toBe('frost');
    expect(effectiveSkin(null, settings('coral'), LEVELS16)).toBe('coral');
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
