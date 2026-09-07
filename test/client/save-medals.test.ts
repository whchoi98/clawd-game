/**
 * Save layer — the P3-6 record fields (medals, best rank / combo, world rank)
 * and Progress.unlockedSkins: repair on load, the transfer snapshot, the merge,
 * and the reset.
 */
import { describe, expect, it } from 'vitest';
import { GEN_VERSION, SIM_VERSION } from '../../src/sim/types.js';
import type { Progress } from '../../src/client/contracts.js';
import type { TransferGetResponse } from '../../src/shared/protocol.js';
import {
  PROGRESS_KEY, Save, cleanMedals, cleanSkins, defaultProgress, mergeProgress, repairProgress, snapshotProgress, type StorageLike,
} from '../../src/client/save.js';

class MemStorage implements StorageLike {
  readonly map = new Map<string, string>();
  constructor(entries: [string, string][] = []) { for (const [k, v] of entries) this.map.set(k, v); }
  getItem(k: string): string | null { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string): void { this.map.set(k, v); }
  removeItem(k: string): void { this.map.delete(k); }
}

const LOCAL_ID = 'local-device-id-01';
const REMOTE_ID = 'remote-device-id-0001';

function localProgress(): Progress {
  const p = defaultProgress(LOCAL_ID, '로컬');
  p.levels.t1 = {
    done: true, bestTicks: 6000, bestShards: 10, stars: 2, relics: 0, deaths: 4, runId: 'run-local-1', masks: 'AAEA', sim: SIM_VERSION,
    medals: ['par'],
  };
  Object.assign(p.levels.t1, { bestRank: 'A', bestCombo: 4, rank: 30 });
  p.levels.t2 = { done: true, bestTicks: 8000, bestShards: 4, stars: 1, relics: 1, deaths: 9, runId: 'run-local-2' };
  p.endless = { bestHeight: 80, bestShards: 5, runs: 3, bestMasks: 'AAEA', bestSeed: 9, bestSim: SIM_VERSION, bestGen: GEN_VERSION };
  p.unlockedSkins = ['azure'];
  return p;
}

describe('P3-6 · repairProgress keeps medals, best rank / combo, world rank and unlocked skins (and drops junk)', () => {
  it('sanitises the new record fields and the skin list; defaults leave them absent', () => {
    const storage = new MemStorage([[PROGRESS_KEY, JSON.stringify({
      v: 1,
      levels: {
        ok: { done: true, bestTicks: 10, medals: ['relic', 'nodeath', 'relic', 'bogus'], bestRank: 'A', bestCombo: 7.9, rank: 12.4 },
        junk: { done: true, bestTicks: 10, medals: 'nope', bestRank: 'Z', bestCombo: -3, rank: 0 },
        plain: { done: true, bestTicks: 10 },
      },
      unlockedSkins: ['azure', 'azure', 'BAD id', 7, 'void'],
      player: { id: 'abcdefgh-1234', name: '클로드' },
    })]]);
    const save = new Save({ storage, schedule: () => 0, cancel: () => undefined });
    expect(save.progress.levels.ok.medals).toEqual(['nodeath', 'relic']);
    expect(save.progress.levels.ok).toMatchObject({ bestRank: 'A', bestCombo: 7, rank: 12 });
    for (const k of ['medals', 'bestRank', 'bestCombo', 'rank']) expect(k in save.progress.levels.junk, k).toBe(false);
    expect('medals' in save.progress.levels.plain).toBe(false);
    expect(save.progress.unlockedSkins).toEqual(['azure', 'void']);
    expect(defaultProgress('abcdefgh-1234').unlockedSkins).toBeUndefined();
    expect(repairProgress({}, defaultProgress('abcdefgh-1234')).unlockedSkins).toBeUndefined();
    expect(cleanMedals(['par', 'par', 'x'])).toEqual(['par']);
    expect(cleanMedals('par')).toEqual([]);
    expect(cleanSkins(['ember', 'ember', 'A'])).toEqual(['ember']);
  });

  it('the snapshot carries medals, best rank / combo, the world rank and the skins; the merge unions them and keeps the better', () => {
    const local = localProgress();
    const snap = snapshotProgress(local);
    expect((snap.levels as Record<string, unknown>).t1).toMatchObject({ medals: ['par'], bestRank: 'A', bestCombo: 4, rank: 30 });
    expect((snap.levels as Record<string, unknown>).t2).not.toHaveProperty('medals');
    expect(JSON.stringify(snap)).not.toContain('masks');
    expect(snap.unlockedSkins).toEqual(['azure']);

    const remote: TransferGetResponse = {
      playerId: REMOTE_ID, name: '리모트',
      progress: {
        v: 1,
        levels: {
          // slower than the local t1: local time and world rank stay; medals union, the S wins, the longer combo wins
          t1: { done: true, bestTicks: 7000, bestShards: 12, stars: 3, relics: 1, deaths: 2, medals: ['nodeath', 'par'], bestRank: 'S', bestCombo: 9, rank: 2 },
          // faster than the local t2: its world rank comes along with its time
          t2: { done: true, bestTicks: 5000, bestShards: 2, stars: 3, relics: 0, deaths: 1, runId: 'run-remote-2', rank: 5 },
        },
        unlockedSkins: ['ember', 'azure'],
        player: { id: REMOTE_ID, name: '리모트' },
      },
    };
    mergeProgress(local, remote);
    expect(local.levels.t1.medals).toEqual(['nodeath', 'par']);
    expect(local.levels.t1).toMatchObject({ bestTicks: 6000, bestRank: 'S', bestCombo: 9, rank: 30 });
    expect(local.levels.t2).toMatchObject({ bestTicks: 5000, runId: 'run-remote-2', rank: 5 });
    expect(local.unlockedSkins).toEqual(['azure', 'ember']);
    expect(local.player.id).toBe(REMOTE_ID);
  });

  it('resetProgress forgets the unlocked skins (the selected skin stays through grandfathering)', () => {
    const save = new Save({ storage: new MemStorage(), schedule: () => 0, cancel: () => undefined });
    save.progress.unlockedSkins = ['azure', 'void'];
    save.progress.levels.t1 = { done: true, bestTicks: 100, bestShards: 0, stars: 3, relics: 0, deaths: 0, medals: ['par'] };
    save.resetProgress();
    expect(save.progress.unlockedSkins).toBeUndefined();
    expect(save.progress.levels).toEqual({});
  });
});
