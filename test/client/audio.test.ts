import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SimEvent, SimState } from '../../src/sim/types.js';
import type { Settings, UiSound } from '../../src/client/contracts.js';
import { AudioEngine } from '../../src/client/audio/engine.js';
import {
  BIOME_STING, CHECKPOINT_PITCH_CAP, EVENT_SFX, SFX, SHARD_LADDER, SHARD_SHIMMER_AT, SILENT_EVENTS, STINGERS, UI_SFX, eventSfx, midi, stingFor,
} from '../../src/client/audio/sfx.js';
import type { SfxName, SfxParams, StingerKind, Synth } from '../../src/client/audio/sfx.js';
import { ENDING_TRACK, SCALES, TRACKS, planStep, planWindow } from '../../src/client/audio/music.js';
import { BIOME_ORDER } from '../../src/shared/biomes.js';

// ------------------------------------------------------------------ fake WebAudio
interface ParamEvent { type: 'set' | 'linear' | 'exp' | 'target'; value: number; time: number }

class FakeParam {
  value: number;
  readonly events: ParamEvent[] = [];
  constructor(v: number) { this.value = v; }
  setValueAtTime(v: number, t: number) { this.events.push({ type: 'set', value: v, time: t }); this.value = v; return this; }
  linearRampToValueAtTime(v: number, t: number) { this.events.push({ type: 'linear', value: v, time: t }); this.value = v; return this; }
  exponentialRampToValueAtTime(v: number, t: number) { this.events.push({ type: 'exp', value: v, time: t }); this.value = v; return this; }
  setTargetAtTime(v: number, t: number, _tc: number) { this.events.push({ type: 'target', value: v, time: t }); this.value = v; return this; }
  cancelScheduledValues(_t: number) { return this; }
}

class FakeNode {
  readonly outputs: FakeNode[] = [];
  started: number[] = [];
  stopped: number[] = [];
  constructor(readonly ctx: FakeAudioContext, readonly kind: string) { ctx.nodes.push(this); }
  connect(n: FakeNode) { this.outputs.push(n); return n; }
  disconnect() { this.outputs.length = 0; }
  start(t = 0) { this.started.push(t); }
  stop(t = 0) { this.stopped.push(t); }
}

class FakeGain extends FakeNode { gain = new FakeParam(1); }
class FakeOsc extends FakeNode {
  type = 'sine';
  frequency = new FakeParam(440);
  detune = new FakeParam(0);
}
class FakeFilter extends FakeNode {
  type = 'lowpass';
  frequency = new FakeParam(350);
  Q = new FakeParam(1);
  gain = new FakeParam(0);
}
class FakeDelay extends FakeNode { delayTime = new FakeParam(0); }
class FakeCompressor extends FakeNode {
  threshold = new FakeParam(-24); knee = new FakeParam(30); ratio = new FakeParam(12);
  attack = new FakeParam(0.003); release = new FakeParam(0.25);
}
class FakePanner extends FakeNode { pan = new FakeParam(0); }
class FakeBufferSource extends FakeNode {
  buffer: unknown = null;
  playbackRate = new FakeParam(1);
  loop = false;
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  readonly nodes: FakeNode[] = [];
  currentTime = 0;
  sampleRate = 48000;
  state: 'suspended' | 'running' | 'closed' = 'running';
  readonly destination: FakeNode;
  resumed = 0;
  suspended = 0;
  closed = 0;
  constructor(_opts?: unknown) {
    FakeAudioContext.instances.push(this);
    this.destination = new FakeNode(this, 'destination');
  }
  createGain() { return new FakeGain(this, 'gain'); }
  createOscillator() { return new FakeOsc(this, 'osc'); }
  createBiquadFilter() { return new FakeFilter(this, 'filter'); }
  createDelay(_max?: number) { return new FakeDelay(this, 'delay'); }
  createDynamicsCompressor() { return new FakeCompressor(this, 'compressor'); }
  createStereoPanner() { return new FakePanner(this, 'panner'); }
  createBufferSource() { return new FakeBufferSource(this, 'bufferSource'); }
  createBuffer(_ch: number, len: number, _rate: number) {
    const data = new Float32Array(len);
    return { length: len, getChannelData: () => data };
  }
  resume() { this.resumed++; this.state = 'running'; return Promise.resolve(); }
  suspend() { this.suspended++; this.state = 'suspended'; return Promise.resolve(); }
  close() { this.closed++; this.state = 'closed'; return Promise.resolve(); }
}

const g = globalThis as unknown as { AudioContext?: unknown };
const installFake = () => { FakeAudioContext.instances = []; g.AudioContext = FakeAudioContext; };
const removeFake = () => { delete g.AudioContext; };

const ctxOf = (i = 0) => FakeAudioContext.instances[i];
const nodesOf = (kind: string, ctx = ctxOf()) => ctx.nodes.filter((n) => n.kind === kind);
const sources = (ctx = ctxOf()) => ctx.nodes.filter((n) => n.kind === 'osc' || n.kind === 'bufferSource');

function makeSettings(o: Partial<Settings> = {}): Settings {
  return {
    v: 1, master: 0.8, music: 0.6, sfx: 0.7, shake: 1, bloom: true, grain: true, quality: 'auto',
    flashes: true, showTimer: true, skin: 'clawd', assist: false, invincible: false, echoSelf: true, echoWorld: true,
    binds: {
      left: ['ArrowLeft'], right: ['ArrowRight'], up: ['ArrowUp'], down: ['ArrowDown'], jump: ['Space'], dash: ['ShiftLeft'],
      pause: ['Escape'], confirm: ['Enter'], cancel: ['Escape'], restart: ['KeyR'],
    },
    ...o,
  };
}

/** Mirrors the SimEvent union in src/sim/types.ts. The type-level check below fails to compile if it drifts. */
const EVENT_TYPES = [
  'phase', 'jump', 'land', 'dash', 'dashEnd', 'wallJump', 'wallSlide', 'stomp', 'stompLand', 'shard', 'relic',
  'crystal', 'toggle', 'checkpoint', 'spring', 'hurt', 'death', 'respawn', 'goal', 'foeHit', 'foeKilled', 'bolt',
  'crumble', 'splash', 'tideOver', 'bubblePop', 'bubbleBack',
] as const;
type EvType = (typeof EVENT_TYPES)[number];
// Both directions: every SimEvent type is listed, and nothing extra is listed.
const _missing: Exclude<SimEvent['type'], EvType> extends never ? true : never = true;
const _extra: Exclude<EvType, SimEvent['type']> extends never ? true : never = true;
void _missing; void _extra;

const summary = {
  levelId: 't1', cleared: true, ticks: 1200, time: 10, shards: 3, totalShards: 20, relics: 0, totalRelics: 1,
  deaths: 0, par: 45, rank: 'A' as const, height: 0,
};

/** One representative event per type. */
function sampleEvent(type: EvType): SimEvent {
  const p = { x: 100, y: 100 };
  switch (type) {
    case 'phase': return { type, phase: 'play' };
    case 'jump': return { type, ...p, air: false };
    case 'land': return { type, ...p, impact: 0.7 };
    case 'dash': return { type, ...p, dx: 1, dy: 0 };
    case 'dashEnd': return { type, ...p };
    case 'wallJump': return { type, ...p, dir: 1 };
    case 'wallSlide': return { type, ...p, dir: -1 };
    case 'stomp': return { type, ...p };
    case 'stompLand': return { type, ...p };
    case 'shard': return { type, ...p, n: 1, total: 20, combo: 1 };
    case 'relic': return { type, ...p, n: 1, total: 1 };
    case 'crystal': return { type, ...p };
    case 'toggle': return { type, ...p, switchA: false };
    case 'checkpoint': return { type, ...p };
    case 'spring': return { type, ...p };
    case 'hurt': return { type, ...p, hp: 2 };
    case 'death': return { type, ...p, cause: 'spikes', deaths: 1 };
    case 'respawn': return { type, ...p };
    case 'goal': return { type, ...p, summary };
    case 'foeHit': return { type, ...p, kind: 'walker' };
    case 'foeKilled': return { type, ...p, kind: 'hopper' };
    case 'bolt': return { type, ...p };
    case 'crumble': return { type, tx: 4, ty: 5 };
    case 'splash': return { type, ...p, enter: true };
    case 'tideOver': return { type, summary: { ...summary, cleared: false, height: 40 } };
    case 'bubblePop': return { type, ...p };
    case 'bubbleBack': return { type, ...p };
  }
}

const fakeSim = (px = 100) => ({ state: { player: { x: px, y: 100 } } as unknown as SimState });

// ------------------------------------------------------------------ tests
describe('AudioEngine', () => {
  let engine: AudioEngine;

  beforeEach(() => { installFake(); engine = new AudioEngine(); });
  afterEach(() => { engine.dispose(); removeFake(); });

  it('init() creates one context, builds the graph and is idempotent', () => {
    expect(engine.ready).toBe(false);
    engine.init();
    expect(engine.ready).toBe(true);
    expect(FakeAudioContext.instances).toHaveLength(1);
    engine.init();
    engine.init();
    expect(FakeAudioContext.instances).toHaveLength(1);

    const ctx = ctxOf();
    // compressor → destination
    const comp = nodesOf('compressor');
    expect(comp).toHaveLength(1);
    expect(comp[0].outputs).toContain(ctx.destination);
    // master → compressor; sfx/music buses → master (music via the muffle lowpass)
    const gains = nodesOf('gain') as FakeGain[];
    const master = gains.find((n) => n.outputs.includes(comp[0]));
    expect(master).toBeDefined();
    const intoMaster = gains.filter((n) => n.outputs.includes(master!));
    expect(intoMaster.length).toBeGreaterThanOrEqual(1); // SFX wet/dry share the volume bus
    const filters = nodesOf('filter') as FakeFilter[];
    expect(filters.some((f) => f.outputs.includes(master!) && f.type === 'lowpass')).toBe(true); // musLp
    // Each category owns a two-tap delay, with independent lowpass feedback.
    const delays = nodesOf('delay') as FakeDelay[];
    expect(delays).toHaveLength(4);
    for (const d of delays) {
      expect(d.delayTime.value).toBeGreaterThan(0);
      const lp = d.outputs.find((n) => n.kind === 'filter') as FakeFilter | undefined;
      expect(lp?.type).toBe('lowpass');
      // the feedback gain feeds the same delay again
      const fb = lp!.outputs.find((n) => n.kind === 'gain');
      expect(fb?.outputs).toContain(d);
    }
  });

  it('init() resumes a suspended context instead of creating a new one', () => {
    engine.init();
    const ctx = ctxOf();
    ctx.state = 'suspended';
    engine.init();
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(ctx.resumed).toBeGreaterThanOrEqual(1);
  });

  it('degrades silently when AudioContext is unavailable', () => {
    removeFake();
    const e = new AudioEngine();
    expect(() => e.init()).not.toThrow();
    expect(e.ready).toBe(false);
    expect(() => {
      e.applySettings(makeSettings());
      e.onEvent(sampleEvent('jump'), fakeSim() as never);
      e.setTrack('tidepool');
      e.setIntensity(0.5);
      e.ui('confirm');
      e.tick();
      e.suspend();
      e.resume();
      e.setTrack(null);
      e.dispose();
    }).not.toThrow();
  });

  it('maps every SimEvent type to a sound or lists it as silent', () => {
    engine.init();
    const ctx = ctxOf();
    for (const type of EVENT_TYPES) {
      const silent = (SILENT_EVENTS as readonly string[]).includes(type);
      const mapped = type in EVENT_SFX;
      expect(silent || mapped, `${type} is neither mapped nor silent`).toBe(true);
      expect(silent && mapped, `${type} is both mapped and silent`).toBe(false);

      const before = sources(ctx).length;
      ctx.currentTime += 1; // defeat per-sound rate gates
      engine.onEvent(sampleEvent(type), fakeSim() as never);
      const made = sources(ctx).length - before;
      if (silent) expect(made, `${type} should be silent`).toBe(0);
      else expect(made, `${type} should make a sound`).toBeGreaterThan(0);
    }
  });

  it('defines at least 22 synthesised effects, every one of which produces voices', () => {
    engine.init();
    const ctx = ctxOf();
    const names = Object.keys(SFX);
    expect(names.length).toBeGreaterThanOrEqual(22);
    for (const name of names) {
      const before = sources(ctx).length;
      ctx.currentTime += 1;
      engine.play(name as keyof typeof SFX, { vol: 1, pan: 0 });
      expect(sources(ctx).length - before, `${name} produced no voice`).toBeGreaterThan(0);
    }
  });

  it('raises shard pitch with the combo', () => {
    engine.init();
    const ctx = ctxOf();
    const freqOf = (combo: number) => {
      const before = ctx.nodes.length;
      engine.onEvent({ type: 'shard', x: 0, y: 0, n: 1, total: 10, combo }, fakeSim(0) as never);
      const osc = ctx.nodes.slice(before).find((n) => n.kind === 'osc') as FakeOsc;
      return osc.frequency.events[0].value;
    };
    const f0 = freqOf(0), f3 = freqOf(3), f8 = freqOf(8);
    expect(f3).toBeGreaterThan(f0);
    expect(f8).toBeGreaterThan(f3);
    // capped so a 40-combo does not scream
    expect(freqOf(40)).toBe(freqOf(30));
    expect(eventSfx({ type: 'shard', x: 0, y: 0, n: 1, total: 1, combo: 0 })).toBe('shard');
  });

  it('pans effects relative to the player', () => {
    engine.init();
    const ctx = ctxOf();
    let before = ctx.nodes.length;
    engine.onEvent({ type: 'bolt', x: 400, y: 0 }, fakeSim(100) as never);
    const right = ctx.nodes.slice(before).find((n) => n.kind === 'panner') as FakePanner;
    ctx.currentTime += 1;
    before = ctx.nodes.length;
    engine.onEvent({ type: 'bolt', x: -200, y: 0 }, fakeSim(100) as never);
    const left = ctx.nodes.slice(before).find((n) => n.kind === 'panner') as FakePanner;
    expect(right.pan.value).toBeGreaterThan(0);
    expect(left.pan.value).toBeLessThan(0);
  });

  it('onEvent works without a sim', () => {
    engine.init();
    expect(() => engine.onEvent(sampleEvent('goal'), undefined as never)).not.toThrow();
    expect(sources().length).toBeGreaterThan(0);
  });

  it('rate-gates machine-gunned identical effects', () => {
    engine.init();
    const ctx = ctxOf();
    engine.onEvent(sampleEvent('bolt'), fakeSim() as never);
    const after1 = sources(ctx).length;
    engine.onEvent(sampleEvent('bolt'), fakeSim() as never); // same audio time → gated
    expect(sources(ctx).length).toBe(after1);
    ctx.currentTime += 0.5;
    engine.onEvent(sampleEvent('bolt'), fakeSim() as never);
    expect(sources(ctx).length).toBeGreaterThan(after1);
  });

  it('plays every UI sound', () => {
    engine.init();
    const ctx = ctxOf();
    const all: UiSound[] = ['move', 'confirm', 'cancel', 'toggle', 'unlock', 'error'];
    for (const u of all) {
      expect(UI_SFX[u]).toBeDefined();
      const before = sources(ctx).length;
      ctx.currentTime += 1;
      engine.ui(u);
      expect(sources(ctx).length - before, `ui ${u}`).toBeGreaterThan(0);
    }
  });

  it('applySettings sets the bus gains', () => {
    engine.init();
    engine.applySettings(makeSettings({ master: 0.55, sfx: 0.25, music: 0.35 }));
    const gains = nodesOf('gain') as FakeGain[];
    const lastTarget = (n: FakeGain) => n.gain.events.filter((e) => e.type === 'target').at(-1)?.value;
    expect(gains.some((n) => lastTarget(n) === 0.55)).toBe(true);
    expect(gains.some((n) => lastTarget(n) === 0.25)).toBe(true);
    expect(gains.some((n) => lastTarget(n) === 0.35)).toBe(true);
  });

  it('applySettings before init() seeds the initial bus gains', () => {
    engine.applySettings(makeSettings({ master: 0.4, sfx: 0.3, music: 0.2 }));
    engine.init();
    const gains = nodesOf('gain') as FakeGain[];
    expect(gains.some((n) => n.gain.value === 0.4)).toBe(true);
    expect(gains.some((n) => n.gain.value === 0.3)).toBe(true);
    expect(gains.some((n) => n.gain.value === 0.2)).toBe(true);
  });

  /** A muted path cannot reach the speaker, including sends through feedback loops. */
  function reachesSpeaker(source: FakeNode): boolean {
    const seen = new Set<FakeNode>();
    const visit = (node: FakeNode): boolean => {
      if (seen.has(node) || (node instanceof FakeGain && node.gain.value === 0)) return false;
      if (node === ctxOf().destination) return true;
      seen.add(node);
      return node.outputs.some(visit);
    };
    return visit(source);
  }

  it.each(['before init', 'after init'] as const)('SFX zero mutes every recipe and its reverb, leaving music audible (%s)', (when) => {
    if (when === 'after init') engine.init();
    engine.applySettings(makeSettings({ master: 1, sfx: 0, music: 1 }));
    engine.init();
    const ctx = ctxOf();
    for (const name of Object.keys(SFX) as SfxName[]) {
      ctx.currentTime += 1;
      const before = sources(ctx).length;
      engine.play(name, { vol: 1, pan: 0.4 });
      const made = sources(ctx).slice(before);
      expect(made.length, name).toBeGreaterThan(0);
      expect(made.some(reachesSpeaker), `${name} leaks around SFX volume`).toBe(false);
    }
    engine.setTrack('title');
    const before = sources(ctx).length;
    engine.tick();
    expect(sources(ctx).slice(before).some(reachesSpeaker)).toBe(true);
  });

  it.each(['before init', 'after init'] as const)('music zero mutes every track and its reverb, leaving SFX audible (%s)', (when) => {
    if (when === 'after init') engine.init();
    engine.applySettings(makeSettings({ master: 1, sfx: 1, music: 0 }));
    engine.init();
    const ctx = ctxOf();
    for (const key of Object.keys(TRACKS)) {
      ctx.currentTime += 5;
      engine.setTrack(key);
      const before = sources(ctx).length;
      engine.tick();
      const made = sources(ctx).slice(before);
      expect(made.length, key).toBeGreaterThan(0);
      expect(made.some(reachesSpeaker), `${key} leaks around music volume`).toBe(false);
    }
    const before = sources(ctx).length;
    engine.play('shard', { vol: 1, pan: -0.4 });
    expect(sources(ctx).slice(before).some(reachesSpeaker)).toBe(true);
  });

  it('channel volume changes also mute and unmute already connected effect sends', () => {
    engine.init();
    const ctx = ctxOf();
    engine.play('shard', { vol: 1, pan: 0 });
    const made = sources(ctx);
    expect(made.some(reachesSpeaker)).toBe(true);
    engine.applySettings(makeSettings({ master: 1, sfx: 0, music: 1 }));
    expect(made.some(reachesSpeaker)).toBe(false);
    engine.applySettings(makeSettings({ master: 1, sfx: 1, music: 0 }));
    expect(made.some(reachesSpeaker)).toBe(true);
  });

  it('a completed track fade disconnects its wet send as well as its dry voices', () => {
    engine.init();
    const ctx = ctxOf();
    engine.setTrack('title');
    ctx.currentTime = 1;
    engine.tick();
    const oldVoices = sources(ctx);
    expect(oldVoices.some(reachesSpeaker)).toBe(true);
    engine.setTrack(null);
    ctx.currentTime = 4;
    engine.tick();
    expect(oldVoices.some(reachesSpeaker)).toBe(false);
  });

  it('setTrack cross-fades: the old track gain ramps down while the new one ramps up', () => {
    engine.init();
    const ctx = ctxOf();
    engine.setTrack('tidepool');
    expect(engine.track).toBe('tidepool');
    ctx.currentTime = 5;
    const before = ctx.nodes.length;
    engine.setTrack('stormspire');
    expect(engine.track).toBe('stormspire');
    const gains = nodesOf('gain') as FakeGain[];
    const ramps = gains.map((n) => n.gain.events.filter((e) => e.type === 'linear' && e.time >= 5));
    const down = gains.filter((_n, i) => ramps[i].some((e) => e.value === 0));
    const up = gains.filter((_n, i) => ramps[i].some((e) => e.value === 1));
    expect(down.length).toBeGreaterThanOrEqual(1);
    expect(up.length).toBeGreaterThanOrEqual(1);
    expect(down[0]).not.toBe(up[0]);
    // the fade-in gain is a fresh node created by this call
    expect(ctx.nodes.indexOf(up[0])).toBeGreaterThanOrEqual(before);
    // same key again is a no-op
    const n = ctx.nodes.length;
    engine.setTrack('stormspire');
    expect(ctx.nodes.length).toBe(n);
  });

  it('setTrack(null) fades out and stops; unknown keys are ignored', () => {
    engine.init();
    engine.setTrack('voidreef');
    engine.setTrack('nope');
    expect(engine.track).toBe('voidreef');
    engine.setTrack(null);
    expect(engine.track).toBeNull();
    const gains = nodesOf('gain') as FakeGain[];
    expect(gains.some((n) => n.gain.events.some((e) => e.type === 'linear' && e.value === 0))).toBe(true);
  });

  it('setTrack before init() starts once the context exists', () => {
    engine.setTrack('title');
    expect(engine.track).toBe('title');
    engine.init();
    const ctx = ctxOf();
    engine.tick();
    expect(sources(ctx).length).toBeGreaterThan(0);
  });

  it('the sequencer schedules notes ahead of the audio clock on tick()', () => {
    engine.init();
    const ctx = ctxOf();
    engine.setTrack('stormspire');
    engine.setIntensity(1);
    const before = sources(ctx).length;
    engine.tick();
    const scheduled = sources(ctx).slice(before);
    expect(scheduled.length).toBeGreaterThan(0);
    // everything is scheduled in the future, never in the past
    for (const s of scheduled) expect(s.started[0]).toBeGreaterThanOrEqual(ctx.currentTime);
    // advancing the clock schedules more
    ctx.currentTime += 0.5;
    engine.tick();
    expect(sources(ctx).length).toBeGreaterThan(before + scheduled.length);
  });

  it('resyncs after a long stall instead of bursting every missed step', () => {
    engine.init();
    const ctx = ctxOf();
    engine.setTrack('tidepool');
    engine.tick();
    ctx.currentTime += 30; // tab was hidden
    const before = sources(ctx).length;
    engine.tick();
    // at most one lookahead window worth of steps (< 64 guard) and nothing at a past time
    const made = sources(ctx).slice(before);
    expect(made.length).toBeLessThan(200);
    for (const s of made) expect(s.started[0]).toBeGreaterThanOrEqual(ctx.currentTime);
  });

  it('suspend()/resume() forward to the context', () => {
    engine.init();
    const ctx = ctxOf();
    engine.suspend();
    expect(ctx.suspended).toBe(1);
    expect(ctx.state).toBe('suspended');
    // sfx are dropped while suspended
    const before = sources(ctx).length;
    engine.onEvent(sampleEvent('jump'), fakeSim() as never);
    expect(sources(ctx).length).toBe(before);
    engine.resume();
    expect(ctx.state).toBe('running');
  });

  it('setIntensity clamps and eases toward the target', () => {
    engine.init();
    engine.setIntensity(5);
    expect(engine.targetIntensity).toBe(1);
    engine.setIntensity(-1);
    expect(engine.targetIntensity).toBe(0);
    engine.setIntensity(0.5);
    const ctx = ctxOf();
    for (let i = 0; i < 40; i++) { ctx.currentTime += 0.1; engine.tick(); }
    expect(engine.intensity).toBeCloseTo(0.5, 1);
  });
});

describe('music', () => {
  it('has the three biome tracks plus a title track with the specified key/mode/tempo', () => {
    expect(TRACKS.tidepool.scale).toBe('dorian');
    expect(TRACKS.tidepool.bpm).toBe(96);
    expect(TRACKS.stormspire.scale).toBe('phrygian');
    expect(TRACKS.stormspire.bpm).toBe(128);
    expect(TRACKS.voidreef.scale).toBe('aeolian');
    expect(TRACKS.voidreef.bpm).toBe(84);
    expect(TRACKS.title).toBeDefined();
    for (const t of Object.values(TRACKS)) {
      expect(SCALES[t.scale]).toBeDefined();
      expect(t.prog.length).toBeGreaterThan(0);
    }
  });

  it('density follows intensity for every track', () => {
    for (const t of Object.values(TRACKS)) {
      const lo = planWindow(t, 0, 8, 0.05).length;
      const mid = planWindow(t, 0, 8, 0.5).length;
      const hi = planWindow(t, 0, 8, 1).length;
      expect(lo, `${t.key} low`).toBeGreaterThan(0); // a bed always plays
      expect(mid, `${t.key} mid > low`).toBeGreaterThan(lo);
      expect(hi, `${t.key} high > mid`).toBeGreaterThan(mid);
    }
  });

  it('keeps every pitched note inside the track scale', () => {
    for (const t of Object.values(TRACKS)) {
      const sc = SCALES[t.scale];
      for (const n of planWindow(t, 0, 16, 1)) {
        if (n.midi <= 0) continue;
        const pc = (((n.midi - t.root) % 12) + 12) % 12;
        expect(sc, `${t.key} ${n.inst} midi ${n.midi}`).toContain(pc);
        expect(n.dur).toBeGreaterThan(0);
        expect(n.vel).toBeGreaterThan(0);
      }
    }
  });

  it('stormspire is the only track with a filtered saw bass; voidreef is the sparsest', () => {
    expect(TRACKS.stormspire.voice.bass).toBe('sawlp');
    expect(TRACKS.tidepool.voice.arp).toBe('marimba');
    const density = (k: string) => planWindow(TRACKS[k], 0, 8, 0.6).length;
    expect(density('voidreef')).toBeLessThan(density('tidepool'));
    expect(density('voidreef')).toBeLessThan(density('stormspire'));
    expect(density('stormspire')).toBeGreaterThan(density('tidepool'));
  });

  it('planStep is deterministic', () => {
    const a = JSON.stringify(planStep(TRACKS.voidreef, 4, 3, 0.7));
    const b = JSON.stringify(planStep(TRACKS.voidreef, 4, 3, 0.7));
    expect(a).toBe(b);
  });

  it('midi helper is A440-tuned', () => {
    expect(midi(69)).toBeCloseTo(440);
    expect(midi(81)).toBeCloseTo(880);
  });
});

describe('visibility (P1-7)', () => {
  class FakeDoc extends EventTarget { hidden = false; }
  let engine: AudioEngine;
  let doc: FakeDoc;
  beforeEach(() => { installFake(); doc = new FakeDoc(); engine = new AudioEngine({ doc }); });
  afterEach(() => { engine.dispose(); removeFake(); });

  it('stops the scheduler clock while hidden and restarts it, resynced to the audio clock, when visible', () => {
    engine.init();
    const ctx = ctxOf();
    engine.setTrack('tidepool');
    engine.tick();
    expect(engine.clockRunning).toBe(true);
    const [seq] = engine.sequencers();
    expect(seq).toBeDefined();

    doc.hidden = true;
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(engine.clockRunning).toBe(false);
    expect(ctx.state).toBe('suspended');

    // a long stay in the background: the audio clock ran on, the sequencer did not
    ctx.currentTime += 45;
    doc.hidden = false;
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(engine.clockRunning).toBe(true);
    expect(ctx.state).toBe('running');
    for (const s of engine.sequencers()) expect(s.nextTime).toBeGreaterThanOrEqual(ctx.currentTime);
    // and the first pass after the return schedules only in the future
    const before = sources(ctx).length;
    engine.tick();
    for (const s of sources(ctx).slice(before)) expect(s.started[0]).toBeGreaterThanOrEqual(ctx.currentTime);
  });

  it('a user suspend is not undone by a visibility change, and no track means no clock either way', () => {
    engine.init();
    const ctx = ctxOf();
    engine.suspend();
    doc.hidden = true;
    doc.dispatchEvent(new Event('visibilitychange'));
    doc.hidden = false;
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(ctx.state).toBe('suspended');
    expect(engine.running).toBe(false);
    expect(engine.clockRunning).toBe(false);
    engine.resume();
    doc.hidden = true;
    doc.dispatchEvent(new Event('visibilitychange'));
    doc.hidden = false;
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(engine.clockRunning).toBe(false); // nothing to sequence
    expect(engine.sequencers()).toEqual([]);
  });
});

describe('unlock()', () => {
  let engine: AudioEngine;
  beforeEach(() => { installFake(); engine = new AudioEngine(); });
  afterEach(() => { engine.dispose(); removeFake(); });

  const kicks = (ctx: FakeAudioContext) => ctx.nodes.filter((n) => n.kind === 'bufferSource' && n.started.length > 0 && (n as FakeBufferSource).buffer !== null);

  it('creates the context, resumes it when suspended and kicks a silent buffer exactly once', () => {
    engine.init();
    const ctx = FakeAudioContext.instances[0];
    ctx.state = 'suspended';
    engine.unlock();
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(ctx.resumed).toBeGreaterThanOrEqual(1);
    expect(kicks(ctx)).toHaveLength(1);
    engine.unlock();
    engine.unlock();
    expect(kicks(ctx)).toHaveLength(1);
    expect(engine.running).toBe(true);
  });

  it('unlock() from nothing creates the context and reports running', () => {
    expect(engine.running).toBe(false);
    engine.unlock();
    expect(engine.ready).toBe(true);
    expect(engine.running).toBe(true);
  });

  it('running is false after suspend() and unlock() does not fight a user suspend', () => {
    engine.unlock();
    engine.suspend();
    expect(engine.running).toBe(false);
    const ctx = FakeAudioContext.instances[0];
    const before = ctx.resumed;
    engine.unlock();
    expect(ctx.resumed).toBe(before);
  });
});

// ================================================================ audio pass (P3-9)
describe('audio pass (P3-9)', () => {
  let engine: AudioEngine;
  beforeEach(() => { installFake(); engine = new AudioEngine(); engine.init(); });
  afterEach(() => { engine.dispose(); removeFake(); });

  /** Frequency the first oscillator of a call starts at (the clock is advanced first so no gate swallows the call). */
  const firstFreq = (fn: () => void): number => {
    const ctx = ctxOf();
    ctx.currentTime += 1;
    const before = ctx.nodes.length;
    fn();
    const osc = ctx.nodes.slice(before).find((n) => n.kind === 'osc') as FakeOsc | undefined;
    expect(osc).toBeDefined();
    return osc!.frequency.events[0].value;
  };
  const voicesOf = (fn: () => void): number => {
    const ctx = ctxOf();
    ctx.currentTime += 1;
    const before = sources(ctx).length;
    fn();
    return sources(ctx).length - before;
  };

  it('every biome key has its own clear sting, and a goal on that biome track plays it instead of the generic fanfare', () => {
    const openings = new Set<number>();
    for (const b of BIOME_ORDER) {
      const name = BIOME_STING[b];
      expect(SFX[name]).toBeDefined();
      expect(stingFor(b)).toBe(name);
      engine.setTrack(b);
      const direct = voicesOf(() => engine.play(name, { vol: 1, pan: 0 }));
      expect(direct).toBeGreaterThan(0);
      expect(voicesOf(() => engine.onEvent(sampleEvent('goal'), fakeSim() as never))).toBe(direct);
      openings.add(firstFreq(() => engine.onEvent(sampleEvent('goal'), fakeSim() as never)));
    }
    // three keys, three different openings
    expect(openings.size).toBe(BIOME_ORDER.length);
    expect(stingFor('title')).toBeNull();
    expect(stingFor(null)).toBeNull();
    // the title track keeps the generic goal fanfare
    engine.setTrack('title');
    const generic = voicesOf(() => engine.play('goal', { vol: 1, pan: 0 }));
    expect(voicesOf(() => engine.onEvent(sampleEvent('goal'), fakeSim() as never))).toBe(generic);
  });

  it('checkpoint chimes rise a step per new pillar, a pillar touched again keeps its pitch, and a new run starts over', () => {
    engine.setTrack('tidepool');
    const cp = (x: number) => () => engine.onEvent({ type: 'checkpoint', x, y: 100 }, fakeSim() as never);
    const f0 = firstFreq(cp(100));
    const f1 = firstFreq(cp(300));
    const f2 = firstFreq(cp(500));
    expect(f1).toBeGreaterThan(f0);
    expect(f2).toBeGreaterThan(f1);
    expect(firstFreq(cp(100))).toBe(f0);
    expect(engine.checkpointIndex(300, 100)).toBe(1);
    // the ladder caps instead of climbing forever
    for (let i = 0; i < CHECKPOINT_PITCH_CAP + 3; i++) firstFreq(cp(1000 + i * 50));
    expect(firstFreq(cp(5000))).toBe(firstFreq(cp(6000)));
    // a restart of the same zone sets the biome track again: the ladder starts over
    engine.setTrack('tidepool');
    expect(firstFreq(cp(300))).toBe(f0);
    // the goal ends the run: the next pillar is the first again
    engine.onEvent(sampleEvent('goal'), fakeSim() as never);
    expect(firstFreq(cp(900))).toBe(f0);
  });

  it('the shard ladder is a pentatonic climb up to the cap that shimmers with a fifth from combo 8', () => {
    for (let i = 1; i < SHARD_LADDER.length; i++) expect(SHARD_LADDER[i]).toBeGreaterThan(SHARD_LADDER[i - 1]);
    for (const iv of SHARD_LADDER) expect([0, 2, 4, 7, 9]).toContain(iv % 12);
    const voices = (combo: number) => voicesOf(() => engine.onEvent({ type: 'shard', x: 0, y: 0, n: 1, total: 20, combo }, fakeSim(0) as never));
    // eventParams counts the combo from 0, so combo SHARD_SHIMMER_AT + 1 is the first shimmering step
    expect(voices(SHARD_SHIMMER_AT + 1)).toBe(voices(3) + 1);
    expect(voices(SHARD_SHIMMER_AT)).toBe(voices(3));
  });

  it('the hurt sound no longer depends on the hp left (the low-hp danger layer is gone)', () => {
    const at = (hp: number) => firstFreq(() => engine.onEvent({ type: 'hurt', x: 100, y: 100, hp }, fakeSim() as never));
    expect(at(1)).toBe(at(3));
  });

  it('stingers: the tier fanfare, the ending chord, a star per index and a medal all make voices; stars rise by index', () => {
    const kinds: StingerKind[] = ['tier', 'ending', 'star', 'medal'];
    for (const k of kinds) {
      expect(SFX[STINGERS[k]]).toBeDefined();
      expect(voicesOf(() => engine.stinger(k))).toBeGreaterThan(0);
    }
    const star = (i: number) => firstFreq(() => engine.stinger('star', i));
    expect(star(1)).toBeGreaterThan(star(0));
    expect(star(2)).toBeGreaterThan(star(1));
    // the fanfare is a phrase, not a blip: its last voice ends more than two seconds out
    const ctx = ctxOf();
    ctx.currentTime += 1;
    const before = sources(ctx).length;
    engine.stinger('tier');
    const made = sources(ctx).slice(before);
    expect(Math.max(...made.map((s) => s.stopped[0] ?? 0)) - ctx.currentTime).toBeGreaterThan(2);
    // unlock and medal are distinct UI recipes
    expect(UI_SFX.unlock).toBe('uiUnlock');
    expect(STINGERS.medal).toBe('uiMedal');
    expect(STINGERS.medal).not.toBe(UI_SFX.unlock);
  });

  it('summit (P5-2): F# lydian at 76 bpm with its own arrangement — glass bells and a wind pad in every bar — renders bars and plays through the engine', () => {
    const t = TRACKS.summit;
    expect(t).toBeDefined();
    expect(t.root).toBe(42);
    expect(t.scale).toBe('lydian');
    expect(t.bpm).toBe(76);
    expect(t.arrange).not.toBe(TRACKS.voidreef.arrange);
    expect(t.arrange).not.toBe(TRACKS.title.arrange);
    expect(t.voice.pad).toBe('glass');
    for (const k of [0, 0.5, 1]) {
      const notes = planWindow(t, 0, 8, k);
      expect(notes.length).toBeGreaterThan(0);
      expect(notes.filter((n) => n.inst === 'bell').length, `bells at ${k}`).toBeGreaterThanOrEqual(16);   // two per bar, the bed
      expect(notes.filter((n) => n.inst === 'wind').length, `wind at ${k}`).toBeGreaterThanOrEqual(8);     // one swell per bar
      for (const n of notes) { expect(n.dur).toBeGreaterThan(0); expect(n.vel).toBeGreaterThan(0); }
    }
    // the wind is unpitched (never fed to the scale check) and renders as a noise voice
    expect(planWindow(t, 0, 4, 1).filter((n) => n.inst === 'wind').every((n) => n.midi === 0)).toBe(true);
    engine.setTrack('summit');
    expect(engine.track).toBe('summit');
    const ctx = ctxOf();
    const before = sources(ctx).length;
    const noiseBefore = nodesOf('bufferSource', ctx).length;
    engine.tick();
    expect(sources(ctx).length).toBeGreaterThan(before);
    expect(nodesOf('bufferSource', ctx).length).toBeGreaterThan(noiseBefore);
  });

  it('stingSummit (P5-2): the fourth clear sting opens on a note none of the other three start on, keyed to the summit track', () => {
    expect(BIOME_STING.summit).toBe('stingSummit');
    expect(stingFor('summit')).toBe('stingSummit');
    const names = ['stingTidepool', 'stingStormspire', 'stingVoidreef', 'stingSummit'] as const;
    const openings = names.map((n) => firstFreq(() => engine.play(n, { vol: 1, pan: 0 })));
    expect(new Set(openings.map((f) => Math.round(f))).size).toBe(4);
    expect(openings[3]).toBeCloseTo(midi(78), 3);          // F#5
    expect(voicesOf(() => engine.play('stingSummit', { vol: 1, pan: 0 }))).toBeGreaterThan(10);
    // on the summit track a goal plays the summit sting, not the generic fanfare
    engine.setTrack('summit');
    const direct = voicesOf(() => engine.play('stingSummit', { vol: 1, pan: 0 }));
    expect(voicesOf(() => engine.onEvent(sampleEvent('goal'), fakeSim() as never))).toBe(direct);
    expect(firstFreq(() => engine.onEvent(sampleEvent('goal'), fakeSim() as never))).toBeCloseTo(midi(78), 3);
  });

  it("the ending track is the title theme's variation: the same F lydian, slower, glass instead of saw, no drums; the engine plays it", () => {
    const t = TRACKS[ENDING_TRACK], title = TRACKS.title;
    expect(t).toBeDefined();
    expect(t.root).toBe(title.root);
    expect(t.scale).toBe('lydian');
    expect(t.bpm).toBeLessThan(title.bpm);
    expect(t.mix.drums).toBe(0);
    expect(t.voice.pad).not.toBe(title.voice.pad);
    // the bell motif is there in every bar (the bed of the screen), even at rest
    expect(planWindow(t, 0, 4, 0).filter((n) => n.inst === 'bell').length).toBeGreaterThanOrEqual(4);
    engine.setTrack(ENDING_TRACK);
    expect(engine.track).toBe(ENDING_TRACK);
    const ctx = ctxOf();
    const before = sources(ctx).length;
    engine.tick();
    expect(sources(ctx).length).toBeGreaterThan(before);
  });
});

// ------------------------------------------------------------------ bubble foe (P5-5)
describe('bubble sfx (P5-5)', () => {
  interface Voice { kind: 'tone' | 'noise'; gain: number; at: number; attack: number; dur: number; freqA: number | null; freqB: number | null; type: string }
  /** A recording Synth: the recipes' calls without WebAudio, so gains and sweeps can be compared directly. */
  function record(name: SfxName, params: SfxParams = { vol: 1, pan: 0 }): Voice[] {
    const out: Voice[] = [];
    const synth: Synth = {
      tone(freqA, freqB, dur, o = {}) {
        out.push({ kind: 'tone', gain: o.gain ?? 1, at: o.at ?? 0, attack: o.attack ?? 0, dur, freqA, freqB, type: o.type ?? 'sine' });
      },
      noise(dur, o = {}) {
        out.push({ kind: 'noise', gain: o.gain ?? 1, at: o.at ?? 0, attack: o.attack ?? 0, dur, freqA: o.freq ?? null, freqB: o.freqEnd ?? null, type: o.type ?? 'lowpass' });
      },
    };
    SFX[name](synth, params);
    return out;
  }
  const peak = (v: Voice[]): number => Math.max(...v.map((x) => x.gain));
  const killed = (): Voice[] => record('foeKilled', { vol: 1, pan: 0, kind: 'hopper' });

  it('bubblePop is a wet pop — one short bandpass burst plus a rising chirp — and quieter than foeKilled', () => {
    const v = record('bubblePop');
    const burst = v.filter((x) => x.kind === 'noise');
    expect(burst).toHaveLength(1);
    expect(burst[0].type).toBe('bandpass');
    expect(burst[0].dur).toBeLessThanOrEqual(0.1);
    expect(burst[0].at).toBe(0);
    const chirp = v.filter((x) => x.kind === 'tone' && x.freqB !== null && x.freqB > (x.freqA ?? 0));
    expect(chirp.length).toBeGreaterThanOrEqual(1);
    expect(v.every((x) => x.dur <= 0.2)).toBe(true);   // a pop, not a tail
    expect(peak(v)).toBeLessThan(peak(killed()));
    expect(peak(v)).toBeLessThanOrEqual(0.12);
  });

  it('bubbleBack is a soft glassy shimmer — sines above 1 kHz swelling in — quieter than the pop and than foeKilled', () => {
    const v = record('bubbleBack');
    const tones = v.filter((x) => x.kind === 'tone');
    expect(tones.length).toBeGreaterThanOrEqual(2);
    expect(tones.every((x) => x.type === 'sine' && x.attack >= 0.05)).toBe(true);
    expect(tones.every((x) => (x.freqA ?? 0) >= 1000)).toBe(true);
    expect(peak(v)).toBeLessThan(peak(record('bubblePop')));
    expect(peak(v)).toBeLessThan(peak(killed()));
    expect(peak(v)).toBeLessThanOrEqual(0.05);
  });

  it('both are deterministic in the event fields alone: two renders match voice for voice, and gain follows vol', () => {
    for (const name of ['bubblePop', 'bubbleBack'] as const) {
      expect(record(name)).toEqual(record(name));
      const full = record(name);
      const half = record(name, { vol: 0.5, pan: 0.3 });
      expect(half).toHaveLength(full.length);
      half.forEach((h, i) => expect(h.gain).toBeCloseTo(full[i].gain * 0.5, 9));
    }
  });

  it('the engine plays both through the event map', () => {
    installFake();
    const engine = new AudioEngine();
    try {
      engine.init();
      const ctx = ctxOf();
      expect(EVENT_SFX.bubblePop).toBe('bubblePop');
      expect(EVENT_SFX.bubbleBack).toBe('bubbleBack');
      for (const type of ['bubblePop', 'bubbleBack'] as const) {
        const before = sources(ctx).length;
        ctx.currentTime += 1;
        engine.onEvent(sampleEvent(type), fakeSim() as never);
        expect(sources(ctx).length - before, type).toBeGreaterThanOrEqual(2);
      }
    } finally {
      engine.dispose();
      removeFake();
    }
  });
});
