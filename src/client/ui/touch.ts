/**
 * Virtual controls for touch devices: a stick on the left, DASH / JUMP on the
 * right. They only write `TouchState`; the input layer reads the stick as a
 * direction (eight sectors, see input/stick.ts) and consumes the `*Pressed`
 * edge flags into its latched mask, so a tap shorter than a frame still
 * produces exactly one press.
 *
 * Layout (P3-7): `applyLayout` pushes the player's TouchLayout to the real pad
 * elements as CSS custom properties (size / opacity scale, per-side offsets)
 * and an `is-floating` class — CSSOM only, no stylesheet rewriting. The
 * stylesheet keeps every hit box at least MIN_HIT_PX square at any scale
 * (`max(44px, calc(<rem> * var(--tscale)))`); `touchHitPx` is the same rule
 * in TypeScript so a headless test can audit it, and the mobile QA measures
 * the real boxes.
 *
 * Floating stick: with `floating` on, the left half of the touch area (#tpad-zone)
 * takes the first touch, the pad's centre relocates to that point and the
 * stick reads neutral there; the pad returns to its resting place on release.
 */
import type { TouchState } from '../contracts.js';
import type { TouchLayout } from '../save.js';
import { DEFAULT_TOUCH } from '../save.js';

/** Fallback stick radius (CSS px) when the pad has no layout yet. */
const FALLBACK_RADIUS = 24;
/** Every touch hit box (pad, buttons, pause, mute) is at least this many CSS px a side, whatever the scale. */
export const MIN_HIT_PX = 44;
/** Touch labels (DASH / JUMP) never render below this size. */
export const MIN_LABEL_PX = 11;
/** Resting sizes in rem, the same numbers the stylesheet scales by --tscale. */
export const TOUCH_BASE_REM = { pad: 7.5, tbtn: 4.4, jump: 5.4, pause: 2.75 } as const;
export type TouchElementKind = keyof typeof TOUCH_BASE_REM;
/** CSS px per rem the stylesheet is designed for (the root font size is never changed by the app). */
export const REM_PX = 16;

/**
 * The CSS px a touch element measures at `scale`: the stylesheet's
 * `max(MIN_HIT_PX, base-rem × scale)` rule (see .tpad / .tbtn / .hud__pause).
 */
export function touchHitPx(kind: TouchElementKind, scale: number, remPx = REM_PX): number {
  return Math.max(MIN_HIT_PX, TOUCH_BASE_REM[kind] * remPx * scale);
}

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

/** Shorter side below this many CSS px reads as a phone; a tablet is playable upright (letterboxed). */
export const PHONE_MAX_SHORT_SIDE = 600;

/** A phone-sized viewport (shorter side under PHONE_MAX_SHORT_SIDE). */
export function isPhoneViewport(win: Window | null | undefined): boolean {
  if (!win) return false;
  return Math.min(win.innerWidth, win.innerHeight) < PHONE_MAX_SHORT_SIDE;
}

/** The rotate prompt targets phones held upright only; an iPad in portrait is left alone. */
export function wantsRotatePrompt(win: Window | null | undefined): boolean {
  return isPortraitViewport(win) && isPhoneViewport(win);
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** The CSS custom properties `applyLayout` writes on #hud-touch, by TouchLayout field. */
export const LAYOUT_VARS: Readonly<Record<Exclude<keyof TouchLayout, 'floating'>, string>> = {
  scale: '--tscale', opacity: '--topacity', leftX: '--tleft-x', leftY: '--tleft-y', rightX: '--tright-x', rightY: '--tright-y',
};

export class TouchControls {
  readonly state: TouchState = makeTouchState();
  /** True once we know the device is touch-first (media query or a real touch). */
  coarse: boolean;
  /** The layout last applied (defaults until the settings arrive). */
  layout: TouchLayout = { ...DEFAULT_TOUCH };
  private pid: number | null = null;
  private cx = 0;
  private cy = 0;
  private r = FALLBACK_RADIUS;
  private readonly doc: Document;
  private readonly root: HTMLElement | null;
  private readonly zone: HTMLElement | null;
  private readonly pad: HTMLElement | null;
  private readonly knob: HTMLElement | null;
  private readonly coarseListeners: (() => void)[] = [];
  /** The stick was picked up through the floating zone (its position is relocated). */
  private floated = false;

  constructor(doc: Document, root: HTMLElement | null) {
    this.doc = doc;
    this.root = root;
    this.zone = doc.getElementById('tpad-zone');
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

  /**
   * Preview mode (the settings editor): the pad is shown over the menus,
   * non-interactive, so a slider drag is seen on the real elements.
   */
  setPreview(on: boolean): void { this.root?.classList.toggle('is-preview', on); }

  /** Push a layout to the pad elements: custom properties + the floating class. Idempotent and cheap. */
  applyLayout(layout: TouchLayout): void {
    this.layout = { ...layout };
    const root = this.root;
    if (!root) return;
    const st = root.style;
    st.setProperty(LAYOUT_VARS.scale, String(layout.scale));
    st.setProperty(LAYOUT_VARS.opacity, String(layout.opacity));
    st.setProperty(LAYOUT_VARS.leftX, `${layout.leftX}px`);
    st.setProperty(LAYOUT_VARS.leftY, `${layout.leftY}px`);
    st.setProperty(LAYOUT_VARS.rightX, `${layout.rightX}px`);
    st.setProperty(LAYOUT_VARS.rightY, `${layout.rightY}px`);
    root.classList.toggle('is-floating', layout.floating);
    if (!layout.floating && this.floated && this.pid === null) this.unfloat();
  }

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
      // Floating: a touch that lands on the resting pad still re-centres on the finger.
      if (this.layout.floating && this.zone) { this.grabFloating(e); return; }
      const rect = pad.getBoundingClientRect();
      this.cx = rect.left + rect.width / 2;
      this.cy = rect.top + rect.height / 2;
      this.r = Math.max(FALLBACK_RADIUS, rect.width / 2);
      this.grab(e, pad);
      this.moveStick(e.clientX, e.clientY);
    });
    const zone = this.zone;
    if (zone) {
      zone.addEventListener('pointerdown', (e: PointerEvent) => {
        if (!this.layout.floating) return;   // the zone has no pointer-events at rest; belt and braces
        e.preventDefault();
        this.grabFloating(e);
      });
      const swallow = (e: Event) => { if (this.layout.floating) e.preventDefault(); };
      zone.addEventListener('touchstart', swallow, { passive: false });
      zone.addEventListener('touchmove', swallow, { passive: false });
      zone.addEventListener('contextmenu', swallow);
    }
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

  /** Common pick-up bookkeeping: pointer id, active flag, capture. */
  private grab(e: PointerEvent, target: HTMLElement): void {
    if (this.pid !== null) return;
    this.pid = e.pointerId;
    this.state.active = true;
    this.pad?.classList.add('is-active');
    try { target.setPointerCapture?.(e.pointerId); } catch { /* not every DOM implements capture */ }
  }

  /**
   * Floating pick-up: the pad's centre moves to the finger (inside the zone's
   * box), the radius stays the pad's, the stick starts neutral.
   */
  private grabFloating(e: PointerEvent): void {
    const pad = this.pad, zone = this.zone;
    if (!pad || !zone || this.pid !== null) return;
    const padRect = pad.getBoundingClientRect();
    const zoneRect = zone.getBoundingClientRect();
    this.r = Math.max(FALLBACK_RADIUS, padRect.width / 2);
    this.cx = e.clientX;
    this.cy = e.clientY;
    pad.style.left = `${Math.round(e.clientX - zoneRect.left - this.r)}px`;
    pad.style.top = `${Math.round(e.clientY - zoneRect.top - this.r)}px`;
    pad.classList.add('is-floated');
    this.floated = true;
    this.grab(e, zone);
    this.moveStick(e.clientX, e.clientY);
  }

  private unfloat(): void {
    this.floated = false;
    const pad = this.pad;
    if (!pad) return;
    pad.style.removeProperty('left');
    pad.style.removeProperty('top');
    pad.classList.remove('is-floated');
  }

  private moveStick(clientX: number, clientY: number): void {
    // Raw deflection, clamped to the unit square; dead zones and sector snapping belong to the input layer.
    const dx = clamp((clientX - this.cx) / this.r, -1, 1);
    const dy = clamp((clientY - this.cy) / this.r, -1, 1);
    this.state.x = dx;
    this.state.y = dy;
    if (this.knob) this.knob.style.translate = `${-50 + dx * 34}% ${-50 + dy * 34}%`;
  }

  private releaseStick(): void {
    this.pid = null;
    this.state.active = false;
    this.state.x = 0;
    this.state.y = 0;
    this.pad?.classList.remove('is-active');
    if (this.knob) this.knob.style.translate = '-50% -50%';
    if (this.floated) this.unfloat();
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
