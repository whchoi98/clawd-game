/**
 * Virtual controls for touch devices: a stick on the left, DASH / JUMP on the
 * right. They only write `TouchState`; the input layer reads the stick as a
 * direction and consumes the `*Pressed` edge flags into its latched mask, so a
 * tap shorter than a frame still produces exactly one press.
 */
import type { TouchState } from '../contracts.js';

/** Stick deflection below these fractions of the radius reads as neutral. */
export const STICK_DEADZONE_X = 0.24;
export const STICK_DEADZONE_Y = 0.3;
/** Fallback stick radius (CSS px) when the pad has no layout yet. */
const FALLBACK_RADIUS = 24;

export function makeTouchState(): TouchState {
  return { active: false, x: 0, y: 0, jump: false, dash: false, jumpPressed: false, dashPressed: false };
}

/** A device whose primary pointer is a finger (no hover). */
export function isCoarsePointer(win: Window | null | undefined): boolean {
  if (!win) return false;
  try {
    return typeof win.matchMedia === 'function' && win.matchMedia('(hover: none) and (pointer: coarse)').matches;
  } catch {
    return false; // headless DOMs without media queries
  }
}

/** Portrait enough that the touch pad would sit on top of the 16:9 world. */
export function isPortraitViewport(win: Window | null | undefined): boolean {
  if (!win) return false;
  return win.innerHeight > win.innerWidth * 1.05;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export class TouchControls {
  readonly state: TouchState = makeTouchState();
  /** True once we know the device is touch-first (media query or a real touch). */
  coarse: boolean;
  private pid: number | null = null;
  private cx = 0;
  private cy = 0;
  private r = FALLBACK_RADIUS;
  private readonly doc: Document;
  private readonly root: HTMLElement | null;
  private readonly pad: HTMLElement | null;
  private readonly knob: HTMLElement | null;
  private readonly coarseListeners: (() => void)[] = [];

  constructor(doc: Document, root: HTMLElement | null) {
    this.doc = doc;
    this.root = root;
    this.pad = doc.getElementById('tpad-move');
    this.knob = (this.pad?.firstElementChild as HTMLElement | null) ?? null;
    this.coarse = isCoarsePointer(doc.defaultView);
    this.wireStick();
    this.wireButtons();
    // A real finger on a "fine pointer" laptop (touch screen) still wants the pad.
    doc.addEventListener('touchstart', () => this.becomeCoarse(), { passive: true, once: true });
  }

  /** Called when the device turns out to be touch-first after construction. */
  onCoarse(cb: () => void): void { this.coarseListeners.push(cb); }

  setVisible(v: boolean): void { if (this.root) this.root.hidden = !v; }
  get visible(): boolean { return !!this.root && !this.root.hidden; }

  private becomeCoarse(): void {
    if (this.coarse) return;
    this.coarse = true;
    for (const cb of this.coarseListeners) cb();
  }

  // ------------------------------------------------------------ stick
  private wireStick(): void {
    const pad = this.pad;
    if (!pad) return;
    pad.addEventListener('pointerdown', (e: PointerEvent) => {
      e.preventDefault();
      const rect = pad.getBoundingClientRect();
      this.cx = rect.left + rect.width / 2;
      this.cy = rect.top + rect.height / 2;
      this.r = Math.max(FALLBACK_RADIUS, rect.width / 2);
      this.pid = e.pointerId;
      this.state.active = true;
      pad.classList.add('is-active');
      try { pad.setPointerCapture?.(e.pointerId); } catch { /* not every DOM implements capture */ }
      this.moveStick(e.clientX, e.clientY);
    });
    const move = (e: PointerEvent) => {
      if (this.pid === e.pointerId && this.state.active) this.moveStick(e.clientX, e.clientY);
    };
    const end = (e: PointerEvent) => {
      if (this.pid === e.pointerId) this.releaseStick();
    };
    this.doc.addEventListener('pointermove', move);
    this.doc.addEventListener('pointerup', end);
    this.doc.addEventListener('pointercancel', end);
    // Browser gestures (scroll, pinch, long-press) must never win over the stick.
    const swallow = (e: Event) => e.preventDefault();
    pad.addEventListener('touchstart', swallow, { passive: false });
    pad.addEventListener('touchmove', swallow, { passive: false });
    pad.addEventListener('contextmenu', swallow);
  }

  private moveStick(clientX: number, clientY: number): void {
    const dx = clamp((clientX - this.cx) / this.r, -1, 1);
    const dy = clamp((clientY - this.cy) / this.r, -1, 1);
    this.state.x = Math.abs(dx) < STICK_DEADZONE_X ? 0 : dx;
    this.state.y = Math.abs(dy) < STICK_DEADZONE_Y ? 0 : dy;
    if (this.knob) this.knob.style.translate = `${-50 + dx * 34}% ${-50 + dy * 34}%`;
  }

  private releaseStick(): void {
    this.pid = null;
    this.state.active = false;
    this.state.x = 0;
    this.state.y = 0;
    this.pad?.classList.remove('is-active');
    if (this.knob) this.knob.style.translate = '-50% -50%';
  }

  // ------------------------------------------------------------ buttons
  private wireButtons(): void {
    if (!this.root) return;
    for (const b of this.root.querySelectorAll<HTMLElement>('[data-touch]')) {
      const key = b.dataset.touch === 'dash' ? 'dash' : 'jump';
      const down = (e: Event) => {
        e.preventDefault();
        this.press(key, true);
        b.classList.add('is-down');
      };
      const up = () => {
        this.press(key, false);
        b.classList.remove('is-down');
      };
      b.addEventListener('pointerdown', down);
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
      b.addEventListener('pointerleave', up);
      b.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
      b.addEventListener('contextmenu', (e) => e.preventDefault());
    }
  }

  private press(key: 'jump' | 'dash', down: boolean): void {
    if (down && !this.state[key]) {
      if (key === 'jump') this.state.jumpPressed = true; else this.state.dashPressed = true;
    }
    this.state[key] = down;
  }
}
