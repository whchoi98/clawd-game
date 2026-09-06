// @vitest-environment happy-dom
/**
 * Haptics (P3-8): the event → pattern table is total over SimEvent, patterns
 * stay short, the per-event gate and the per-second budget thin repeated
 * pulses, the setting gates everything, and the output reaches
 * navigator.vibrate and a gamepad's dual-rumble actuator.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SimEvent } from '../../src/sim/types.js';
import {
  BUDGET_BURST_MS, BUDGET_MS_PER_S, EVENT_HAPTIC, GATE_MS, Haptics, LAND_MIN_IMPACT, patternFor, patternOnMs, patternTotalMs,
  type RumblePadLike,
} from '../../src/client/haptics.js';
import { defaultHaptics } from '../../src/client/save.js';

/** Mirrors the SimEvent union in src/sim/types.ts; the type-level checks fail to compile when it drifts. */
const EVENT_TYPES = [
  'phase', 'jump', 'land', 'dash', 'dashEnd', 'wallJump', 'wallSlide', 'stomp', 'stompLand', 'shard', 'relic',
  'crystal', 'toggle', 'checkpoint', 'spring', 'hurt', 'death', 'respawn', 'goal', 'foeHit', 'foeKilled', 'bolt',
  'crumble', 'splash', 'tideOver',
] as const;
type EvType = (typeof EVENT_TYPES)[number];
const _missing: Exclude<SimEvent['type'], EvType> extends never ? true : never = true;
const _extra: Exclude<EvType, SimEvent['type']> extends never ? true : never = true;
void _missing; void _extra;

const summary = {
  levelId: 't1', cleared: true, ticks: 1200, time: 10, shards: 3, totalShards: 20, relics: 0, totalRelics: 1,
  deaths: 0, par: 45, rank: 'A' as const, height: 0,
};

function sampleEvent(type: EvType): SimEvent {
  const p = { x: 100, y: 100 };
  switch (type) {
    case 'phase': return { type, phase: 'play' };
    case 'jump': return { type, ...p, air: false };
    case 'land': return { type, ...p, impact: 0.8 };
    case 'dash': return { type, ...p, dx: 1, dy: 0 };
    case 'dashEnd': return { type, ...p };
    case 'wallJump': return { type, ...p, dir: 1 };
    case 'wallSlide': return { type, ...p, dir: -1 };
    case 'stomp': return { type, ...p };
    case 'stompLand': return { type, ...p };
    case 'shard': return { type, ...p, n: 1, total: 20, combo: 1 };
    case 'relic': return { type, ...p, n: 1, total: 1 };
    case 'crystal': return { type, ...p };
    case 'toggle': return { type, ...p, switchA: false };
    case 'checkpoint': return { type, ...p };
    case 'spring': return { type, ...p };
    case 'hurt': return { type, ...p, hp: 2 };
    case 'death': return { type, ...p, cause: 'pit', deaths: 1 };
    case 'respawn': return { type, ...p };
    case 'goal': return { type, ...p, summary };
    case 'foeHit': return { type, ...p, kind: 'walker' };
    case 'foeKilled': return { type, ...p, kind: 'hopper' };
    case 'bolt': return { type, ...p };
    case 'crumble': return { type, tx: 4, ty: 5 };
    case 'splash': return { type, ...p, enter: true };
    case 'tideOver': return { type, summary: { ...summary, cleared: false, height: 40 } };
  }
}

const death = (): SimEvent => sampleEvent('death');
const land = (impact = 0.9): SimEvent => ({ type: 'land', x: 0, y: 0, impact });

/** A Haptics with a manual clock and a recording vibrate; no gamepads unless given. */
function make(opts: { enabled?: boolean; pads?: RumblePadLike[] } = {}) {
  let t = 0;
  const vibrate = vi.fn((_p: number[]) => true);
  const h = new Haptics({ vibrate, getGamepads: opts.pads ? () => opts.pads! : null, now: () => t });
  h.applySettings({ haptics: opts.enabled ?? true });
  return { h, vibrate, advance: (ms: number) => { t += ms; } };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('EVENT_HAPTIC', () => {
  it('lists every SimEvent type exactly once, as a pattern or null', () => {
    for (const type of EVENT_TYPES) expect(type in EVENT_HAPTIC, `missing ${type}`).toBe(true);
    expect(Object.keys(EVENT_HAPTIC).sort()).toEqual([...EVENT_TYPES].sort());
    for (const [type, p] of Object.entries(EVENT_HAPTIC)) {
      if (p === null) continue;
      expect(Array.isArray(p) && p.length > 0, type).toBe(true);
      for (const v of p) expect(Number.isInteger(v) && v > 0, `${type} segment ${v}`).toBe(true);
    }
  });

  it('follows the roadmap patterns and keeps every pattern within 200 ms of motor time', () => {
    expect(EVENT_HAPTIC.land).toEqual([8]);
    expect(EVENT_HAPTIC.dash).toEqual([12]);
    expect(EVENT_HAPTIC.wallJump).toEqual([10]);
    expect(EVENT_HAPTIC.death).toEqual([30, 40, 60]);
    expect(EVENT_HAPTIC.checkpoint).toEqual([15]);
    expect(EVENT_HAPTIC.goal).toEqual([20, 60, 20, 60, 80]);
    expect(EVENT_HAPTIC.shard).toBeNull();
    expect(EVENT_HAPTIC.phase).toBeNull();
    expect(EVENT_HAPTIC.jump).toBeNull();
    for (const [type, p] of Object.entries(EVENT_HAPTIC)) {
      if (!p) continue;
      expect(patternOnMs(p), `${type} motor time`).toBeLessThanOrEqual(200);
      expect(patternOnMs(p), `${type} must fit the burst budget`).toBeLessThanOrEqual(BUDGET_BURST_MS);
      expect(patternTotalMs(p), `${type} wall time`).toBeLessThanOrEqual(300);
    }
    // motor time counts the on-segments only: goal = 20 + 20 + 80
    expect(patternOnMs([20, 60, 20, 60, 80])).toBe(120);
    expect(patternTotalMs([20, 60, 20, 60, 80])).toBe(240);
  });

  it('a soft landing is silent, a hard one is not; every sample event resolves without throwing', () => {
    expect(patternFor(land(LAND_MIN_IMPACT))).toBeNull();
    expect(patternFor(land(0.2))).toBeNull();
    expect(patternFor(land(0.51))).toEqual([8]);
    for (const type of EVENT_TYPES) {
      const p = patternFor(sampleEvent(type));
      expect(p === null || Array.isArray(p)).toBe(true);
    }
  });
});

describe('Haptics', () => {
  it('death → navigator.vibrate once with the death pattern; nothing when haptics is off', () => {
    const on = make();
    expect(on.h.onEvent(death())).toBe(true);
    expect(on.vibrate).toHaveBeenCalledTimes(1);
    expect(on.vibrate.mock.calls[0][0]).toEqual([30, 40, 60]);
    expect(on.h.pulses).toBe(1);

    const off = make({ enabled: false });
    expect(off.h.onEvent(death())).toBe(false);
    off.h.onEvent(sampleEvent('goal'));
    expect(off.vibrate).not.toHaveBeenCalled();
    expect(off.h.pulses).toBe(0);
  });

  it('applySettings follows Settings.haptics (undefined reads as off)', () => {
    const { h, vibrate } = make({ enabled: false });
    h.applySettings({});
    h.onEvent(death());
    expect(vibrate).not.toHaveBeenCalled();
    h.applySettings({ haptics: true });
    h.onEvent(death());
    expect(vibrate).toHaveBeenCalledTimes(1);
  });

  it('two lands within 40 ms are one pulse (the land gate is 60 ms, like the sfx gate)', () => {
    const { h, vibrate, advance } = make();
    expect(GATE_MS.land).toBe(60);
    expect(h.onEvent(land())).toBe(true);
    advance(40);
    expect(h.onEvent(land())).toBe(false);
    expect(vibrate).toHaveBeenCalledTimes(1);
    advance(30); // 70 ms after the first
    expect(h.onEvent(land())).toBe(true);
    expect(vibrate).toHaveBeenCalledTimes(2);
    // the gate is per event type: a dash right after a land still plays
    expect(h.onEvent(sampleEvent('dash'))).toBe(true);
  });

  it('silent events never reach the platform', () => {
    const { h, vibrate } = make();
    for (const t of ['phase', 'jump', 'shard', 'dashEnd', 'wallSlide', 'bolt', 'respawn', 'stomp'] as const) {
      expect(h.onEvent(sampleEvent(t))).toBe(false);
    }
    expect(vibrate).not.toHaveBeenCalled();
  });

  it('keeps the long-run motor time at or under 80 ms per second (token bucket, 200 ms burst)', () => {
    const { h, vibrate, advance } = make();
    expect(BUDGET_MS_PER_S).toBe(80);
    // A hail of stomp landings (14 ms each, no gate) every 20 ms for 10 s.
    let played = 0;
    for (let i = 0; i < 500; i++) {
      if (h.onEvent(sampleEvent('stompLand'))) played++;
      advance(20);
    }
    const motorMs = vibrate.mock.calls.reduce((s, c) => s + patternOnMs(c[0] as number[]), 0);
    expect(played).toBe(vibrate.mock.calls.length);
    // burst allowance + 10 s of refill, and clearly fewer than the 500 requested
    expect(motorMs).toBeLessThanOrEqual(BUDGET_BURST_MS + 10 * BUDGET_MS_PER_S + 14);
    expect(played).toBeLessThan(120);
    // the hail drained the bucket; 1.2 quiet seconds refill 96 ms — enough for a death (90 ms of motor time)
    expect(h.budgetLeft).toBeLessThan(14);
    advance(1200);
    expect(h.budgetLeft).toBeGreaterThanOrEqual(90);
    expect(h.onEvent(death())).toBe(true);
    // a goal (120 ms) right after a death is over the remaining budget → skipped, then plays once refilled
    expect(h.onEvent(sampleEvent('goal'))).toBe(false);
    advance(2000);
    expect(h.onEvent(sampleEvent('goal'))).toBe(true);
  });

  it('reset() forgets gates and refills the budget', () => {
    const { h } = make();
    h.onEvent(land());
    expect(h.onEvent(land())).toBe(false);
    h.reset();
    expect(h.onEvent(land())).toBe(true);
    expect(h.budgetLeft).toBeCloseTo(BUDGET_BURST_MS - 8, 5);
  });

  it('rumbles the first connected gamepad with a dual-rumble effect spanning the pattern, and survives a refusing actuator', () => {
    const playEffect = vi.fn(() => Promise.resolve('complete'));
    const rejecting = vi.fn(() => Promise.reject(new Error('no')));
    const pads: RumblePadLike[] = [
      null as unknown as RumblePadLike,
      { connected: false, vibrationActuator: { playEffect: vi.fn() } },
      { connected: true, vibrationActuator: { playEffect } },
      { connected: true, vibrationActuator: { playEffect: rejecting } },
    ];
    const { h, vibrate } = make({ pads });
    expect(h.onEvent(death())).toBe(true);
    expect(vibrate).toHaveBeenCalledTimes(1);
    expect(playEffect).toHaveBeenCalledTimes(1);
    const [type, params] = playEffect.mock.calls[0] as unknown as [string, { duration: number; strongMagnitude: number; weakMagnitude: number }];
    expect(type).toBe('dual-rumble');
    expect(params.duration).toBe(130);
    expect(params.strongMagnitude).toBeCloseTo(1, 5);
    expect(params.weakMagnitude).toBeLessThanOrEqual(1);
    expect(rejecting).not.toHaveBeenCalled(); // only the first connected pad
    // a pad whose promise rejects must not surface an unhandled rejection
    const only = make({ pads: [{ connected: true, vibrationActuator: { playEffect: rejecting } }] });
    expect(only.h.onEvent(sampleEvent('dash'))).toBe(true);
    expect(rejecting).toHaveBeenCalledTimes(1);
    // a throwing actuator is swallowed too
    const throwing = make({ pads: [{ connected: true, vibrationActuator: { playEffect: () => { throw new Error('boom'); } } }] });
    expect(throwing.h.onEvent(sampleEvent('dash'))).toBe(true);
  });

  it('uses navigator.vibrate by default (happy-dom) and stays quiet without one', () => {
    const vib = vi.fn((_p: number | number[]) => true);
    Object.defineProperty(navigator, 'vibrate', { value: vib, configurable: true, writable: true });
    try {
      const h = new Haptics({ getGamepads: null, now: () => 0 });
      h.applySettings({ haptics: true });
      expect(h.onEvent(death())).toBe(true);
      expect(vib).toHaveBeenCalledTimes(1);
      expect(vib.mock.calls[0][0]).toEqual([30, 40, 60]);
    } finally {
      delete (navigator as unknown as Record<string, unknown>).vibrate;
    }
    const silent = new Haptics({ getGamepads: null, now: () => 0 });
    silent.applySettings({ haptics: true });
    expect(() => silent.onEvent(death())).not.toThrow();
    expect(silent.pulses).toBe(1); // the pattern counts as played even when no motor exists
  });
});

describe('defaultHaptics', () => {
  it('is on for a coarse pointer, off under prefers-reduced-motion and on fine pointers', () => {
    expect(defaultHaptics(true, false)).toBe(true);
    expect(defaultHaptics(true, true)).toBe(false);
    expect(defaultHaptics(false, false)).toBe(false);
    expect(defaultHaptics(false, true)).toBe(false);
  });
});
