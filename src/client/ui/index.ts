/**
 * Public surface of the DOM UI package.
 */
export { UI, fmtDateKr, reasonKr, REASON_KR, NAG_DISMISSED_KEY, IOS_HINT_DISMISSED_KEY } from './ui.js';
export type { UIOptions } from './ui.js';
export {
  SCREENS, MODAL_SCREENS, ScreenStack, Navigator, el, starSvg, lockSvg, isVisible, validateName, NAME_MAX,
  REPEAT_DELAY, REPEAT_INTERVAL,
} from './screens.js';
export type { NavHooks, NavDir } from './screens.js';
export { Hud, fmtTime, fmtTicks, LIVE_INTERVAL, TOAST_SECONDS, BANNER_SECONDS } from './hud.js';
export { SettingsPanel, BIND_ROWS, findBindConflict, bindLabel } from './settings.js';
export type { SettingsPanelDeps, PortraitPainter } from './settings.js';
export {
  TouchControls, makeTouchState, isCoarsePointer, isPortraitViewport, isPhoneViewport, wantsRotatePrompt, PHONE_MAX_SHORT_SIDE,
} from './touch.js';
export { renderLeaderboard, recordText } from './leaderboard.js';
export type { LeaderboardRenderOptions, LbStatus } from './leaderboard.js';
