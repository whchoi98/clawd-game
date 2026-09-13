import { describe, expect, it } from 'vitest';
import {
  PROGRESS_KEY, SETTINGS_KEY, Save, defaultLevelRecord, defaultProgress, defaultSettings, markEcho,
  type StorageLike,
} from '../../src/client/save.js';
import { GEN_VERSION, SIM_VERSION } from '../../src/sim/types.js';

class SharedStorage implements StorageLike {
  readonly data = new Map<string, string>();
  writes = 0;
  failNextProgress = false;
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  setItem(key: string, value: string): void {
    if (key === PROGRESS_KEY && this.failNextProgress) {
      this.failNextProgress = false;
      throw new Error('storage full');
    }
    this.writes++;
    this.data.set(key, value);
  }
  removeItem(key: string): void { this.data.delete(key); }
}

function tabs(progress = defaultProgress('shared-player-id', 'Original')) {
  const storage = new SharedStorage();
  storage.setItem(PROGRESS_KEY, JSON.stringify(progress));
  storage.setItem(SETTINGS_KEY, JSON.stringify(defaultSettings()));
  const open = () => new Save({ storage, schedule: () => 1, cancel: () => {} });
  return { storage, a: open(), b: open(), open };
}

describe('Save · overlapping tabs', () => {
  it('an idle pagehide does not overwrite a newer clear or settings', () => {
    const { a, b, open, storage } = tabs();
    Object.assign(a.levelRecord('t1'), { done: true, bestTicks: 100, stars: 3 });
    a.settings.master = 0;
    a.flush();
    const writes = storage.writes;
    b.flush();
    expect(storage.writes).toBe(writes);
    expect(open().progress.levels.t1).toMatchObject({ done: true, bestTicks: 100, stars: 3 });
    expect(open().settings.master).toBe(0);
  });

  it.each(['a first', 'b first'])('preserves both tabs’ accomplishments and the winning replay (%s)', (order) => {
    const p = defaultProgress('shared-player-id', 'Original');
    p.levels.t1 = { ...defaultLevelRecord(), done: true, bestTicks: 600, stars: 1, deaths: 5, segBest: [100, 150], medals: ['relic'] };
    markEcho(p.levels.t1, 'OLD');
    p.levels.t1.runId = 'old-run';
    p.totals = { deaths: 10, shards: 100 };
    p.playDays = 4;
    const { a, b, open } = tabs(p);
    Object.assign(a.levelRecord('t1'), { bestTicks: 400, stars: 2, deaths: 7, segBest: [90, 150], medals: ['relic', 'nodeath'] });
    markEcho(a.levelRecord('t1'), 'FAST');
    delete a.levelRecord('t1').runId;
    Object.assign(b.levelRecord('t1'), { bestTicks: 500, stars: 3, deaths: 8, segBest: [100, 100], medals: ['relic', 'par'], runId: 'slow-run' });
    markEcho(b.levelRecord('t1'), 'SLOW');
    a.levelRecord('t2').done = true;
    b.levelRecord('t3').done = true;
    a.progress.totals = { deaths: 12, shards: 105 };
    b.progress.totals = { deaths: 13, shards: 107 };
    a.progress.playDays = b.progress.playDays = 5;
    if (order === 'a first') { a.flush(); b.flush(); } else { b.flush(); a.flush(); }
    const got = open().progress;
    expect(got.levels.t1).toMatchObject({ bestTicks: 400, masks: 'FAST', sim: SIM_VERSION, stars: 3, deaths: 10, segBest: [90, 100] });
    expect(got.levels.t1.runId).toBeUndefined();
    expect(new Set(got.levels.t1.medals)).toEqual(new Set(['relic', 'nodeath', 'par']));
    expect(got.levels.t2.done).toBe(true);
    expect(got.levels.t3.done).toBe(true);
    expect(got.totals).toEqual({ deaths: 15, shards: 112 });
    expect(got.playDays).toBe(5);
    // Repeated lifecycle flushes must not count either tab's increments twice.
    a.flush(); b.flush();
    expect(open().progress.totals).toEqual({ deaths: 15, shards: 112 });
  });

  it('merges daily and endless bests without stripping or mixing replay metadata', () => {
    const { a, b, open } = tabs();
    a.progress.daily['2026-09-13'] = { bestTicks: 500, cleared: true, height: 50, seed: 13, masks: 'DAILY-FAST', sim: SIM_VERSION, runId: 'daily-fast', rank: 2 };
    b.progress.daily['2026-09-13'] = { bestTicks: 700, cleared: true, height: 60, seed: 13, masks: 'DAILY-SLOW', sim: SIM_VERSION, runId: 'daily-slow', rank: 5 };
    a.progress.endless = { bestHeight: 80, bestShards: 2, runs: 1, bestMasks: 'HIGH', bestSeed: 123, bestSim: SIM_VERSION, bestGen: GEN_VERSION };
    b.progress.endless = { bestHeight: 60, bestShards: 8, runs: 1, bestMasks: 'LOW', bestSeed: 456, bestSim: SIM_VERSION, bestGen: GEN_VERSION };
    a.flush(); b.flush();
    const got = open().progress;
    expect(got.daily['2026-09-13']).toEqual({
      bestTicks: 500, cleared: true, height: 60, seed: 13, masks: 'DAILY-FAST', sim: SIM_VERSION, runId: 'daily-fast', rank: 2,
    });
    expect(got.endless).toEqual({
      bestHeight: 80, bestShards: 8, runs: 2, bestMasks: 'HIGH', bestSeed: 123, bestSim: SIM_VERSION, bestGen: GEN_VERSION,
    });
  });

  it('keeps an acknowledgement for the same replay when another tab earns an unrelated medal', () => {
    const p = defaultProgress('shared-player-id');
    p.levels.t1 = { ...defaultLevelRecord(), done: true, bestTicks: 400, masks: 'BEST', sim: SIM_VERSION };
    const { a, b, open } = tabs(p);
    a.levelRecord('t1').runId = 'accepted-run';
    b.levelRecord('t1').medals = ['nodeath'];
    a.flush(); b.flush();
    expect(open().progress.levels.t1).toMatchObject({ masks: 'BEST', runId: 'accepted-run', medals: ['nodeath'] });
  });

  it('preserves explicit settings edits per field, including false, zero and nested binds', () => {
    const { a, b, open } = tabs();
    a.settings.master = 0;
    a.settings.flashes = false;
    a.settings.binds.jump = ['KeyJ'];
    b.settings.music = 0.2;
    b.settings.binds.left = ['KeyH'];
    a.flush(); b.flush();
    expect(open().settings).toMatchObject({
      master: 0, music: 0.2, flashes: false, binds: { jump: ['KeyJ'], left: ['KeyH'] },
    });
    b.settings.master = 0.4;
    b.settings.flashes = true;
    b.settings.binds.jump = [];
    b.flush(); a.flush();
    expect(open().settings).toMatchObject({ master: 0.4, music: 0.2, flashes: true, binds: { jump: [], left: ['KeyH'] } });
  });

  it('preserves an explicit name edit while merging unrelated progress', () => {
    const { a, b, open } = tabs();
    a.levelRecord('t1').done = true;
    b.progress.player.name = 'Renamed';
    a.flush(); b.flush();
    expect(open().progress.player).toEqual({ id: 'shared-player-id', name: 'Renamed' });
    expect(open().progress.levels.t1.done).toBe(true);
  });

  it('an explicit setting choice wins even when it returns to this tab’s baseline value', () => {
    const { a, b, open } = tabs();
    a.settings.master = 0;
    a.settings.flashes = false;
    a.settings.music = 0.1;
    a.flush();
    b.settings.master = 0.5;
    b.settings.master = 0.8; // Back to its baseline, but still an explicit edit.
    b.settings.flashes = true;
    b.flush();
    expect(open().settings).toMatchObject({ master: 0.8, flashes: true, music: 0.1 });
    // Observing edits must preserve the plain, structured-cloneable settings API.
    expect(structuredClone(b.settings).master).toBe(0.8);
  });

  it('explicit name and last-level assignments are not mistaken for an idle tab', () => {
    const p = defaultProgress('shared-player-id', 'Original');
    p.lastLevel = 't1';
    const { a, b, open } = tabs(p);
    a.progress.player.name = 'Other';
    a.progress.lastLevel = 't2';
    a.levelRecord('t2').done = true;
    a.flush();
    b.progress.player.name = 'Original';
    b.progress.lastLevel = 't1';
    b.flush();
    expect(open().progress.player.name).toBe('Original');
    expect(open().progress.lastLevel).toBe('t1');
    expect(open().progress.levels.t2.done).toBe(true);
    expect(structuredClone(b.progress).player.name).toBe('Original');
  });

  it('does not resurrect intentionally deleted records, flags or replay fields', () => {
    const p = defaultProgress('shared-player-id');
    p.levels.t1 = { ...defaultLevelRecord(), done: true, bestTicks: 400, masks: 'BEST', sim: SIM_VERSION, runId: 'old-run' };
    p.levels.t2 = { ...defaultLevelRecord(), done: true };
    p.seen = { dismissed: true };
    p.unlockedSkins = ['azure', 'coral'];
    const { a, b, open } = tabs(p);
    delete a.levelRecord('t1').masks;
    delete a.levelRecord('t1').sim;
    delete a.levelRecord('t1').runId;
    delete a.progress.levels.t2;
    delete a.progress.seen.dismissed;
    a.progress.unlockedSkins = ['coral'];
    b.levelRecord('t1').medals = ['par'];
    b.progress.seen.new = true;
    a.flush(); b.flush();
    const got = open().progress;
    expect(got.levels.t1).not.toHaveProperty('masks');
    expect(got.levels.t1).not.toHaveProperty('runId');
    expect(got.levels.t2).toBeUndefined();
    expect(got.seen).toEqual({ new: true });
    expect(got.unlockedSkins).toEqual(['coral']);
  });

  it('a reset wins over stale dirty tabs and subsequent fresh accomplishments still persist', () => {
    const p = defaultProgress('shared-player-id', 'Original');
    p.levels.t1 = { ...defaultLevelRecord(), done: true, bestTicks: 400 };
    p.tiersBroken = ['tidepool'];
    p.unlockedSkins = ['azure'];
    p.endingSeen = true;
    const { a, b, open } = tabs(p);
    b.levelRecord('t2').done = true; // still pending when reset happens
    b.saveProgress();
    a.resetProgress();
    b.flush();
    let got = open().progress;
    expect(got.levels).toEqual({});
    expect(got.player).toEqual({ id: 'shared-player-id', name: 'Original' });
    expect(got.tiersBroken).toBeUndefined();
    expect(got.endingSeen).toBeUndefined();
    expect(got.unlockedSkins).toBeUndefined();
    b.levelRecord('t3').done = true;
    b.flush();
    got = open().progress;
    expect(Object.keys(got.levels)).toEqual(['t3']);
  });

  it.each(['shared-player-id', 'imported-player-id'])('an import is a generation boundary even for %s', (playerId) => {
    const p = defaultProgress('shared-player-id', 'Original');
    p.levels.t1 = { ...defaultLevelRecord(), done: true, bestTicks: 600, masks: 'OLD', sim: SIM_VERSION, runId: 'old-run' };
    const { a, b, open } = tabs(p);
    b.levelRecord('t2').done = true;
    b.progress.player.name = 'Stale name';
    const incoming = defaultProgress(playerId, 'Imported');
    incoming.levels.t1 = { ...defaultLevelRecord(), done: true, bestTicks: 300, runId: 'imported-run' };
    a.importSnapshot({ playerId, name: 'Imported', progress: incoming as unknown as Record<string, unknown> });
    b.flush();
    const got = open().progress;
    expect(got.player).toEqual({ id: playerId, name: 'Imported' });
    expect(got.levels.t1).toMatchObject({ bestTicks: 300, runId: 'imported-run' });
    expect(got.levels.t1.masks).toBeUndefined();
    expect(got.levels.t2).toBeUndefined();
  });

  it('an import reconciles accomplishments already saved by another tab first', () => {
    const { a, b, open } = tabs();
    b.levelRecord('t2').done = true;
    b.flush();
    const incoming = defaultProgress('imported-player-id');
    incoming.levels.t1 = { ...defaultLevelRecord(), done: true };
    a.importSnapshot({ playerId: incoming.player.id, name: incoming.player.name, progress: incoming as unknown as Record<string, unknown> });
    expect(open().progress.levels.t1.done).toBe(true);
    expect(open().progress.levels.t2.done).toBe(true);
  });

  it('retries a failed merged write without dropping local changes or double-counting remote counters', () => {
    const { a, b, open, storage } = tabs();
    a.progress.totals.deaths = 2;
    b.progress.totals.deaths = 3;
    a.levelRecord('t1').done = true;
    b.levelRecord('t2').done = true;
    a.flush();
    storage.failNextProgress = true;
    b.flush();
    expect(open().progress.totals.deaths).toBe(2);
    b.flush();
    expect(open().progress.totals.deaths).toBe(5);
    expect(Object.keys(open().progress.levels).sort()).toEqual(['t1', 't2']);
  });
});
