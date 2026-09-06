/**
 * Input subsystem: keyboard + gamepad + touch → per-tick InputMask with press
 * latching, plus edge-triggered menu actions. See `Input` for the model.
 */
export { Input, makeTouchState } from './input.js';
export type { GamepadButtonLike, GamepadLike, GamepadSource, InputOptions } from './input.js';
export {
  BIND_ACTIONS,
  DEFAULT_BINDS,
  PAD_DEADZONE,
  PAD_MAP,
  PAD_TRIGGER,
  TOUCH_THRESHOLD,
  cloneBinds,
  isOwnedCode,
  keyLabel,
} from './binds.js';
export { STICK_DEADZONE, STICK_SECTOR_RAD, STICK_Y_DEADZONE, snapStick, stickMask } from './stick.js';
export type { StickDir, StickSnap } from './stick.js';
