// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IN, IN_ALL } from '../../src/sim/types.js';
import type { BindAction, Binds } from '../../src/client/contracts.js';
import {
  DEFAULT_BINDS,
  Input,
  PAD_DEADZONE,
  PAD_MAP,
  isOwnedCode,
  keyLabel,
  makeTouchState,
  type GamepadLike,
} from '../../src/client/input/index.js';

// ------------------------------------------------------------------ helpers
function key(type: 'keydown' | 'keyup', code: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent(type, { code, bubbles: true, cancelable: true, ...init });
  window.dispatchEvent(e);
  return e;
}
const down = (code: string, init: KeyboardEventInit = {}) => key('keydown', code, init);
const up = (code: string, init: KeyboardEventInit = {}) => key('keyup', code, init);

interface FakePad {
  index: number;
  connected: boolean;
  buttons: { pressed: boolean; value: number }[];
  axes: number[];
}
function fakePad(index = 0): FakePad {
  return {
    index,
    connected: true,
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
    axes: [0, 0, 0, 0],
  };
}

/** The pad list `navigator.getGamepads()` hands back; tests mutate the pads in place. */
let pads: (GamepadLike | null)[] = [];
let input: Input;

beforeEach(() => {
  pads = [];
  Object.defineProperty(navigator, 'getGamepads', {
    configurable: true,
    writable: true,
    value: () => pads,
  });
  input = new Input();
});
afterEach(() => {
  input.dispose();
});

// ------------------------------------------------------------------ keyboard
describe('Input — keyboard', () => {
  it('a tap that opens and closes inside one frame latches JUMP without being held', () => {
    down('Space');
    up('Space');
    input.poll();
    expect(input.takeLatched() & IN.JUMP).toBe(IN.JUMP);
    expect(input.held() & IN.JUMP).toBe(0);
    // Latched bits are consumed by the call.
    expect(input.takeLatched()).toBe(0);
  });

  it('a held key is held every frame but latched only once', () => {
    down('ArrowRight');
    input.poll();
    expect(input.held() & IN.RIGHT).toBe(IN.RIGHT);
    expect(input.takeLatched() & IN.RIGHT).toBe(IN.RIGHT);
    for (let i = 0; i < 3; i++) {
      input.poll();
      expect(input.held() & IN.RIGHT).toBe(IN.RIGHT);
      expect(input.takeLatched()).toBe(0);
    }
    up('ArrowRight');
    input.poll();
    expect(input.held()).toBe(0);
  });

  it('OS auto-repeat events do not produce new press edges', () => {
    down('KeyZ');
    input.poll();
    input.takeLatched();
    down('KeyZ', { repeat: true });
    down('KeyZ', { repeat: true });
    input.poll();
    expect(input.takeLatched()).toBe(0);
    expect(input.held() & IN.JUMP).toBe(IN.JUMP);
  });

  it('every code bound to an action maps to the same bit', () => {
    down('KeyA');
    input.poll();
    expect(input.held() & IN.LEFT).toBe(IN.LEFT);
    up('KeyA');
    down('ArrowLeft');
    input.poll();
    expect(input.held() & IN.LEFT).toBe(IN.LEFT);
  });

  it('rebinding moves a key', () => {
    const binds: Binds = { ...DEFAULT_BINDS, jump: ['KeyQ'] };
    input.setBinds(binds);
    down('KeyQ');
    input.poll();
    expect(input.held() & IN.JUMP).toBe(IN.JUMP);
    expect(input.takeMenu()).toEqual(['confirm']); // jump doubles as confirm
    up('KeyQ');
    input.poll();
    // Space no longer jumps but is still bound to confirm.
    down('Space');
    input.poll();
    expect(input.held() & IN.JUMP).toBe(0);
    expect(input.takeMenu()).toEqual(['confirm']);
    up('Space');
  });

  it('setBinds does not let the caller mutate the internal copy', () => {
    const binds: Binds = { ...DEFAULT_BINDS, jump: ['KeyQ'] };
    input.setBinds(binds);
    binds.jump.push('KeyE');
    down('KeyE');
    input.poll();
    expect(input.held() & IN.JUMP).toBe(0);
    expect(input.binds.jump).toEqual(['KeyQ']);
  });

  it('window blur releases everything that was held', () => {
    down('ArrowLeft');
    down('Space');
    input.poll();
    expect(input.held()).toBe(IN.LEFT | IN.JUMP);
    expect(input.takeLatched()).toBe(IN.LEFT | IN.JUMP);
    window.dispatchEvent(new Event('blur'));
    input.poll();
    expect(input.held()).toBe(0);
    // The late keyup from the OS must not break anything or re-press.
    up('ArrowLeft');
    up('Space');
    input.poll();
    expect(input.held()).toBe(0);
    expect(input.takeLatched()).toBe(0);
  });

  it('prevents the default of owned keys only', () => {
    expect(down('Space').defaultPrevented).toBe(true);
    expect(down('ArrowDown').defaultPrevented).toBe(true);
    expect(down('KeyA').defaultPrevented).toBe(false);
    // Repeats of an owned key must not scroll either.
    expect(down('Space', { repeat: true }).defaultPrevented).toBe(true);
  });

  it('owns Enter so a focused button cannot be clicked by the browser on top of the cursor confirm', () => {
    expect(isOwnedCode('Enter')).toBe(true);
    expect(isOwnedCode('NumpadEnter')).toBe(true);
    const e = down('Enter');
    expect(e.defaultPrevented).toBe(true);
    input.poll();
    expect(input.takeMenu()).toEqual(['confirm']);
    up('Enter');
    // only bound codes are owned: NumpadEnter is free until someone binds it
    expect(down('NumpadEnter').defaultPrevented).toBe(false);
    up('NumpadEnter');
    input.setBinds({ ...DEFAULT_BINDS, confirm: ['NumpadEnter'] });
    expect(down('NumpadEnter').defaultPrevented).toBe(true);
    up('NumpadEnter');
  });

  it('ignores keys typed into an editable element but still tracks their release', () => {
    const field = document.createElement('input');
    document.body.appendChild(field);
    const e = new KeyboardEvent('keydown', { code: 'Space', bubbles: true, cancelable: true });
    field.dispatchEvent(e);
    input.poll();
    expect(input.held()).toBe(0);
    expect(input.takeLatched()).toBe(0);
    expect(e.defaultPrevented).toBe(false);
    field.remove();
  });

  it('leaves browser shortcuts (ctrl / meta combos) alone', () => {
    down('KeyR', { ctrlKey: true });
    down('KeyR', { metaKey: true });
    input.poll();
    expect(input.takeMenu()).toEqual([]);
    up('KeyR');
    input.poll();
    expect(input.held()).toBe(0);
  });

  it('reports the keyboard as the last device used', () => {
    down('ArrowUp');
    input.poll();
    expect(input.lastDevice).toBe('keyboard');
  });

  it('the restart bind is a sim input: R sets IN.RETRY in held and latched (a tap latches once)', () => {
    down('KeyR');
    input.poll();
    expect(input.held() & IN.RETRY).toBe(IN.RETRY);
    expect(input.takeLatched() & IN.RETRY).toBe(IN.RETRY);
    expect(input.takeMenu()).toEqual(['restart']);
    expect(input.menuHeld('restart')).toBe(true);
    // held: still in the mask, latched only once
    input.poll();
    expect(input.held() & IN.RETRY).toBe(IN.RETRY);
    expect(input.takeLatched()).toBe(0);
    up('KeyR');
    input.poll();
    expect(input.held()).toBe(0);
    expect(input.menuHeld('restart')).toBe(false);
    // a tap inside one frame is still one press edge for the sim
    down('KeyR');
    up('KeyR');
    input.poll();
    expect(input.held()).toBe(0);
    expect(input.takeLatched()).toBe(IN.RETRY);
    // RETRY is outside the six movement bits and inside IN_ALL
    expect(IN.RETRY & 0x3f).toBe(0);
    expect(IN.RETRY & IN_ALL).toBe(IN.RETRY);
  });
});

// ------------------------------------------------------------------ menu
describe('Input — menu actions', () => {
  it('yields edge actions once and drains them', () => {
    down('Enter');
    input.poll();
    expect(input.takeMenu()).toEqual(['confirm']);
    expect(input.takeMenu()).toEqual([]);
    up('Enter');
    down('ArrowDown');
    input.poll();
    expect(input.takeMenu()).toEqual(['down']);
    up('ArrowDown');
    down('KeyR');
    input.poll();
    expect(input.takeMenu()).toEqual(['restart']);
  });

  it('Escape is both pause and cancel (consumers decide who owns it)', () => {
    down('Escape');
    input.poll();
    const m = input.takeMenu();
    expect(m).toContain('pause');
    expect(m).toContain('cancel');
    expect(m.length).toBe(2);
  });

  it('jump keys double as confirm without duplicating a shared code', () => {
    down('Space'); // bound to jump AND confirm → exactly one confirm
    input.poll();
    expect(input.takeMenu()).toEqual(['confirm']);
    up('Space');
    down('KeyZ'); // jump only
    input.poll();
    expect(input.takeMenu()).toEqual(['confirm']);
  });

  it('menuHeld reflects the current held state', () => {
    down('ArrowDown');
    down('Enter');
    input.poll();
    expect(input.menuHeld('down')).toBe(true);
    expect(input.menuHeld('confirm')).toBe(true);
    expect(input.menuHeld('up')).toBe(false);
    up('ArrowDown');
    up('Enter');
    input.poll();
    expect(input.menuHeld('down')).toBe(false);
    expect(input.menuHeld('confirm')).toBe(false);
  });
});

// ------------------------------------------------------------------ gamepad
describe('Input — gamepad (fake navigator.getGamepads)', () => {
  it('button presses latch, hold and emit menu actions once', () => {
    const pad = fakePad();
    pads = [pad];
    pad.buttons[0].pressed = true;
    input.poll();
    expect(input.padConnected).toBe(true);
    expect(input.lastDevice).toBe('gamepad');
    expect(input.held() & IN.JUMP).toBe(IN.JUMP);
    expect(input.takeLatched() & IN.JUMP).toBe(IN.JUMP);
    expect(input.takeMenu()).toEqual(['confirm']);
    input.poll();
    expect(input.held() & IN.JUMP).toBe(IN.JUMP);
    expect(input.takeLatched()).toBe(0);
    expect(input.takeMenu()).toEqual([]);
    pad.buttons[0].pressed = false;
    input.poll();
    expect(input.held()).toBe(0);
  });

  it('a tap that opens and closes between polls is still visible when pressed at poll time', () => {
    const pad = fakePad();
    pads = [pad];
    pad.buttons[2].pressed = true;
    input.poll();
    pad.buttons[2].pressed = false;
    expect(input.takeLatched() & IN.DASH).toBe(IN.DASH);
    input.poll();
    expect(input.held()).toBe(0);
  });

  it('the left stick respects the deadzone', () => {
    const pad = fakePad();
    pads = [pad];
    expect(PAD_DEADZONE).toBeCloseTo(0.35);
    pad.axes[0] = 0.3;
    input.poll();
    expect(input.held()).toBe(0);
    expect(input.takeLatched()).toBe(0);
    pad.axes[0] = 0.6;
    input.poll();
    expect(input.held() & IN.RIGHT).toBe(IN.RIGHT);
    expect(input.takeLatched() & IN.RIGHT).toBe(IN.RIGHT);
    expect(input.takeMenu()).toEqual(['right']);
    input.poll();
    expect(input.takeLatched()).toBe(0);
    expect(input.takeMenu()).toEqual([]);
    pad.axes[0] = -0.9;
    input.poll();
    expect(input.held() & IN.LEFT).toBe(IN.LEFT);
    expect(input.held() & IN.RIGHT).toBe(0);
    expect(input.takeMenu()).toEqual(['left']);
    pad.axes[0] = 0;
    pad.axes[1] = 0.8;
    input.poll();
    expect(input.held()).toBe(IN.DOWN);
    pad.axes[1] = -0.8;
    input.poll();
    expect(input.held()).toBe(IN.UP);
    pad.axes[1] = 0;
    input.poll();
    expect(input.held()).toBe(0);
  });

  it('d-pad buttons map through PAD_MAP', () => {
    expect(PAD_MAP[0]).toBe('jump');
    expect(PAD_MAP[12]).toBe('up');
    const pad = fakePad();
    pads = [pad];
    const cases: [number, number][] = [[12, IN.UP], [13, IN.DOWN], [14, IN.LEFT], [15, IN.RIGHT]];
    for (const [b, bit] of cases) {
      pad.buttons[b].pressed = true;
      input.poll();
      expect(input.held()).toBe(bit);
      pad.buttons[b].pressed = false;
    }
    input.poll();
    expect(input.held()).toBe(0);
  });

  it('analogue triggers count as pressed above the threshold', () => {
    const pad = fakePad();
    pads = [pad];
    pad.buttons[7].value = 0.3;
    input.poll();
    expect(input.held()).toBe(0);
    pad.buttons[7].value = 0.8;
    input.poll();
    expect(input.held() & IN.DASH).toBe(IN.DASH);
  });

  it('start is pause, B is cancel — neither touches the sim mask; back is restart and carries IN.RETRY', () => {
    const pad = fakePad();
    pads = [pad];
    pad.buttons[9].pressed = true;
    input.poll();
    expect(input.takeMenu()).toEqual(['pause']);
    expect(input.held()).toBe(0);
    expect(input.takeLatched()).toBe(0);
    pad.buttons[9].pressed = false;
    pad.buttons[1].pressed = true;
    input.poll();
    expect(input.takeMenu()).toEqual(['cancel']);
    expect(input.held()).toBe(0);
    expect(input.takeLatched()).toBe(0);
    pad.buttons[1].pressed = false;
    pad.buttons[8].pressed = true;
    input.poll();
    expect(input.takeMenu()).toEqual(['restart']);
    expect(input.takeLatched()).toBe(IN.RETRY);
    expect(input.held()).toBe(IN.RETRY);
    expect(input.menuHeld('restart')).toBe(true);
    pad.buttons[8].pressed = false;
    input.poll();
    expect(input.held()).toBe(0);
    expect(input.menuHeld('restart')).toBe(false);
  });

  it('tolerates an empty or null pad list', () => {
    pads = [null, null];
    input.poll();
    expect(input.padConnected).toBe(false);
    expect(input.held()).toBe(0);
    pads = [];
    input.poll();
    expect(input.held()).toBe(0);
  });

  it('reset keeps a still-held button and stick quiet until they return to neutral', () => {
    const pad = fakePad();
    pads = [pad];
    pad.buttons[0].pressed = true;
    pad.axes[0] = 1;
    input.poll();
    expect(input.held()).toBe(IN.JUMP | IN.RIGHT);
    input.reset();
    expect(input.held()).toBe(0);
    input.poll();
    expect(input.held()).toBe(0);
    expect(input.takeLatched()).toBe(0);
    pad.buttons[0].pressed = false;
    pad.axes[0] = 0;
    input.poll();
    pad.buttons[0].pressed = true;
    pad.axes[0] = 1;
    input.poll();
    expect(input.held()).toBe(IN.JUMP | IN.RIGHT);
  });

  it('accepts an explicit gamepad source instead of navigator', () => {
    const pad = fakePad();
    const own = new Input({ getGamepads: () => [pad] });
    pad.buttons[0].pressed = true;
    own.poll();
    expect(own.held() & IN.JUMP).toBe(IN.JUMP);
    own.dispose();
  });

  it('survives a getGamepads that throws (cross-origin frame)', () => {
    const own = new Input({ getGamepads: () => { throw new Error('SecurityError'); } });
    expect(() => own.poll()).not.toThrow();
    expect(own.padConnected).toBe(false);
    own.dispose();
  });
});

// ------------------------------------------------------------------ touch
describe('Input — touch', () => {
  it('consumes jumpPressed / dashPressed into latched bits', () => {
    input.touch.jumpPressed = true;
    input.touch.dashPressed = true;
    input.poll();
    expect(input.touch.jumpPressed).toBe(false);
    expect(input.touch.dashPressed).toBe(false);
    expect(input.takeLatched()).toBe(IN.JUMP | IN.DASH);
    expect(input.held()).toBe(0);
    expect(input.lastDevice).toBe('touch');
  });

  it('held virtual buttons and the stick feed the mask; the stick has a threshold', () => {
    const t = input.touch;
    t.active = true;
    t.x = 0.8;
    t.jump = true;
    input.poll();
    expect(input.held()).toBe(IN.RIGHT | IN.JUMP);
    expect(input.takeLatched()).toBe(IN.RIGHT | IN.JUMP);
    input.poll();
    expect(input.takeLatched()).toBe(0);
    t.x = 0.2;
    t.y = -0.7;
    input.poll();
    expect(input.held()).toBe(IN.UP | IN.JUMP);
    t.active = false;
    t.jump = false;
    input.poll();
    expect(input.held()).toBe(0);
  });

  it('attachTouch shares the UI-owned state object', () => {
    const shared = makeTouchState();
    input.attachTouch(shared);
    expect(input.touch).toBe(shared);
    shared.dash = true;
    input.poll();
    expect(input.held()).toBe(IN.DASH);
  });

  it('a Input created with a touch option uses that object', () => {
    const shared = makeTouchState();
    const own = new Input({ touch: shared });
    expect(own.touch).toBe(shared);
    own.dispose();
  });
});

// ------------------------------------------------------------------ capture
describe('Input — rebind capture', () => {
  it('routes the next key to the callback and suppresses normal handling', () => {
    const cb = vi.fn();
    input.capture(cb);
    expect(input.capturing).toBe(true);
    const e = down('Space');
    expect(cb).toHaveBeenCalledWith('Space');
    expect(e.defaultPrevented).toBe(true);
    expect(input.capturing).toBe(false);
    up('Space');
    input.poll();
    expect(input.held()).toBe(0);
    expect(input.takeLatched()).toBe(0);
    expect(input.takeMenu()).toEqual([]);
    // Capture is one-shot: the following press is handled normally.
    down('Space');
    input.poll();
    expect(input.held() & IN.JUMP).toBe(IN.JUMP);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('Escape cancels with null', () => {
    const cb = vi.fn();
    input.capture(cb);
    down('Escape');
    expect(cb).toHaveBeenCalledWith(null);
    input.poll();
    expect(input.takeMenu()).toEqual([]);
  });

  it('cancelCapture drops the pending callback', () => {
    const cb = vi.fn();
    input.capture(cb);
    input.cancelCapture();
    down('KeyM');
    expect(cb).not.toHaveBeenCalled();
    expect(input.capturing).toBe(false);
  });
});

// ------------------------------------------------------------------ reset / dispose
describe('Input — reset and dispose', () => {
  it('reset clears held, latched and menu state', () => {
    down('ArrowRight');
    down('Enter');
    input.touch.active = true;
    input.touch.x = 1;
    input.touch.jump = true;
    input.poll();
    expect(input.held()).not.toBe(0);
    input.reset();
    expect(input.held()).toBe(0);
    expect(input.takeLatched()).toBe(0);
    expect(input.takeMenu()).toEqual([]);
    expect(input.touch.active).toBe(false);
    expect(input.touch.jump).toBe(false);
    input.poll();
    expect(input.held()).toBe(0);
    // Late releases are harmless.
    up('ArrowRight');
    up('Enter');
    input.poll();
    expect(input.held()).toBe(0);
  });

  it('dispose detaches the listeners', () => {
    input.dispose();
    down('Space');
    input.poll();
    expect(input.held()).toBe(0);
    expect(input.takeLatched()).toBe(0);
  });
});

// ------------------------------------------------------------------ binds / labels
describe('binds', () => {
  it('DEFAULT_BINDS covers every action with at least one code', () => {
    const actions: BindAction[] = ['left', 'right', 'up', 'down', 'jump', 'dash', 'pause', 'confirm', 'cancel', 'restart'];
    for (const a of actions) {
      expect(Array.isArray(DEFAULT_BINDS[a])).toBe(true);
      expect(DEFAULT_BINDS[a].length).toBeGreaterThan(0);
    }
  });

  it('keyLabel gives short human labels', () => {
    expect(keyLabel('Space')).toBe('Space');
    expect(keyLabel('KeyA')).toBe('A');
    expect(keyLabel('ArrowLeft')).toBe('←');
    expect(keyLabel('Digit3')).toBe('3');
    expect(keyLabel('Numpad5')).toBe('Num 5');
    expect(keyLabel('ShiftLeft')).toBe('L Shift');
    expect(keyLabel('Escape')).toBe('Esc');
    expect(keyLabel('')).toBe('—');
    expect(input.keyLabel('KeyZ')).toBe('Z');
  });
});
