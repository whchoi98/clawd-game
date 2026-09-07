/**
 * Public surface of the render package. `main.ts` constructs one `Renderer`
 * and talks to it through `RendererPort`; the building blocks are exported for
 * the QA harness and tests.
 */
export { Renderer, AFTER_IMAGE_SPACING, BAND_FADE_S, BAND_SNAP_ROWS } from './renderer.js';
export type { RendererOptions, SimView } from './renderer.js';
export {
  Stage, VIEW_W, VIEW_H, UI_FONT,
  AUTOTIER_KEY, FRAME_WINDOW_S, FrameHistogram, HIST_BUCKETS, MENU_BUCKET_MS, MENU_COST_RATIO, MENU_FRAME_MS, MENU_SLOW_RATIO,
  MIN_MENU_SAMPLES, MIN_WINDOW_SAMPLES, REFRESH_RATES, SMOOTH_RATIO, STEP_DOWN_LOCK_S, STEP_DOWN_RATIO, STEP_UP_AFTER_S, STEP_UP_RATIO,
  readStoredTier, snapRefreshRate,
} from './stage.js';
export type { FpsStats, QualityTier, StageOptions, StageSettings, TierStorage, Viewport } from './stage.js';
export { Sky } from './sky.js';
export { Terrain, SPIKE_SCALE, SPIKE_TIP_INSET } from './tiles.js';
export { Particles } from './particles.js';
export { SKINS, GOAL_LOOK_TILES, LOOK_WEIGHT, drawClawd, drawClawdPortrait, lookTarget, setLookTarget, skinById, tintedSkin } from './clawd.js';
export type { RigPose, RigState, Skin } from './clawd.js';
export { Actors, PlayerVisual, drawGhost, UPDRAFT_STREAKS_PER_S } from './actors.js';
