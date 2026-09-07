/**
 * Runtime-synthesised audio — nothing is downloaded. Implements `AudioPort`.
 *
 * Signal graph:
 *   voices ─┬─> sfxBus ───────────────┐
 *           └─> track gain ─> musBus ─> musLp ─┤
 *                                              ├─> master ─> compressor ─> destination
 *              fxSend ─> [delay ─> lowpass ─> feedback ─> delay] x2 ─> wet ─┘
 *
 * `fxSend` is a two-tap feedback delay with a lowpass in each loop: a cheap
 * stand-in for reverb. The two combs are independent — one shared feedback
 * gain would sum both return paths and double the effective loop gain.
 *
 * Music: each `setTrack` creates a fresh gain + `Sequencer` "layer"; the old
 * layer ramps down while the new one ramps up, and faded layers are reaped.
 * The sequencer is driven by a self-owned interval (the port has no tick), so
 * it keeps time without the render loop; `tick()` is public for the shell and
 * for tests.
 *
 * Everything degrades silently: with no AudioContext, every method is a no-op.
 */
import type { SimEvent, SimState } from '../../sim/types.js';
import type { AudioPort, Settings, UiSound } from '../contracts.js';
import { GATE_MS, SFX, STINGERS, UI_SFX, eventParams, eventSfx, stingFor } from './sfx.js';
import type { NoiseOpts, SfxName, SfxParams, StingerKind, Synth, ToneOpts } from './sfx.js';
import { LOOKAHEAD, Sequencer, TRACKS } from './music.js';
import type { TrackDef } from './music.js';

/** All the engine reads from a Sim: the player's position, to pan effects. */
export interface SimLike { readonly state: SimState }

interface TrackLayer {
  key: string;
  def: TrackDef;
  gain: GainNode;
  seq: Sequencer;
  /** Audio time after which the layer is silent and can be removed. */
  fadeEnd: number | null;
}

type AudioContextCtor = new (opts?: AudioContextOptions) => AudioContext;

/** The slice of Document the engine watches for visibility (injectable for Node tests). */
export interface VisibilityDoc {
  hidden?: boolean;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface AudioEngineOptions {
  /** Defaults to the global document; `null` watches nothing. */
  doc?: VisibilityDoc | null;
}

/** Cross-fade length between tracks, seconds. */
export const TRACK_FADE = 1.2;
/** Scheduler period, ms. Well under LOOKAHEAD so late timers never leave a gap. */
const CLOCK_MS = 80;
const MUFFLE_HZ = 420;
const OPEN_HZ = 20000;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v: number) => (Number.isFinite(v) ? clamp(v, 0, 1) : 0);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const swallow = (p: unknown): void => { if (p && typeof (p as Promise<unknown>).catch === 'function') (p as Promise<unknown>).catch(() => undefined); };

function defaultDoc(): VisibilityDoc | null {
  const doc = (globalThis as { document?: VisibilityDoc }).document;
  return doc && typeof doc.addEventListener === 'function' ? doc : null;
}

function findAudioContext(): AudioContextCtor | null {
  const g = globalThis as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  const ctor = g.AudioContext ?? g.webkitAudioContext ?? null;
  return typeof ctor === 'function' ? ctor : null;
}

export class AudioEngine implements AudioPort, Synth {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musBus: GainNode | null = null;
  private musLp: BiquadFilterNode | null = null;
  private fxSend: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private hasPanner = false;

  private levels = { master: 0.8, music: 0.6, sfx: 0.8 };

  private layers: TrackLayer[] = [];
  private current: TrackLayer | null = null;
  private trackKey: string | null = null;
  private pendingTrack: string | null = null;

  private curIntensity = 1;
  private tgtIntensity = 1;
  private muffle = 0;
  private tgtMuffle = 0;

  /** Last play time (audio-clock ms) per gated effect. */
  private readonly gates = new Map<string, number>();
  /**
   * Checkpoint pillars reached in the current run, by position → index: the
   * chime rises a step per pillar (P3-9). Reset by every setTrack (a run start
   * always sets the biome track) and when the run finishes.
   */
  private readonly checkpoints = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTick = -1;
  private userSuspended = false;
  private hiddenSuspended = false;
  /** The silent unlock buffer has been started once. */
  private kicked = false;
  private visHandler: (() => void) | null = null;
  private readonly doc: VisibilityDoc | null;

  /** Voices created since init — a liveness signal for QA. */
  voices = 0;

  constructor(opts: AudioEngineOptions = {}) {
    this.doc = opts.doc === undefined ? defaultDoc() : opts.doc;
  }

  // ------------------------------------------------------------ AudioPort
  get ready(): boolean { return this.ctx !== null; }
  get running(): boolean { return this.ctx !== null && this.ctx.state === 'running'; }
  /** The scheduler interval is armed (false while hidden or with nothing to sequence). */
  get clockRunning(): boolean { return this.timer !== null; }
  /** Sequencers of the live track layers (the fading one included), for tests and diagnostics. */
  sequencers(): Sequencer[] { return this.layers.map((l) => l.seq); }

  /**
   * Gesture-time unlock. Browsers only let a context start inside a user
   * activation, and a *touch* pointerdown is not one (pointerup / touchend /
   * click / keydown are), so the shell calls this from those events until
   * `running` is true. The one-sample silent buffer is the long-standing iOS
   * trick: Safari opens the audio session for sound started in the gesture.
   */
  unlock(): void {
    this.init();
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.state === 'suspended' && !this.userSuspended) swallow(ctx.resume());
    if (!this.kicked) {
      try {
        const src = ctx.createBufferSource();
        src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
        src.connect(ctx.destination);
        src.start(0);
        this.kicked = true;
      } catch { /* a context that cannot play yet will be kicked on the next gesture */ }
    }
  }
  /** Key of the track currently requested ('title', a biome track, or null). */
  get track(): string | null { return this.trackKey; }
  get intensity(): number { return this.curIntensity; }
  get targetIntensity(): number { return this.tgtIntensity; }

  /** Safe to call from a pointerdown/keydown handler; idempotent. */
  init(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended' && !this.userSuspended) swallow(this.ctx.resume());
      return;
    }
    const AC = findAudioContext();
    if (!AC) return;
    let ctx: AudioContext;
    try {
      ctx = new AC({ latencyHint: 'interactive' });
      this.buildGraph(ctx);
    } catch {
      this.ctx = null;
      return;
    }
    this.ctx = ctx;
    this.lastTick = ctx.currentTime;
    if (ctx.state === 'suspended') swallow(ctx.resume());
    this.watchVisibility();

    const pending = this.pendingTrack;
    this.pendingTrack = null;
    if (pending) {
      this.trackKey = null;
      this.setTrack(pending);
    }
  }

  applySettings(s: Settings): void {
    this.levels = { master: clamp01(s.master), music: clamp01(s.music), sfx: clamp01(s.sfx) };
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.sfxBus || !this.musBus) return;
    const t = ctx.currentTime;
    this.master.gain.setTargetAtTime(this.levels.master, t, 0.05);
    this.sfxBus.gain.setTargetAtTime(this.levels.sfx, t, 0.05);
    this.musBus.gain.setTargetAtTime(this.levels.music, t, 0.05);
  }

  /**
   * Map a sim event to a sound. Only reads event fields and, when given,
   * `sim.state.player`. A goal on a biome track plays that biome's clear sting
   * (in the track's key) instead of the generic fanfare; a checkpoint chimes a
   * step higher for every new pillar of the run.
   */
  onEvent(ev: SimEvent, sim?: SimLike | null): void {
    if (!this.ctx) return;
    let name = eventSfx(ev);
    if (!name) return;
    const player = sim?.state?.player ?? null;
    const p = eventParams(ev, player);
    if (ev.type === 'checkpoint') p.idx = this.checkpointIndex(ev.x, ev.y);
    else if (ev.type === 'goal' || ev.type === 'tideOver') {
      this.checkpoints.clear();
      if (ev.type === 'goal') name = stingFor(this.trackKey) ?? name;
    }
    this.play(name, p);
  }

  /** The 0-based index of a checkpoint pillar in the current run (a pillar touched again keeps its index). */
  checkpointIndex(x: number, y: number): number {
    const key = `${Math.round(x)},${Math.round(y)}`;
    let idx = this.checkpoints.get(key);
    if (idx === undefined) { idx = this.checkpoints.size; this.checkpoints.set(key, idx); }
    return idx;
  }

  /** A ceremony sound outside the sim event stream (P3-9): the tier fanfare, the ending chord, a star (by index), a medal. */
  stinger(kind: StingerKind, idx = 0): void {
    const name = STINGERS[kind];
    if (name) this.play(name, { vol: 1, pan: 0, idx });
  }

  setTrack(key: string | null): void {
    // Every run start sets its biome track (a restart included): the checkpoint ladder starts over.
    this.checkpoints.clear();
    if (key !== null && !TRACKS[key]) return;
    if (key === this.trackKey) return;
    this.trackKey = key;
    const ctx = this.ctx;
    if (!ctx || !this.musBus) { this.pendingTrack = key; return; }
    const now = ctx.currentTime;
    if (this.current) {
      this.fadeOut(this.current, now);
      this.current = null;
    }
    if (key) {
      const def = TRACKS[key];
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(1, now + TRACK_FADE);
      gain.connect(this.musBus);
      const layer: TrackLayer = { key, def, gain, seq: new Sequencer(def, this, gain, now + 0.05), fadeEnd: null };
      this.layers.push(layer);
      this.current = layer;
    }
    this.startClock();
  }

  setIntensity(v: number): void { this.tgtIntensity = clamp01(v); }

  /** Muffle the music (pause menu) without touching the volume settings. */
  setMuffle(on: boolean): void { this.tgtMuffle = on ? 1 : 0; }

  ui(name: UiSound): void {
    const sfx = UI_SFX[name];
    if (sfx) this.play(sfx, { vol: 1, pan: 0 });
  }

  suspend(): void {
    this.userSuspended = true;
    const ctx = this.ctx;
    if (ctx && ctx.state === 'running') swallow(ctx.suspend());
  }

  resume(): void {
    this.userSuspended = false;
    this.hiddenSuspended = false;
    const ctx = this.ctx;
    if (ctx && ctx.state === 'suspended') swallow(ctx.resume());
  }

  // ------------------------------------------------------------ scheduling
  /**
   * One scheduler pass: eases intensity and muffle, schedules every active
   * track up to the lookahead horizon, reaps finished fades. Called by the
   * internal timer; harmless to call more often.
   */
  tick(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const dt = this.lastTick < 0 ? 0 : clamp(now - this.lastTick, 0, 0.5);
    this.lastTick = now;

    this.curIntensity = lerp(this.curIntensity, this.tgtIntensity, 1 - Math.pow(0.001, dt));
    this.muffle = lerp(this.muffle, this.tgtMuffle, 1 - Math.pow(0.0005, dt));
    if (this.musLp) this.musLp.frequency.value = lerp(OPEN_HZ, MUFFLE_HZ, this.muffle);

    if (ctx.state === 'running') {
      const horizon = now + LOOKAHEAD;
      for (const layer of this.layers) layer.seq.schedule(now, horizon, this.curIntensity);
    }

    for (let i = this.layers.length - 1; i >= 0; i--) {
      const l = this.layers[i];
      if (l.fadeEnd !== null && now >= l.fadeEnd) {
        try { l.gain.disconnect(); } catch { /* already gone */ }
        this.layers.splice(i, 1);
      }
    }
    if (this.layers.length === 0) this.stopClock();
  }

  /** Play a named effect directly (UI, tests, debug). Respects the per-effect rate gate. */
  play(name: SfxName, p: SfxParams): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const recipe = SFX[name];
    if (!recipe) return;
    const gate = GATE_MS[name];
    if (gate) {
      const nowMs = ctx.currentTime * 1000;
      const last = this.gates.get(name);
      if (last !== undefined && nowMs - last < gate) return;
      this.gates.set(name, nowMs);
    }
    recipe(this, p);
  }

  /** Release the context and timers. The engine can be re-initialised afterwards. */
  dispose(): void {
    this.stopClock();
    if (this.visHandler) {
      try { this.doc?.removeEventListener('visibilitychange', this.visHandler); } catch { /* no DOM */ }
      this.visHandler = null;
    }
    for (const l of this.layers) { try { l.gain.disconnect(); } catch { /* ignore */ } }
    this.layers = [];
    this.current = null;
    this.pendingTrack = null;
    this.trackKey = null;
    const ctx = this.ctx;
    this.ctx = null;
    this.master = this.sfxBus = this.musBus = this.fxSend = null;
    this.musLp = null;
    this.noiseBuf = null;
    if (ctx) { try { swallow(ctx.close()); } catch { /* ignore */ } }
  }

  // ------------------------------------------------------------ Synth
  tone(freqA: number, freqB: number | null, dur: number, o: ToneOpts = {}): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfxBus) return;
    const t = Math.max(ctx.currentTime, ctx.currentTime + (o.at ?? 0));
    const gain = Math.max(0.0001, o.gain ?? 0.3);
    const attack = Math.max(0.001, o.attack ?? 0.004);
    const end = t + Math.max(dur, attack + 0.005);

    const osc = ctx.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(Math.max(1, freqA), t);
    if (freqB !== null && freqB !== freqA) {
      if ((o.curve ?? 'exp') === 'exp') osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqB), t + dur);
      else osc.frequency.linearRampToValueAtTime(Math.max(1, freqB), t + dur);
    }
    if (o.detune) osc.detune.value = o.detune;

    let head: AudioNode = osc;
    if (o.filter) {
      const f = ctx.createBiquadFilter();
      f.type = o.filter.type;
      f.frequency.setValueAtTime(Math.max(10, o.filter.freq), t);
      if (o.filter.freqEnd) f.frequency.exponentialRampToValueAtTime(Math.max(10, o.filter.freqEnd), t + dur);
      f.Q.value = o.filter.q ?? 1;
      head.connect(f);
      head = f;
    }

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    head.connect(g);
    this.route(g, o.dest ?? this.sfxBus, o.fx ?? 0, o.pan ?? 0);

    osc.start(t);
    osc.stop(end + 0.05);
    this.voices++;
  }

  noise(dur: number, o: NoiseOpts = {}): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfxBus || !this.noiseBuf) return;
    const t = Math.max(ctx.currentTime, ctx.currentTime + (o.at ?? 0));
    const gain = Math.max(0.0001, o.gain ?? 0.3);
    const attack = o.attack ?? 0;
    const end = t + Math.max(dur, attack + 0.005);

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    src.playbackRate.value = 0.8 + Math.random() * 0.5;

    const f = ctx.createBiquadFilter();
    f.type = o.type ?? 'highpass';
    f.frequency.setValueAtTime(Math.max(10, o.freq ?? 4000), t);
    if (o.freqEnd) f.frequency.exponentialRampToValueAtTime(Math.max(10, o.freqEnd), t + dur);
    f.Q.value = o.q ?? 0.7;

    const g = ctx.createGain();
    if (attack > 0) {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain, t + attack);
    } else {
      g.gain.setValueAtTime(gain, t);
    }
    g.gain.exponentialRampToValueAtTime(0.0001, end);

    src.connect(f);
    f.connect(g);
    this.route(g, o.dest ?? this.sfxBus, o.fx ?? 0, o.pan ?? 0);

    src.start(t, Math.random() * 0.4);
    src.stop(end + 0.05);
    this.voices++;
  }

  // ------------------------------------------------------------ internals
  private buildGraph(ctx: AudioContext): void {
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 24;
    comp.ratio.value = 6;
    comp.attack.value = 0.004;
    comp.release.value = 0.16;
    comp.connect(ctx.destination);

    const master = ctx.createGain();
    master.gain.value = this.levels.master;
    master.connect(comp);

    const sfxBus = ctx.createGain();
    sfxBus.gain.value = this.levels.sfx;
    sfxBus.connect(master);

    const musBus = ctx.createGain();
    musBus.gain.value = this.levels.music;
    const musLp = ctx.createBiquadFilter();
    musLp.type = 'lowpass';
    musLp.frequency.value = OPEN_HZ;
    musBus.connect(musLp);
    musLp.connect(master);

    // Two independent comb filters, each owning its damping and feedback.
    const fxSend = ctx.createGain();
    fxSend.gain.value = 1;
    const wet = ctx.createGain();
    wet.gain.value = 0.5;
    for (const [time, feedback] of [[0.147, 0.38], [0.211, 0.34]] as const) {
      const d = ctx.createDelay(1);
      d.delayTime.value = time;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2600;
      const fb = ctx.createGain();
      fb.gain.value = feedback;
      fxSend.connect(d);
      d.connect(lp);
      lp.connect(fb);
      fb.connect(d);
      lp.connect(wet);
    }
    wet.connect(master);

    // Shared white-noise buffer for hats, dust and impacts (looped by each voice).
    const len = Math.max(1, Math.floor(ctx.sampleRate * 1.2));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    this.master = master;
    this.sfxBus = sfxBus;
    this.musBus = musBus;
    this.musLp = musLp;
    this.fxSend = fxSend;
    this.noiseBuf = buf;
    this.hasPanner = typeof (ctx as Partial<AudioContext>).createStereoPanner === 'function';
  }

  /** Connect a voice's envelope to its bus, with optional panning and an fx send. */
  private route(g: GainNode, dest: AudioNode, fx: number, pan: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    let out: AudioNode = g;
    if (pan !== 0 && this.hasPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      g.connect(p);
      out = p;
    }
    out.connect(dest);
    if (fx > 0 && this.fxSend) {
      const send = ctx.createGain();
      send.gain.value = Math.min(1, fx);
      out.connect(send);
      send.connect(this.fxSend);
    }
  }

  private fadeOut(layer: TrackLayer, now: number): void {
    const p = layer.gain.gain;
    try { p.cancelScheduledValues(now); } catch { /* ignore */ }
    p.setValueAtTime(Math.max(0.0001, p.value), now);
    p.linearRampToValueAtTime(0, now + TRACK_FADE);
    layer.fadeEnd = now + TRACK_FADE + 0.1;
  }

  private startClock(): void {
    if (this.timer !== null || typeof setInterval !== 'function') return;
    this.timer = setInterval(() => this.tick(), CLOCK_MS);
    // Never keep a Node process alive (tests, tooling); no-op in browsers.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  private stopClock(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Hidden tab: stop the scheduler clock (a throttled interval would stutter
   * the music and pile up missed steps) and suspend the context. Visible again:
   * resume, resync every sequencer to the audio clock — which kept running in
   * the background — and restart the clock when there is something to play.
   */
  private watchVisibility(): void {
    const doc = this.doc;
    if (!doc || this.visHandler) return;
    this.visHandler = () => {
      const ctx = this.ctx;
      if (!ctx) return;
      if (doc.hidden) {
        this.stopClock();
        if (!this.userSuspended && ctx.state === 'running') { this.hiddenSuspended = true; swallow(ctx.suspend()); }
        return;
      }
      if (this.userSuspended) return;
      if (this.hiddenSuspended) {
        this.hiddenSuspended = false;
        if (ctx.state === 'suspended') swallow(ctx.resume());
      }
      const now = ctx.currentTime;
      for (const layer of this.layers) layer.seq.nextTime = now + 0.02;
      this.lastTick = now;
      if (this.layers.length) this.startClock();
    };
    doc.addEventListener('visibilitychange', this.visHandler);
  }
}
