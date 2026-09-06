/**
 * tools/solve.ts building blocks that do not need a search: the CLI parser, the
 * pacing schedule, the safe-spot predicate and the reference table. The corpus
 * itself is checked in test/levels/solutions.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { INTRO_TICKS, Sim } from '../../src/sim/sim.js';
import { decodeMasks } from '../../src/sim/replay.js';
import { LEVEL_BY_ID } from '../../src/sim/levels.generated.js';
import { readSolution } from '../../levels/solutions.js';
import { Schedule, isSafeSpot, parseArgs, referenceFrom } from '../../tools/solve.js';
import type { PaceSpec } from '../../tools/solve.js';

const t1 = LEVEL_BY_ID.t1;

describe('tools/solve — CLI parsing', () => {
  it('accepts --name=value, --name value, boolean flags and zone ids in any order', () => {
    const { flags, ids } = parseArgs(['t1', '--pace', '1.0', '--pace-tolerance=0.075', '--no-dash-chain', '--out', 'levels/solutions/par', 't2', '--budget=120']);
    expect(ids).toEqual(['t1', 't2']);
    expect(flags.get('pace')).toBe('1.0');
    expect(flags.get('pace-tolerance')).toBe('0.075');
    expect(flags.get('no-dash-chain')).toBe('true');
    expect(flags.get('out')).toBe('levels/solutions/par');
    expect(flags.get('budget')).toBe('120');
  });

  it('--pace before a zone id takes the default, not the id', () => {
    const { flags, ids } = parseArgs(['--pace', 't1', '--force']);
    expect(flags.get('pace')).toBe('');
    expect(flags.has('force')).toBe(true);
    expect(ids).toEqual(['t1']);
  });

  it('rejects unknown options', () => {
    expect(() => parseArgs(['--speed=2'])).toThrow(/unknown option/);
  });
});

describe('tools/solve — pacing schedule', () => {
  const fast = readSolution('t1', 'fast');

  it('referenceFrom: the tick a route first reaches a potential is non-increasing in the potential', () => {
    if (!fast) return;
    const ref = referenceFrom(t1, decodeMasks(fast.masks));
    expect(ref.pot0).toBeGreaterThan(0);
    expect(ref.refTicks(ref.pot0)).toBe(0);
    expect(ref.refTicks(0)).toBe(ref.refTotal);
    let prev = ref.refTicks(ref.pot0);
    for (let p = ref.pot0; p >= 0; p -= ref.pot0 / 50) {
      const t = ref.refTicks(p);
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
  });

  it('Schedule: spends the pause budget over the first 80 % of the route, ends on the target, and potAt inverts at', () => {
    if (!fast) return;
    const ref = referenceFrom(t1, decodeMasks(fast.masks));
    const targetTicks = Math.round(1.025 * t1.par * 120) + INTRO_TICKS;
    const spec: PaceSpec = { targetTicks, minTicks: 0, refTicks: ref.refTicks, refTotal: ref.refTotal, leadTicks: 600 };
    const s = new Schedule(spec, ref.pot0);
    expect(s.wait).toBe(targetTicks - ref.refTotal);
    expect(s.at(ref.pot0)).toBeCloseTo(s.wait * 0.05, 6);            // a twentieth of the pauses before the first step
    expect(s.at(0)).toBeCloseTo(targetTicks, 6);                       // the finish is the target
    expect(s.at(ref.pot0 * 0.2)).toBeCloseTo(s.wait + ref.refTicks(ref.pot0 * 0.2), 6);   // the tail is run at reference speed
    // monotone: later potentials are scheduled later
    let prev = s.at(ref.pot0);
    for (let p = ref.pot0; p >= 0; p -= ref.pot0 / 40) { expect(s.at(p)).toBeGreaterThanOrEqual(prev); prev = s.at(p); }
    // potAt inverts at
    for (const p of [ref.pot0 * 0.9, ref.pot0 * 0.5, ref.pot0 * 0.3]) expect(s.potAt(s.at(p))).toBeCloseTo(p, 3);
    expect(s.potAt(0)).toBe(ref.pot0);
    expect(s.potAt(targetTicks + 1)).toBe(0);
    // the lead is full early, gone in the tail
    expect(s.lead(ref.pot0)).toBe(600);
    expect(s.lead(ref.pot0 * 0.1)).toBe(0);
    expect(s.ahead(ref.pot0 * 0.5, s.at(ref.pot0 * 0.5) - 120)).toBe(120);
  });
});

describe('tools/solve — safe spot', () => {
  it('the t1 spawn is a safe spot once the intro is over; mid-air is not; a tide zone never is', () => {
    const sim = new Sim(t1, { seed: t1.seed });
    for (let i = 0; i < INTRO_TICKS + 5; i++) sim.step(0);
    expect(sim.state.player.grounded).toBe(true);
    expect(isSafeSpot(sim)).toBe(true);
    sim.step(16);   // jump
    for (let i = 0; i < 6; i++) sim.step(16);
    expect(sim.state.player.grounded).toBe(false);
    expect(isSafeSpot(sim)).toBe(false);
    const tide = new Sim({ ...t1, tide: true }, { seed: t1.seed });
    for (let i = 0; i < INTRO_TICKS + 5; i++) tide.step(0);
    expect(isSafeSpot(tide)).toBe(false);
  });

  it('a foe within 200 units makes a spot unsafe', () => {
    // t1 has a walker at tile 24 on the start ground: walk right until it is within reach
    const sim = new Sim(t1, { seed: t1.seed });
    for (let i = 0; i < INTRO_TICKS + 5; i++) sim.step(0);
    let steps = 0;
    while (steps++ < 600 && isSafeSpot(sim)) sim.step(2);
    const p = sim.state.player;
    const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
    expect(isSafeSpot(sim)).toBe(false);
    expect(sim.state.foes.some((f) => Math.hypot(f.x - cx, f.y - cy) < 200)).toBe(true);
  });
});
