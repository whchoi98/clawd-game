/**
 * Device-aware hint text. Zone hints (LevelDef.hint) are token templates —
 * `{move} {jump} {dash} {stomp} {down}` — never raw key names, so one string
 * serves the keyboard (whatever the player bound), a gamepad and the touch
 * pad. `hintFor` / `renderHint` are pure: everything they read is passed in.
 */
import type { LevelDef } from '../../sim/types.js';
import type { Binds, Device } from '../contracts.js';
import { DEFAULT_BINDS, PAD_MAP, keyLabel as defaultKeyLabel } from '../input/binds.js';

export type HintToken = 'move' | 'jump' | 'dash' | 'stomp' | 'down';
export const HINT_TOKENS: readonly HintToken[] = ['move', 'jump', 'dash', 'stomp', 'down'];

/** Matches `{move}` … `{down}`; unknown tokens are left as written. */
export const HINT_TOKEN_RE = /\{(move|jump|dash|stomp|down)\}/g;

/**
 * Raw key names a hint template must not carry: they are wrong on a phone and
 * after a rebind. Word-bounded for the Latin names; `R` only as a bare letter.
 */
export const RAW_KEY_RE = /\b(?:Shift|SHIFT|Space|SPACE)\b|[←→↑↓]|\bA\s*\/\s*D\b|(?:^|[^A-Za-z])R(?![A-Za-z])/;

/** True when a hint template names a physical key instead of a token. */
export function hasRawKeyName(hint: string): boolean {
  return RAW_KEY_RE.test(hint);
}

export interface HintContext {
  /** The player's current bindings (keyboard glyphs come from slot 0). Defaults to DEFAULT_BINDS. */
  binds?: Binds;
  /** KeyboardEvent.code → label, normally `input.keyLabel`. */
  keyLabel?: (code: string) => string;
}

/** Re-hint templates the shell shows after repeated deaths of one kind. */
export const REHINT_PIT = '공중에서 {jump} 한 번 더 — 2단 점프로 구덩이를 넘는다';
export const REHINT_HAZARD = '{dash} 대시 — 대시 중에는 가시와 톱날을 스쳐도 다치지 않는다';

/** Standard-mapping button index → glyph (enclosed letters render in every CJK UI font). */
const PAD_BUTTON_GLYPH: Readonly<Record<number, string>> = { 0: 'Ⓐ', 1: 'Ⓑ', 2: 'Ⓧ', 3: 'Ⓨ', 12: '↑', 13: '↓', 14: '←', 15: '→' };

/** Glyph of the lowest-numbered face / d-pad button PAD_MAP assigns to `action`. */
function padGlyph(action: 'jump' | 'dash' | 'down'): string {
  const idx = Object.keys(PAD_MAP).map(Number).sort((a, b) => a - b).find((b) => PAD_MAP[b] === action && b in PAD_BUTTON_GLYPH);
  return idx === undefined ? action.toUpperCase() : PAD_BUTTON_GLYPH[idx];
}

/** A short glyph for a key code: modifiers lose their side, everything else is the settings label. */
export function keyGlyph(code: string | undefined, label: (code: string) => string): string {
  if (!code) return '—';
  if (code === 'ShiftLeft' || code === 'ShiftRight') return 'Shift';
  if (code === 'ControlLeft' || code === 'ControlRight') return 'Ctrl';
  if (code === 'AltLeft' || code === 'AltRight') return 'Alt';
  return label(code);
}

/** The glyph for one token on one device. */
export function tokenGlyph(token: HintToken, device: Device, ctx: HintContext = {}): string {
  const binds = ctx.binds ?? DEFAULT_BINDS;
  const label = ctx.keyLabel ?? defaultKeyLabel;
  switch (device) {
    case 'touch':
      switch (token) {
        case 'move': return '왼쪽 스틱';
        case 'jump': return 'JUMP';
        case 'dash': return 'DASH';
        case 'stomp':
        case 'down': return '스틱 아래';
      }
      break;
    case 'gamepad':
      switch (token) {
        case 'move': return '왼쪽 스틱';
        case 'jump': return padGlyph('jump');
        case 'dash': return padGlyph('dash');
        case 'stomp':
        case 'down': return padGlyph('down');
      }
      break;
    case 'keyboard':
      switch (token) {
        case 'move': return `${keyGlyph(binds.left[0], label)} ${keyGlyph(binds.right[0], label)}`;
        case 'jump': return keyGlyph(binds.jump[0], label);
        case 'dash': return keyGlyph(binds.dash[0], label);
        case 'stomp':
        case 'down': return keyGlyph(binds.down[0], label);
      }
      break;
  }
  return token;
}

/** Substitute every token in a hint template for `device`. Pure. */
export function renderHint(template: string, device: Device, ctx: HintContext = {}): string {
  return template.replace(HINT_TOKEN_RE, (_m, t: HintToken) => tokenGlyph(t, device, ctx));
}

/** The zone's hint rendered for `device`; empty string when the zone has none. */
export function hintFor(def: Pick<LevelDef, 'hint'>, device: Device, ctx: HintContext = {}): string {
  return def.hint ? renderHint(def.hint, device, ctx) : '';
}
