/**
 * Public surface of the render package. `main.ts` constructs one `Renderer`
 * and talks to it through `RendererPort`; the building blocks are exported for
 * the QA harness and tests.
 */
export { Renderer } from './renderer.js';
export type { RendererOptions, SimView } from './renderer.js';
export { Stage, VIEW_W, VIEW_H, UI_FONT } from './stage.js';
export type { QualityTier, StageOptions, StageSettings, Viewport } from './stage.js';
export { Sky } from './sky.js';
export { Terrain } from './tiles.js';
export { Particles } from './particles.js';
export { SKINS, drawClawd, drawClawdPortrait, skinById, tintedSkin } from './clawd.js';
export type { RigPose, RigState, Skin } from './clawd.js';
export { Actors, PlayerVisual, drawGhost } from './actors.js';
