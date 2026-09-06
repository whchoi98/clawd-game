/**
 * Key bindings, gamepad button map and key labels.
 *
 * Codes are `KeyboardEvent.code` values (physical keys), so a binding survives
 * keyboard layouts and IME state. Gamepad buttons follow the W3C "standard"
 * mapping.
 */
import type { BindAction, Binds } from '../contracts.js';

export const DEFAULT_BINDS: Binds = {
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
  up: ['ArrowUp', 'KeyW'],
  down: ['ArrowDown', 'KeyS'],
  jump: ['Space', 'KeyZ', 'KeyJ'],
  dash: ['ShiftLeft', 'ShiftRight', 'KeyX', 'KeyK'],
  pause: ['Escape', 'KeyP'],
  confirm: ['Enter', 'Space'],
  cancel: ['Escape', 'Backspace'],
  restart: ['KeyR'],
};

/** Standard-mapping gamepad button index → action. */
export const PAD_MAP: Readonly<Partial<Record<number, BindAction>>> = {
  0: 'jump',     // A / cross
  1: 'cancel',   // B / circle
  2: 'dash',     // X / square
  3: 'dash',     // Y / triangle
  5: 'dash',     // RB
  7: 'dash',     // RT
  8: 'restart',  // back / select
  9: 'pause',    // start
  12: 'up',
  13: 'down',
  14: 'left',
  15: 'right',
};

/** Left-stick deflection below this is treated as neutral. */
export const PAD_DEADZONE = 0.35;
/** Analogue buttons (triggers) count as pressed above this value. */
export const PAD_TRIGGER = 0.55;
/** Virtual-stick deflection (TouchState.x/y) below this is neutral. */
export const TOUCH_THRESHOLD = 0.35;

/** Every action a rebinding UI must offer, in display order. */
export const BIND_ACTIONS: readonly BindAction[] = [
  'left', 'right', 'up', 'down', 'jump', 'dash', 'pause', 'confirm', 'cancel', 'restart',
];

export function cloneBinds(b: Binds): Binds {
  const out = {} as Binds;
  for (const a of BIND_ACTIONS) out[a] = [...(b[a] ?? [])];
  return out;
}

/**
 * Keys whose browser default (scrolling, focus travel, history navigation,
 * quick-find, activating a focused button) would fight the game. Only bound
 * codes are ever owned. Enter is owned so a DOM-focused button never receives
 * the browser's synthesized click on top of the menu cursor's confirm — the
 * cursor is the single activation path. Editable targets are exempted by the
 * input layer before this check, so typing keeps native Enter.
 */
export function isOwnedCode(code: string): boolean {
  return code.startsWith('Arrow')
    || code === 'Space'
    || code === 'Enter'
    || code === 'NumpadEnter'
    || code === 'Tab'
    || code === 'Backspace'
    || code === 'Slash'
    || code === 'Quote';
}

const LABELS: Readonly<Record<string, string>> = {
  ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
  Space: 'Space',
  ShiftLeft: 'L Shift', ShiftRight: 'R Shift',
  ControlLeft: 'L Ctrl', ControlRight: 'R Ctrl',
  AltLeft: 'Alt', AltRight: 'Alt Gr',
  MetaLeft: 'Meta', MetaRight: 'Meta',
  Enter: 'Enter', NumpadEnter: 'Num Enter',
  Escape: 'Esc', Backspace: 'Bksp', Tab: 'Tab', CapsLock: 'Caps',
  Delete: 'Del', Insert: 'Ins', Home: 'Home', End: 'End', PageUp: 'PgUp', PageDown: 'PgDn',
  Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'",
  BracketLeft: '[', BracketRight: ']', Backslash: '\\', IntlBackslash: '\\',
  Minus: '-', Equal: '=', Backquote: '`',
};

const NUMPAD_LABELS: Readonly<Record<string, string>> = {
  Add: '+', Subtract: '-', Multiply: '*', Divide: '/', Decimal: '.',
};

/** Human label for a KeyboardEvent.code ('Space' → 'Space', 'KeyA' → 'A', 'ArrowLeft' → '←'). */
export function keyLabel(code: string): string {
  if (!code) return '—';
  const known = LABELS[code];
  if (known) return known;
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) {
    const rest = code.slice(6);
    return 'Num ' + (NUMPAD_LABELS[rest] ?? rest);
  }
  return code;
}
