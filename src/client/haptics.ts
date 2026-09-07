/**
 * Haptics — vibration on impacts (P3-8).
 *
 * `EVENT_HAPTIC` is a total function over `SimEvent['type']`: every event type
 * maps to a vibration pattern (ms on, off, on… as `navigator.vibrate` reads
 * it) or to null when it is silent. A land only buzzes past LAND_MIN_IMPACT.
 *
 * Two limiters keep a phone from humming: a per-event gate mirroring the sfx
 * GATE_MS (two lands inside 60 ms are one pulse), and a token-bucket budget of
 * BUDGET_MS_PER_S milliseconds of vibration per second that may burst up to
 * BUDGET_BURST_MS — so a death or a goal always plays after a quiet second
 * while a hail of small pulses is thinned out.
 *
 * Output goes to `navigator.vibrate` and to the first connected gamepad's
 * `vibrationActuator.playEffect('dual-rumble')`; both are optional and every
 * failure is swallowed. Nothing here touches the sim.
 */
import type { SimEvent } from '../sim/types.js';
import type { Settings } from './contracts.js';

export type HapticPattern = readonly number[];

/** Event → pattern; null = no vibration. The test suite asserts every SimEvent type is listed. */
export const EVENT_HAPTIC: Readonly<Record<SimEvent['type'], HapticPattern | null>> = {
  phase: null,
  jump: null,
  /** Only past LAND_MIN_IMPACT (see patternFor). */
  land: [8],
  dash: [12],
  dashEnd: null,
  wallJump: [10],
  wallSlide: null,
  stomp: null,
  stompLand: [14],
  shard: null,
  relic: [12, 40, 24],
  crystal: [6],
  toggle: [8],
  checkpoint: [15],
  spring: [10],
  hurt: [24],
  death: [30, 40, 60],
  respawn: null,
  goal: [20, 60, 20, 60, 80],
  foeHit: [8],
  foeKilled: [12],
  bubblePop: [10],
  bubbleBack: null,
  bolt: null,
  crumble: [6],
  splash: [8],
  tideOver: [40, 60, 90],
};

/** A landing softer than this (0..1) is not felt. */
export const LAND_MIN_IMPACT = 0.5;
/** Minimum spacing (ms) between two pulses of the same event type — the sfx gate, mirrored. */
export const GATE_MS: Readonly<Partial<Record<SimEvent['type'], number>>> = {
  land: 60, dash: 40, foeHit: 50, crumble: 90, splash: 120, crystal: 80, toggle: 80, wallJump: 40,
};
/** Long-run vibration allowance, ms of "on" time per second. */
export const BUDGET_MS_PER_S = 80;
/** Largest burst the budget allows (the longest pattern must fit, or it could never play). */
export const BUDGET_BURST_MS = 200;
/** Rumble magnitude reaches 1 at this many ms of the longest "on" segment. */
const RUMBLE_FULL_MS = 60;

/** Milliseconds the motor is on in a pattern (even indices). */
export function patternOnMs(p: HapticPattern): number {
  let sum = 0;
  for (let i = 0; i < p.length; i += 2) sum += p[i];
  return sum;
}

/** Wall-clock length of a pattern, pauses included. */
export function patternTotalMs(p: HapticPattern): number {
  let sum = 0;
  for (const v of p) sum += v;
  return sum;
}

/** The pattern an event plays, after the per-event rules (a soft land is silent). */
export function patternFor(ev: SimEvent): HapticPattern | null {
  const p = EVENT_HAPTIC[ev.type];
  if (!p) return null;
  if (ev.type === 'land' && !(ev.impact > LAND_MIN_IMPACT)) return null;
  return p;
}

// ---------------------------------------------------------------- platform
export type VibrateFn = (pattern: number[]) => boolean;

/** The slice of Gamepad / GamepadHapticActuator the rumble path reads. */
export interface RumbleActuatorLike {
  playEffect(type: 'dual-rumble', params: {
    startDelay?: number; duration: number; strongMagnitude: number; weakMagnitude: number;
  }): unknown;
}
export interface RumblePadLike {
  connected?: boolean;
  vibrationActuator?: RumbleActuatorLike | null;
}
export type PadSource = () => ReadonlyArray<RumblePadLike | null>;

export interface HapticsOptions {
  /** Default: `navigator.vibrate` (resolved at call time); `null` = no vibration output. */
  vibrate?: VibrateFn | null;
  /** Default: `navigator.getGamepads()`; `null` = no rumble output. */
  getGamepads?: PadSource | null;
  /** Milliseconds clock for gates and the budget (default performance.now / Date.now). */
  now?: () => number;
}

/** What the shell calls: one line in Scenes.tick and one in applySettings. */
export interface HapticsPort {
  onEvent(ev: SimEvent): void;
  applySettings(s: Pick<Settings, 'haptics'>): void;
}

function defaultVibrate(): VibrateFn | null {
  const nav = (globalThis as { navigator?: { vibrate?: (p: number | number[]) => boolean } }).navigator;
  if (!nav || typeof nav.vibrate !== 'function') return null;
  return (p) => { try { return !!nav.vibrate!(p); } catch { return false; } };
}

function defaultPads(): PadSource | null {
  const nav = (globalThis as { navigator?: { getGamepads?: () => ReadonlyArray<RumblePadLike | null> } }).navigator;
  if (!nav || typeof nav.getGamepads !== 'function') return null;
  return () => { try { return nav.getGamepads!() ?? []; } catch { return []; } };
}

function defaultNow(): () => number {
  const p = (globalThis as { performance?: { now?: () => number } }).performance;
  return p && typeof p.now === 'function' ? () => p.now!() : () => Date.now();
}

// ---------------------------------------------------------------- engine
export class Haptics implements HapticsPort {
  /** Settings.haptics as last applied; false until applySettings says otherwise. */
  enabled = false;
  /** Patterns actually played this session (tests and diagnostics). */
  pulses = 0;

  private readonly vibrateOpt: VibrateFn | null | undefined;
  private readonly padsOpt: PadSource | null | undefined;
  private readonly now: () => number;
  private readonly lastAt = new Map<SimEvent['type'], number>();
  private budget = BUDGET_BURST_MS;
  private budgetAt: number;

  constructor(opts: HapticsOptions = {}) {
    this.vibrateOpt = opts.vibrate;
    this.padsOpt = opts.getGamepads;
    this.now = opts.now ?? defaultNow();
    this.budgetAt = this.now();
  }

  applySettings(s: Pick<Settings, 'haptics'>): void {
    this.enabled = s.haptics === true;
  }

  /** Vibration time (ms) the budget would still allow right now. */
  get budgetLeft(): number {
    this.refill(this.now());
    return this.budget;
  }

  /** Dispatch a sim event; returns whether a pattern was played. */
  onEvent(ev: SimEvent): boolean {
    if (!this.enabled) return false;
    const p = patternFor(ev);
    if (!p) return false;
    const t = this.now();
    const gate = GATE_MS[ev.type];
    const last = this.lastAt.get(ev.type);
    if (gate !== undefined && last !== undefined && t - last < gate) return false;
    this.refill(t);
    const on = patternOnMs(p);
    if (on > this.budget) return false;
    this.budget -= on;
    this.lastAt.set(ev.type, t);
    this.play(p);
    this.pulses++;
    return true;
  }

  /** Forget gates and refill the budget (a new run). */
  reset(): void {
    this.lastAt.clear();
    this.budget = BUDGET_BURST_MS;
    this.budgetAt = this.now();
  }

  private refill(t: number): void {
    const dt = t - this.budgetAt;
    if (dt <= 0) return;
    this.budgetAt = t;
    this.budget = Math.min(BUDGET_BURST_MS, this.budget + (dt / 1000) * BUDGET_MS_PER_S);
  }

  private play(p: HapticPattern): void {
    const pattern = [...p];
    const vibrate = this.vibrateOpt === undefined ? defaultVibrate() : this.vibrateOpt;
    if (vibrate) { try { vibrate(pattern); } catch { /* the platform refused (no user activation) */ } }
    this.rumble(pattern);
  }

  /** The first connected pad with an actuator gets one dual-rumble effect spanning the pattern. */
  private rumble(p: number[]): void {
    const pads = this.padsOpt === undefined ? defaultPads() : this.padsOpt;
    if (!pads) return;
    let list: ReadonlyArray<RumblePadLike | null>;
    try { list = pads(); } catch { return; }
    for (const pad of list) {
      if (!pad || pad.connected === false) continue;
      const act = pad.vibrationActuator;
      if (!act || typeof act.playEffect !== 'function') continue;
      let peak = 0;
      for (let i = 0; i < p.length; i += 2) peak = Math.max(peak, p[i]);
      const strong = Math.min(1, peak / RUMBLE_FULL_MS);
      try {
        const r = act.playEffect('dual-rumble', {
          startDelay: 0, duration: Math.max(1, patternTotalMs(p)), strongMagnitude: strong, weakMagnitude: Math.min(1, strong * 0.6 + 0.3),
        });
        const maybe = r as { catch?: (fn: () => void) => unknown } | null;
        if (maybe && typeof maybe.catch === 'function') maybe.catch(() => undefined);
      } catch { /* an actuator that does not do dual-rumble */ }
      return;
    }
  }
}
