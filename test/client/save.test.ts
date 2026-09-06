/**
 * Save-layer rules added in Phase 1: stored echo masks are tied to the
 * SIM_VERSION that recorded them (a stale or unversioned replay is dropped
 * while the record's times / stars / run id survive), and the anonymous
 * retention inputs — firstSeen, playDays, lastPlayDay — are maintained per UTC
 * day at boot and turned into the coarse buckets the boot event carries.
 */
import { describe, expect, it } from 'vitest';
import { SIM_VERSION } from '../../src/sim/types.js';
import type { Progress } from '../../src/client/contracts.js';
import type { LevelDef } from '../../src/sim/types.js';
import {
  DEFAULT_ECHO_WORLD_MODE, DEFAULT_NAME, PROGRESS_KEY, SETTINGS_KEY, Save, daysBucket, defaultLevelRecord, defaultProgress,
  defaultSettings, echoMasks, echoWorldMode, fallbackName, isValidName, markEcho, recordSegmentBest, repairProgress,
  retentionBuckets, segmentBests, setEchoWorldMode, streakFor, touchPlayDay, unlockedZones, type StorageLike,
} from '../../src/client/save.js';

class MemStorage implements StorageLike {
  readonly map = new Map<string, string>();
  getItem(k: string): string | null { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string): void { this.map.set(k, v); }
  removeItem(k: string): void { this.map.delete(k); }
}

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 6, 12); // 2026-09-06 12:00Z

function stored(progress: unknown): Save {
  const storage = new MemStorage();
  storage.setItem(PROGRESS_KEY, JSON.stringify(progress));
  return new Save({ storage, schedule: () => 0, cancel: () => {} });
}

describe('repairProgress · echo masks are versioned', () => {
  it('drops v1 (unversioned) masks from an old Progress but keeps time, stars and the run id', () => {
    const save = stored({
      v: 1,
      levels: { t1: { done: true, bestTicks: 5400, bestShards: 12, stars: 2, relics: 1, deaths: 3, runId: 'run-9', masks: 'AAEA' } },
      daily: { '2026-09-05': { bestTicks: 7000, cleared: true, height: 0, seed: 7, runId: 'run-d', masks: 'AAEA' } },
    });
    const t1 = save.progress.levels.t1;
    expect(t1.masks).toBeUndefined();
    expect(t1.done).toBe(true);
    expect(t1.bestTicks).toBe(5400);
    expect(t1.stars).toBe(2);
    expect(t1.runId).toBe('run-9');
    const d = save.progress.daily['2026-09-05'];
    expect(d.masks).toBeUndefined();
    expect(d.bestTicks).toBe(7000);
    expect(d.runId).toBe('run-d');
  });

  it('drops masks recorded under another SIM_VERSION and keeps those of the current one', () => {
    const save = stored({
      v: 1,
      levels: {
        t1: { done: true, bestTicks: 100, masks: 'AAEA', sim: SIM_VERSION - 1 },
        t2: { done: true, bestTicks: 200, masks: 'AAEA', sim: SIM_VERSION },
      },
      daily: {
        '2026-09-05': { bestTicks: 1, cleared: true, height: 0, seed: 1, masks: 'AAEA', sim: SIM_VERSION + 1 },
        '2026-09-06': { bestTicks: 2, cleared: true, height: 0, seed: 2, masks: 'AAEA', sim: SIM_VERSION },
      },
    });
    expect(save.progress.levels.t1.masks).toBeUndefined();
    expect(echoMasks(save.progress.levels.t1)).toBeUndefined();
    expect(save.progress.levels.t2.masks).toBe('AAEA');
    expect(echoMasks(save.progress.levels.t2)).toBe('AAEA');
    expect(save.progress.daily['2026-09-05'].masks).toBeUndefined();
    expect(save.progress.daily['2026-09-06'].masks).toBe('AAEA');
    expect(echoMasks(save.progress.daily['2026-09-06'])).toBe('AAEA');
  });

  it('markEcho stores the masks with the current version so the next boot keeps them', () => {
    const p = defaultProgress('abcdefghij');
    p.levels.t1 = { done: true, bestTicks: 10, bestShards: 0, stars: 1, relics: 0, deaths: 0 };
    markEcho(p.levels.t1, 'AAEA');
    expect(p.levels.t1.masks).toBe('AAEA');
    expect(echoMasks(p.levels.t1)).toBe('AAEA');
    const again = repairProgress(JSON.parse(JSON.stringify(p)), defaultProgress('abcdefghij'));
    expect(again.levels.t1.masks).toBe('AAEA');
    // a record whose masks were deleted no longer answers as an echo
    delete p.levels.t1.masks;
    expect(echoMasks(p.levels.t1)).toBeUndefined();
  });
});

describe('retention fields (firstSeen · playDays · lastPlayDay)', () => {
  it('a first boot seeds firstSeen and counts today as the first play day', () => {
    const p = defaultProgress('abcdefghij');
    expect(touchPlayDay(p, T0)).toBe(true);
    expect(p.firstSeen).toBe(T0);
    expect(p.playDays).toBe(1);
    expect(p.lastPlayDay).toBe('2026-09-06');
    // the same UTC day again changes nothing
    expect(touchPlayDay(p, T0 + 3 * 3_600_000)).toBe(false);
    expect(p.playDays).toBe(1);
    // the next UTC day counts once more, firstSeen stays
    expect(touchPlayDay(p, T0 + DAY)).toBe(true);
    expect(p.playDays).toBe(2);
    expect(p.lastPlayDay).toBe('2026-09-07');
    expect(p.firstSeen).toBe(T0);
  });

  it('buckets days as 0 / 1 / 2-6 / 7+ and derives both boot buckets from the progress', () => {
    expect(daysBucket(0)).toBe('0');
    expect(daysBucket(1)).toBe('1');
    expect(daysBucket(2)).toBe('2-6');
    expect(daysBucket(6)).toBe('2-6');
    expect(daysBucket(7)).toBe('7+');
    expect(daysBucket(400)).toBe('7+');
    const p = defaultProgress('abcdefghij');
    touchPlayDay(p, T0);
    expect(retentionBuckets(p, T0)).toEqual({ daysSinceFirstSeen: '0', daysPlayedBucket: '1' });
    // D1: the next UTC day (even 13 hours later across midnight)
    expect(retentionBuckets(p, T0 + 13 * 3_600_000).daysSinceFirstSeen).toBe('1');
    for (let d = 1; d <= 8; d++) touchPlayDay(p, T0 + d * DAY);
    expect(retentionBuckets(p, T0 + 8 * DAY)).toEqual({ daysSinceFirstSeen: '7+', daysPlayedBucket: '7+' });
    // no firstSeen at all reads as day 0
    expect(retentionBuckets(defaultProgress('abcdefghij'), T0).daysSinceFirstSeen).toBe('0');
  });

  it('Save.touchPlayDay persists the fields and repairProgress accepts only sane values', () => {
    const storage = new MemStorage();
    const save = new Save({ storage, schedule: (fn) => { fn(); return 0; }, cancel: () => {} });
    save.touchPlayDay(T0);
    const raw = JSON.parse(storage.getItem(PROGRESS_KEY)!) as Progress;
    expect(raw.firstSeen).toBe(T0);
    expect(raw.playDays).toBe(1);
    expect(raw.lastPlayDay).toBe('2026-09-06');
    const bad = repairProgress({ v: 1, firstSeen: 'yesterday', playDays: -3, lastPlayDay: 'not a date' }, defaultProgress('abcdefghij'));
    expect(bad.firstSeen).toBeUndefined();
    expect(bad.playDays).toBe(0);
    expect(bad.lastPlayDay).toBeUndefined();
    const ok = repairProgress({ v: 1, firstSeen: T0, playDays: 3.7, lastPlayDay: '2026-09-06' }, defaultProgress('abcdefghij'));
    expect(ok.firstSeen).toBe(T0);
    expect(ok.playDays).toBe(3);
    expect(ok.lastPlayDay).toBe('2026-09-06');
  });
});

// ---------------------------------------------------------------- P2-3 daily streak
describe('streakFor (daily streak)', () => {
  const rec = (date: string, cleared = false) => [date, { bestTicks: cleared ? 4000 : 0, cleared, height: 12, seed: 1 }] as const;
  const daily = (...dates: readonly (readonly [string, unknown])[]) => Object.fromEntries(dates);

  it('counts consecutive UTC days ending today (any attempt is a 도전)', () => {
    expect(streakFor(daily(rec('2026-09-04'), rec('2026-09-05', true), rec('2026-09-06')), '2026-09-06')).toBe(3);
    expect(streakFor(daily(rec('2026-09-06')), '2026-09-06')).toBe(1);
  });

  it('a streak ending yesterday still counts (today is not over); a gap breaks it', () => {
    expect(streakFor(daily(rec('2026-09-03'), rec('2026-09-04'), rec('2026-09-05')), '2026-09-06')).toBe(3);
    // today and two days ago, nothing yesterday → only today counts
    expect(streakFor(daily(rec('2026-09-04'), rec('2026-09-06')), '2026-09-06')).toBe(1);
    // the last attempt was two days ago: the streak is over
    expect(streakFor(daily(rec('2026-09-03'), rec('2026-09-04')), '2026-09-06')).toBe(0);
  });

  it('ignores dates after the server date, junk keys and empty saves', () => {
    expect(streakFor(daily(rec('2026-09-07'), rec('2026-09-08')), '2026-09-06')).toBe(0);
    expect(streakFor(daily(rec('2026-09-06'), rec('2026-09-07'), rec('2026-09-09')), '2026-09-06')).toBe(1);
    expect(streakFor({}, '2026-09-06')).toBe(0);
    expect(streakFor(daily(rec('2026-09-06')), 'not-a-date')).toBe(0);
    // month and year boundaries are plain UTC arithmetic
    expect(streakFor(daily(rec('2026-12-31'), rec('2027-01-01')), '2027-01-01')).toBe(2);
  });
});

// ---------------------------------------------------------------- P2-5 fallback name
describe('fallbackName', () => {
  it('is the default name plus four hex digits, stable per id, distinct across ids and a valid board name', () => {
    const a = fallbackName('abcdefgh-1234');
    expect(a).toMatch(/^클로드 #[0-9a-f]{4}$/);
    expect(a.startsWith(`${DEFAULT_NAME} #`)).toBe(true);
    expect(fallbackName('abcdefgh-1234')).toBe(a);
    expect(fallbackName('abcdefgh-1235')).not.toBe(a);
    expect([...a].length).toBeLessThanOrEqual(12);
    expect(isValidName(a)).toBe(true);
  });
});

// ---------------------------------------------------------------- P2-6 two-zone unlock
describe('unlockedZones', () => {
  const zones: Pick<LevelDef, 'id' | 'biome'>[] = [
    { id: 't1', biome: 'tidepool' }, { id: 't2', biome: 'tidepool' }, { id: 't3', biome: 'tidepool' },
    { id: 's1', biome: 'stormspire' }, { id: 's2', biome: 'stormspire' }, { id: 's3', biome: 'stormspire' },
    { id: 'v1', biome: 'voidreef' }, { id: 'v2', biome: 'voidreef' }, { id: 'v3', biome: 'voidreef' },
  ];
  const withDone = (...ids: string[]) => {
    const p = defaultProgress('abcdefghij');
    for (const id of ids) p.levels[id] = { done: true, bestTicks: 100, bestShards: 0, stars: 1, relics: 0, deaths: 0 };
    return p;
  };

  it('a fresh save opens the first zone only', () => {
    expect([...unlockedZones(zones, withDone())]).toEqual(['t1']);
  });

  it('clearing zone N opens N+1 and N+2 within the tier; the next tier waits for the previous zone', () => {
    expect([...unlockedZones(zones, withDone('t1'))].sort()).toEqual(['t1', 't2', 't3']);
    // t2 alone: t3 opens, but s1 (a tier's first zone) still needs t3 itself
    expect([...unlockedZones(zones, withDone('t2'))].sort()).toEqual(['t1', 't2', 't3']);
    expect([...unlockedZones(zones, withDone('t3'))].sort()).toEqual(['s1', 's2', 't1', 't3']);
    expect([...unlockedZones(zones, withDone('t1', 't2', 't3', 's3'))].sort()).toEqual(['s1', 's2', 's3', 't1', 't2', 't3', 'v1', 'v2']);
  });
});

// ---------------------------------------------------------------- P2-2 / P2-6 repair of the new fields
describe('repairProgress · endless best replay, daily rank, session deaths', () => {
  it('keeps the best endless replay only with the current SIM_VERSION and a seed', () => {
    const ok = stored({ v: 1, endless: { bestHeight: 40, bestShards: 3, runs: 2, bestMasks: 'AAEA', bestSeed: 777, bestSim: SIM_VERSION } });
    expect(ok.progress.endless).toEqual({ bestHeight: 40, bestShards: 3, runs: 2, bestMasks: 'AAEA', bestSeed: 777, bestSim: SIM_VERSION });
    const stale = stored({ v: 1, endless: { bestHeight: 40, bestShards: 3, runs: 2, bestMasks: 'AAEA', bestSeed: 777, bestSim: SIM_VERSION - 1 } });
    expect(stale.progress.endless).toEqual({ bestHeight: 40, bestShards: 3, runs: 2 });
    const noSeed = stored({ v: 1, endless: { bestHeight: 40, bestMasks: 'AAEA', bestSim: SIM_VERSION } });
    expect(noSeed.progress.endless.bestMasks).toBeUndefined();
  });

  it('keeps a positive daily rank and positive session deaths, drops junk', () => {
    const save = stored({
      v: 1,
      levels: { t1: { done: false, deaths: 30, sessionDeaths: 21 }, t2: { done: false, sessionDeaths: -4 }, t3: { sessionDeaths: 'many' } },
      daily: {
        '2026-09-05': { bestTicks: 7000, cleared: true, height: 0, seed: 7, rank: 12 },
        '2026-09-04': { bestTicks: 0, cleared: false, height: 3, seed: 6, rank: 0 },
      },
    });
    expect(save.progress.levels.t1.sessionDeaths).toBe(21);
    expect(save.progress.levels.t2.sessionDeaths).toBeUndefined();
    expect(save.progress.levels.t3.sessionDeaths).toBeUndefined();
    expect(save.progress.daily['2026-09-05'].rank).toBe(12);
    expect(save.progress.daily['2026-09-04'].rank).toBeUndefined();
  });
});

describe('P2-4 · 세계 메아리 mode and segment bests', () => {
  function withSettings(raw: unknown): Save {
    const storage = new MemStorage();
    storage.setItem(SETTINGS_KEY, JSON.stringify(raw));
    return new Save({ storage, schedule: () => 0, cancel: () => {} });
  }

  it('echoWorldMode defaults to rival, keeps top, drops junk, and round-trips through the save', () => {
    expect(DEFAULT_ECHO_WORLD_MODE).toBe('rival');
    expect(echoWorldMode(defaultSettings())).toBe('rival');
    expect(echoWorldMode(withSettings({ v: 1, echoWorldMode: 'top' }).settings)).toBe('top');
    expect(echoWorldMode(withSettings({ v: 1, echoWorldMode: 'median' }).settings)).toBe('rival');
    expect(echoWorldMode(withSettings({ v: 1 }).settings)).toBe('rival');
    // a pre-P2-4 Settings object without the field reads as the default through the accessor
    const bare = defaultSettings() as unknown as Record<string, unknown>;
    delete bare.echoWorldMode;
    expect(echoWorldMode(bare as unknown as ReturnType<typeof defaultSettings>)).toBe('rival');
    const storage = new MemStorage();
    const save = new Save({ storage, schedule: () => 0, cancel: () => {} });
    setEchoWorldMode(save.settings, 'top');
    save.flush();
    expect(JSON.parse(storage.getItem(SETTINGS_KEY)!).echoWorldMode).toBe('top');
    expect(echoWorldMode(new Save({ storage, schedule: () => 0, cancel: () => {} }).settings)).toBe('top');
  });

  it('recordSegmentBest keeps the faster whole-tick time per segment; repairLevelRecord sanitises segBest', () => {
    const rec = defaultLevelRecord();
    expect(segmentBests(rec)).toEqual([]);
    expect(recordSegmentBest(rec, 1, 900)).toBe(true);
    expect(segmentBests(rec)).toEqual([0, 900]);
    expect(recordSegmentBest(rec, 1, 950)).toBe(false);
    expect(recordSegmentBest(rec, 1, 850.7)).toBe(true);
    expect(segmentBests(rec)).toEqual([0, 850]);
    expect(recordSegmentBest(rec, 0, 0)).toBe(false);
    expect(recordSegmentBest(rec, -1, 10)).toBe(false);
    expect(recordSegmentBest(rec, 99, 10)).toBe(false);
    expect(recordSegmentBest(rec, 0.5, 10)).toBe(false);
    const save = stored({
      v: 1,
      levels: {
        ok: { done: true, bestTicks: 10, segBest: [120, 0, 300.9, -4, 'x'] },
        junk: { done: true, bestTicks: 10, segBest: 'nope' },
        zeros: { done: true, bestTicks: 10, segBest: [0, 0] },
        plain: { done: true, bestTicks: 10 },
      },
    });
    expect(segmentBests(save.progress.levels.ok)).toEqual([120, 0, 300, 0, 0]);
    expect(segmentBests(save.progress.levels.junk)).toEqual([]);
    expect('segBest' in save.progress.levels.junk).toBe(false);
    expect(segmentBests(save.progress.levels.zeros)).toEqual([]);
    expect(segmentBests(save.progress.levels.plain)).toEqual([]);
    // the other fields are untouched
    expect(save.progress.levels.ok.bestTicks).toBe(10);
  });
});
