/**
 * Sound design. Every effect is a tiny recipe written against the `Synth`
 * primitives (a tone with an envelope, a filtered burst of noise); the engine
 * implements those primitives with WebAudio and this module never touches an
 * AudioContext, so the recipes are testable with a fake synth.
 *
 * Event → sound mapping is a total function over `SimEvent['type']`: an event
 * type is either a key of `EVENT_SFX` or listed in `SILENT_EVENTS`. The test
 * suite asserts the union is complete.
 */
import type { BiomeId, FoeKind, PlayerState, SimEvent } from '../../sim/types.js';
import type { UiSound } from '../contracts.js';

export type OscType = 'sine' | 'triangle' | 'square' | 'sawtooth';
export type FilterType = 'lowpass' | 'highpass' | 'bandpass' | 'notch' | 'peaking';

export interface FilterSpec {
  type: FilterType;
  freq: number;
  q?: number;
  /** Sweep the cutoff exponentially to this value over the voice's duration. */
  freqEnd?: number;
}

export interface ToneOpts {
  type?: OscType;
  gain?: number;
  /** Seconds from now. */
  at?: number;
  attack?: number;
  /** Pitch sweep shape when freqB differs from freqA. */
  curve?: 'exp' | 'lin';
  /** 0..1 send level into the feedback-delay "reverb". */
  fx?: number;
  /** -1..1 stereo placement (ignored when the platform lacks a panner). */
  pan?: number;
  /** Optional filter between the oscillator and the envelope. */
  filter?: FilterSpec;
  /** Cents. */
  detune?: number;
  /** Destination bus; the engine defaults to the sfx bus. */
  dest?: AudioNode | null;
}

export interface NoiseOpts {
  gain?: number;
  type?: FilterType;
  freq?: number;
  freqEnd?: number;
  q?: number;
  at?: number;
  attack?: number;
  fx?: number;
  pan?: number;
  dest?: AudioNode | null;
}

/** The only surface sound recipes and the sequencer see. */
export interface Synth {
  tone(freqA: number, freqB: number | null, dur: number, o?: ToneOpts): void;
  noise(dur: number, o?: NoiseOpts): void;
}

export const midi = (n: number): number => 440 * Math.pow(2, (n - 69) / 12);
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

// ---------------------------------------------------------------- effects
export type SfxName =
  | 'jump' | 'land' | 'dash' | 'wallJump' | 'wallSlide' | 'stomp' | 'stompLand'
  | 'shard' | 'relic' | 'crystal' | 'toggle' | 'checkpoint' | 'spring'
  | 'hurt' | 'death' | 'respawn' | 'goal'
  | 'foeHit' | 'foeKilled' | 'bolt' | 'crumble' | 'splash' | 'tideOver'
  /** Clear stings, one per biome, written in that biome track's key (P3-9). */
  | 'stingTidepool' | 'stingStormspire' | 'stingVoidreef' | 'stingSummit'
  /** Ceremony stingers (P3-9): the tier-break fanfare and the ending chord. */
  | 'fanfare' | 'endingSting'
  | 'uiMove' | 'uiConfirm' | 'uiCancel' | 'uiToggle' | 'uiUnlock' | 'uiError'
  /** Result ceremony (P3-9): a star popping in (pitch by index) and a medal landing. */
  | 'uiStar' | 'uiMedal';

/** Per-play parameters extracted from the event (or supplied by the UI). */
export interface SfxParams {
  vol: number;
  pan: number;
  /** land: 0..1 */
  impact?: number;
  /** shard */
  combo?: number;
  /** jump */
  air?: boolean;
  /** dash: vertical component (-1 up .. 1 down) */
  dy?: number;
  /** hurt */
  hp?: number;
  /** splash */
  enter?: boolean;
  /** toggle */
  switchA?: boolean;
  /** foeHit / foeKilled */
  kind?: FoeKind;
  dir?: number;
  /** checkpoint: index of the pillar in the run (the chime rises per pillar) · uiStar: star index 0..2. */
  idx?: number;
}

/** Highest combo step that still raises the shard pitch. */
export const SHARD_COMBO_CAP = 12;
/**
 * The shard combo ladder in semitones above E5 (midi 76): a major-pentatonic
 * climb, so a long combo sings a scale instead of a whole-tone siren. From
 * SHARD_SHIMMER_AT on, a fifth above rides along (the "8+" shimmer).
 */
export const SHARD_LADDER: readonly number[] = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24, 26, 28];
export const SHARD_SHIMMER_AT = 8;
/** Checkpoint pillars raise the chime by a scale step each, up to this index. */
export const CHECKPOINT_PITCH_CAP = 6;
const CHECKPOINT_LADDER: readonly number[] = [0, 2, 3, 5, 7, 8, 10];

type Recipe = (s: Synth, p: SfxParams) => void;

export const SFX: Record<SfxName, Recipe> = {
  jump(s, p) {
    const v = p.vol, pan = p.pan;
    if (p.air) {
      // second jump: brighter, a touch of room
      s.tone(420, 880, 0.2, { type: 'triangle', gain: 0.24 * v, fx: 0.2, pan });
      s.tone(640, 1300, 0.14, { type: 'sine', gain: 0.12 * v, at: 0.02, pan });
    } else {
      s.tone(300, 620, 0.16, { type: 'triangle', gain: 0.26 * v, attack: 0.002, pan });
      s.noise(0.09, { gain: 0.06 * v, type: 'highpass', freq: 1800, pan });
    }
  },
  land(s, p) {
    const k = clamp(p.impact ?? 0.5, 0, 1), v = p.vol;
    s.noise(0.1 + k * 0.1, { gain: (0.07 + k * 0.16) * v, type: 'lowpass', freq: 900 + k * 700, pan: p.pan });
    s.tone(150 - k * 40, 70, 0.1, { type: 'sine', gain: 0.12 * k * v, pan: p.pan });
  },
  dash(s, p) {
    const v = p.vol, pan = p.pan;
    s.noise(0.26, { gain: 0.2 * v, type: 'bandpass', freq: 1500, freqEnd: 700, q: 1.1, pan });
    s.tone(900, 220, 0.24, { type: 'sawtooth', gain: 0.1 * v, fx: 0.25, pan, filter: { type: 'lowpass', freq: 2400 } });
    if ((p.dy ?? 0) < -0.3) s.tone(400, 900, 0.18, { type: 'sine', gain: 0.08 * v, at: 0.02, pan });
  },
  wallJump(s, p) {
    s.tone(260, 700, 0.18, { type: 'square', gain: 0.14 * p.vol, pan: p.pan, filter: { type: 'lowpass', freq: 3000 } });
    s.noise(0.12, { gain: 0.1 * p.vol, type: 'highpass', freq: 2400, pan: p.pan });
  },
  wallSlide(s, p) {
    // quiet scrape; gated by the engine so a long slide is a texture, not a rattle
    s.noise(0.18, { gain: 0.05 * p.vol, type: 'bandpass', freq: 1200, freqEnd: 900, q: 2.2, attack: 0.03, pan: p.pan });
  },
  stomp(s, p) {
    // the dive: a downward whoosh
    s.noise(0.18, { gain: 0.12 * p.vol, type: 'bandpass', freq: 2200, freqEnd: 500, q: 0.9, pan: p.pan });
    s.tone(320, 90, 0.12, { type: 'square', gain: 0.1 * p.vol, pan: p.pan, filter: { type: 'lowpass', freq: 1800 } });
  },
  stompLand(s, p) {
    // the impact: boom + click
    s.noise(0.45, { gain: 0.28 * p.vol, type: 'lowpass', freq: 500, pan: p.pan });
    s.tone(110, 34, 0.4, { type: 'sine', gain: 0.3 * p.vol, pan: p.pan });
    s.noise(0.04, { gain: 0.12 * p.vol, type: 'highpass', freq: 3000, pan: p.pan });
  },
  shard(s, p) {
    const step = clamp(Math.floor(p.combo ?? 0), 0, SHARD_COMBO_CAP);
    const f = midi(76 + SHARD_LADDER[step]);
    s.tone(f, f, 0.1, { type: 'triangle', gain: 0.2 * p.vol, fx: 0.35, pan: p.pan });
    s.tone(f * 2, f * 2, 0.16, { type: 'sine', gain: 0.1 * p.vol, at: 0.03, fx: 0.4, pan: p.pan });
    // a long combo shimmers: a fifth above, softer, a hair later
    if (step >= SHARD_SHIMMER_AT) s.tone(f * 1.5, f * 1.5, 0.14, { type: 'sine', gain: 0.07 * p.vol, at: 0.05, fx: 0.5, pan: p.pan });
  },
  relic(s, p) {
    [0, 4, 7, 12].forEach((iv, i) =>
      s.tone(midi(72 + iv), null, 0.5, { type: 'sine', gain: 0.15 * p.vol, at: i * 0.07, fx: 0.6 }));
    s.tone(midi(91), null, 0.9, { type: 'sine', gain: 0.06 * p.vol, at: 0.3, fx: 0.9 });
  },
  crystal(s, p) {
    // glassy refill: rising partials over a short whoosh
    s.noise(0.12, { gain: 0.06 * p.vol, type: 'highpass', freq: 2600, pan: p.pan });
    s.tone(880, 1760, 0.25, { type: 'sine', gain: 0.16 * p.vol, fx: 0.5, pan: p.pan });
    s.tone(1320, null, 0.3, { type: 'triangle', gain: 0.08 * p.vol, at: 0.05, fx: 0.5, pan: p.pan });
  },
  toggle(s, p) {
    // mechanical clack, then a tone that tells the polarity apart
    s.tone(180, 120, 0.05, { type: 'square', gain: 0.18 * p.vol, pan: p.pan });
    s.noise(0.08, { gain: 0.14 * p.vol, type: 'bandpass', freq: 900, q: 2, pan: p.pan });
    if (p.switchA) s.tone(660, 880, 0.16, { type: 'triangle', gain: 0.12 * p.vol, at: 0.05, fx: 0.3, pan: p.pan });
    else s.tone(880, 660, 0.16, { type: 'triangle', gain: 0.12 * p.vol, at: 0.05, fx: 0.3, pan: p.pan });
  },
  checkpoint(s, p) {
    // each pillar of the run chimes a scale step higher than the last
    const base = 64 + CHECKPOINT_LADDER[clamp(Math.floor(p.idx ?? 0), 0, CHECKPOINT_PITCH_CAP)];
    [0, 7, 12].forEach((iv, i) =>
      s.tone(midi(base + iv), null, 0.4, { type: 'triangle', gain: 0.13 * p.vol, at: i * 0.06, fx: 0.5 }));
  },
  spring(s, p) {
    s.tone(180, 1000, 0.22, { type: 'sine', gain: 0.22 * p.vol, curve: 'lin', fx: 0.2, pan: p.pan });
    s.noise(0.06, { gain: 0.05 * p.vol, type: 'highpass', freq: 2000, pan: p.pan });
  },
  hurt(s, p) {
    // one hit sound whatever hp is left: the low-hp danger layer went with the hp bar (SIM v3 lands instant death)
    s.tone(340, 90, 0.3, { type: 'sawtooth', gain: 0.22 * p.vol, filter: { type: 'lowpass', freq: 2200 } });
    s.noise(0.2, { gain: 0.16 * p.vol, type: 'lowpass', freq: 1200 });
  },
  death(s, p) {
    s.tone(400, 55, 0.7, { type: 'square', gain: 0.2 * p.vol, fx: 0.3, filter: { type: 'lowpass', freq: 1600 } });
    s.noise(0.5, { gain: 0.18 * p.vol, type: 'lowpass', freq: 700 });
  },
  respawn(s, p) {
    s.tone(220, 660, 0.35, { type: 'sine', gain: 0.12 * p.vol, fx: 0.4 });
    s.tone(440, 880, 0.3, { type: 'triangle', gain: 0.08 * p.vol, at: 0.08, fx: 0.4 });
  },
  goal(s, p) {
    [0, 4, 7, 12, 16].forEach((iv, i) =>
      s.tone(midi(65 + iv), null, 0.7, { type: 'triangle', gain: 0.16 * p.vol, at: i * 0.085, fx: 0.7 }));
    s.tone(midi(77), null, 1.2, { type: 'sine', gain: 0.1 * p.vol, at: 0.5, fx: 0.9 });
    s.tone(midi(89), null, 1.0, { type: 'sine', gain: 0.05 * p.vol, at: 0.55, fx: 0.9 });
  },
  foeHit(s, p) {
    s.noise(0.08, { gain: 0.14 * p.vol, type: 'bandpass', freq: 1400, q: 1.2, pan: p.pan });
    s.tone(520, 200, 0.09, { type: 'square', gain: 0.12 * p.vol, pan: p.pan, filter: { type: 'lowpass', freq: 2600 } });
  },
  foeKilled(s, p) {
    s.noise(0.22, { gain: 0.18 * p.vol, type: 'bandpass', freq: 900, q: 0.8, pan: p.pan });
    s.tone(500, 140, 0.2, { type: 'triangle', gain: 0.14 * p.vol, fx: 0.25, pan: p.pan });
  },
  bolt(s, p) {
    s.tone(720, 260, 0.13, { type: 'square', gain: 0.09 * p.vol, pan: p.pan, filter: { type: 'lowpass', freq: 3200 } });
  },
  crumble(s, p) {
    s.noise(0.3, { gain: 0.12 * p.vol, type: 'bandpass', freq: 700, freqEnd: 400, q: 0.6, pan: p.pan });
  },
  splash(s, p) {
    if (p.enter !== false) {
      s.noise(0.3, { gain: 0.2 * p.vol, type: 'lowpass', freq: 1200, freqEnd: 400, pan: p.pan });
      s.tone(300, 120, 0.2, { type: 'sine', gain: 0.1 * p.vol, pan: p.pan });
    } else {
      s.noise(0.2, { gain: 0.12 * p.vol, type: 'highpass', freq: 1400, pan: p.pan });
      s.tone(200, 500, 0.15, { type: 'sine', gain: 0.08 * p.vol, pan: p.pan });
    }
  },
  tideOver(s, p) {
    // the flood closes over: a sinking drone and a long rumble
    s.tone(90, 30, 1.4, { type: 'sine', gain: 0.3 * p.vol, fx: 0.6 });
    s.noise(1.2, { gain: 0.25 * p.vol, type: 'lowpass', freq: 600, freqEnd: 200, fx: 0.5 });
    s.tone(midi(53), midi(41), 1.6, { type: 'triangle', gain: 0.1 * p.vol, at: 0.1, fx: 0.8 });
  },

  // ------------------------------------------------------------ clear stings (one per biome, in the track's key)
  stingTidepool(s, p) {
    // E dorian (the tidepool track): a bright marimba climb E–G–B–D–E–G with a water-drop on top
    [0, 3, 7, 10, 12, 15].forEach((iv, i) => {
      const f = midi(64 + iv);
      s.tone(f, null, 0.5, { type: 'sine', gain: 0.17 * p.vol, at: i * 0.075, fx: 0.55, pan: -0.3 + i * 0.12 });
      s.tone(f * 4, null, 0.05, { type: 'sine', gain: 0.05 * p.vol, at: i * 0.075, pan: -0.3 + i * 0.12 });
    });
    s.tone(midi(88) * 0.7, midi(88), 0.16, { type: 'sine', gain: 0.1 * p.vol, at: 0.5, fx: 0.8 });
    s.tone(midi(88), null, 1.3, { type: 'triangle', gain: 0.06 * p.vol, at: 0.55, fx: 0.9 });
  },
  stingStormspire(s, p) {
    // E phrygian (the stormspire track): a saw stab on E, the b2 F snapping back to the fifth, a crash under it
    const stab = (m: number, at: number, dur: number, g: number): void => {
      s.tone(midi(m), null, dur, { type: 'sawtooth', gain: g * p.vol, at, fx: 0.3, filter: { type: 'lowpass', freq: 3200, freqEnd: 500, q: 2 } });
      s.tone(midi(m), null, dur, { type: 'sawtooth', gain: g * 0.6 * p.vol, at, detune: 9, fx: 0.3, filter: { type: 'lowpass', freq: 2800, freqEnd: 500, q: 2 } });
    };
    stab(52, 0, 0.32, 0.16);
    stab(53, 0.16, 0.14, 0.12);
    stab(59, 0.3, 0.7, 0.16);
    stab(64, 0.3, 0.7, 0.1);
    s.tone(midi(40), null, 0.7, { type: 'sine', gain: 0.24 * p.vol, at: 0.3, attack: 0.01 });
    s.noise(0.9, { gain: 0.16 * p.vol, type: 'lowpass', freq: 600, freqEnd: 180, attack: 0.02, at: 0.3, fx: 0.5 });
  },
  stingVoidreef(s, p) {
    // A aeolian (the voidreef track): dark glass bells E–C–A–G falling, then the octave rising out of the deep
    [7, 3, 0, 10].forEach((iv, i) => {
      const f = midi(69 + iv);
      s.tone(f, null, 0.9, { type: 'sine', gain: 0.14 * p.vol, at: i * 0.11, fx: 0.9, pan: 0.35 - i * 0.2 });
      s.tone(f * 2.76, null, 0.4, { type: 'sine', gain: 0.035 * p.vol, at: i * 0.11, fx: 0.9 });
    });
    s.tone(midi(45), midi(57), 1.4, { type: 'sine', gain: 0.18 * p.vol, at: 0.45, attack: 0.3, fx: 0.7 });
    s.tone(midi(81), null, 1.6, { type: 'triangle', gain: 0.05 * p.vol, at: 0.7, attack: 0.2, fx: 0.95 });
  },

  stingSummit(s, p) {
    // F# lydian (the summit track): placeholder — three glass bells rising F#–A#–C# with a high shimmer.
    // The Phase 5 audio pass replaces this with the composed sting.
    [0, 4, 7].forEach((iv, i) => {
      const f = midi(66 + iv);
      s.tone(f, null, 0.8, { type: 'sine', gain: 0.13 * p.vol, at: i * 0.1, fx: 0.9, pan: -0.3 + i * 0.3 });
    });
    s.tone(midi(90), null, 1.2, { type: 'triangle', gain: 0.04 * p.vol, at: 0.35, attack: 0.25, fx: 0.95 });
  },

  // ------------------------------------------------------------ ceremonies
  fanfare(s, p) {
    // tier break: a brass-like F lydian motif (F–A–C, the lydian B as a grace, F) over a kick and a crash, ~2.4 s
    const brass = (m: number, at: number, dur: number, g: number): void => {
      s.tone(midi(m), null, dur, { type: 'sawtooth', gain: g * p.vol, at, attack: 0.02, fx: 0.4, filter: { type: 'lowpass', freq: 1800, q: 0.8 } });
      s.tone(midi(m), null, dur, { type: 'square', gain: g * 0.35 * p.vol, at, attack: 0.02, detune: -7, fx: 0.4, filter: { type: 'lowpass', freq: 1400 } });
      s.tone(midi(m - 12), null, dur, { type: 'triangle', gain: g * 0.5 * p.vol, at, attack: 0.02, fx: 0.3 });
    };
    brass(65, 0, 0.28, 0.12);
    brass(69, 0.3, 0.28, 0.12);
    brass(72, 0.6, 0.28, 0.13);
    brass(71, 0.9, 0.12, 0.08);
    brass(77, 1.05, 1.3, 0.16);
    brass(72, 1.05, 1.3, 0.08);
    s.tone(120, 42, 0.18, { type: 'sine', gain: 0.32 * p.vol, at: 1.05, attack: 0.002 });
    s.noise(1.4, { gain: 0.2 * p.vol, type: 'lowpass', freq: 500, freqEnd: 160, attack: 0.02, at: 1.05, fx: 0.5 });
    [0, 4, 7, 12].forEach((iv, i) => s.tone(midi(89 + iv), null, 0.8, { type: 'sine', gain: 0.05 * p.vol, at: 1.25 + i * 0.07, fx: 0.9 }));
  },
  endingSting(s, p) {
    // the ending: a slow F lydian bell cluster (F–A–C–E–B) blooming over a low F, long tails
    [0, 4, 7, 11, 18].forEach((iv, i) => {
      const f = midi(65 + iv);
      s.tone(f, null, 2.4, { type: 'sine', gain: 0.12 * p.vol, at: i * 0.22, attack: 0.05, fx: 0.95, pan: -0.4 + i * 0.2 });
      s.tone(f * 2.76, null, 0.9, { type: 'sine', gain: 0.03 * p.vol, at: i * 0.22, fx: 0.95 });
    });
    s.tone(midi(41), null, 3.2, { type: 'sine', gain: 0.2 * p.vol, attack: 0.6, fx: 0.7 });
    s.tone(midi(53), null, 3.0, { type: 'triangle', gain: 0.06 * p.vol, attack: 0.9, fx: 0.9, filter: { type: 'lowpass', freq: 900 } });
  },

  // ------------------------------------------------------------ ui
  uiMove(s, p) { s.tone(660, null, 0.05, { type: 'sine', gain: 0.08 * p.vol }); },
  uiConfirm(s, p) { s.tone(520, 780, 0.11, { type: 'triangle', gain: 0.14 * p.vol, fx: 0.2 }); },
  uiCancel(s, p) { s.tone(420, 260, 0.11, { type: 'triangle', gain: 0.12 * p.vol }); },
  uiToggle(s, p) {
    s.tone(440, null, 0.06, { type: 'square', gain: 0.08 * p.vol, filter: { type: 'lowpass', freq: 2000 } });
    s.tone(880, null, 0.05, { type: 'sine', gain: 0.08 * p.vol, at: 0.03 });
  },
  uiUnlock(s, p) {
    [0, 4, 7, 12].forEach((iv, i) => s.tone(midi(76 + iv), null, 0.3, { type: 'sine', gain: 0.12 * p.vol, at: i * 0.06, fx: 0.5 }));
  },
  uiError(s, p) {
    s.tone(220, 180, 0.16, { type: 'square', gain: 0.1 * p.vol, filter: { type: 'lowpass', freq: 1400 } });
    s.tone(220, 180, 0.16, { type: 'square', gain: 0.1 * p.vol, at: 0.14, filter: { type: 'lowpass', freq: 1400 } });
  },
  uiStar(s, p) {
    // a star pops in: a bright ping, a fourth higher per star, staggered by index so three fire from one stage
    const i = clamp(Math.floor(p.idx ?? 0), 0, 2);
    const f = midi(88 + i * 5);
    s.tone(f * 0.8, f, 0.22, { type: 'sine', gain: 0.13 * p.vol, at: i * 0.12, fx: 0.6, pan: -0.3 + i * 0.3 });
    s.tone(f * 2, null, 0.12, { type: 'triangle', gain: 0.05 * p.vol, at: i * 0.12 + 0.02, fx: 0.6 });
  },
  uiMedal(s, p) {
    // a medal lands: a metallic tick and a two-note chime (E5 → B5)
    s.noise(0.04, { gain: 0.1 * p.vol, type: 'highpass', freq: 3200 });
    s.tone(midi(76), null, 0.3, { type: 'triangle', gain: 0.12 * p.vol, at: 0.02, fx: 0.5 });
    s.tone(midi(83), null, 0.45, { type: 'sine', gain: 0.11 * p.vol, at: 0.13, fx: 0.7 });
    s.tone(midi(83) * 2.76, null, 0.2, { type: 'sine', gain: 0.03 * p.vol, at: 0.13, fx: 0.7 });
  },
};

/** Minimum spacing (ms of audio-clock time) between two plays of the same effect. */
export const GATE_MS: Partial<Record<SfxName, number>> = {
  jump: 40, land: 60, wallSlide: 140, bolt: 50, foeHit: 50, crumble: 90, splash: 120, uiMove: 40, dash: 40,
};

// ---------------------------------------------------------------- mapping
/** Event types that intentionally make no sound. */
export const SILENT_EVENTS = ['phase', 'dashEnd'] as const;
export type SilentEvent = (typeof SILENT_EVENTS)[number];
export type SoundedEvent = Exclude<SimEvent['type'], SilentEvent>;

export const EVENT_SFX: Record<SoundedEvent, SfxName> = {
  jump: 'jump', land: 'land', dash: 'dash', wallJump: 'wallJump', wallSlide: 'wallSlide',
  stomp: 'stomp', stompLand: 'stompLand', shard: 'shard', relic: 'relic', crystal: 'crystal',
  toggle: 'toggle', checkpoint: 'checkpoint', spring: 'spring', hurt: 'hurt', death: 'death',
  respawn: 'respawn', goal: 'goal', foeHit: 'foeHit', foeKilled: 'foeKilled', bolt: 'bolt',
  crumble: 'crumble', splash: 'splash', tideOver: 'tideOver',
};

export const UI_SFX: Record<UiSound, SfxName> = {
  move: 'uiMove', confirm: 'uiConfirm', cancel: 'uiCancel', toggle: 'uiToggle', unlock: 'uiUnlock', error: 'uiError',
};

/**
 * The clear sting per biome (P3-9), keyed by the biome id — which is also the
 * biome's music track key, so the engine picks it from the track it is playing.
 * Any other track (the title, none) keeps the generic `goal` fanfare.
 */
export const BIOME_STING: Readonly<Record<BiomeId, SfxName>> = {
  tidepool: 'stingTidepool', stormspire: 'stingStormspire', voidreef: 'stingVoidreef', summit: 'stingSummit',
};

/** The clear sting for a track key, or null when the key is not a biome's. */
export function stingFor(track: string | null | undefined): SfxName | null {
  if (!track) return null;
  return (BIOME_STING as Readonly<Record<string, SfxName | undefined>>)[track] ?? null;
}

/** Ceremony stingers the shell and the UI trigger outside the sim event stream (P3-9). */
export type StingerKind = 'tier' | 'ending' | 'star' | 'medal';
export const STINGERS: Readonly<Record<StingerKind, SfxName>> = {
  tier: 'fanfare', ending: 'endingSting', star: 'uiStar', medal: 'uiMedal',
};

const isSilent = (t: SimEvent['type']): t is SilentEvent => (SILENT_EVENTS as readonly string[]).includes(t);

/** The effect for an event, or null when the event is silent. */
export function eventSfx(ev: SimEvent): SfxName | null {
  if (isSilent(ev.type)) return null;
  return EVENT_SFX[ev.type];
}

/** World-space distance (units) at which an effect is fully panned to one side. */
const PAN_RANGE = 240;
const TILE = 16;

/**
 * Extract the play parameters from an event. `player` (the listener) is
 * optional: without it every effect is centred.
 */
export function eventParams(ev: SimEvent, player?: Pick<PlayerState, 'x' | 'y'> | null): SfxParams {
  const p: SfxParams = { vol: 1, pan: 0 };
  let x: number | null = null;
  if ('x' in ev && typeof ev.x === 'number') x = ev.x;
  else if (ev.type === 'crumble') x = ev.tx * TILE + TILE / 2;
  if (x !== null && player) p.pan = clamp((x - player.x) / PAN_RANGE, -1, 1) * 0.7;

  switch (ev.type) {
    case 'jump': p.air = ev.air; break;
    case 'land': p.impact = ev.impact; break;
    case 'dash': p.dy = ev.dy; break;
    case 'shard': p.combo = Math.max(0, ev.combo - 1); break;
    case 'hurt': p.hp = ev.hp; break;
    case 'toggle': p.switchA = ev.switchA; break;
    case 'splash': p.enter = ev.enter; break;
    case 'foeHit': p.kind = ev.kind; p.vol = 0.8; break;
    case 'foeKilled': p.kind = ev.kind; break;
    case 'wallJump': case 'wallSlide': p.dir = ev.dir; break;
    case 'crumble': p.vol = 0.8; break;
    default: break;
  }
  return p;
}
