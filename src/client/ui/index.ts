/**
 * Public surface of the DOM UI package.
 */
export {
  UI, fmtDateKr, reasonKr, REASON_KR, NAG_DISMISSED_KEY, IOS_HINT_DISMISSED_KEY, GAMEPAD_HIDE_S, TOUCH_PREVIEW_S, MUTE_KR,
} from './ui.js';
export type { UIOptions } from './ui.js';
export {
  SCREENS, MODAL_SCREENS, ScreenStack, Navigator, el, starSvg, lockSvg, isVisible, validateName, NAME_MAX,
  REPEAT_DELAY, REPEAT_INTERVAL,
} from './screens.js';
export type { NavHooks, NavDir } from './screens.js';
export { Hud, fmtTime, fmtTicks, LIVE_INTERVAL, TOAST_SECONDS, BANNER_SECONDS } from './hud.js';
export { SettingsPanel, BIND_ROWS, TOUCH_KR, TOUCH_SLIDERS, findBindConflict, bindLabel } from './settings.js';
export type { SettingsPanelDeps, PortraitPainter } from './settings.js';
export { TransferPanel, TRANSFER_KR, CODE_MODULES, codeModules, drawCodeCanvas, fmtCode, normalizeCode } from './transfer.js';
export type { TransferPanelDeps, TransferStatusKind } from './transfer.js';
export {
  TouchControls, makeTouchState, isCoarsePointer, isPortraitViewport, isPhoneViewport, wantsRotatePrompt, PHONE_MAX_SHORT_SIDE,
  LAYOUT_VARS, MIN_HIT_PX, MIN_LABEL_PX, TOUCH_BASE_REM, touchHitPx,
} from './touch.js';
export type { TouchElementKind } from './touch.js';
export { renderLeaderboard, recordText } from './leaderboard.js';
export type { LeaderboardRenderOptions, LbStatus } from './leaderboard.js';
