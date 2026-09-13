import { describe, expect, it } from 'vitest';
import { Save, SETTINGS_KEY, type StorageLike } from '../../src/client/save.js';

class Storage implements StorageLike {
  values = new Map<string, string>();
  getItem(k: string): string | null { return this.values.get(k) ?? null; }
  setItem(k: string, v: string): void { this.values.set(k, v); }
  removeItem(k: string): void { this.values.delete(k); }
}

const open = (storage: StorageLike): Save => new Save({ storage, schedule: () => 1, cancel: () => {} });

describe('goal preferences in saves', () => {
  it('loads an old profile without imposing a challenge and persists an explicit target', () => {
    const storage = new Storage();
    storage.setItem(SETTINGS_KEY, JSON.stringify({ v: 1, music: 0.3 }));
    const a = open(storage);
    expect(a.settings.goalTargets).toEqual({});
    expect(a.settings.music).toBe(0.3);
    expect(a.setGoalTarget('t1', 'shards')).toBe(true);
    a.flush();
    expect(open(storage).settings.goalTargets).toEqual({ t1: 'shards' });
  });

  it('keeps targets changed independently in overlapping tabs', () => {
    const storage = new Storage();
    open(storage).flush();
    const a = open(storage), b = open(storage);
    a.setGoalTarget('t1', 'nodeath');
    b.setGoalTarget('t2', 'relic');
    a.flush(); b.flush();
    expect(open(storage).settings.goalTargets).toEqual({ t1: 'nodeath', t2: 'relic' });
  });

  it('honors an explicit free/auto choice even when it equals the local baseline', () => {
    const storage = new Storage();
    const a = open(storage);
    a.setGoalTarget('t1', 'auto'); a.flush();
    const b = open(storage);
    b.setGoalTarget('t1', 'par'); b.flush();
    a.setGoalTarget('t1', 'auto'); a.flush();
    expect(open(storage).settings.goalTargets?.t1).toBe('auto');
    a.setGoalTarget('t1', 'free'); a.flush();
    expect(open(storage).settings.goalTargets?.t1).toBe('free');
  });

  it('sanitizes saved targets before merging them into the live settings object', () => {
    const storage = new Storage();
    storage.setItem(SETTINGS_KEY, '{"v":1,"goalTargets":{"t1":"par","t2":"nope","__proto__":{"polluted":true}}}');
    const a = open(storage);
    expect(a.settings.goalTargets).toEqual({ t1: 'par' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(a.setGoalTarget('__proto__', 'par')).toBe(false);
  });
});
