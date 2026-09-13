/**
 * Screen registry, the modal stack and the unified menu cursor.
 *
 * Every readable surface is a `<section class="screen" id="scr-<name>">`.
 * Base screens (boot, title, select, daily, play, replay) replace each other; modal
 * screens (pause, result, over, settings, credits, name) stack on top of the
 * current base so the world — or the pause menu — stays visible behind the blur.
 *
 * Mouse, touch, keyboard and gamepad all drive one cursor: a hover moves it, a
 * `takeMenu()` edge moves it, `confirm` clicks whatever it rests on. Elements
 * inside a `[data-row]` container form a row, so up/down jump between rows
 * (keeping the column) and left/right walk along one — that is what makes a
 * 3×3 tier grid, a tab strip and a plain vertical menu feel the same.
 */
import type { InputPort, MenuAction, Screen } from '../contracts.js';

export const SCREENS: readonly Screen[] = [
  'boot', 'title', 'select', 'daily', 'settings', 'credits', 'journal', 'play', 'replay', 'pause', 'result', 'over', 'name', 'assist',
];
export const MODAL_SCREENS: ReadonlySet<Screen> = new Set<Screen>(['pause', 'result', 'over', 'settings', 'credits', 'journal', 'name', 'assist']);
/** How long the leaving animation keeps a screen in the layout. */
export const LEAVE_MS = 280;

// ---------------------------------------------------------------- DOM helpers
export type Attrs = Record<string, string | number | boolean | null | undefined>;
export type Child = Node | string | null | undefined | false;

/** Tiny element builder: attributes via setAttribute (never innerHTML), strings become text nodes. */
export function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document, tag: K, attrs: Attrs = {}, ...children: Child[]
): HTMLElementTagNameMap[K] {
  const n = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    n.append(typeof c === 'string' ? doc.createTextNode(c) : c);
  }
  return n;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function starSvg(doc: Document, on: boolean): SVGElement {
  const s = doc.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', on ? 'star on' : 'star');
  s.setAttribute('aria-hidden', 'true');
  const p = doc.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', 'M12 2l3.1 6.5 7 .9-5.1 4.9 1.3 7L12 18l-6.3 3.3 1.3-7L2 9.4l7-.9z');
  p.setAttribute('fill', on ? '#F4C95D' : '#5F7683');
  s.appendChild(p);
  return s;
}

export function lockSvg(doc: Document): SVGElement {
  const s = doc.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.8');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('aria-hidden', 'true');
  const r = doc.createElementNS(SVG_NS, 'rect');
  r.setAttribute('x', '4.5'); r.setAttribute('y', '10.5'); r.setAttribute('width', '15'); r.setAttribute('height', '10.5'); r.setAttribute('rx', '2.5');
  const p = doc.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', 'M8 10.5V7.5a4 4 0 0 1 8 0v3');
  s.append(r, p);
  return s;
}

/**
 * Layout-free visibility: `offsetParent` is unreliable in headless DOMs and
 * forces layout in browsers. Walk up to `root` looking for `hidden` and for an
 * inactive settings pane.
 */
export function isVisible(node: Element, root: Element): boolean {
  let n: Element | null = node;
  while (n) {
    if (n.hasAttribute('hidden') || n.hasAttribute('inert')) return false;
    if (n.classList.contains('pane') && !n.classList.contains('is-active')) return false;
    if (n === root) return true;
    n = n.parentElement;
  }
  return false;
}

/** Restart a CSS animation class on an element. */
export function replay(elm: Element | null, cls: string): void {
  if (!elm) return;
  elm.classList.remove(cls);
  // Reading a layout property forces the style flush that lets the class re-trigger.
  void (elm as HTMLElement).offsetWidth;
  elm.classList.add(cls);
}

// ---------------------------------------------------------------- names
export const NAME_MAX = 12;
/** Mirrors the server's PlayerRef.name rule: no control chars or markup punctuation. */
const NAME_RE = /^[^\p{C}<>&"'`]+$/u;

/** Korean error text for an invalid display name, or null when it is fine. */
export function validateName(raw: string): string | null {
  const s = raw.trim();
  if (!s.length) return '이름이 비어 있다';
  if (s.length > NAME_MAX) return `이름은 ${NAME_MAX}자 이하여야 한다`;
  if (!NAME_RE.test(s)) return '쓸 수 없는 문자가 있다 ( < > & " \' ` )';
  return null;
}

// ---------------------------------------------------------------- screen stack
const FOCUS_SELECTOR = 'a[href],button,input:not([type="hidden"]),select,textarea,[tabindex],[contenteditable="true"]';

function focusable(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUS_SELECTOR)]
    .filter((n) => (!n.hasAttribute('tabindex') || n.tabIndex >= 0) && !n.matches(':disabled') && isVisible(n, root));
}

function focusElement(node: HTMLElement): void {
  try { node.focus({ preventScroll: true }); } catch { /* detached or unavailable DOM */ }
}

export class ScreenStack {
  base: Screen = 'boot';
  readonly modals: Screen[] = [];
  private readonly els = new Map<Screen, HTMLElement>();
  private readonly doc: Document;
  private focusRoot: HTMLElement | null = null;
  private readonly rememberedFocus = new WeakMap<HTMLElement, HTMLElement>();

  constructor(doc: Document) {
    this.doc = doc;
    for (const s of SCREENS) {
      const e = doc.getElementById(`scr-${s}`);
      if (e) this.els.set(s, e);
    }
    // Adopt whatever the template marks active as the starting base.
    for (const [s, e] of this.els) {
      if (!MODAL_SCREENS.has(s) && e.classList.contains('is-active')) this.base = s;
      if (MODAL_SCREENS.has(s) && !e.hasAttribute('role')) e.setAttribute('role', 'dialog');
    }
    this.setFocusRoot(null);
  }

  el(s: Screen): HTMLElement | null { return this.els.get(s) ?? null; }
  get top(): Screen { return this.modals.length ? this.modals[this.modals.length - 1] : this.base; }
  isActive(s: Screen): boolean { return this.els.get(s)?.classList.contains('is-active') ?? false; }

  /** Show a screen. Returns true when the base screen changed (a new run, a return to the title …). */
  show(name: Screen): boolean {
    let baseChanged = false;
    if (MODAL_SCREENS.has(name)) {
      const i = this.modals.indexOf(name);
      if (i >= 0) for (const m of this.modals.splice(i + 1)) this.deactivate(m);
      else this.modals.push(name);
    } else {
      for (const m of this.modals.splice(0)) this.deactivate(m);
      if (this.base !== name) { this.deactivate(this.base); baseChanged = true; }
      this.base = name;
    }
    this.activate(name);
    this.setFocusRoot(null);
    return baseChanged;
  }

  /** Close the top modal. Returns the screen that was closed, or null when no modal is open. */
  pop(): Screen | null {
    const m = this.modals.pop();
    if (!m) return null;
    this.deactivate(m);
    this.setFocusRoot(null);
    return m;
  }

  /**
   * Hand focus to a manually managed overlay after it becomes visible.
   * Pass null to return to the regular top screen. show()/pop() do this
   * automatically; a UI returning to an ending/data overlay should reapply
   * its root before refreshing the Navigator. The last focused control in
   * each surface is restored when it is still available.
   */
  setFocusRoot(root: HTMLElement | null, preferred?: HTMLElement | null): void {
    const previous = this.focusRoot;
    const active = this.doc.activeElement as HTMLElement | null;
    if (previous && active && previous.contains(active)) this.rememberedFocus.set(previous, active);
    previous?.removeEventListener('keydown', this.onTab);
    const next = root ?? this.el(this.top);
    this.focusRoot = next;

    if (next) {
      next.removeAttribute('inert');
      next.removeAttribute('aria-hidden');
      if (next.getAttribute('role') === 'dialog' || next.getAttribute('role') === 'alertdialog') {
        next.setAttribute('aria-modal', 'true');
      }
      next.addEventListener('keydown', this.onTab);
      const gameplay = next.id === 'scr-play' || next.id === 'scr-boot';
      const saved = preferred ?? (gameplay ? next : active && next.contains(active) ? active : this.rememberedFocus.get(next));
      const canRestore = saved && next.contains(saved) && isVisible(saved, next) && !saved.matches(':disabled');
      if (canRestore) {
        if (saved === next && !next.hasAttribute('tabindex')) next.setAttribute('tabindex', '-1');
        focusElement(saved);
      }
      else this.focusInitial(next);
    }

    // Move focus first, then hide covered surfaces from keyboard and AT.
    // Leaving animations can remain visible without keeping live controls.
    for (const e of this.els.values()) if (e !== next) this.makeInert(e);
    if (previous && previous !== next) this.makeInert(previous);
  }

  private makeInert(root: HTMLElement): void {
    root.setAttribute('inert', '');
    root.setAttribute('aria-hidden', 'true');
    root.removeAttribute('aria-modal');
  }

  private focusInitial(root: HTMLElement): void {
    // Native button activation must not turn Enter/Space into a pause on entry.
    const controls = root.id === 'scr-play' || root.id === 'scr-boot' ? [] : focusable(root);
    const target = controls.find((n) => n.hasAttribute('autofocus'))
      ?? controls.find((n) => n.hasAttribute('data-default'))
      ?? controls.find((n) => n.classList.contains('menu__item'))
      ?? controls.find((n) => n.classList.contains('card'))
      ?? controls[0];
    if (target) focusElement(target);
    else {
      if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
      focusElement(root);
    }
  }

  private readonly onTab = (e: KeyboardEvent): void => {
    const root = this.focusRoot;
    if (!root || e.key !== 'Tab' || e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
    // Base screens may let Tab leave the application. Modals and explicitly
    // handed-off overlays own focus until their close/cancel action runs.
    if (root === this.el(this.top) && !MODAL_SCREENS.has(this.top)) return;
    const controls = focusable(root);
    const index = controls.indexOf(this.doc.activeElement as HTMLElement);
    if (!controls.length) {
      e.preventDefault();
      this.focusInitial(root);
    } else if (index < 0 || (e.shiftKey ? index === 0 : index === controls.length - 1)) {
      e.preventDefault();
      focusElement(controls[e.shiftKey ? controls.length - 1 : 0]);
    }
  };

  private activate(s: Screen): void {
    const e = this.els.get(s);
    if (!e) return;
    e.classList.remove('is-leaving');
    e.classList.add('is-active');
  }

  private deactivate(s: Screen): void {
    const e = this.els.get(s);
    if (!e || !e.classList.contains('is-active')) return;
    e.classList.remove('is-active');
    e.classList.add('is-leaving');
    const timer = this.doc.defaultView?.setTimeout ?? setTimeout;
    timer(() => e.classList.remove('is-leaving'), LEAVE_MS);
  }
}

// ---------------------------------------------------------------- cursor
export type NavDir = 'up' | 'down' | 'left' | 'right';
export const NAV_SELECTOR = 'button:not([disabled]):not([data-touch]):not([data-nonav]), input[type="range"]:not([disabled])';
/** Seconds a direction must stay held before it starts repeating, and the repeat period. */
export const REPEAT_DELAY = 0.32;
export const REPEAT_INTERVAL = 0.085;

export interface NavHooks {
  onMove?(): void;
  onConfirm(target: HTMLElement): void;
  onCancel(): void;
  /** Return true when the element consumed a left/right press (sliders). */
  onAdjust?(target: HTMLElement, dir: -1 | 1): boolean;
}

export class Navigator {
  els: HTMLElement[] = [];
  index = 0;
  private repeatDir: NavDir | null = null;
  private repeatT = 0;
  private readonly doc: Document;
  private readonly hooks: NavHooks;

  constructor(doc: Document, hooks: NavHooks) {
    this.doc = doc;
    this.hooks = hooks;
  }

  get current(): HTMLElement | null { return this.els[this.index] ?? null; }

  /**
   * Re-collect navigable elements under `root` (null clears the cursor). With
   * `keep`, the cursor stays on the same element when it is still there;
   * otherwise it prefers `[data-default]`, then the first menu item or card.
   * Restore lost DOM focus to the new cursor, preserving live controls and editors.
   */
  refresh(root: HTMLElement | null, keep = false): void {
    const prev = this.current;
    const active = this.doc.activeElement as HTMLElement | null;
    this.els = root
      ? [...root.querySelectorAll<HTMLElement>(NAV_SELECTOR)].filter((n) => isVisible(n, root))
      : [];
    let i = -1;
    if (keep && prev) i = this.els.indexOf(prev);
    if (i < 0) i = this.els.indexOf(active as HTMLElement);
    if (i < 0) i = this.els.findIndex((n) => n.hasAttribute('data-default'));
    if (i < 0) i = this.els.findIndex((n) => n.classList.contains('menu__item'));
    if (i < 0) i = this.els.findIndex((n) => n.classList.contains('card'));
    this.index = Math.max(0, i);
    this.paint();
    const hasFocus = active && active !== this.doc.body && active !== this.doc.documentElement
      && active.isConnected && !active.matches(':disabled') && isVisible(active, this.doc.documentElement);
    const current = this.current;
    if (root?.isConnected && current && !hasFocus) focusElement(current);
  }

  paint(): void {
    // Clear globally: a modal over a live screen must not leave the screen
    // beneath with a second highlighted item.
    for (const n of this.doc.querySelectorAll('.is-cursor')) n.classList.remove('is-cursor');
    const n = this.current;
    if (n) n.classList.add('is-cursor');
  }

  /** Pointer hover puts the cursor on the hovered element (no sound — the pointer moved, not the menu). */
  hover(node: Element): void {
    const i = this.els.indexOf(node as HTMLElement);
    if (i >= 0 && i !== this.index) {
      this.index = i;
      this.paint();
    }
  }

  private rows(): HTMLElement[][] {
    const byKey = new Map<Element, HTMLElement[]>();
    const rows: HTMLElement[][] = [];
    for (const n of this.els) {
      const key = n.closest('[data-row]') ?? n;
      let r = byKey.get(key);
      if (!r) { r = []; byKey.set(key, r); rows.push(r); }
      r.push(n);
    }
    return rows;
  }

  move(dir: NavDir): boolean {
    if (!this.els.length) return false;
    const cur = this.current;
    if (cur && (dir === 'left' || dir === 'right') && this.hooks.onAdjust?.(cur, dir === 'right' ? 1 : -1)) return true;
    const rows = this.rows();
    let ri = cur ? rows.findIndex((r) => r.includes(cur)) : 0;
    if (ri < 0) ri = 0;
    const ci = cur ? Math.max(0, rows[ri].indexOf(cur)) : 0;
    let target: HTMLElement | undefined;
    if (dir === 'up' || dir === 'down') {
      const row = rows[(ri + (dir === 'down' ? 1 : -1) + rows.length) % rows.length];
      target = row[Math.min(ci, row.length - 1)];
    } else {
      const row = rows[ri];
      if (row.length <= 1) return false;
      const nci = ci + (dir === 'right' ? 1 : -1);
      if (nci < 0 || nci >= row.length) return false;
      target = row[nci];
    }
    if (!target || target === cur) return false;
    this.index = this.els.indexOf(target);
    this.paint();
    focusElement(target);
    target.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    this.hooks.onMove?.();
    return true;
  }

  /**
   * Drive the cursor from the frame's menu edges plus held-to-repeat. Edges
   * are processed in order (two quick taps are two moves); confirm and cancel
   * fire at most once per frame.
   */
  update(dt: number, actions: readonly MenuAction[], input: InputPort): void {
    let moved: NavDir | null = null;
    for (const a of actions) {
      if (a === 'up' || a === 'down' || a === 'left' || a === 'right') {
        this.move(a);
        moved = a;
      }
    }
    if (moved) {
      this.repeatDir = moved;
      this.repeatT = REPEAT_DELAY;
    } else if (this.repeatDir) {
      if (input.menuHeld(this.repeatDir)) {
        // A long frame (tab switch) must not spin the cursor round the menu.
        this.repeatT -= Math.min(dt, 0.5);
        for (let n = 0; this.repeatT <= 0 && n < 6; n++) {
          this.move(this.repeatDir);
          this.repeatT += REPEAT_INTERVAL;
        }
        if (this.repeatT < 0) this.repeatT = 0;
      } else {
        this.repeatDir = null;
      }
    }
    if (actions.includes('confirm')) {
      const c = this.current;
      if (c) this.hooks.onConfirm(c);
    } else if (actions.includes('cancel')) {
      this.hooks.onCancel();
    }
  }
}
