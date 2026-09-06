/**
 * Sequenced music. Each track is a key, a mode, a tempo, a chord progression
 * and an arrangement function that decides, for one sixteenth-note step, which
 * notes play at a given intensity (0..1 — calm to frantic). The arrangement is
 * pure data-out (`Note[]`), so the compositions are testable without audio;
 * `renderNote` turns a note into `Synth` primitives with the track's timbres,
 * and `Sequencer` schedules ahead of the audio clock.
 *
 * Tracks (all new for Echo Tower):
 *   title       F lydian   76 bpm   floating pads, bell motif, no drums
 *   tidepool    E dorian   96 bpm   bright marimba phrase, shaker, water-drop sparkles
 *   stormspire  E phrygian 128 bpm  driving filtered-saw bass, four-on-the-floor, stabs
 *   voidreef    A aeolian  84 bpm   sparse dark pads, slow glass arpeggio, heartbeat
 */
import { midi } from './sfx.js';
import type { Synth } from './sfx.js';

export type ScaleName = 'dorian' | 'phrygian' | 'aeolian' | 'lydian' | 'pentMin';

export const SCALES: Record<ScaleName, readonly number[]> = {
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  pentMin: [0, 3, 5, 7, 10],
};

export const STEPS_PER_BAR = 16;
/** Seconds of audio scheduled ahead of the clock on every tick. */
export const LOOKAHEAD = 0.25;

export type Inst =
  | 'pad' | 'bass' | 'sub' | 'arp' | 'lead' | 'bell' | 'drop'
  | 'kick' | 'snare' | 'hat' | 'shaker' | 'rim' | 'crash';

export interface Note {
  inst: Inst;
  /** MIDI note; 0 for unpitched percussion. */
  midi: number;
  /** Offset from the step start, in steps (fractional for swing/flams). */
  offset: number;
  /** Length in steps. */
  dur: number;
  /** 0..1 */
  vel: number;
}

export interface TrackVoices {
  pad: 'saw' | 'glass' | 'dark';
  bass: 'soft' | 'sawlp' | 'sub';
  arp: 'marimba' | 'pluck' | 'glass';
  lead: 'stab' | 'arp';
  kick: 'punch' | 'heart';
}

/** Chord helpers handed to an arrangement for the current bar. */
export interface PlanCtx {
  /** Scale degree of the bar's chord. */
  deg: number;
  chordRoot: number;
  /** Scale note by index relative to the track root (negative and >6 wrap octaves). */
  sn(idx: number): number;
  /** Chord tone i: 0 root · 1 third · 2 fifth · 3 root+8ve · 4 third+8ve · 5 fifth+8ve · 6 root+15ve … */
  ct(i: number): number;
}

export type Arrangement = (s: number, bar: number, k: number, c: PlanCtx, out: Note[]) => void;

export interface TrackDef {
  key: string;
  /** Korean display name. */
  name: string;
  root: number;
  scale: ScaleName;
  bpm: number;
  /** Chord scale degrees, one per bar. */
  prog: readonly number[];
  /** Layer levels 0..1. */
  mix: { pad: number; bass: number; arp: number; lead: number; bell: number; drums: number };
  voice: TrackVoices;
  /** Pad lowpass cutoff (Hz). */
  padCutoff: number;
  arrange: Arrangement;
}

const N = (inst: Inst, m: number, dur: number, vel: number, offset = 0): Note => ({ inst, midi: m, offset, dur, vel });

function scaleNote(root: number, sc: readonly number[], idx: number): number {
  const len = sc.length;
  const oct = Math.floor(idx / len);
  const i = idx - oct * len;
  return root + sc[i] + 12 * oct;
}

export function planCtx(track: TrackDef, bar: number): PlanCtx {
  const sc = SCALES[track.scale];
  const deg = track.prog[bar % track.prog.length];
  const sn = (idx: number) => scaleNote(track.root, sc, idx);
  const ct = (i: number) => {
    const oct = Math.floor(i / 3);
    const k = i - oct * 3;
    return sn(deg + k * 2 + oct * sc.length);
  };
  return { deg, chordRoot: sn(deg), sn, ct };
}

// ---------------------------------------------------------------- arrangements
/** Two-bar marimba phrase: step → chord-tone index (undefined = rest). */
const TIDE_PHRASE: ReadonlyArray<Readonly<Record<number, number>>> = [
  { 0: 3, 2: 4, 3: 5, 6: 4, 8: 3, 10: 5, 11: 4, 14: 6 },
  { 0: 4, 2: 5, 3: 3, 6: 5, 8: 4, 10: 6, 11: 5, 14: 3 },
];
const TIDE_BACKBONE = new Set([0, 8]);
const TIDE_MID = new Set([0, 3, 6, 8, 11, 14]);

const tidepool: Arrangement = (s, bar, k, c, out) => {
  // bright, high glass pad on every bar
  if (s === 0) for (const i of [3, 4, 5]) out.push(N('pad', c.ct(i), 16.5, 0.55));

  // soft bass: root on 1 and 3, fifth pickup, octave on odd bars
  if (s === 0 || s === 8) out.push(N('bass', c.ct(0) - 12, 3.5, 0.8));
  if (k > 0.3 && s === 6) out.push(N('bass', c.ct(2) - 12, 1.5, 0.6));
  if (k > 0.55 && s === 14 && (bar & 1)) out.push(N('bass', c.ct(0), 1.5, 0.55));

  // marimba phrase: density thins with intensity
  const ph = TIDE_PHRASE[bar % 2];
  const idx = ph[s];
  if (idx !== undefined) {
    const on = k < 0.2 ? TIDE_BACKBONE.has(s) : k < 0.5 ? TIDE_MID.has(s) : true;
    if (on) {
      const accent = s === 0 || s === 8 ? 0.9 : s % 4 === 2 ? 0.55 : 0.7;
      out.push(N('arp', c.ct(idx), 1.5, accent));
      if (k > 0.75 && (s === 3 || s === 11)) out.push(N('arp', c.ct(idx + 3), 1.2, 0.4, 0.5));
    }
  }

  // water-drop sparkle
  if (k > 0.35 && s === 6 && bar % 2 === 1) out.push(N('drop', c.ct(6 + (bar % 3)), 1.5, 0.6));

  // closing bell every fourth bar
  if (s === 14 && bar % 4 === 3) out.push(N('bell', c.ct(7), 6, 0.5));

  // light kit
  if (k > 0.25 && (s === 0 || s === 8)) out.push(N('kick', 0, 1, 0.7));
  if (k > 0.6 && s === 10) out.push(N('kick', 0, 1, 0.5));
  if (k > 0.35 && s % 2 === 0) out.push(N('shaker', 0, 0.5, s % 4 === 0 ? 0.6 : 0.4));
  if (k > 0.5 && (s === 4 || s === 12)) out.push(N('rim', 0, 0.5, 0.6));
  if (k > 0.8 && s % 2 === 1) out.push(N('hat', 0, 0.3, 0.35));
};

const STORM_BASS_FULL = new Set([0, 2, 3, 4, 6, 7, 8, 10, 11, 12, 14, 15]);
const STORM_OCTAVE = new Set([3, 7, 11, 15]);
const STORM_ARP_STEPS = [2, 6, 10, 14];
const STORM_ARP_TONES = [6, 7, 8, 7];
const STORM_STAB_STEPS = [3, 6, 10, 13];
const STORM_STAB_TONES = [8, 7, 6, 7];

const stormspire: Arrangement = (s, bar, k, c, out) => {
  // thin detuned saw pad, brighter with intensity
  if (s === 0) for (const i of [3, 4, 5]) out.push(N('pad', c.ct(i), 16.5, 0.4 + 0.2 * k));

  // filtered saw bass, 16th-note engine; the velocity opens the filter
  const on = k < 0.3 ? s % 4 === 0 : k < 0.6 ? s % 2 === 0 : STORM_BASS_FULL.has(s);
  if (on) {
    const vel = 0.6 + 0.4 * k;
    if (STORM_OCTAVE.has(s)) out.push(N('bass', c.ct(3), 0.9, vel * 0.7));
    else if (s === 12) out.push(N('bass', c.ct(2), 1.8, vel));
    else if (s === 14) out.push(N('bass', c.ct(1), 1.8, vel * 0.9));
    else out.push(N('bass', c.ct(0), s % 4 === 0 ? 1.8 : 0.9, vel));
  }

  // kit: four on the floor, backbeat, hats fill in with intensity
  if (k > 0.2 && s % 4 === 0) out.push(N('kick', 0, 1, 0.85));
  if (k > 0.7 && s === 14 && (bar & 1)) out.push(N('kick', 0, 1, 0.6));
  if (k > 0.35 && (s === 4 || s === 12)) out.push(N('snare', 0, 1, 0.8));
  if (k > 0.75) out.push(N('hat', 0, 0.3, s % 2 === 1 ? 0.5 : 0.28));
  else if (k > 0.45 && s % 2 === 1) out.push(N('hat', 0, 0.3, 0.45));
  if (k > 0.5 && s === 0 && bar % 8 === 0) out.push(N('crash', 0, 8, 0.6));

  // offbeat pluck arpeggio
  const ai = STORM_ARP_STEPS.indexOf(s);
  if (k > 0.45 && ai >= 0) out.push(N('arp', c.ct(STORM_ARP_TONES[ai]), 1.2, 0.5));

  // stabs, and a scale run into every fourth bar
  if (k > 0.6) {
    if (bar % 4 === 3 && s >= 12) out.push(N('lead', c.sn(c.deg + 14 + (s - 12)), 0.9, 0.55));
    else {
      const li = STORM_STAB_STEPS.indexOf(s);
      if (li >= 0) out.push(N('lead', c.ct(STORM_STAB_TONES[li]), 1.4, 0.5));
    }
  }
};

const VOID_ARP_SLOW = [3, 4, 5, 6, 5, 4, 3, 4];
const VOID_ARP_FAST = [3, 4, 5, 6, 7, 6, 5, 4, 3, 5, 4, 6, 5, 7, 6, 4];

const voidreef: Arrangement = (s, bar, k, c, out) => {
  // dark, low pad; a ninth-ish colour tone above 0.5
  if (s === 0) {
    for (const i of [0, 1, 2]) out.push(N('pad', c.ct(i), 16.5, 0.5));
    if (k > 0.5) out.push(N('pad', c.ct(4), 16.5, 0.3));
  }

  // sub pulses
  if (s === 0) out.push(N('sub', c.ct(0) - 12, 8, 0.5));
  if (k > 0.4 && s === 8) out.push(N('sub', c.ct(0) - 12, 6, 0.4));

  // slow glass arpeggio, quarter notes; eighths above 0.5
  if (k > 0.5) {
    if (s % 2 === 0) {
      const pos = ((bar % 2) * 8 + s / 2) % VOID_ARP_FAST.length;
      out.push(N('arp', c.ct(VOID_ARP_FAST[pos]), 3, 0.5));
    }
  } else if (k < 0.15 ? s % 8 === 0 : s % 4 === 0) {
    const pos = ((bar % 2) * 4 + s / 4) % VOID_ARP_SLOW.length;
    out.push(N('arp', c.ct(VOID_ARP_SLOW[pos]), 4, 0.55));
  }

  // heartbeat
  if (k > 0.3 && s === 0) out.push(N('kick', 0, 1, 0.4));
  if (k > 0.3 && s === 3) out.push(N('kick', 0, 1, 0.28));

  // distant bell
  if (s === 10 && bar % 4 === 1) out.push(N('bell', c.ct(7), 8, 0.4));

  // tension layers
  if (k > 0.65 && (s === 4 || s === 12)) out.push(N('shaker', 0, 0.5, 0.3));
  if (k > 0.8 && s % 4 === 2) out.push(N('arp', c.ct(6 + (bar % 2)), 2, 0.3));
};

const title: Arrangement = (s, bar, k, c, out) => {
  // floating saw pad with a 9th on alternate bars
  if (s === 0) {
    for (const i of [3, 4, 5]) out.push(N('pad', c.ct(i), 16.5, 0.4));
    if (bar % 2 === 1) out.push(N('pad', c.sn(c.deg + 8), 16.5, 0.25));
  }

  // soft bass
  if (s === 0) out.push(N('bass', c.ct(0) - 12, 6, 0.7));
  if (k > 0.3 && s === 10) out.push(N('bass', c.ct(0) - 12, 4, 0.5));

  // bell motif over two bars
  if (bar % 2 === 0) {
    if (s === 0) out.push(N('bell', c.ct(6), 6, 0.5));
    if (s === 6) out.push(N('bell', c.ct(7), 6, 0.4));
  } else {
    if (s === 2) out.push(N('bell', c.ct(8), 6, 0.45));
    if (s === 10) out.push(N('bell', c.ct(6), 6, 0.4));
  }

  // glass arpeggio fills in as the menu gets busier
  if (k > 0.3 && s % 4 === 2) out.push(N('arp', c.ct(3 + ((s / 4) | 0) % 3), 3, 0.35));
  if (k > 0.7 && s % 4 === 0 && s > 0) out.push(N('arp', c.ct(4 + ((s / 4) | 0) % 3), 3, 0.3));
};

export const TRACKS: Record<string, TrackDef> = {
  title: {
    key: 'title', name: '메아리 탑', root: 53, scale: 'lydian', bpm: 76, prog: [0, 1, 5, 4],
    mix: { pad: 0.3, bass: 0.2, arp: 0.14, lead: 0, bell: 0.18, drums: 0 },
    voice: { pad: 'saw', bass: 'soft', arp: 'glass', lead: 'arp', kick: 'punch' }, padCutoff: 900,
    arrange: title,
  },
  tidepool: {
    key: 'tidepool', name: '조수 웅덩이', root: 52, scale: 'dorian', bpm: 96, prog: [0, 3, 6, 4],
    mix: { pad: 0.22, bass: 0.24, arp: 0.3, lead: 0, bell: 0.16, drums: 0.28 },
    voice: { pad: 'glass', bass: 'soft', arp: 'marimba', lead: 'arp', kick: 'punch' }, padCutoff: 3000,
    arrange: tidepool,
  },
  stormspire: {
    key: 'stormspire', name: '폭풍 첨탑', root: 40, scale: 'phrygian', bpm: 128, prog: [0, 1, 0, 3],
    mix: { pad: 0.18, bass: 0.34, arp: 0.16, lead: 0.22, bell: 0.06, drums: 0.44 },
    voice: { pad: 'saw', bass: 'sawlp', arp: 'pluck', lead: 'stab', kick: 'punch' }, padCutoff: 1400,
    arrange: stormspire,
  },
  voidreef: {
    key: 'voidreef', name: '공허의 초', root: 45, scale: 'aeolian', bpm: 84, prog: [0, 5, 3, 4],
    mix: { pad: 0.32, bass: 0.28, arp: 0.22, lead: 0, bell: 0.2, drums: 0.16 },
    voice: { pad: 'dark', bass: 'sub', arp: 'glass', lead: 'arp', kick: 'heart' }, padCutoff: 500,
    arrange: voidreef,
  },
};

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Notes for one step (0..15) of one bar at the given intensity. Pure. */
export function planStep(track: TrackDef, step: number, bar: number, intensity: number): Note[] {
  const out: Note[] = [];
  track.arrange(step % STEPS_PER_BAR, bar, clamp01(intensity), planCtx(track, bar), out);
  return out;
}

/** Every note in `bars` consecutive bars starting at `startBar`. For tests and tooling. */
export function planWindow(track: TrackDef, startBar: number, bars: number, intensity: number): Note[] {
  const out: Note[] = [];
  for (let b = startBar; b < startBar + bars; b++) {
    for (let s = 0; s < STEPS_PER_BAR; s++) out.push(...planStep(track, s, b, intensity));
  }
  return out;
}

// ---------------------------------------------------------------- rendering
/** Turn one note into synth voices. `at` is seconds from now. */
export function renderNote(s: Synth, t: TrackDef, n: Note, at: number, stepDur: number, dest: AudioNode | null): void {
  const dur = Math.max(0.03, n.dur * stepDur);
  const f = n.midi > 0 ? midi(n.midi) : 0;
  const v = n.vel;
  const m = t.mix;
  const pan = n.midi > 0 ? (((n.midi % 12) / 12) - 0.5) * 0.5 : 0;

  switch (n.inst) {
    case 'pad': {
      const g = m.pad * v;
      if (g <= 0) return;
      if (t.voice.pad === 'saw') {
        for (const det of [-6, 6]) {
          s.tone(f, null, dur, { type: 'sawtooth', gain: g * 0.06, attack: 0.35, at, dest, fx: 0.5, detune: det,
            filter: { type: 'lowpass', freq: t.padCutoff, q: 0.5 } });
        }
      } else if (t.voice.pad === 'glass') {
        s.tone(f, null, dur, { type: 'sine', gain: g * 0.1, attack: 0.25, at, dest, fx: 0.6, pan });
        s.tone(f * 2, null, dur, { type: 'triangle', gain: g * 0.03, attack: 0.4, at, dest, fx: 0.6, pan: -pan });
      } else {
        s.tone(f, null, dur, { type: 'sine', gain: g * 0.12, attack: 0.9, at, dest, fx: 0.8 });
        s.tone(f, null, dur, { type: 'sawtooth', gain: g * 0.05, attack: 1.2, at, dest, fx: 0.8, detune: 4,
          filter: { type: 'lowpass', freq: t.padCutoff, q: 0.7 } });
      }
      return;
    }
    case 'bass': {
      const g = m.bass * v;
      if (g <= 0) return;
      if (t.voice.bass === 'sawlp') {
        s.tone(f, null, dur, { type: 'sawtooth', gain: g * 0.4, attack: 0.004, at, dest,
          filter: { type: 'lowpass', freq: 300 + v * 1700, freqEnd: 180, q: 5 } });
        s.tone(f / 2, null, dur * 0.8, { type: 'sine', gain: g * 0.25, attack: 0.004, at, dest });
      } else if (t.voice.bass === 'sub') {
        s.tone(f, null, dur, { type: 'sine', gain: g * 0.6, attack: 0.03, at, dest });
        s.tone(f, null, dur, { type: 'triangle', gain: g * 0.1, attack: 0.05, at, dest, filter: { type: 'lowpass', freq: 300 } });
      } else {
        s.tone(f, f * 0.995, dur, { type: 'triangle', gain: g * 0.5, attack: 0.006, at, dest });
        s.tone(f * 2, null, dur * 0.4, { type: 'square', gain: g * 0.08, at, dest, filter: { type: 'lowpass', freq: 1200 } });
      }
      return;
    }
    case 'sub': {
      const g = m.bass * v;
      if (g > 0) s.tone(f, null, dur, { type: 'sine', gain: g * 0.6, attack: 0.02, at, dest });
      return;
    }
    case 'arp':
    case 'lead': {
      const isLead = n.inst === 'lead';
      const g = (isLead ? m.lead : m.arp) * v;
      if (g <= 0) return;
      if (isLead && t.voice.lead === 'stab') {
        s.tone(f, null, dur, { type: 'sawtooth', gain: g * 0.25, attack: 0.005, at, dest, fx: 0.25, pan,
          filter: { type: 'lowpass', freq: 3000, freqEnd: 600, q: 2 } });
        s.tone(f, null, dur, { type: 'sawtooth', gain: g * 0.15, attack: 0.005, at, dest, detune: 9, pan: -pan,
          filter: { type: 'lowpass', freq: 2600, freqEnd: 500, q: 2 } });
        return;
      }
      if (t.voice.arp === 'marimba') {
        s.tone(f, null, Math.min(dur, 0.35), { type: 'sine', gain: g * 0.5, attack: 0.002, at, dest, fx: 0.35, pan });
        s.tone(f * 4, null, 0.06, { type: 'sine', gain: g * 0.18, attack: 0.001, at, dest, pan });
      } else if (t.voice.arp === 'pluck') {
        s.tone(f, null, Math.min(dur, 0.25), { type: 'square', gain: g * 0.3, attack: 0.003, at, dest, fx: 0.3, pan,
          filter: { type: 'lowpass', freq: 2400, freqEnd: 300, q: 1.2 } });
      } else {
        s.tone(f, null, dur, { type: 'sine', gain: g * 0.35, attack: 0.06, at, dest, fx: 0.7, pan });
        s.tone(f, null, dur, { type: 'triangle', gain: g * 0.08, attack: 0.1, at, dest, fx: 0.7, detune: 5, pan: -pan });
      }
      return;
    }
    case 'bell': {
      const g = m.bell * v;
      if (g <= 0) return;
      s.tone(f, null, dur, { type: 'sine', gain: g * 0.3, at, dest, fx: 0.9, pan });
      s.tone(f * 2.76, null, dur * 0.5, { type: 'sine', gain: g * 0.08, at, dest, fx: 0.9, pan });
      return;
    }
    case 'drop': {
      const g = m.bell * v;
      if (g > 0) s.tone(f * 0.7, f, 0.14, { type: 'sine', gain: g * 0.25, attack: 0.003, at, dest, fx: 0.8, pan });
      return;
    }
    case 'kick': {
      const g = m.drums * v;
      if (g <= 0) return;
      if (t.voice.kick === 'heart') s.tone(80, 30, 0.25, { type: 'sine', gain: g * 0.6, attack: 0.004, at, dest });
      else s.tone(120, 42, 0.16, { type: 'sine', gain: g * 0.8, attack: 0.002, at, dest });
      return;
    }
    case 'snare': {
      const g = m.drums * v;
      if (g <= 0) return;
      s.noise(0.13, { gain: g * 0.34, type: 'bandpass', freq: 1900, q: 0.7, at, dest });
      s.tone(210, 170, 0.08, { type: 'triangle', gain: g * 0.2, at, dest });
      return;
    }
    case 'hat': {
      const g = m.drums * v;
      if (g > 0) s.noise(0.045, { gain: g * 0.14, type: 'highpass', freq: 7200, at, dest });
      return;
    }
    case 'shaker': {
      const g = m.drums * v;
      if (g > 0) s.noise(0.08, { gain: g * 0.1, type: 'highpass', freq: 5500, q: 0.8, attack: 0.01, at, dest });
      return;
    }
    case 'rim': {
      const g = m.drums * v;
      if (g <= 0) return;
      s.noise(0.05, { gain: g * 0.2, type: 'bandpass', freq: 3000, q: 3, at, dest });
      s.tone(900, null, 0.03, { type: 'square', gain: g * 0.08, at, dest });
      return;
    }
    case 'crash': {
      const g = m.drums * v;
      if (g > 0) s.noise(1.2, { gain: g * 0.5, type: 'lowpass', freq: 400, freqEnd: 150, attack: 0.02, at, dest, fx: 0.5 });
      return;
    }
    default:
      return;
  }
}

// ---------------------------------------------------------------- sequencer
/**
 * Steps one track ahead of the audio clock. `schedule` is called by the
 * engine's timer; it renders every step whose start time falls before the
 * horizon and returns how many notes it placed.
 */
export class Sequencer {
  step = 0;
  bar = 0;
  nextTime: number;

  constructor(
    readonly track: TrackDef,
    private readonly synth: Synth,
    private readonly dest: AudioNode | null,
    startAt: number,
  ) {
    this.nextTime = startAt;
  }

  get stepDur(): number { return 60 / this.track.bpm / STEPS_PER_BAR * 4; }

  schedule(now: number, horizon: number, intensity: number): number {
    // Timers stop while a tab is hidden, so nextTime can fall far behind the
    // audio clock. Resync instead of firing every missed step at once.
    if (this.nextTime < now - LOOKAHEAD) this.nextTime = now + 0.02;
    const stepDur = this.stepDur;
    let placed = 0;
    let guard = 0;
    while (this.nextTime < horizon && guard++ < 64) {
      const notes = planStep(this.track, this.step, this.bar, intensity);
      const at = this.nextTime - now;
      for (const n of notes) renderNote(this.synth, this.track, n, at + n.offset * stepDur, stepDur, this.dest);
      placed += notes.length;
      this.nextTime += stepDur;
      this.step++;
      if (this.step >= STEPS_PER_BAR) { this.step = 0; this.bar++; }
    }
    return placed;
  }
}
