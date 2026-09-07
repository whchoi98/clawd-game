/**
 * In-game HUD: hearts, shard / relic chips, timer, tide height, dash meter,
 * hint line, toasts and banners — plus the polite live region a screen reader
 * follows while the canvas stays aria-hidden.
 *
 * Everything is diffed against the last HudState so a 60 Hz caller only
 * touches the DOM when a value actually changed.
 */
import type { HudState } from '../contracts.js';
import { TICK_HZ } from '../../sim/types.js';
import { replay } from './screens.js';

/** Minimum seconds between live-region updates (4 per second). */
export const LIVE_INTERVAL = 0.25;
export const TOAST_SECONDS = 1.8;
export const BANNER_SECONDS = 2.1;
/** How long the dash meter lingers after the dash comes back, so the refill reads. */
const DASH_LINGER = 0.35;
/** Shard combo at which the HUD chip turns hot (the sfx ladder adds its fifth at the same step, P3-6). */
export const COMBO_HOT = 8;

/** `m:ss.cc` — negative or non-finite input reads as zero. */
export function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec * 100) % 100);
  return `${m}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

export function fmtTicks(ticks: number): string {
  return fmtTime(ticks / TICK_HZ);
}

interface LastHud {
  hp?: number; maxHp?: number;
  shards?: number; totalShards?: number;
  relics?: number; totalRelics?: number;
  timeStr?: string; showTimer?: boolean;
  level?: string;
  height?: number; hasHeight?: boolean;
  combo?: number;
  dashReady?: boolean;
  assist?: boolean;
}

export class Hud {
  private last: LastHud = {};
  private liveClock = 0;
  private liveAt = -1;
  private livePending: string | null = null;
  private toastT = 0;
  private bannerT = 0;
  private dashHideT = 0;

  private readonly hearts: HTMLElement | null;
  private readonly shards: HTMLElement | null;
  private readonly shardsTotal: HTMLElement | null;
  private readonly shardChip: HTMLElement | null;
  private readonly relicChip: HTMLElement | null;
  private readonly relics: HTMLElement | null;
  private readonly relicsTotal: HTMLElement | null;
  private readonly combo: HTMLElement | null;
  private readonly comboN: HTMLElement | null;
  private readonly assist: HTMLElement | null;
  private readonly timer: HTMLElement | null;
  private readonly level: HTMLElement | null;
  private readonly height: HTMLElement | null;
  private readonly heightN: HTMLElement | null;
  private readonly dash: HTMLElement | null;
  private readonly splitEl: HTMLElement | null;
  private readonly hintEl: HTMLElement | null;
  private readonly toastEl: HTMLElement | null;
  private readonly bannerEl: HTMLElement | null;
  private readonly sr: HTMLElement | null;
  private readonly doc: Document;

  constructor(doc: Document) {
    this.doc = doc;
    const q = (id: string) => doc.getElementById(id);
    this.hearts = q('hud-hearts');
    this.shards = q('hud-shards');
    this.shardsTotal = q('hud-shards-total');
    this.shardChip = doc.querySelector('.hud__chip--shard');
    this.relicChip = q('hud-relic-chip');
    this.relics = q('hud-relics');
    this.relicsTotal = q('hud-relics-total');
    this.combo = q('hud-combo');
    this.comboN = q('hud-combo-n');
    this.assist = q('hud-assist');
    this.timer = q('hud-timer');
    this.level = q('hud-level');
    this.height = q('hud-height');
    this.heightN = q('hud-height-n');
    this.dash = q('hud-dash');
    this.splitEl = q('hud-split');
    this.hintEl = q('hud-hint');
    this.toastEl = q('hud-toast');
    this.bannerEl = q('hud-banner');
    this.sr = q('hud-sr');
  }

  /** Forget the previous run so the next update() repaints everything. */
  reset(): void {
    this.last = {};
    this.livePending = null;
    this.hint(null);
    this.split(null);
    this.setLevelHidden(false);
    if (this.dash) this.dash.classList.remove('show');
  }

  /**
   * Checkpoint split chip under the timer: '+0.84s' (behind, red), '−1.20s'
   * (ahead, teal), '±0.00s' / '—' (even / the echo is not there yet, muted).
   * The shell owns its lifetime and hides it with null.
   */
  split(text: string | null, sign: -1 | 0 | 1 = 0): void {
    const el = this.splitEl;
    if (!el) return;
    if (text === null || text === '') {
      el.hidden = true;
      el.textContent = '';
      el.classList.remove('is-ahead', 'is-behind', 'is-even', 'bump');
      delete el.dataset.sign;
      return;
    }
    el.textContent = text;
    el.classList.toggle('is-ahead', sign < 0);
    el.classList.toggle('is-behind', sign > 0);
    el.classList.toggle('is-even', sign === 0);
    el.dataset.sign = String(sign);
    el.hidden = false;
    replay(el, 'bump');
    this.announce(`구간 ${text}`);
  }

  /** Hide the zone name chip while the goal is drawn under it (the renderer reports goalScreen). */
  setLevelHidden(on: boolean): void {
    if (this.level && this.level.hidden !== on) this.level.hidden = on;
  }

  update(h: HudState): void {
    const L = this.last;
    const say: string[] = [];

    if (h.maxHp !== L.maxHp && this.hearts) {
      this.hearts.replaceChildren();
      for (let i = 0; i < h.maxHp; i++) {
        const heart = this.doc.createElement('i');
        heart.className = 'heart';
        this.hearts.appendChild(heart);
      }
      L.maxHp = h.maxHp;
      L.hp = undefined;
    }
    if (h.hp !== L.hp && this.hearts) {
      this.hearts.setAttribute('aria-label', `체력 ${h.hp} / ${h.maxHp}`);
      const hs = this.hearts.querySelectorAll<HTMLElement>('.heart');
      hs.forEach((heart, i) => {
        const on = i < h.hp;
        heart.classList.toggle('off', !on);
        if (L.hp !== undefined && !on && i === h.hp) replay(heart, 'pulse');
      });
      if (L.hp !== undefined) say.push(`체력 ${h.hp}`);
      L.hp = h.hp;
    }

    if (h.totalShards !== L.totalShards && this.shardsTotal) {
      this.shardsTotal.textContent = `/${h.totalShards}`;
      L.totalShards = h.totalShards;
    }
    if (h.shards !== L.shards) {
      if (this.shards) this.shards.textContent = String(h.shards);
      if (L.shards !== undefined) replay(this.shardChip, 'bump');
      say.push(`파편 ${h.shards} / ${h.totalShards}`);
      L.shards = h.shards;
    }

    if (h.totalRelics !== L.totalRelics) {
      if (this.relicChip) this.relicChip.hidden = h.totalRelics <= 0;
      if (this.relicsTotal) this.relicsTotal.textContent = `/${h.totalRelics}`;
      L.totalRelics = h.totalRelics;
    }
    if (h.relics !== L.relics) {
      if (this.relics) this.relics.textContent = String(h.relics);
      if (L.relics !== undefined) {
        replay(this.relicChip, 'bump');
        say.push(`유물 ${h.relics} / ${h.totalRelics}`);
      }
      L.relics = h.relics;
    }

    if (h.combo !== L.combo && this.combo) {
      this.combo.hidden = h.combo < 2;
      if (this.comboN) this.comboN.textContent = String(h.combo);
      if (h.combo >= 2 && h.combo !== L.combo) replay(this.combo, 'bump');
      // 8+ turns the chip hot (the sfx ladder shimmers from the same step)
      this.combo.classList.toggle('is-hot', h.combo >= COMBO_HOT);
      L.combo = h.combo;
    }

    if (h.assist !== L.assist) {
      if (this.assist) this.assist.hidden = !h.assist;
      // SIM v3: hazards kill outright outside assist, so hp never moves there — the hearts only mean something in assist mode.
      if (this.hearts) this.hearts.hidden = !h.assist;
      L.assist = h.assist;
    }

    if (h.showTimer !== L.showTimer && this.timer) {
      this.timer.hidden = !h.showTimer;
      L.showTimer = h.showTimer;
    }
    if (h.showTimer && this.timer) {
      const t = fmtTime(h.time);
      if (t !== L.timeStr) { this.timer.textContent = t; L.timeStr = t; }
    }

    const levelText = `${h.biomeName} · ${h.levelName}`;
    if (levelText !== L.level && this.level) {
      this.level.textContent = levelText;
      L.level = levelText;
    }

    const hasHeight = h.height !== undefined;
    if (hasHeight !== L.hasHeight && this.height) {
      this.height.hidden = !hasHeight;
      L.hasHeight = hasHeight;
    }
    if (hasHeight) {
      const hv = Math.max(0, Math.floor(h.height as number));
      if (hv !== L.height && this.heightN) { this.heightN.textContent = String(hv); L.height = hv; }
    }

    if (h.dashReady !== L.dashReady && this.dash) {
      const bar = this.dash.firstElementChild;
      if (!h.dashReady) {
        this.dash.classList.add('show');
        bar?.classList.add('is-empty');
        this.dashHideT = 0;
      } else {
        bar?.classList.remove('is-empty');
        this.dashHideT = L.dashReady === undefined ? 0.0001 : DASH_LINGER;
      }
      L.dashReady = h.dashReady;
    }

    if (say.length) this.announce(say.join(' · '));
  }

  /** Advance timers: live-region throttle, toast / banner lifetimes, dash meter linger. */
  frame(dt: number): void {
    this.liveClock += dt;
    if (this.livePending !== null && this.liveClock - this.liveAt >= LIVE_INTERVAL) {
      this.write(this.livePending);
    }
    if (this.toastT > 0) {
      this.toastT -= dt;
      if (this.toastT <= 0) this.toastEl?.classList.remove('show');
    }
    if (this.bannerT > 0) {
      this.bannerT -= dt;
      if (this.bannerT <= 0) this.bannerEl?.classList.remove('show');
    }
    if (this.dashHideT > 0) {
      this.dashHideT -= dt;
      if (this.dashHideT <= 0) this.dash?.classList.remove('show');
    }
  }

  /**
   * Push text to the polite live region. Throttled to LIVE_INTERVAL: shard
   * pickups land several times a second and a screen reader would never catch
   * up, so only the latest pending text is spoken when the window reopens.
   */
  announce(text: string): void {
    if (this.liveAt < 0 || this.liveClock - this.liveAt >= LIVE_INTERVAL) this.write(text);
    else this.livePending = text;
  }

  private write(text: string): void {
    if (this.sr) this.sr.textContent = text;
    this.liveAt = this.liveClock;
    this.livePending = null;
  }

  toast(text: string): void {
    if (!this.toastEl) return;
    this.toastEl.textContent = text;
    replay(this.toastEl, 'show');
    this.toastT = TOAST_SECONDS;
    this.announce(text);
  }

  banner(text: string): void {
    if (!this.bannerEl) return;
    this.bannerEl.textContent = text;
    replay(this.bannerEl, 'show');
    this.bannerT = BANNER_SECONDS;
  }

  hint(text: string | null): void {
    if (!this.hintEl) return;
    if (text === null || text === '') {
      this.hintEl.hidden = true;
      this.hintEl.textContent = '';
    } else {
      this.hintEl.textContent = text;
      this.hintEl.hidden = false;
    }
  }
}
