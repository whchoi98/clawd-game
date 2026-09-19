import { describe, expect, it } from 'vitest';
import type { LevelDef, Rank } from '../../src/sim/types.js';
import type { LevelRecord, Progress } from '../../src/client/contracts.js';
import { normalizeGoalTargets, type GoalId } from '../../src/client/goal-settings.js';
import {
  availableGoals, evaluateGoal, GOAL_DESCRIPTIONS, resolveGoal, skinMilestones, type GoalSnapshot,
} from '../../src/client/goals.js';
import { defaultProgress, defaultSettings } from '../../src/client/save.js';
import { availableSkins, medalsFor } from '../../src/client/unlocks.js';
import { MEDAL_KR } from '../../src/client/ui/ceremony.js';

const GOALS: GoalId[] = ['nodeath', 'par', 'shards', 'relic'];

function level(over: Partial<LevelDef> = {}): LevelDef {
  return { id: 't1', name: '시험 구역', en: 'Test zone', biome: 'tidepool', par: 45, seed: 1, rows: ['PoRoG', '#####'], ...over };
}

function record(over: Partial<LevelRecord> = {}): LevelRecord {
  return { done: true, bestTicks: 4800, bestShards: 1, stars: 0, relics: 0, deaths: 2, ...over };
}

function snapshot(over: Partial<GoalSnapshot> = {}): GoalSnapshot {
  return {
    cleared: false, finished: false, time: 10, ticks: 1200, par: 45, deaths: 0,
    shards: 0, totalShards: 2, relics: 0, eligible: true, ...over,
  };
}

function progress(records: Record<string, LevelRecord> = {}, over: Partial<Progress> = {}): Progress {
  return { ...defaultProgress('goal-model-tests'), levels: records, ...over };
}

function ranked(rank: Rank): LevelRecord {
  return Object.assign(record(), { bestRank: rank });
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

const LEVELS: LevelDef[] = (['tidepool', 'stormspire', 'voidreef', 'summit'] as const).flatMap((biome, tier) =>
  Array.from({ length: 4 }, (_, i) => level({ id: `${['t', 's', 'v', 'm'][tier]}${i + 1}`, biome })),
);

function completed(count: number, over: Partial<LevelRecord> = {}): Progress {
  return progress(Object.fromEntries(LEVELS.slice(0, count).map((def) => [def.id, record(over)])));
}

describe('goal preferences', () => {
  it('retains all six preferences under safe ids, including a 48-character id', () => {
    const raw = {
      t1: 'auto', 's-2': 'free', void_3: 'nodeath', '4': 'par', _zone: 'shards', '-zone': 'relic',
      ['a'.repeat(48)]: 'auto',
    };
    expect(normalizeGoalTargets(raw)).toEqual(raw);
  });

  it.each([undefined, null, true, 7, 'par', ['par'], new Map([['t1', 'par']])])(
    'ignores a non-record input: %s',
    (raw) => expect(normalizeGoalTargets(raw)).toEqual({}),
  );

  it('ignores malformed values without coercing or repairing them', () => {
    expect(normalizeGoalTargets({
      a: 'PAR', b: '', c: ' relic ', d: 'bogus', e: 1, f: true, g: null, h: undefined,
      i: ['par'], j: { goal: 'par' }, k: new String('par'), t1: 'relic',
    })).toEqual({ t1: 'relic' });
  });

  it('rejects unsafe, uppercase, empty and overlong ids without truncation', () => {
    const raw = Object.fromEntries([
      '', 'T1', 'two words', 't/1', 't.1', '구역', 't1\n', 't1\0', 'a'.repeat(49),
    ].map((id) => [id, 'par']));
    expect(normalizeGoalTargets({ ...raw, t1: 'free' })).toEqual({ t1: 'free' });
  });

  it('drops prototype-related keys and exposes no inherited preferences', () => {
    const raw: unknown = JSON.parse(
      '{"__proto__":"par","constructor":"relic","prototype":"shards","toString":"nodeath","hasOwnProperty":"auto","t1":"free"}',
    );
    const out = normalizeGoalTargets(raw);
    expect(out).toEqual({ t1: 'free' });
    for (const id of ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty']) {
      expect(Object.hasOwn(out, id)).toBe(false);
      expect(out[id]).toBeUndefined();
    }
    expect(Object.prototype).not.toHaveProperty('t1');
  });

  it('reads only own data properties, without invoking accessors', () => {
    let reads = 0;
    const raw = Object.create({ t1: 'relic' }) as Record<string, unknown>;
    raw.s1 = 'par';
    Object.defineProperty(raw, 't2', { enumerable: true, get: () => { reads++; return 'shards'; } });
    expect(normalizeGoalTargets(raw)).toEqual({ s1: 'par' });
    expect(reads).toBe(0);
  });

  it('caps accepted entries at 128; malformed entries do not consume the allowance', () => {
    const raw = { bad: null, ...Object.fromEntries(Array.from({ length: 130 }, (_, i) => [`zone_${i}`, 'par'])) };
    const out = normalizeGoalTargets(raw);
    expect(Object.keys(out)).toHaveLength(128);
    expect(out.zone_0).toBe('par');
    expect(out.zone_127).toBe('par');
    expect(out.zone_128).toBeUndefined();
    expect(out.zone_129).toBeUndefined();
  });

  it('is idempotent and never mutates or aliases saved preferences', () => {
    const raw = freeze({ t1: 'par', s1: 'free', bad: { goal: 'relic' } });
    const before = structuredClone(raw);
    const out = normalizeGoalTargets(raw);
    expect(normalizeGoalTargets(out)).toEqual(out);
    out.t1 = 'relic';
    expect(raw).toEqual(before);
    expect(normalizeGoalTargets(raw)).toEqual({ t1: 'par', s1: 'free' });
  });
});

describe('attainable replay goals', () => {
  it.each([
    { rows: ['PoRoG', '#####'], want: ['nodeath', 'par', 'shards', 'relic'] },
    { rows: ['P..G', '####'], want: ['nodeath', 'par'] },
    { rows: ['Po.G', '####'], want: ['nodeath', 'par', 'shards'] },
    { rows: ['PR.G', '####'], want: ['nodeath', 'par', 'relic'] },
    { rows: [], want: ['nodeath', 'par'] },
  ])('offers only collectibles present in $rows', ({ rows, want }) => {
    expect(availableGoals(level({ rows }))).toEqual(want);
  });

  it.each([0, -1, NaN, Infinity])('does not offer an unattainable par of %s', (par) => {
    expect(availableGoals(level({ par }))).toEqual(['nodeath', 'shards', 'relic']);
    expect(resolveGoal(level({ par }), record(), 'par')).toBeNull();
  });

  it('leaves a first attempt free, including an uncleared record with stale medals', () => {
    expect(resolveGoal(level(), undefined)).toBeNull();
    expect(resolveGoal(level(), record({ done: false, medals: ['relic'] }))).toBeNull();
  });

  it.each([
    { medals: undefined, want: 'relic' },
    { medals: [], want: 'relic' },
    { medals: ['relic'], want: 'shards' },
    { medals: ['relic', 'shards'], want: 'par' },
    { medals: ['relic', 'shards', 'par'], want: 'nodeath' },
    { medals: ['relic', 'shards', 'par', 'nodeath'], want: null },
  ])('recommends $want after earning $medals', ({ medals, want }) => {
    expect(resolveGoal(level(), record({ medals }))).toBe(want);
  });

  it('uses recorded medals, not best collectible totals or stars from other attempts', () => {
    expect(resolveGoal(level(), record({ relics: 1, bestShards: 2, stars: 3, deaths: 0 }))).toBe('relic');
    expect(resolveGoal(level(), record({ medals: ['bogus', 'relic', 'relic'] }))).toBe('shards');
  });

  it('skips empty categories and considers a zone mastered once its attainable medals are earned', () => {
    const def = level({ rows: ['P.G', '###'] });
    expect(resolveGoal(def, record())).toBe('par');
    expect(resolveGoal(def, record({ medals: ['par'] }))).toBe('nodeath');
    expect(resolveGoal(def, record({ medals: ['par', 'nodeath'] }))).toBeNull();
    expect(resolveGoal(def, record(), 'shards')).toBeNull();
    expect(resolveGoal(def, record(), 'relic')).toBeNull();
  });

  it('honors free play and allows an explicit attainable goal before or after mastery', () => {
    expect(resolveGoal(level(), undefined, 'free')).toBeNull();
    expect(resolveGoal(level(), record(), 'free')).toBeNull();
    for (const id of GOALS) {
      expect(resolveGoal(level(), undefined, id)).toBe(id);
      expect(resolveGoal(level(), record({ medals: [...GOALS] }), id)).toBe(id);
    }
  });

  it('does not change level definitions, medal records, or later recommendations', () => {
    const def = freeze(level());
    const rec = freeze(record({ medals: ['relic'] }));
    const before = structuredClone({ def, rec });
    availableGoals(def).splice(0);
    expect(availableGoals(def)).toEqual(GOALS);
    expect(resolveGoal(def, rec)).toBe('shards');
    expect({ def, rec }).toEqual(before);
  });
});

describe('live and finished goal evaluation', () => {
  it('returns no view for free play', () => {
    expect(evaluateGoal(null, snapshot())).toBeNull();
  });

  it.each(GOALS)('labels %s with its existing medal name and readable clear condition', (id) => {
    expect(evaluateGoal(id, snapshot())?.label).toBe(MEDAL_KR[id]);
    expect(GOAL_DESCRIPTIONS[id]).toContain('클리어');
  });

  it.each(GOALS)('requires both finish and clear to complete %s', (id) => {
    const collected = { shards: 2, relics: 1 };
    const liveState = id === 'shards' || id === 'relic' ? 'ready' : 'active';
    for (const cleared of [false, true]) {
      const view = evaluateGoal(id, snapshot({ ...collected, cleared }));
      expect(view?.state).toBe(liveState);
      expect(view?.detail).not.toMatch(/메달\s*획득/);
    }
    expect(evaluateGoal(id, snapshot({ ...collected, finished: true }))?.state).toBe('missed');
    expect(evaluateGoal(id, snapshot({ ...collected, cleared: true, finished: true }))).toMatchObject({
      state: 'complete', practice: false,
    });
  });

  it('shows real collection fractions and keeps satisfied collections ready until clear', () => {
    expect(evaluateGoal('shards', snapshot({ shards: 1 }))).toMatchObject({ state: 'active', progress: 0.5 });
    expect(evaluateGoal('relic', snapshot())).toMatchObject({ state: 'active', progress: 0 });
    for (const id of ['shards', 'relic'] as const) {
      const view = evaluateGoal(id, snapshot({ shards: 2, relics: 1 }));
      expect(view).toMatchObject({ state: 'ready', progress: 1 });
      expect(view?.detail).toContain('클리어');
      expect(evaluateGoal(id, snapshot({ shards: 20, relics: 3 }))?.progress).toBe(1);
    }
  });

  it('never treats zero shards out of zero as collection readiness or a medal', () => {
    expect(evaluateGoal('shards', snapshot({ totalShards: 0 }))).toMatchObject({ state: 'active', progress: 0 });
    expect(evaluateGoal('shards', snapshot({ totalShards: 0, cleared: true, finished: true }))).toMatchObject({
      state: 'missed', progress: 0,
    });
  });

  it.each([
    { time: 45 - 1 / 120, live: 'active', end: 'complete' },
    { time: 45, live: 'active', end: 'complete' },
    { time: 45 + 1 / 120, live: 'missed', end: 'missed' },
  ])('checks par strictly against elapsed seconds at $time', ({ time, live, end }) => {
    // Deliberately mismatched ticks: medalsFor awards from time, without rounding or tolerance.
    expect(evaluateGoal('par', snapshot({ time, ticks: 999_999 }))?.state).toBe(live);
    expect(evaluateGoal('par', snapshot({ time, ticks: 1, cleared: true, finished: true }))?.state).toBe(end);
  });

  it('shows remaining par time and leaves nodeath progress indeterminate', () => {
    expect(evaluateGoal('par', snapshot({ time: 0 }))?.progress).toBe(1);
    expect(evaluateGoal('par', snapshot({ time: 22.5 }))?.progress).toBe(0.5);
    expect(evaluateGoal('par', snapshot({ time: 45 }))?.progress).toBe(0);
    expect(evaluateGoal('par', snapshot({ time: 46 }))?.progress).toBe(0);
    expect(evaluateGoal('nodeath', snapshot())?.progress).toBeNull();
    expect(evaluateGoal('nodeath', snapshot({ deaths: 1 }))?.progress).toBeNull();
  });

  it('keeps cumulative death/time failures missed after checkpoints; a fresh run resets them', () => {
    expect(evaluateGoal('nodeath', snapshot({ deaths: 1 }))?.state).toBe('missed');
    expect(evaluateGoal('nodeath', snapshot({ deaths: 1, time: 20 }))?.state).toBe('missed');
    expect(evaluateGoal('par', snapshot({ time: 46 }))?.state).toBe('missed');
    expect(evaluateGoal('par', snapshot({ time: 47, deaths: 1 }))?.state).toBe('missed');
    expect(evaluateGoal('nodeath', snapshot({ time: 0 }))?.state).toBe('active');
    expect(evaluateGoal('par', snapshot({ time: 0 }))?.state).toBe('active');
  });

  it.each([
    { over: {}, want: ['nodeath', 'par', 'shards', 'relic'] },
    { over: { deaths: 1 }, want: ['par', 'shards', 'relic'] },
    { over: { time: 46 }, want: ['nodeath', 'shards', 'relic'] },
    { over: { shards: 1 }, want: ['nodeath', 'par', 'relic'] },
    { over: { relics: 0 }, want: ['nodeath', 'par', 'shards'] },
    { over: { cleared: false }, want: [] },
  ])('agrees with the normative medal rules for a finished run: $over', ({ over, want }) => {
    const s = snapshot({ finished: true, cleared: true, shards: 2, relics: 1, ...over });
    const complete = GOALS.filter((id) => evaluateGoal(id, s)?.state === 'complete');
    expect(complete).toEqual(want);
    expect(complete).toEqual(medalsFor(s));
  });

  it.each(GOALS)('marks unrecorded %s challenge states as practice without claiming a medal', (id) => {
    const attempts = [
      snapshot(),
      snapshot({ shards: 2, relics: 1 }),
      snapshot({ deaths: 1, time: 46, finished: true }),
      snapshot({ shards: 2, relics: 1, cleared: true, finished: true }),
    ];
    for (const s of attempts) {
      const view = evaluateGoal(id, { ...s, eligible: false });
      expect(view?.practice).toBe(true);
      expect(view?.detail).toMatch(/기록 없는 도전|연습 목표/);
      expect(view?.detail).not.toMatch(/메달\s*(획득|달성|완료)|보상\s*(획득|지급)/);
      expect(view?.state).toBe(evaluateGoal(id, s)?.state);
    }
  });

  it('allows real goal success when local recording is eligible, including normal assisted clears', () => {
    // Scenes supplies !run.raceLocked here; assist/invincible do not make a local clear unrecordable.
    const s = snapshot({ eligible: true, cleared: true, finished: true, shards: 2, relics: 1 });
    for (const id of GOALS) {
      const view = evaluateGoal(id, s);
      expect(view).toMatchObject({ state: 'complete', practice: false });
      expect(view?.detail).not.toMatch(/기록 없는 도전|연습 목표/);
    }
  });

  it.each([NaN, Infinity, -Infinity, -3, 1e300])('keeps display progress finite and bounded for %s', (value) => {
    const attempts = [
      snapshot({ time: value, shards: value, relics: value, deaths: value }),
      snapshot({ par: value, totalShards: value }),
    ];
    for (const s of attempts) for (const id of GOALS) {
      const view = evaluateGoal(id, s)!;
      if (view.progress !== null) {
        expect(Number.isFinite(view.progress)).toBe(true);
        expect(view.progress).toBeGreaterThanOrEqual(0);
        expect(view.progress).toBeLessThanOrEqual(1);
      }
      expect(view.detail).not.toMatch(/NaN|Infinity|undefined/);
    }
  });

  it('does not mutate snapshots or retain caller changes to returned views', () => {
    const s = freeze(snapshot({ shards: 2, relics: 1, cleared: true, finished: true }));
    const before = structuredClone(s);
    for (const id of GOALS) {
      const view = evaluateGoal(id, s)!;
      view.state = 'missed';
      view.detail = 'caller edit';
      expect(evaluateGoal(id, s)?.state).toBe('complete');
    }
    expect(s).toEqual(before);
  });
});

describe('skin milestone projections', () => {
  it('shows three available starters and seven earned costumes with honest starting progress', () => {
    const rows = skinMilestones(progress(), defaultSettings(), LEVELS);
    expect(rows.map(({ id, available, current, target }) => [id, available, current, target])).toEqual([
      ['clawd', true, 1, 1],
      ['rabbit', true, 1, 1],
      ['robot', true, 1, 1],
      ['azure', false, 0, 6],
      ['ember', false, 0, 1],
      ['void', false, 0, 1],
      ['coral', false, 0, 12],
      ['frost', false, 0, 1],
      ['gold', false, 0, 16],
      ['nova', false, 0, 3],
    ]);
    for (const row of rows) {
      expect(row.unit.trim().length).toBeGreaterThan(0);
      expect(row.hint.trim().length).toBeGreaterThan(0);
    }
    expect(rows.find((row) => row.id === 'gold')?.hint).toContain('16');
  });

  it.each([{ stars: 5, available: false }, { stars: 6, available: true }])(
    'projects azure at $stars stars',
    ({ stars, available }) => {
      const p = progress({ t1: record({ stars: 3 }), t2: record({ stars: stars - 3 }) });
      expect(skinMilestones(p, defaultSettings(), LEVELS).find((row) => row.id === 'azure')).toMatchObject({
        available, current: stars, target: 6, unit: '별',
      });
    },
  );

  it('counts story stars with the existing per-zone cap and excludes unrelated records', () => {
    const p = progress({
      t1: record({ stars: 99 }), t2: record({ stars: 3 }), t3: record({ stars: 3 }),
      daily: record({ stars: 3, medals: [...GOALS] }),
    });
    const rows = skinMilestones(p, defaultSettings(), LEVELS);
    expect(rows.find((row) => row.id === 'azure')).toMatchObject({ available: true, current: 9, target: 6 });
    expect(rows.find((row) => row.id === 'coral')?.current).toBe(0);
  });

  it.each([
    { id: 'ember', clears: 3, current: 0, available: false },
    { id: 'ember', clears: 4, current: 1, available: true },
    { id: 'frost', clears: 11, current: 0, available: false },
    { id: 'frost', clears: 12, current: 1, available: true },
  ])('projects $id after $clears cleared zones', ({ id, clears, current, available }) => {
    expect(skinMilestones(completed(clears), defaultSettings(), LEVELS).find((row) => row.id === id)).toMatchObject({
      available, current, target: 1,
    });
  });

  it('keeps frost locked when the supplied tower has no summit zones', () => {
    expect(skinMilestones(completed(12), defaultSettings(), LEVELS.slice(0, 12)).find((row) => row.id === 'frost')).toMatchObject({
      available: false, current: 0, target: 1,
    });
  });

  it.each([{ medals: 11, available: false }, { medals: 12, available: true }])(
    'projects coral at $medals medals, ignoring duplicates and unknown medals',
    ({ medals, available }) => {
      const p = progress({
        t1: record({ medals: [...GOALS] }),
        t2: record({ medals: [...GOALS] }),
        t3: record({ medals: [...GOALS.slice(0, medals - 8), 'nodeath', 'bogus'] }),
      });
      expect(skinMilestones(p, defaultSettings(), LEVELS).find((row) => row.id === 'coral')).toMatchObject({
        available, current: medals, target: 12, unit: '메달',
      });
    },
  );

  it.each([
    { ranks: 0, voidAvailable: false, novaAvailable: false },
    { ranks: 1, voidAvailable: true, novaAvailable: false },
    { ranks: 2, voidAvailable: true, novaAvailable: false },
    { ranks: 3, voidAvailable: true, novaAvailable: true },
  ])('projects void and nova from $ranks S ranks', ({ ranks, voidAvailable, novaAvailable }) => {
    const p = progress({
      ...Object.fromEntries(LEVELS.slice(0, ranks).map((def) => [def.id, ranked('S')])),
      m4: ranked('A'),
    });
    const rows = skinMilestones(p, defaultSettings(), LEVELS);
    expect(rows.find((row) => row.id === 'void')).toMatchObject({ available: voidAvailable, current: ranks, target: 1 });
    expect(rows.find((row) => row.id === 'nova')).toMatchObject({ available: novaAvailable, current: ranks, target: 3 });
  });

  it('preserves the existing rank counter scope even for records outside the supplied zone list', () => {
    const p = progress({ old_zone: ranked('S') });
    expect(skinMilestones(p, defaultSettings(), LEVELS).find((row) => row.id === 'void')).toMatchObject({
      available: true, current: 1, target: 1,
    });
  });

  it.each([{ clears: 15, available: false }, { clears: 16, available: true }])(
    'projects gold from $clears cleared story zones',
    ({ clears, available }) => {
      const p = completed(clears);
      p.levels.unlisted = record();
      if (clears === 15) p.levels.m4 = record({ done: false });
      expect(skinMilestones(p, defaultSettings(), LEVELS).find((row) => row.id === 'gold')).toMatchObject({
        available, current: clears, target: 16, unit: '구역',
      });
    },
  );

  it('uses the supplied zone count for gold without unlocking an empty tower', () => {
    expect(skinMilestones(completed(12), defaultSettings(), LEVELS.slice(0, 12)).find((row) => row.id === 'gold')).toMatchObject({
      available: true, current: 12, target: 12,
    });
    const empty = skinMilestones(progress(), defaultSettings(), []);
    expect(empty).toHaveLength(10);
    expect(empty.find((row) => row.id === 'gold')).toMatchObject({ available: false, current: 0, target: 0 });
  });

  it('keeps recorded and grandfathered skins available without fabricating earned progress', () => {
    const p = progress({}, { unlockedSkins: ['azure', 'void', 'gold', 'unknown_skin'] });
    const settings = { ...defaultSettings(), skin: 'nova' };
    const rows = skinMilestones(p, settings, LEVELS);
    expect(rows.filter((row) => row.available).map((row) => row.id)).toEqual(['clawd', 'rabbit', 'robot', 'azure', 'void', 'gold', 'nova']);
    expect(rows.find((row) => row.id === 'nova')).toMatchObject({ available: true, current: 0, target: 3 });
    for (const id of ['azure', 'void', 'gold']) {
      expect(rows.find((row) => row.id === id)).toMatchObject({ available: true, current: 0 });
    }
    expect(rows).toHaveLength(10);
  });

  it('matches availableSkins for every rule and retains exact counters above the thresholds', () => {
    const all = completed(16, { stars: 3, medals: [...GOALS] });
    for (const rec of Object.values(all.levels)) Object.assign(rec, { bestRank: 'S' });
    const settings = defaultSettings();
    for (const p of [progress(), completed(4), all, progress({}, { unlockedSkins: ['nova'] })]) {
      const available = availableSkins(p, settings, LEVELS);
      for (const row of skinMilestones(p, settings, LEVELS)) expect(row.available).toBe(available.has(row.id));
    }
    const rows = skinMilestones(all, settings, LEVELS);
    expect(rows.every((row) => row.available)).toBe(true);
    expect(rows.find((row) => row.id === 'azure')?.current).toBe(48);
    expect(rows.find((row) => row.id === 'coral')?.current).toBe(64);
    expect(rows.find((row) => row.id === 'void')?.current).toBe(16);
    expect(rows.find((row) => row.id === 'nova')?.current).toBe(16);
  });

  it('never writes progress, settings, levels, or a shared milestone array', () => {
    const p = freeze(completed(4, { stars: 3, medals: [...GOALS] }));
    const settings = freeze(defaultSettings());
    const levels = freeze(structuredClone(LEVELS));
    const before = structuredClone({ p, settings, levels });
    const rows = skinMilestones(p, settings, levels);
    const expected = structuredClone(rows);
    rows[0].current = -1;
    rows.pop();
    expect(skinMilestones(p, settings, levels)).toEqual(expected);
    expect({ p, settings, levels }).toEqual(before);
    expect(p.unlockedSkins).toBeUndefined();
  });
});
