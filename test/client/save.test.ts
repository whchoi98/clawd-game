/**
 * Save-layer rules added in Phase 1: stored echo masks are tied to the
 * SIM_VERSION that recorded them (a stale or unversioned replay is dropped
 * while the record's times / stars / run id survive), and the anonymous
 * retention inputs — firstSeen, playDays, lastPlayDay — are maintained per UTC
 * day at boot and turned into the coarse buckets the boot event carries.
 */
import { describe, expect, it } from 'vitest';
import { GEN_VERSION, SIM_VERSION } from '../../src/sim/types.js';
import type { Progress, Settings } from '../../src/client/contracts.js';
import type { LevelDef } from '../../src/sim/types.js';
import { MAX_TRANSFER_BYTES, TransferCreateRequest, TransferGetResponse } from '../../src/shared/protocol.js';
import {
  DEFAULT_ECHO_WORLD_MODE, DEFAULT_NAME, DEFAULT_TOUCH, PROGRESS_KEY, SETTINGS_KEY, Save, TOUCH_LIMITS, TRANSFER_MARGIN_BYTES,
  UNMUTE_FALLBACK_MASTER, daysBucket, defaultLevelRecord,
  defaultProgress, defaultSettings, echoMasks, echoWorldMode, fallbackName, isMuted, isValidName, jsonBytes, markEcho, mergeProgress,
  recordSegmentBest, repairProgress, repairSettings, repairTouch, retentionBuckets, segmentBests, setEchoWorldMode, snapshotProgress, streakFor,
  toggleMute, touchLayout, touchPlayDay, unlockedZones, type MuteExtra, type StorageLike, type TouchLayout,
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
  it('keeps the best endless replay only with the current SIM_VERSION, GEN_VERSION and a seed', () => {
    const ok = stored({ v: 1, endless: { bestHeight: 40, bestShards: 3, runs: 2, bestMasks: 'AAEA', bestSeed: 777, bestSim: SIM_VERSION, bestGen: GEN_VERSION } });
    expect(ok.progress.endless).toEqual({ bestHeight: 40, bestShards: 3, runs: 2, bestMasks: 'AAEA', bestSeed: 777, bestSim: SIM_VERSION, bestGen: GEN_VERSION });
    const stale = stored({ v: 1, endless: { bestHeight: 40, bestShards: 3, runs: 2, bestMasks: 'AAEA', bestSeed: 777, bestSim: SIM_VERSION - 1, bestGen: GEN_VERSION } });
    expect(stale.progress.endless).toEqual({ bestHeight: 40, bestShards: 3, runs: 2 });
    // A different tower generator makes the replay meaningless: dropped too.
    const staleGen = stored({ v: 1, endless: { bestHeight: 40, bestShards: 3, runs: 2, bestMasks: 'AAEA', bestSeed: 777, bestSim: SIM_VERSION, bestGen: GEN_VERSION - 1 } });
    expect(staleGen.progress.endless).toEqual({ bestHeight: 40, bestShards: 3, runs: 2 });
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

// ================================================================ P3-5 · progress transfer
const LOCAL_ID = 'local-device-id-01';
const REMOTE_ID = 'remote-device-id-0001';

/** A lived-in local save: replays everywhere a replay can live, plus install-only fields. */
function richProgress(): Progress {
  const p = defaultProgress(LOCAL_ID, '로컬');
  p.levels.t1 = { done: true, bestTicks: 6000, bestShards: 10, stars: 2, relics: 0, deaths: 4, runId: 'run-local-1', masks: 'AAEA', sim: SIM_VERSION, sessionDeaths: 3, segBest: [100, 200] };
  p.levels.t2 = { done: true, bestTicks: 8000, bestShards: 4, stars: 1, relics: 1, deaths: 9, runId: 'run-local-2', masks: 'BBBB', sim: SIM_VERSION };
  p.daily['2026-09-05'] = { bestTicks: 7000, cleared: true, height: 40, seed: 5, runId: 'run-d5', masks: 'AAEA', sim: SIM_VERSION, rank: 3 };
  p.daily['2026-09-04'] = { bestTicks: 0, cleared: false, height: 30, seed: 4 };
  p.daily['2026-09-02'] = { bestTicks: 6100, cleared: true, height: 90, seed: 2, runId: 'run-d2' };
  p.endless = { bestHeight: 80, bestShards: 5, runs: 3, bestMasks: 'AAEA', bestSeed: 9, bestSim: SIM_VERSION, bestGen: GEN_VERSION };
  p.seen = { t1: true, 'name:asked': true };
  p.totals = { deaths: 20, shards: 100 };
  p.lastLevel = 't2';
  p.firstSeen = T0 - 3 * DAY;
  p.playDays = 3;
  p.lastPlayDay = '2026-09-06';
  return p;
}

describe('P3-5 · snapshotProgress (what travels to the other device)', () => {
  it('strips every replay and install-only field, keeps records, run ids, identity, seen flags and retention', () => {
    const snap = snapshotProgress(richProgress());
    const json = JSON.stringify(snap);
    for (const forbidden of ['masks', 'bestMasks', 'bestSeed', 'bestSim', 'bestGen', 'segBest', 'sessionDeaths', '"sim"']) {
      expect(json, forbidden).not.toContain(forbidden);
    }
    expect(snap.levels).toEqual({
      t1: { done: true, bestTicks: 6000, bestShards: 10, stars: 2, relics: 0, deaths: 4, runId: 'run-local-1' },
      t2: { done: true, bestTicks: 8000, bestShards: 4, stars: 1, relics: 1, deaths: 9, runId: 'run-local-2' },
    });
    expect((snap.daily as Record<string, unknown>)['2026-09-05']).toEqual({ bestTicks: 7000, cleared: true, height: 40, seed: 5, runId: 'run-d5', rank: 3 });
    expect((snap.daily as Record<string, unknown>)['2026-09-04']).toEqual({ bestTicks: 0, cleared: false, height: 30, seed: 4 });
    expect(snap.endless).toEqual({ bestHeight: 80, bestShards: 5, runs: 3 });
    expect(snap.player).toEqual({ id: LOCAL_ID, name: '로컬' });
    expect(snap.seen).toEqual({ t1: true, 'name:asked': true });
    expect(snap.totals).toEqual({ deaths: 20, shards: 100 });
    expect(snap.lastLevel).toBe('t2');
    expect(snap.firstSeen).toBe(T0 - 3 * DAY);
    expect(snap.playDays).toBe(3);
    expect(snap.lastPlayDay).toBe('2026-09-06');
    // it is a valid wire body and a valid Progress on the other side
    const body: TransferCreateRequest = { player: { id: LOCAL_ID, name: '로컬' }, progress: snap };
    expect(TransferCreateRequest.safeParse(body).success).toBe(true);
    expect(jsonBytes(body)).toBeLessThanOrEqual(MAX_TRANSFER_BYTES);
    const back = repairProgress(snap, defaultProgress('other-device-id'));
    expect(back.levels.t1.bestTicks).toBe(6000);
    expect(back.levels.t1.masks).toBeUndefined();
  });

  it('trims a long daily history oldest-first until the document fits the byte cap', () => {
    const p = richProgress();
    const first = Date.UTC(2025, 0, 1);
    for (let i = 0; i < 400; i++) {
      const date = new Date(first + i * DAY).toISOString().slice(0, 10);
      p.daily[date] = { bestTicks: 5000 + i, cleared: true, height: 60, seed: i, runId: `run-${i}-abcdefghijklmnop`, rank: i + 1 };
    }
    const newest = Object.keys(p.daily).sort().at(-1)!;
    const full = snapshotProgress(p, Number.MAX_SAFE_INTEGER);
    expect(jsonBytes(full)).toBeGreaterThan(MAX_TRANSFER_BYTES);
    const snap = snapshotProgress(p);
    expect(jsonBytes(snap)).toBeLessThanOrEqual(MAX_TRANSFER_BYTES - TRANSFER_MARGIN_BYTES);
    expect(jsonBytes({ player: p.player, progress: snap })).toBeLessThanOrEqual(MAX_TRANSFER_BYTES);
    const dates = Object.keys(snap.daily as Record<string, unknown>).sort();
    expect(dates.length).toBeGreaterThan(30);
    expect(dates.length).toBeLessThan(403);
    expect(dates.at(-1)).toBe(newest);
    // everything but the daily history is intact
    expect(snap.levels).toEqual(snapshotProgress(richProgress()).levels);
  });

  it('jsonBytes counts UTF-8 bytes (Korean names are three bytes a code point)', () => {
    expect(jsonBytes({ a: 1 })).toBe(7);
    expect(jsonBytes('클')).toBe(5); // quotes + 3
  });
});

describe('P3-5 · mergeProgress (restoring on the other device)', () => {
  function remoteSnap(over: Record<string, unknown> = {}): TransferGetResponse {
    return {
      playerId: REMOTE_ID, name: '리모트',
      progress: {
        v: 1,
        levels: {
          // slower than the local t1 (6000) but with more stars
          t1: { done: true, bestTicks: 7000, bestShards: 12, stars: 3, relics: 1, deaths: 2, runId: 'run-remote-1' },
          // faster than the local t2 (8000); a replay that must never be imported
          t2: { done: true, bestTicks: 5000, bestShards: 2, stars: 3, relics: 0, deaths: 1, runId: 'run-remote-2', masks: 'ZZZZ', sim: SIM_VERSION, segBest: [1, 2], sessionDeaths: 7 },
          // unknown locally
          t3: { done: true, bestTicks: 9000, bestShards: 0, stars: 1, relics: 0, deaths: 0, runId: 'run-remote-3', masks: 'ZZZZ', sim: SIM_VERSION },
        },
        daily: {
          '2026-09-05': { bestTicks: 6500, cleared: true, height: 40, seed: 5, runId: 'run-r5', rank: 1, masks: 'ZZZZ', sim: SIM_VERSION }, // faster clear
          '2026-09-04': { bestTicks: 0, cleared: false, height: 50, seed: 4 },                                                          // higher, both uncleared
          '2026-09-03': { bestTicks: 7200, cleared: true, height: 40, seed: 3, runId: 'run-r3' },                                        // only remote
          '2026-09-02': { bestTicks: 0, cleared: false, height: 150, seed: 2 },                                                         // local clear beats a height
        },
        endless: { bestHeight: 120, bestShards: 1, runs: 5 },
        totals: { deaths: 15, shards: 140 },
        seen: { t3: true, 'assist:t1': true, junk: false },
        lastLevel: 't3',
        player: { id: REMOTE_ID, name: '리모트' },
        firstSeen: T0 - 10 * DAY, playDays: 8, lastPlayDay: '2026-09-07',
        ...over,
      },
    };
  }

  it('keeps the better record per zone, replaces the player identity, and never imports a replay', () => {
    const local = richProgress();
    const out = mergeProgress(local, remoteSnap());
    expect(out).toBe(local);
    // t1: the local clear is faster → local time, local run id, local replay kept; stars / shards / relics take the max
    expect(local.levels.t1.bestTicks).toBe(6000);
    expect(local.levels.t1.runId).toBe('run-local-1');
    expect(local.levels.t1.masks).toBe('AAEA');
    expect(echoMasks(local.levels.t1)).toBe('AAEA');
    expect(local.levels.t1.stars).toBe(3);
    expect(local.levels.t1.bestShards).toBe(12);
    expect(local.levels.t1.relics).toBe(1);
    expect(local.levels.t1.deaths).toBe(4);
    expect(local.levels.t1.segBest).toEqual([100, 200]);
    expect(local.levels.t1.sessionDeaths).toBe(3);
    // t2: the other device's clear is faster → its time and run id; the local replay no longer fits the record, the remote one is never taken
    expect(local.levels.t2.bestTicks).toBe(5000);
    expect(local.levels.t2.runId).toBe('run-remote-2');
    expect(local.levels.t2.masks).toBeUndefined();
    expect(local.levels.t2.sim).toBeUndefined();
    expect(local.levels.t2.segBest).toBeUndefined();
    expect(local.levels.t2.sessionDeaths).toBeUndefined();
    // t3: new here, replay stripped
    expect(local.levels.t3.done).toBe(true);
    expect(local.levels.t3.bestTicks).toBe(9000);
    expect(local.levels.t3.masks).toBeUndefined();
    expect(JSON.stringify(local.levels)).not.toContain('ZZZZ');
    // identity: the other device's
    expect(local.player).toEqual({ id: REMOTE_ID, name: '리모트' });
  });

  it('daily, endless, totals, seen, lastLevel and retention follow the same rules', () => {
    const local = richProgress();
    mergeProgress(local, remoteSnap());
    const d = local.daily;
    expect(d['2026-09-05']).toEqual({ bestTicks: 6500, cleared: true, height: 40, seed: 5, runId: 'run-r5', rank: 1 });
    expect(d['2026-09-04']).toEqual({ bestTicks: 0, cleared: false, height: 50, seed: 4 });
    expect(d['2026-09-03']).toEqual({ bestTicks: 7200, cleared: true, height: 40, seed: 3, runId: 'run-r3' });
    expect(d['2026-09-02']).toEqual({ bestTicks: 6100, cleared: true, height: 150, seed: 2, runId: 'run-d2' });
    expect(JSON.stringify(d)).not.toContain('ZZZZ');
    // endless: the higher climb wins and the local best replay, which belonged to the lower one, is dropped
    expect(local.endless).toEqual({ bestHeight: 120, bestShards: 5, runs: 5 });
    expect(local.totals).toEqual({ deaths: 20, shards: 140 });
    expect(local.seen).toEqual({ t1: true, 'name:asked': true, t3: true, 'assist:t1': true });
    expect(local.lastLevel).toBe('t2');
    expect(local.firstSeen).toBe(T0 - 10 * DAY);
    expect(local.playDays).toBe(8);
    expect(local.lastPlayDay).toBe('2026-09-07');
  });

  it('a lower remote endless climb leaves the local best replay alone; an empty local save takes everything', () => {
    const local = richProgress();
    mergeProgress(local, remoteSnap({ endless: { bestHeight: 40, bestShards: 9, runs: 1 }, lastLevel: null }));
    expect(local.endless.bestHeight).toBe(80);
    expect(local.endless.bestMasks).toBe('AAEA');
    expect(local.endless.bestShards).toBe(9);
    expect(local.endless.runs).toBe(3);

    const fresh = defaultProgress('fresh-device-id');
    mergeProgress(fresh, remoteSnap());
    expect(fresh.player.id).toBe(REMOTE_ID);
    expect(fresh.levels.t2.bestTicks).toBe(5000);
    expect(fresh.levels.t2.masks).toBeUndefined();
    expect(fresh.lastLevel).toBe('t3');
    expect(fresh.daily['2026-09-05'].runId).toBe('run-r5');
  });

  it('sanitises a hostile snapshot: junk records are repaired, an invalid identity keeps the local one, nothing throws', () => {
    const local = richProgress();
    mergeProgress(local, {
      playerId: 'bad id!', name: '<x>',
      progress: { levels: { t1: 'nope', t9: { done: 'yes', bestTicks: -5, stars: 99 } }, daily: { nope: { bestTicks: 1 } }, endless: 3, seen: 'x', totals: null },
    });
    expect(local.player).toEqual({ id: LOCAL_ID, name: '로컬' });
    expect(local.levels.t1.bestTicks).toBe(6000);
    expect(local.levels.t9).toEqual({ done: false, bestTicks: 0, bestShards: 0, stars: 3, relics: 0, deaths: 0 });
    expect(local.daily.nope).toBeUndefined();
    expect(local.endless.bestHeight).toBe(80);
  });

  it('Save.importSnapshot writes through at once and Save.snapshot() is snapshotProgress of the live progress', () => {
    const storage = new MemStorage();
    storage.setItem(PROGRESS_KEY, JSON.stringify(richProgress()));
    let scheduled = 0;
    const save = new Save({ storage, schedule: () => { scheduled++; return 0; }, cancel: () => {} });
    expect(save.snapshot()).toEqual(snapshotProgress(save.progress));
    save.importSnapshot(remoteSnap());
    const stored = JSON.parse(storage.getItem(PROGRESS_KEY)!) as Progress;
    expect(stored.player.id).toBe(REMOTE_ID);
    expect(stored.levels.t2.bestTicks).toBe(5000);
    expect(stored.levels.t2.masks).toBeUndefined();
    expect(stored.levels.t1.masks).toBe('AAEA');
    expect(scheduled).toBe(0); // no debounce: the write was immediate
  });
});

describe('P3-8 · Settings.haptics default', () => {
  it('repairSettings keeps a boolean, drops junk; the Save seeds the device default only when the player never chose', () => {
    expect(repairSettings({ haptics: false }, defaultSettings()).haptics).toBe(false);
    expect(repairSettings({ haptics: true }, defaultSettings()).haptics).toBe(true);
    expect('haptics' in repairSettings({ haptics: 'yes' }, defaultSettings())).toBe(false);
    expect('haptics' in repairSettings(undefined, defaultSettings())).toBe(false);

    const fresh = (opts: { coarsePointer?: boolean; reducedMotion?: boolean }) => new Save({ storage: null, ...opts }).settings.haptics;
    expect(fresh({ coarsePointer: true })).toBe(true);
    expect(fresh({ coarsePointer: true, reducedMotion: true })).toBe(false);
    expect(fresh({})).toBe(false);
    expect(fresh({ reducedMotion: true })).toBe(false);

    // a stored choice wins over the device default, either way
    const storage = new MemStorage();
    storage.setItem(SETTINGS_KEY, JSON.stringify({ ...defaultSettings(), haptics: true }));
    expect(new Save({ storage, coarsePointer: false, reducedMotion: true }).settings.haptics).toBe(true);
    storage.setItem(SETTINGS_KEY, JSON.stringify({ ...defaultSettings(), haptics: false }));
    expect(new Save({ storage, coarsePointer: true }).settings.haptics).toBe(false);
    // an old save without the field gets the device default and keeps its other choices
    storage.setItem(SETTINGS_KEY, JSON.stringify({ ...defaultSettings(), music: 0.1 }));
    const s = new Save({ storage, coarsePointer: true });
    expect(s.settings.haptics).toBe(true);
    expect(s.settings.music).toBeCloseTo(0.1);
  });
});

describe('P3-7 · Settings.touch layout and the mute chip', () => {
  it('a v1 settings document gets the touch defaults and keeps every other choice; a stored layout round-trips', () => {
    const storage = new MemStorage();
    const { touch: _drop, ...v1 } = defaultSettings();
    storage.setItem(SETTINGS_KEY, JSON.stringify({ ...v1, music: 0.2, skin: 'azure' }));
    const s = new Save({ storage, schedule: () => 0, cancel: () => {} });
    expect(s.settings.touch).toEqual(DEFAULT_TOUCH);
    expect(s.settings.music).toBeCloseTo(0.2);
    expect(s.settings.skin).toBe('azure');

    // the player's layout survives a write / read cycle exactly
    const mine: TouchLayout = { scale: 1.25, opacity: 0.6, leftX: 24, leftY: -8, rightX: -40, rightY: 12, floating: true };
    s.settings.touch = { ...mine };
    s.flush();
    const again = new Save({ storage, schedule: () => 0, cancel: () => {} });
    expect(again.settings.touch).toEqual(mine);
    expect(touchLayout(again.settings)).toBe(again.settings.touch);
  });

  it('repairTouch clamps to the limits (scale 0.8–1.4, opacity 0.2–0.8, offsets ±80) and drops junk to the defaults', () => {
    expect(repairTouch(undefined)).toEqual(DEFAULT_TOUCH);
    expect(repairTouch('nope')).toEqual(DEFAULT_TOUCH);
    const r = repairTouch({ scale: 9, opacity: 0.05, leftX: -500, leftY: 'x', rightX: 79.5, rightY: Infinity, floating: 'yes' });
    expect(r).toEqual({ scale: TOUCH_LIMITS.scale.max, opacity: TOUCH_LIMITS.opacity.min, leftX: -80, leftY: 0, rightX: 79.5, rightY: 0, floating: false });
    expect(repairTouch({ scale: 0.1 }).scale).toBe(TOUCH_LIMITS.scale.min);
    // through repairSettings as well
    const s = repairSettings({ touch: { scale: 0.8, floating: true } }, defaultSettings());
    expect(s.touch).toEqual({ ...DEFAULT_TOUCH, scale: 0.8, floating: true });
    // a fixture without the field gets it attached on first read (the editor mutates that object)
    const bare = defaultSettings();
    delete bare.touch;
    const attached = touchLayout(bare);
    expect(bare.touch).toBe(attached);
    expect(attached).toEqual(DEFAULT_TOUCH);
  });

  it('toggleMute zeroes the master volume, remembers the level, restores it, and the memory is sanitised on load', () => {
    const s = defaultSettings();
    s.master = 0.55;
    expect(isMuted(s)).toBe(false);
    expect(toggleMute(s)).toBe(true);
    expect(s.master).toBe(0);
    expect(isMuted(s)).toBe(true);
    expect((s as Settings & MuteExtra).masterBeforeMute).toBeCloseTo(0.55);
    expect(toggleMute(s)).toBe(false);
    expect(s.master).toBeCloseTo(0.55);
    expect('masterBeforeMute' in s).toBe(false);
    // muted with no memory (an old save at 0): unmute lands on the fallback level
    s.master = 0;
    expect(toggleMute(s)).toBe(false);
    expect(s.master).toBe(UNMUTE_FALLBACK_MASTER);
    // persistence: the memory rides along only while muted and only as a positive number
    const muted = repairSettings({ master: 0, masterBeforeMute: 0.7 }, defaultSettings());
    expect((muted as Settings & MuteExtra).masterBeforeMute).toBeCloseTo(0.7);
    const loud = repairSettings({ master: 0.4, masterBeforeMute: 0.7 }, defaultSettings());
    expect('masterBeforeMute' in loud).toBe(false);
    const junk = repairSettings({ master: 0, masterBeforeMute: 'x' }, defaultSettings());
    expect('masterBeforeMute' in junk).toBe(false);
  });
});
