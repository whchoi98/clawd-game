/**
 * Public surface of the audio package. The shell composes `AudioEngine`
 * through `AudioPort`; the rest is exported for tooling and tests.
 */
export { AudioEngine, TRACK_FADE } from './engine.js';
export type { SimLike } from './engine.js';
export { SFX, EVENT_SFX, SILENT_EVENTS, UI_SFX, GATE_MS, SHARD_COMBO_CAP, eventSfx, eventParams, midi } from './sfx.js';
export type { SfxName, SfxParams, Synth, ToneOpts, NoiseOpts, FilterSpec, OscType, FilterType, SilentEvent, SoundedEvent } from './sfx.js';
export { TRACKS, SCALES, STEPS_PER_BAR, LOOKAHEAD, planCtx, planStep, planWindow, renderNote, Sequencer } from './music.js';
export type { TrackDef, TrackVoices, Note, Inst, ScaleName, PlanCtx, Arrangement } from './music.js';

import { AudioEngine } from './engine.js';
import type { AudioPort } from '../contracts.js';

/** Factory for the shell: one engine per page. */
export function createAudio(): AudioPort & AudioEngine {
  return new AudioEngine();
}
export { installAudioUnlock, UNLOCK_EVENTS } from './unlock.js';
export type { UnlockController, UnlockableAudio } from './unlock.js';
