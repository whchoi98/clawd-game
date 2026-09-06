/**
 * Unified input — keyboard, gamepad and touch folded into the sim's per-tick
 * mask model.
 *
 * Design note — why an event queue instead of reading key state: a tap that
 * starts and ends inside a single frame (common at 144 Hz and on touch) would
 * be invisible to a naive prev/cur diff. DOM events are queued as they arrive
 * and drained once per frame in `poll()`, so no press is ever lost: it shows up
 * in `takeLatched()` even though `held()` never saw it. The game loop ORs the
 * latched bits into the first tick of the frame only, so each tap is worth
 * exactly one press edge inside the sim.
 */
import { IN, type InputMask } from '../../sim/types.js';
import type { BindAction, Binds, Device, InputPort, MenuAction, TouchState } from '../contracts.js';
import {
  DEFAULT_BINDS,
  PAD_DEADZONE,
  PAD_MAP,
  PAD_TRIGGER,
  TOUCH_THRESHOLD,
  cloneBinds,
  isOwnedCode,
  keyLabel,
} from './binds.js';

// ---------------------------------------------------------------- types
export interface GamepadButtonLike {
  readonly pressed: boolean;
  readonly value: number;
}

/** Structural subset of the DOM `Gamepad` so tests can feed fakes. */
export interface GamepadLike {
  readonly index: number;
  readonly connected?: boolean;
  readonly buttons: ReadonlyArray<GamepadButtonLike>;
  readonly axes: ReadonlyArray<number>;
}

export type GamepadSource = () => ReadonlyArray<GamepadLike | null>;

export interface InputOptions {
  binds?: Binds;
  /** Event target for keyboard / blur / gamepad-connection listeners. Default: `window`; `null` attaches nothing. */
  target?: EventTarget | null;
  /** Gamepad source. Default: `navigator.getGamepads()`, read at every poll. */
  getGamepads?: GamepadSource;
  /** Share the UI's TouchState object instead of creating a private one (see `attachTouch`). */
  touch?: TouchState;
}

export function makeTouchState(): TouchState {
  return { active: false, x: 0, y: 0, jump: false, dash: false, jumpPressed: false, dashPressed: false };
}

// ---------------------------------------------------------------- tables
/**
 * Bind action → sim mask bit. `restart` is a sim input too: a press edge is a
 * checkpoint retry inside the replay (the UI turns a ≥0.6 s hold into a full
 * zone restart on top of it).
 */
const ACTION_BIT: Readonly<Partial<Record<BindAction, InputMask>>> = {
  left: IN.LEFT, right: IN.RIGHT, up: IN.UP, down: IN.DOWN, jump: IN.JUMP, dash: IN.DASH, restart: IN.RETRY,
};

/** Bind action → menu action. Jump doubles as confirm (Z / A activate menu items). */
const MENU_OF: Readonly<Partial<Record<BindAction, MenuAction>>> = {
  left: 'left', right: 'right', up: 'up', down: 'down',
  confirm: 'confirm', cancel: 'cancel', pause: 'pause', restart: 'restart',
  jump: 'confirm',
};

type Dir = -1 | 0 | 1;

function dirOf(v: number, threshold: number): Dir {
  if (v > threshold) return 1;
  if (v < -threshold) return -1;
  return 0;
}

function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as { tagName?: unknown; isContentEditable?: unknown } | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

interface KeyEv { code: string; down: boolean }

// ---------------------------------------------------------------- class
export class Input implements InputPort {
  private _binds: Binds;
  private codeToActions = new Map<string, BindAction[]>();
  private owned = new Set<string>();

  // keyboard
  private readonly queue: KeyEv[] = [];
  /** Codes physically down as seen by the event handlers (dedupes repeats, drives blur release). */
  private readonly physDown = new Set<string>();
  /** Codes down after the last drain — what `held()` reflects. */
  private readonly keyDown = new Set<string>();
  private readonly kbActions = new Set<BindAction>();

  // gamepad
  private readonly getGamepads: GamepadSource | null;
  private readonly padActions = new Set<BindAction>();
  private padIndex = -1;
  private padPrevButtons: boolean[] = [];
  private readonly padPrevAxis: { x: Dir; y: Dir } = { x: 0, y: 0 };
  /** Buttons / axis directions that were active at `reset()`; ignored until they return to neutral. */
  private readonly padStaleButtons = new Set<number>();
  private readonly padStaleAxis: { x: Dir; y: Dir } = { x: 0, y: 0 };
  private _padConnected = false;

  // touch
  private _touch: TouchState;
  private readonly touchPrev: { jump: boolean; dash: boolean; x: Dir; y: Dir } = { jump: false, dash: false, x: 0, y: 0 };
  private touchMask: InputMask = 0;

  // outputs
  private heldMask: InputMask = 0;
  private latched: InputMask = 0;
  private menu: MenuAction[] = [];
  private captureFn: ((code: string | null) => void) | null = null;
  private _lastDevice: Device = 'keyboard';

  // listeners
  private readonly target: EventTarget | null;
  private readonly doc: EventTarget | null;
  private readonly listeners: Array<[EventTarget, string, EventListener]> = [];

  constructor(opts: InputOptions = {}) {
    this._binds = cloneBinds(opts.binds ?? DEFAULT_BINDS);
    this.rebuild();
    this._touch = opts.touch ?? makeTouchState();
    this.getGamepads = opts.getGamepads ?? null;

    const hasWindow = typeof window !== 'undefined';
    this.target = opts.target === undefined ? (hasWindow ? window : null) : opts.target;
    this.doc = hasWindow && this.target === window && typeof document !== 'undefined' ? document : null;

    if (this.target) {
      this.listen(this.target, 'keydown', this.onKeyDown, { passive: false });
      this.listen(this.target, 'keyup', this.onKeyUp);
      this.listen(this.target, 'blur', this.onBlur);
      this.listen(this.target, 'gamepadconnected', this.onPadConnected);
      this.listen(this.target, 'gamepaddisconnected', this.onPadDisconnected);
    }
    if (this.doc) this.listen(this.doc, 'visibilitychange', this.onVisibility);
  }

  // -------------------------------------------------------------- InputPort
  poll(): void {
    this.drainKeys();
    this.pollPad();
    this.pollTouch();
    this.heldMask = maskOf(this.kbActions) | maskOf(this.padActions) | this.touchMask;
  }

  held(): InputMask {
    return this.heldMask;
  }

  takeLatched(): InputMask {
    const l = this.latched;
    this.latched = 0;
    return l;
  }

  takeMenu(): MenuAction[] {
    if (this.menu.length === 0) return [];
    const m = this.menu;
    this.menu = [];
    return m;
  }

  menuHeld(a: MenuAction): boolean {
    switch (a) {
      case 'left': return (this.heldMask & IN.LEFT) !== 0;
      case 'right': return (this.heldMask & IN.RIGHT) !== 0;
      case 'up': return (this.heldMask & IN.UP) !== 0;
      case 'down': return (this.heldMask & IN.DOWN) !== 0;
      case 'confirm':
        return this.kbActions.has('confirm') || this.kbActions.has('jump') || this.padActions.has('jump');
      default:
        return this.kbActions.has(a) || this.padActions.has(a);
    }
  }

  setBinds(b: Binds): void {
    this._binds = cloneBinds(b);
    this.rebuild();
    // Keys held under the old map must not leak into the new one without a fresh press.
    this.physDown.clear();
    this.keyDown.clear();
    this.kbActions.clear();
  }

  capture(cb: (code: string | null) => void): void {
    this.captureFn = cb;
  }

  reset(): void {
    // keyboard
    this.queue.length = 0;
    this.physDown.clear();
    this.keyDown.clear();
    this.kbActions.clear();
    // gamepad: whatever is down now must be released before it counts again
    for (let b = 0; b < this.padPrevButtons.length; b++) if (this.padPrevButtons[b]) this.padStaleButtons.add(b);
    this.padStaleAxis.x = this.padPrevAxis.x;
    this.padStaleAxis.y = this.padPrevAxis.y;
    this.padActions.clear();
    // touch
    const t = this._touch;
    t.active = false; t.x = 0; t.y = 0;
    t.jump = false; t.dash = false;
    t.jumpPressed = false; t.dashPressed = false;
    this.touchPrev.jump = false; this.touchPrev.dash = false;
    this.touchPrev.x = 0; this.touchPrev.y = 0;
    this.touchMask = 0;
    // outputs
    this.heldMask = 0;
    this.latched = 0;
    this.menu = [];
  }

  get lastDevice(): Device {
    return this._lastDevice;
  }

  get touch(): TouchState {
    return this._touch;
  }

  keyLabel(code: string): string {
    return keyLabel(code);
  }

  // -------------------------------------------------------------- extras
  /** Deep copy of the current bindings (for the settings screen). */
  get binds(): Binds {
    return cloneBinds(this._binds);
  }

  get capturing(): boolean {
    return this.captureFn !== null;
  }

  cancelCapture(): void {
    this.captureFn = null;
  }

  /** True while at least one gamepad is reported by the platform. */
  get padConnected(): boolean {
    return this._padConnected;
  }

  /** Read virtual controls from the UI's own TouchState object from now on. */
  attachTouch(t: TouchState): void {
    this._touch = t;
    this.touchPrev.jump = t.jump; this.touchPrev.dash = t.dash;
    this.touchPrev.x = 0; this.touchPrev.y = 0;
  }

  /** Detach every DOM listener. The instance is inert afterwards. */
  dispose(): void {
    for (const [tgt, type, fn] of this.listeners) tgt.removeEventListener(type, fn);
    this.listeners.length = 0;
    this.captureFn = null;
  }

  // -------------------------------------------------------------- keyboard
  private listen(tgt: EventTarget, type: string, fn: EventListener, opts?: AddEventListenerOptions): void {
    tgt.addEventListener(type, fn, opts);
    this.listeners.push([tgt, type, fn]);
  }

  private rebuild(): void {
    this.codeToActions.clear();
    this.owned.clear();
    for (const action of Object.keys(this._binds) as BindAction[]) {
      for (const code of this._binds[action]) {
        let list = this.codeToActions.get(code);
        if (!list) this.codeToActions.set(code, (list = []));
        if (!list.includes(action)) list.push(action);
        if (isOwnedCode(code)) this.owned.add(code);
      }
    }
  }

  private readonly onKeyDown = (ev: Event): void => {
    const e = ev as KeyboardEvent;
    const code = e.code;
    if (!code) return;
    if (this.captureFn) {
      e.preventDefault();
      const fn = this.captureFn;
      this.captureFn = null;
      fn(code === 'Escape' ? null : code);
      return;
    }
    if (isEditableTarget(e.target)) return;
    // Space/arrows scroll the page and steal focus from the canvas otherwise —
    // including their auto-repeats, so this runs before the repeat filter.
    if (this.owned.has(code)) e.preventDefault();
    if (e.repeat || this.physDown.has(code)) return;
    // Browser shortcuts (Ctrl+R, Cmd+W …) keep their meaning.
    if (e.metaKey || (e.ctrlKey && !code.startsWith('Control'))) return;
    this.physDown.add(code);
    this.queue.push({ code, down: true });
  };

  private readonly onKeyUp = (ev: Event): void => {
    const e = ev as KeyboardEvent;
    if (!e.code) return;
    this.physDown.delete(e.code);
    // Always queued: a release is always safe, and it keeps `keyDown` honest
    // after a rebind, a reset or a press we chose to ignore.
    this.queue.push({ code: e.code, down: false });
  };

  private readonly onBlur = (): void => {
    this.releaseKeys();
  };

  private readonly onVisibility = (): void => {
    const d = this.doc as { visibilityState?: string } | null;
    if (d && d.visibilityState === 'hidden') this.releaseKeys();
  };

  private readonly onPadConnected = (): void => {
    this._padConnected = true;
  };

  private readonly onPadDisconnected = (): void => {
    this._padConnected = false;
  };

  private releaseKeys(): void {
    for (const code of this.physDown) this.queue.push({ code, down: false });
    this.physDown.clear();
  }

  private drainKeys(): void {
    const q = this.queue;
    for (let i = 0; i < q.length; i++) {
      const ev = q[i];
      if (ev.down) {
        if (this.keyDown.has(ev.code)) continue;
        this.keyDown.add(ev.code);
        const actions = this.codeToActions.get(ev.code);
        if (!actions) continue;
        this._lastDevice = 'keyboard';
        this.press(actions);
      } else {
        this.keyDown.delete(ev.code);
      }
    }
    q.length = 0;
    this.kbActions.clear();
    for (const code of this.keyDown) {
      const actions = this.codeToActions.get(code);
      if (actions) for (const a of actions) this.kbActions.add(a);
    }
  }

  /** Register a press edge for `actions`: latch the sim bits, queue menu actions once each. */
  private press(actions: readonly BindAction[]): void {
    let emitted: MenuAction[] | null = null;
    for (const a of actions) {
      this.latched |= ACTION_BIT[a] ?? 0;
      const m = MENU_OF[a];
      if (!m) continue;
      if (emitted === null) emitted = [];
      if (emitted.includes(m)) continue;
      emitted.push(m);
      this.menu.push(m);
    }
  }

  // -------------------------------------------------------------- gamepad
  private readPads(): ReadonlyArray<GamepadLike | null> {
    try {
      if (this.getGamepads) return this.getGamepads();
      if (typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function') {
        return navigator.getGamepads();
      }
    } catch {
      // getGamepads throws in frames without the gamepad permission policy.
    }
    return [];
  }

  private pollPad(): void {
    this.padActions.clear();
    let pad: GamepadLike | null = null;
    for (const p of this.readPads()) {
      if (p && p.connected !== false) { pad = p; break; } // first connected pad wins
    }
    this._padConnected = pad !== null;
    if (!pad) {
      this.padIndex = -1;
      this.padPrevButtons.length = 0;
      this.padPrevAxis.x = 0; this.padPrevAxis.y = 0;
      this.padStaleButtons.clear();
      this.padStaleAxis.x = 0; this.padStaleAxis.y = 0;
      return;
    }
    if (pad.index !== this.padIndex) {
      // A different pad took over: forget the old one's edge state.
      this.padIndex = pad.index;
      this.padPrevButtons.length = 0;
      this.padStaleButtons.clear();
    }

    const prev = this.padPrevButtons;
    const n = pad.buttons.length;
    for (let b = 0; b < n; b++) {
      const btn = pad.buttons[b];
      const on = !!btn && (btn.pressed || btn.value > PAD_TRIGGER);
      const was = prev[b] === true;
      prev[b] = on;
      if (!on) { this.padStaleButtons.delete(b); continue; }
      if (this.padStaleButtons.has(b)) continue;
      const action = PAD_MAP[b];
      if (!action) continue;
      this.padActions.add(action);
      if (!was) {
        this._lastDevice = 'gamepad';
        this.press([action]);
      }
    }

    this.padAxis('x', dirOf(pad.axes[0] ?? 0, PAD_DEADZONE), 'left', 'right');
    this.padAxis('y', dirOf(pad.axes[1] ?? 0, PAD_DEADZONE), 'up', 'down');
  }

  private padAxis(axis: 'x' | 'y', dir: Dir, neg: BindAction, pos: BindAction): void {
    const prevDir = this.padPrevAxis[axis];
    this.padPrevAxis[axis] = dir;
    if (dir === 0) { this.padStaleAxis[axis] = 0; return; }
    if (this.padStaleAxis[axis] === dir) return; // held through a reset: wait for neutral
    this.padStaleAxis[axis] = 0;
    const action = dir < 0 ? neg : pos;
    this.padActions.add(action);
    if (dir !== prevDir) {
      this._lastDevice = 'gamepad';
      this.press([action]);
    }
  }

  // -------------------------------------------------------------- touch
  private pollTouch(): void {
    const t = this._touch;
    const prev = this.touchPrev;
    let mask: InputMask = 0;
    let touched = false;

    // Edge flags set by the UI when a virtual button went down — even if it is
    // already up again — so a tap shorter than a frame still jumps.
    if (t.jumpPressed) { t.jumpPressed = false; this.latched |= IN.JUMP; touched = true; }
    if (t.dashPressed) { t.dashPressed = false; this.latched |= IN.DASH; touched = true; }

    if (t.jump) { mask |= IN.JUMP; if (!prev.jump) { this.latched |= IN.JUMP; touched = true; } }
    if (t.dash) { mask |= IN.DASH; if (!prev.dash) { this.latched |= IN.DASH; touched = true; } }
    prev.jump = t.jump;
    prev.dash = t.dash;

    const dx = t.active ? dirOf(t.x, TOUCH_THRESHOLD) : 0;
    const dy = t.active ? dirOf(t.y, TOUCH_THRESHOLD) : 0;
    if (dx !== 0) {
      const bit = dx < 0 ? IN.LEFT : IN.RIGHT;
      mask |= bit;
      if (dx !== prev.x) { this.latched |= bit; touched = true; }
    }
    if (dy !== 0) {
      const bit = dy < 0 ? IN.UP : IN.DOWN;
      mask |= bit;
      if (dy !== prev.y) { this.latched |= bit; touched = true; }
    }
    prev.x = dx;
    prev.y = dy;

    if (touched) this._lastDevice = 'touch';
    this.touchMask = mask;
  }
}

function maskOf(actions: ReadonlySet<BindAction>): InputMask {
  let m: InputMask = 0;
  for (const a of actions) m |= ACTION_BIT[a] ?? 0;
  return m;
}
