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
import {
  PROGRESS_KEY, Save, daysBucket, defaultProgress, echoMasks, markEcho, repairProgress, retentionBuckets, touchPlayDay,
  type StorageLike,
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
