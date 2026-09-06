/**
 * FxBus — screen feedback derived from SimEvents: trauma (shake), hitstop,
 * flash, zoom pulses, fade and chromatic aberration, plus the presentation
 * time scale (relic / goal slow-motion). It produces the `FxState` the
 * renderer composites and the `TimeControl` the tick scheduler reads.
 *
 * Nothing here feeds back into the sim: hitstop and slow-mo only change how
 * many ticks the loop runs per wall-clock frame, and every tick is still
 * recorded, so a replay is unaffected by what the player saw.
 *
 * Constants are ported from the reference world.js / player.js fx calls.
 */
import type { SimEvent } from '../sim/types.js';
import { C } from '../shared/biomes.js';
import type { FxState, Settings } from './contracts.js';
import type { TimeControl } from './loop.js';

/** Frame-rate independent exponential smoothing; `half` is the half-life in seconds. */
const damp = (a: number, b: number, half: number, dt: number): number => b + (a - b) * Math.pow(2, -dt / half);
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export interface FxOptions {
  /** Randomness for the shake offsets; defaults to Math.random. */
  random?: () => number;
}

/**
 * Seconds into the death animation before the screen starts fading to black.
 * The sim respawns DYING_T (0.45 s) after a death, so the fade-out has ~0.2 s
 * to reach black and the fade-in runs during the short respawn intro: death →
 * control reads as ~0.6 s.
 */
export const DEATH_FADE_AT = 0.25;
/** Half-life of the fade towards clear (respawn, new level). */
export const FADE_IN_HALF = 0.06;
/** Half-life of the fade towards black (death): faster, so the screen is black when the respawn lands. */
export const FADE_OUT_HALF = 0.045;
const MAX_TRAUMA = 1.6;
/** Flash cap when the photosensitivity toggle is off. */
const FLASH_CAP_SAFE = 0.12;

export class FxBus implements TimeControl {
  trauma = 0;
  hitstop = 0;
  flashA = 0;
  flashCol = '#ffffff';
  fade = 1;
  fadeTarget = 0;
  zoom = 1;
  zoomTarget = 1;
  aberr = 0;
  timeScale = 1;

  private shakeScale = 1;
  private flashes = true;
  /** Seconds since the last death, or -1 when not dying. */
  private dieT = -1;
  private readonly random: () => number;

  constructor(opts: FxOptions = {}) {
    this.random = opts.random ?? Math.random;
  }

  applySettings(s: Pick<Settings, 'shake' | 'flashes'>): void {
    this.shakeScale = clamp01(s.shake);
    this.flashes = s.flashes;
  }

  // ------------------------------------------------------------ primitives
  shake(a: number): void { this.trauma = Math.min(MAX_TRAUMA, this.trauma + a * this.shakeScale); }
  stop(seconds: number): void { this.hitstop = Math.max(this.hitstop, seconds); }
  flash(a: number, col = '#ffffff'): void {
    const cap = this.flashes ? 1 : FLASH_CAP_SAFE;
    this.flashA = Math.max(this.flashA, Math.min(cap, a));
    this.flashCol = col;
    this.aberr = Math.max(this.aberr, Math.min(cap * 2, a * 2));
  }
  zoomPulse(a: number): void { this.zoomTarget = 1 + a * this.shakeScale; }
  slowMo(scale: number): void { this.timeScale = Math.min(this.timeScale, scale); }

  /** New level / respawn from black: `fadeFrom` 1 = start black and fade in. */
  reset(fadeFrom = 1): void {
    this.trauma = 0; this.hitstop = 0; this.flashA = 0; this.aberr = 0;
    this.zoom = 1; this.zoomTarget = 1; this.timeScale = 1;
    this.fade = fadeFrom; this.fadeTarget = 0;
    this.dieT = -1;
  }

  // ------------------------------------------------------------ events
  onEvent(ev: SimEvent): void {
    switch (ev.type) {
      case 'phase':
        if (ev.phase === 'intro') { this.fadeTarget = 0; this.dieT = -1; }
        break;
      case 'land':
        if (ev.impact > 0.12) this.shake(Math.min(1.2, 0.2 + ev.impact * 0.7));
        break;
      case 'dash':
        this.stop(0.055); this.shake(0.5); this.zoomPulse(0.035);
        break;
      case 'wallJump':
        this.shake(0.4);
        break;
      case 'stompLand':
        this.shake(0.5); this.zoomPulse(0.02);
        break;
      case 'spring':
        this.shake(0.5);
        break;
      case 'relic':
        this.stop(0.11); this.shake(0.7); this.flash(0.3, C.relicHi); this.slowMo(0.35);
        break;
      case 'checkpoint':
        this.flash(0.14, C.checkpoint);
        break;
      case 'crystal':
        this.flash(0.1, C.crystalHi); this.zoomPulse(0.015);
        break;
      case 'toggle':
        this.flash(0.12, ev.switchA ? C.switchA : C.switchB); this.shake(0.25);
        break;
      case 'goal':
        this.slowMo(0.3); this.flash(0.4, C.goal); this.shake(0.8);
        break;
      case 'hurt':
        this.stop(0.09); this.shake(1.1); this.flash(0.22, C.danger);
        break;
      case 'death':
        this.shake(1.2); this.flash(0.3, '#ffffff'); this.dieT = 0;
        break;
      case 'respawn':
        this.dieT = -1; this.fadeTarget = 0; this.trauma = 0;
        break;
      case 'foeHit':
        this.stop(0.05); this.shake(0.65);
        break;
      case 'foeKilled':
        this.stop(0.04); this.shake(0.3);
        break;
      case 'splash':
        if (ev.enter) this.shake(0.2);
        break;
      case 'tideOver':
        this.dieT = -1; this.fadeTarget = 0.55; this.slowMo(0.5);
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------ per frame
  /** Advance with wall-clock dt (hitstop and fades run in real time). */
  update(dtWall: number): void {
    const dt = dtWall > 0 ? Math.min(dtWall, 0.1) : 0;
    if (this.hitstop > 0) this.hitstop = Math.max(0, this.hitstop - dt);
    this.timeScale = damp(this.timeScale, 1, 0.22, dt);
    if (this.timeScale > 0.999) this.timeScale = 1;
    if (this.dieT >= 0) {
      this.dieT += dt;
      if (this.dieT > DEATH_FADE_AT) this.fadeTarget = 1;
    }
    this.trauma = Math.max(0, this.trauma - dt * 2.4);
    this.flashA = Math.max(0, this.flashA - dt * 3.2);
    this.aberr = Math.max(0, this.aberr - dt * 2.6);
    this.zoomTarget = damp(this.zoomTarget, 1, 0.1, dt);
    this.zoom = damp(this.zoom, this.zoomTarget, 0.07, dt);
    this.fade = damp(this.fade, this.fadeTarget, this.fadeTarget > this.fade ? FADE_OUT_HALF : FADE_IN_HALF, dt);
    if (Math.abs(this.zoomTarget - 1) < 1e-4) this.zoomTarget = 1;
    if (Math.abs(this.zoom - this.zoomTarget) < 1e-4) this.zoom = this.zoomTarget;
    if (Math.abs(this.fade - this.fadeTarget) < 1e-3) this.fade = this.fadeTarget;
  }

  /** The composite parameters for this frame (shake offsets are re-rolled per call). */
  state(): FxState {
    const tr = this.trauma * this.trauma;
    const r = () => this.random() * 2 - 1;
    return {
      shakeX: tr > 0 ? r() * tr * 7 : 0,
      shakeY: tr > 0 ? r() * tr * 7 : 0,
      shakeRot: tr > 0 ? r() * tr * 0.012 : 0,
      flash: this.flashA,
      flashColor: this.flashCol,
      fade: clamp01(this.fade),
      zoom: this.zoom,
      aberr: clamp01(this.aberr),
      vignette: clamp01(this.trauma * 0.6),
    };
  }

  /** True when every channel has settled (tests; also lets the loop skip work). */
  atRest(): boolean {
    return this.trauma === 0 && this.hitstop === 0 && this.flashA === 0 && this.aberr === 0 &&
      this.zoom === 1 && this.zoomTarget === 1 && this.timeScale === 1 && this.fade === this.fadeTarget && this.dieT < 0;
  }
}
