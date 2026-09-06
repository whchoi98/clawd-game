/**
 * DOM UI — `class UI implements UIPort`.
 *
 * The canvas draws the world; every glyph the player reads is real DOM. That
 * buys crisp text at any DPR, CSS motion, focus rings and screen-reader access
 * that a canvas bitmap font cannot offer.
 *
 * Ownership: the UI never touches game state. It emits `UIAction`s for the
 * shell, mutates the shared `Settings` object in place (and says so through
 * `settingsChanged` / `rebind` / `toggleEcho`), and owns its own navigation
 * between pure UI surfaces (title ↔ select ↔ daily ↔ settings ↔ credits ↔ name).
 *
 * Pause: `UIAction` has no `pause`, so an Escape / Start edge during play makes
 * the UI show the pause screen itself; the shell steps the sim only while
 * `ui.screen === 'play'`, and `resume` / `restart` / `quit` come back as actions.
 */
import type {
  AudioPort, Binds, HudState, InputPort, MenuAction, Progress, ResultView, Screen, Settings, TouchState,
  UIAction, UIPort, UiSound,
} from '../contracts.js';
import type { LevelDef, RunSummary } from '../../sim/types.js';
import type { DailyResponse, LeaderboardResponse, RejectReason } from '../../shared/protocol.js';
import type { Biome } from '../../shared/biomes.js';
import { BIOMES, BIOME_ORDER } from '../../shared/biomes.js';
import { DEFAULT_BINDS } from '../input/binds.js';
import {
  MODAL_SCREENS, Navigator, ScreenStack, el, lockSvg, starSvg, validateName, NAME_MAX,
} from './screens.js';
import { Hud, fmtTicks, fmtTime } from './hud.js';
import { SettingsPanel, type PortraitPainter } from './settings.js';
import { TouchControls, wantsRotatePrompt } from './touch.js';
import { renderLeaderboard, type LbStatus } from './leaderboard.js';

export interface UIOptions {
  /** Defaults to the global document. */
  document?: Document;
  /** The input layer; also picked up from every `frame()` call. */
  input?: InputPort | null;
  /** UI sounds and the first-gesture AudioContext unlock. */
  audio?: Pick<AudioPort, 'ui' | 'init'> | null;
  /** Skins for the character picker (RendererPort.skins). */
  skins?: Record<string, { name: string; kr: string }>;
  /** DEFAULT_BINDS from the input layer, for the "reset controls" button. */
  defaultBinds?: Binds;
  /** Build id shown in the tech notes. */
  build?: string;
  /** Clock for the daily countdown (ms since epoch). */
  now?: () => number;
  /** "홈 화면에 추가": show the browser's deferred install prompt (src/client/pwa.ts). */
  onInstall?: () => void;
}

/**
 * Korean text for every RunRejected.reason. Typed over the protocol enum so a
 * reason added on the server without a translation is a compile error here.
 */
export const REASON_KR: Readonly<Record<RejectReason, string>> = {
  assist: '보조 모드 기록이다',
  'too-long': '기록이 너무 길다',
  'not-finished': '완주하지 않은 기록이다',
  'claim-mismatch': '서버 재생 결과와 맞지 않는다',
  'bad-level': '알 수 없는 구역이다',
  'bad-seed': '시드가 맞지 않는다',
  'stale-date': '날짜가 지난 기록이다',
  'bad-masks': '입력 기록이 손상됐다',
  'rate-limited': '요청이 너무 잦다. 잠시 후 다시',
  duplicate: '이미 접수된 기록이다',
  'sim-version': '새 버전이 나왔다. 새로고침 후 다시 제출된다',
};
/** Transport-level reasons the API client produces (ApiError.reason) when there is no server verdict. */
const TRANSPORT_REASON_KR: Readonly<Record<string, string>> = {
  'bad-request': '잘못된 요청이다',
  'not-found': '서버가 기록을 찾지 못했다',
  'server-error': '서버 오류다',
  'bad-response': '서버 응답을 읽을 수 없다',
  timeout: '서버가 응답하지 않는다',
  network: '서버에 닿지 않는다',
};

/** Korean line for a rejection reason; unknown strings fall back to themselves. */
export function reasonKr(reason: string | undefined): string {
  if (!reason) return '알 수 없는 이유';
  return (REASON_KR as Readonly<Record<string, string | undefined>>)[reason]
    ?? TRANSPORT_REASON_KR[reason]
    ?? reason;
}

/** sessionStorage key: the player chose to keep playing in portrait. */
export const NAG_DISMISSED_KEY = 'clawd-echo.nag-dismissed';
/** localStorage key: the iOS "share → add to home screen" hint was closed. */
export const IOS_HINT_DISMISSED_KEY = 'clawd-echo.ios-hint-dismissed';
const ROMAN = ['I', 'II', 'III', 'IV', 'V'];
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const HOVER_SELECTOR = '.menu__item,.card,.tab,.chip,.echo,.bindbtn,.switch,.seg button,.icon-btn';

/** '2026-09-06' → '2026년 9월 6일 (일)'. */
export function fmtDateKr(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const wd = WEEKDAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
  return `${y}년 ${mo}월 ${d}일 (${wd})`;
}

function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), mi = Math.floor((s % 3600) / 60), se = s % 60;
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:${String(se).padStart(2, '0')}`;
}

export class UI implements UIPort {
  readonly touch: TouchState;

  private readonly doc: Document;
  private readonly win: Window | null;
  private readonly screens: ScreenStack;
  private readonly nav: Navigator;
  private readonly hudCtl: Hud;
  private readonly settingsPanel: SettingsPanel;
  private readonly touchCtl: TouchControls;
  private readonly audio: Pick<AudioPort, 'ui' | 'init'> | null;
  private readonly skins: Record<string, { name: string; kr: string }>;
  private readonly defaultBinds: Binds;
  private readonly now: () => number;
  private readonly onInstall: (() => void) | null;
  private readonly listeners: ((a: UIAction) => void)[] = [];

  private input: InputPort | null;
  private settings: Settings | null = null;
  private progress: Progress | null = null;
  private levels: LevelDef[] = [];
  private lastHud: HudState | null = null;
  private result: ResultView | null = null;
  private daily: DailyResponse | null = null;
  private dailyLb: LeaderboardResponse | null = null;
  private dailyStatus: LbStatus = 'loading';
  private dailyClock = 0;
  private portrait: PortraitPainter | null = null;
  private resetArmed = false;
  private playerName = '';
  private nagDismissed = false;
  private iosHintWanted = false;
  private iosHintDismissed = false;
  /** Set by showUpdate(); the bar stays until the player applies the update. */
  private updateApply: (() => void) | null = null;

  constructor(opts: UIOptions = {}) {
    this.doc = opts.document ?? document;
    this.win = this.doc.defaultView ?? null;
    this.input = opts.input ?? null;
    this.audio = opts.audio ?? null;
    this.skins = opts.skins ?? {};
    this.defaultBinds = opts.defaultBinds ?? DEFAULT_BINDS;
    this.now = opts.now ?? (() => Date.now());
    this.onInstall = opts.onInstall ?? null;
    this.nagDismissed = this.readNagDismissed();
    this.iosHintDismissed = this.readFlag(IOS_HINT_DISMISSED_KEY);

    this.screens = new ScreenStack(this.doc);
    this.hudCtl = new Hud(this.doc);
    this.touchCtl = new TouchControls(this.doc, this.doc.getElementById('hud-touch'));
    this.touch = this.touchCtl.state;
    this.nav = new Navigator(this.doc, {
      onMove: () => this.sound('move'),
      onConfirm: (target) => this.confirm(target),
      onCancel: () => this.cancel(),
      onAdjust: (target, dir) => this.adjust(target, dir),
    });
    this.settingsPanel = new SettingsPanel({
      doc: this.doc,
      settings: () => this.settings,
      skins: () => this.skins,
      keyLabel: (code) => this.input?.keyLabel(code) ?? code,
      capture: (cb) => {
        if (!this.input) return false;
        this.input.capture(cb);
        return true;
      },
      defaultBinds: () => this.defaultBinds,
      onChange: () => this.emit({ type: 'settingsChanged' }),
      onRebind: (binds) => {
        this.input?.setBinds(binds);
        this.emit({ type: 'rebind', binds });
      },
      onRebuilt: () => { if (this.screens.top === 'settings') this.nav.refresh(this.screens.el('settings'), true); },
      sound: (n) => this.sound(n),
      portrait: () => this.portrait,
      build: opts.build,
    });

    this.buildEchoToggles();
    this.buildCredits();
    this.wireClicks();
    this.wireName();
    this.wireTabs();
    this.wireLifecycle();
    this.touchCtl.onCoarse(() => { this.updateTouchVisibility(); this.updateNag(); });
    this.updateNag();
  }

  // ================================================================ UIPort
  on(cb: (a: UIAction) => void): void { this.listeners.push(cb); }

  get screen(): Screen { return this.screens.top; }

  show(screen: Screen): void {
    const baseChanged = this.screens.show(screen);
    if (screen === 'play' && baseChanged) this.hudCtl.reset();
    this.afterShow();
  }

  frame(dt: number, input: InputPort): void {
    this.input = input;
    // A long frame (tab switch) simply expires toasts and reopens the live region.
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    this.hudCtl.frame(step);
    this.tickDaily(step);

    const edges = input.takeMenu();
    const actions = new Set<MenuAction>(edges);
    if (this.settingsPanel.capturing) return;
    const top = this.screens.top;
    if (top === 'boot') return;
    if (top === 'play') {
      if (actions.has('pause')) this.pause();
      else if (actions.has('restart')) this.emit({ type: 'restart' });
      return;
    }
    if (top === 'pause' && (actions.has('pause') || actions.has('cancel'))) {
      this.sound('cancel');
      this.emit({ type: 'resume' });
      return;
    }
    if (top === 'name' && this.doc.activeElement === this.nameInput()) {
      // Typing: arrows move the caret, not the cursor. Enter confirms, Escape closes.
      if (actions.has('cancel')) this.goBack();
      else if (actions.has('confirm')) this.submitName();
      return;
    }
    this.nav.update(step, edges, input);
  }

  hud(h: HudState): void {
    this.lastHud = h;
    this.hudCtl.update(h);
  }

  hint(text: string | null): void { this.hudCtl.hint(text); }

  toast(text: string): void { this.hudCtl.toast(text); }

  /** Big centred banner (zone name at start, "끝없는 등반" …). Not part of UIPort but handy for the shell. */
  banner(text: string): void { this.hudCtl.banner(text); }

  /** Boot progress: 0..1 and an optional status line. */
  boot(k: number, label?: string): void {
    const fill = this.doc.getElementById('boot-fill');
    if (fill) fill.style.width = `${Math.round(Math.min(1, Math.max(0, k)) * 100)}%`;
    const hint = this.doc.getElementById('boot-hint');
    if (hint && label) hint.textContent = label;
  }

  refreshSelect(progress: Progress, levels: LevelDef[]): void {
    this.progress = progress;
    this.levels = levels;
    this.playerName = progress.player.name;
    const host = this.doc.getElementById('sel-tiers');
    if (host) {
      host.replaceChildren();
      const unlocked = new Set<string>();
      levels.forEach((lv, i) => {
        if (i === 0 || progress.levels[levels[i - 1].id]?.done) unlocked.add(lv.id);
      });
      let done = 0;
      let lastUnlocked: HTMLElement | null = null;
      const tiers = BIOME_ORDER
        .map((b) => ({ biome: BIOMES[b], levels: levels.filter((l) => l.biome === b) }))
        .filter((t) => t.levels.length > 0);
      tiers.forEach((t, ti) => {
        let tierDone = 0;
        const grid = el(this.doc, 'div', { class: 'tier__cards', 'data-row': '', role: 'group', 'aria-label': `${t.biome.kr} 구역` });
        t.levels.forEach((lv, i) => {
          const rec = progress.levels[lv.id];
          if (rec?.done) { done++; tierDone++; }
          const isOpen = unlocked.has(lv.id);
          const card = this.card(lv, i, rec, isOpen, t.biome);
          if (isOpen) lastUnlocked = card;
          grid.appendChild(card);
        });
        const tier = el(this.doc, 'section', { class: 'tier', 'aria-label': `${ti + 1}층 ${t.biome.kr}` },
          el(this.doc, 'div', { class: 'tier__spine', 'aria-hidden': 'true' },
            el(this.doc, 'div', { class: 'tier__num' }, ROMAN[ti] ?? String(ti + 1)),
            el(this.doc, 'div', { class: 'tier__floor' }, `${ti + 1}층`)),
          el(this.doc, 'div', { class: 'tier__body' },
            el(this.doc, 'div', { class: 'tier__name' },
              el(this.doc, 'span', {}, t.biome.name),
              el(this.doc, 'b', {}, t.biome.kr),
              el(this.doc, 'small', {}, `${tierDone} / ${t.levels.length}`)),
            grid));
        tier.style.setProperty('--tier-c', t.biome.accent);
        tier.style.setProperty('--tier-a', t.biome.sky[0]);
        tier.style.setProperty('--tier-b', t.biome.sky[2]);
        tier.style.setProperty('--tier-d', t.biome.ridge[2]);
        host.appendChild(tier);
      });
      if (lastUnlocked) (lastUnlocked as HTMLElement).setAttribute('data-default', '');
      const prog = this.doc.getElementById('sel-progress');
      if (prog) prog.textContent = `${done} / ${levels.length} 구역 돌파 · ${unlocked.size} 해금`;
    }
    this.refreshTitle();
    this.renderDailyMine();
    if (this.screens.top === 'select') this.nav.refresh(this.screens.el('select'));
  }

  setDaily(daily: DailyResponse | null, lb: LeaderboardResponse | null, status: 'loading' | 'ok' | 'error'): void {
    this.daily = daily;
    this.dailyLb = lb;
    this.dailyStatus = status;
    this.dailyClock = 1; // repaint the countdown on the next frame
    this.renderDaily();
  }

  showResult(view: ResultView): void {
    this.result = view;
    const d = this.doc;
    const s = view.summary;
    const rank = d.getElementById('res-rank');
    if (rank) { rank.textContent = s.rank; rank.dataset.rank = s.rank; }
    const level = d.getElementById('res-level');
    if (level) level.textContent = view.levelName;
    const title = d.getElementById('res-title');
    if (title) title.textContent = s.cleared ? '구역 돌파' : '기록 종료';
    const rows = d.getElementById('res-rows');
    if (rows) {
      const list: HTMLElement[] = [
        this.resRow(view.personalBest ? '기록 · 신기록!' : '기록', fmtTime(s.time), view.personalBest),
        this.resRow('목표 시간', fmtTime(s.par)),
        this.resRow('파편', `${s.shards} / ${s.totalShards}`),
      ];
      if (s.totalRelics > 0) list.push(this.resRow('유물', `${s.relics} / ${s.totalRelics}`));
      list.push(this.resRow('쓰러진 횟수', String(s.deaths)));
      if (s.height > 0) list.push(this.resRow('도달 높이', String(Math.floor(s.height))));
      rows.replaceChildren(...list);
    }
    const stars = d.getElementById('res-stars');
    if (stars) {
      stars.replaceChildren();
      for (let i = 0; i < 3; i++) stars.appendChild(starSvg(d, view.stars > i));
      stars.setAttribute('aria-label', `별 ${view.stars} / 3`);
    }
    const next = d.querySelector<HTMLElement>('#scr-result [data-act="next"]');
    if (next) next.hidden = !view.nextLevelId;
    this.paintSubmission('res-submit', 'res-lb', view);
    this.show('result');
  }

  updateResult(view: ResultView): void {
    this.result = view;
    const top = this.screens.top;
    if (top === 'over' || this.screens.isActive('over')) this.paintSubmission('over-submit', 'over-lb', view);
    else this.paintSubmission('res-submit', 'res-lb', view);
  }

  showOver(summary: RunSummary, bestHeight: number): void {
    const d = this.doc;
    // Heights are whole tiles everywhere the player reads them, so compare
    // floors: a sub-tile climb that displays as 0 is never a record, and a
    // run that displays the same height as the best is a tie, not a record.
    const h = Math.max(0, Math.floor(summary.height));
    const prevBest = Math.max(0, Math.floor(bestHeight));
    const best = h > 0 && h > prevBest;
    const rows = d.getElementById('over-rows');
    if (rows) {
      rows.replaceChildren(
        this.resRow(best ? '도달 높이 · 신기록!' : '도달 높이', String(h), best),
        this.resRow('최고 높이', String(Math.max(prevBest, h))),
        this.resRow('파편', String(summary.shards)),
        this.resRow('버틴 시간', fmtTime(summary.time)),
      );
    }
    const submit = d.getElementById('over-submit');
    if (submit) submit.hidden = true;
    const lb = d.getElementById('over-lb');
    if (lb) { lb.hidden = true; lb.replaceChildren(); }
    this.show('over');
  }

  applySettings(s: Settings): void {
    // Rebuild only for a new settings object; the shell may re-apply on every
    // change, and replacing a slider mid-drag would break the drag.
    const rebuild = s !== this.settings || !this.settingsPanel.built;
    this.settings = s;
    if (rebuild) this.settingsPanel.build();
    else this.settingsPanel.sync();
    this.syncEcho();
  }

  setPortraitPainter(fn: PortraitPainter): void {
    this.portrait = fn;
    if (this.settings) this.settingsPanel.build();
  }

  // ================================================================ PWA surfaces
  /**
   * A new build is installed and waiting: show the "새 버전이 준비됐다 · 새로고침"
   * bar on every screen but play (the reload would kill the run). `apply`
   * switches workers; the page reloads on controllerchange.
   */
  showUpdate(apply: () => void): void {
    this.updateApply = apply;
    this.syncUpdateBar();
  }

  /** The browser offered a deferred install prompt: reveal "홈 화면에 추가" in the title menu. */
  setInstallable(on: boolean): void {
    const btn = this.doc.querySelector<HTMLElement>('#title-menu [data-act="install"]');
    if (!btn || btn.hidden === !on) return;
    btn.hidden = !on;
    if (this.screens.top === 'title') this.nav.refresh(this.screens.el('title'), true);
  }

  /** iOS Safari in a tab: point at 공유 → 홈 화면에 추가 (until dismissed). */
  setIosHint(on: boolean): void {
    this.iosHintWanted = on;
    const hint = this.doc.getElementById('ios-hint');
    if (hint) hint.hidden = !(on && !this.iosHintDismissed);
  }

  /** navigator.onLine mirror: the title badge and an `is-offline` class on #ui for styling. */
  setOffline(on: boolean): void {
    const badge = this.doc.getElementById('offline-badge');
    if (badge) badge.hidden = !on;
    this.doc.getElementById('ui')?.classList.toggle('is-offline', on);
  }

  private syncUpdateBar(): void {
    const bar = this.doc.getElementById('upbar');
    if (!bar) return;
    bar.hidden = !this.updateApply || this.screens.top === 'play';
  }

  private applyUpdate(): void {
    const apply = this.updateApply;
    if (!apply) return;
    this.updateApply = null;
    this.syncUpdateBar();
    this.sound('confirm');
    apply();
  }

  private dismissIosHint(): void {
    this.iosHintDismissed = true;
    this.writeFlag(IOS_HINT_DISMISSED_KEY);
    this.sound('cancel');
    this.setIosHint(this.iosHintWanted);
  }

  private readFlag(key: string): boolean {
    try { return this.win?.localStorage?.getItem(key) === '1'; } catch { return false; }
  }

  private writeFlag(key: string): void {
    try { this.win?.localStorage?.setItem(key, '1'); } catch { /* private mode / quota */ }
  }

  // ================================================================ emit / sound
  private emit(a: UIAction): void {
    for (const cb of this.listeners) cb(a);
  }

  private sound(n: UiSound): void {
    try { this.audio?.ui(n); } catch { /* audio is best-effort */ }
  }

  // ================================================================ screens
  private afterShow(): void {
    const top = this.screens.top;
    switch (top) {
      case 'title': this.refreshTitle(); break;
      case 'pause': this.fillPause(); break;
      case 'name': this.prepName(); break;
      case 'daily': this.renderDaily(); break;
      case 'settings': this.resetArmed = false; break;
      default: break;
    }
    this.updateTouchVisibility();
    this.syncUpdateBar();
    const root = top === 'play' || top === 'boot' ? null : this.screens.el(top);
    this.nav.refresh(root);
    if (top !== 'name' && this.doc.activeElement === this.nameInput()) this.nameInput()?.blur();
  }

  private pause(): void {
    if (this.screens.top !== 'play') return;
    this.sound('toggle');
    this.show('pause');
  }

  /** Back / Escape: pop a modal or return to the title; the shell hears `back` either way. */
  private goBack(): void {
    const top = this.screens.top;
    if (top === 'pause') { this.emit({ type: 'resume' }); return; }
    if (top === 'result' || top === 'over' || top === 'boot' || top === 'title' || top === 'play') return;
    this.sound('cancel');
    if (MODAL_SCREENS.has(top)) {
      this.screens.pop();
      this.afterShow();
    } else {
      this.show('title');
    }
    this.emit({ type: 'back' });
  }

  private confirm(target: HTMLElement): void {
    if (target.tagName === 'INPUT') return;
    target.click();
  }

  private cancel(): void { this.goBack(); }

  /** Left / right on a slider nudges it; anything else lets the cursor move. */
  private adjust(target: HTMLElement, dir: -1 | 1): boolean {
    if (target.tagName !== 'INPUT' || (target as HTMLInputElement).type !== 'range') return false;
    const input = target as HTMLInputElement;
    const step = Number(input.step) || 0.05;
    const min = Number(input.min) || 0;
    const max = Number(input.max) || 1;
    const v = Math.min(max, Math.max(min, (Number(input.value) || 0) + dir * step));
    input.value = String(Math.round(v * 1000) / 1000);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    this.sound('move');
    return true;
  }

  // ================================================================ clicks
  private wireClicks(): void {
    this.doc.addEventListener('click', (e) => {
      const t = e.target as Element | null;
      const btn = (t?.closest?.('[data-act]') ?? null) as HTMLElement | null;
      if (!btn || (btn as HTMLButtonElement).disabled) return;
      try { this.audio?.init(); } catch { /* first-gesture unlock is best-effort */ }
      this.onAct(btn.dataset.act ?? '', btn);
      // A pointer click leaves the button DOM-focused; drop that focus so the
      // menu cursor stays the only thing Enter / Space can activate.
      try { btn.blur(); } catch { /* detached or non-focusable */ }
    });
    this.doc.addEventListener('pointerenter', (e) => {
      const t = e.target as Element | null;
      const n = (t?.closest?.(HOVER_SELECTOR) ?? null) as HTMLElement | null;
      if (n) this.nav.hover(n);
    }, true);
    // Tab users: the cursor follows DOM focus onto any navigable element.
    this.doc.addEventListener('focusin', (e) => {
      const t = e.target as Element | null;
      if (t && this.nav.els.includes(t as HTMLElement)) this.nav.hover(t);
    });
  }

  private onAct(act: string, btn: HTMLElement): void {
    switch (act) {
      case 'start': {
        const id = btn.dataset.id;
        if (id) { this.sound('confirm'); this.emit({ type: 'start', levelId: id }); }
        break;
      }
      case 'continue': {
        const id = this.progress?.lastLevel;
        if (id) { this.sound('confirm'); this.emit({ type: 'start', levelId: id }); }
        break;
      }
      case 'daily': this.sound('confirm'); this.emit({ type: 'daily' }); break;
      case 'endless': this.sound('confirm'); this.emit({ type: 'endless' }); break;
      case 'resume': this.sound('cancel'); this.emit({ type: 'resume' }); break;
      case 'restart': this.sound('confirm'); this.emit({ type: 'restart' }); break;
      case 'quit': this.sound('cancel'); this.emit({ type: 'quit' }); break;
      case 'next': this.sound('confirm'); this.emit({ type: 'next' }); break;
      case 'retry': this.sound('confirm'); this.emit({ type: 'retry' }); break;
      case 'openSelect': this.sound('confirm'); this.show('select'); this.emit({ type: 'openSelect' }); break;
      case 'openDaily': this.sound('confirm'); this.show('daily'); this.emit({ type: 'openDaily' }); break;
      case 'openSettings': this.sound('confirm'); this.show('settings'); this.emit({ type: 'openSettings' }); break;
      case 'openCredits': this.sound('confirm'); this.show('credits'); this.emit({ type: 'openCredits' }); break;
      case 'back':
      case 'close': this.goBack(); break;
      case 'pause': this.pause(); break;
      case 'name': this.sound('confirm'); this.show('name'); break;
      case 'nameOk': this.submitName(); break;
      case 'refreshLb': {
        if (!this.daily) break;
        this.sound('confirm');
        this.setDaily(this.daily, this.dailyLb, 'loading');
        this.emit({ type: 'requestLeaderboard', mode: 'daily', board: this.daily.date });
        break;
      }
      case 'resetProgress': this.resetProgress(btn); break;
      case 'dismissNag': this.dismissNag(); break;
      case 'install':
        this.sound('confirm');
        try { this.onInstall?.(); } catch { /* the prompt is best-effort */ }
        break;
      case 'dismissIos': this.dismissIosHint(); break;
      case 'applyUpdate': this.applyUpdate(); break;
      default: break;
    }
  }

  /** Two presses within the same visit to the settings screen. */
  private resetProgress(btn: HTMLElement): void {
    if (!this.resetArmed) {
      this.resetArmed = true;
      btn.classList.add('bindbtn--armed');
      btn.textContent = '정말?';
      this.sound('error');
      return;
    }
    this.resetArmed = false;
    btn.classList.remove('bindbtn--armed');
    btn.textContent = 'DONE';
    this.sound('cancel');
    this.emit({ type: 'resetProgress' });
  }

  private wireTabs(): void {
    const tabs = [...this.doc.querySelectorAll<HTMLElement>('#set-tabs .tab')];
    for (const tab of tabs) {
      tab.addEventListener('click', () => {
        for (const t of tabs) {
          const on = t === tab;
          t.classList.toggle('is-active', on);
          t.setAttribute('aria-selected', String(on));
        }
        for (const p of this.doc.querySelectorAll<HTMLElement>('#scr-settings .pane')) {
          p.classList.toggle('is-active', p.dataset.pane === tab.dataset.tab);
        }
        this.sound('move');
        this.nav.refresh(this.screens.el('settings'), true);
      });
    }
  }

  private wireLifecycle(): void {
    const win = this.win;
    this.doc.addEventListener('visibilitychange', () => { if (this.doc.hidden) this.pause(); });
    if (!win) return;
    win.addEventListener('blur', () => this.pause());
    // The rotate prompt is re-evaluated only when the device actually turns —
    // a resize from the soft keyboard or the URL bar must not flash it.
    const recheck = (): void => { win.setTimeout(() => this.updateNag(), 120); };
    win.addEventListener('orientationchange', recheck);
    try { win.screen?.orientation?.addEventListener?.('change', recheck); } catch { /* no Screen Orientation API */ }
  }

  private updateTouchVisibility(): void {
    this.touchCtl.setVisible(this.touchCtl.coarse && this.screens.top === 'play');
    this.doc.getElementById('ui')?.classList.toggle('is-touch', this.touchCtl.coarse);
  }

  /**
   * Ask a phone held upright to turn: the world is 16:9 and the pad would cover
   * it. Tablets are left alone (an upright iPad plays letterboxed). Dismissable —
   * "그래도 계속" hides it for the rest of the session.
   */
  private updateNag(): void {
    const nag = this.doc.getElementById('nag-rotate');
    if (!nag) return;
    nag.hidden = this.nagDismissed || !(this.touchCtl.coarse && wantsRotatePrompt(this.win));
  }

  private dismissNag(): void {
    this.nagDismissed = true;
    try { this.win?.sessionStorage?.setItem(NAG_DISMISSED_KEY, '1'); } catch { /* private mode / quota */ }
    this.sound('cancel');
    this.updateNag();
  }

  private readNagDismissed(): boolean {
    try { return this.win?.sessionStorage?.getItem(NAG_DISMISSED_KEY) === '1'; } catch { return false; }
  }

  // ================================================================ title
  private refreshTitle(): void {
    const cont = this.doc.querySelector<HTMLElement>('#title-menu [data-act="continue"]');
    const note = this.doc.getElementById('continue-note');
    const last = this.progress?.lastLevel;
    const lv = last ? this.levels.find((l) => l.id === last) : undefined;
    if (cont) {
      cont.hidden = !lv;
      if (lv && note) note.textContent = `${BIOMES[lv.biome].kr} · ${lv.name}`;
    }
    const chip = this.doc.getElementById('title-name');
    if (chip) chip.textContent = this.playerName || '—';
    if (this.screens.top === 'title') this.nav.refresh(this.screens.el('title'), true);
  }

  // ================================================================ select
  private card(lv: LevelDef, idx: number, rec: Progress['levels'][string] | undefined, unlocked: boolean, biome: Biome): HTMLButtonElement {
    const d = this.doc;
    const card = el(d, 'button', {
      class: 'card', type: 'button', 'data-act': 'start', 'data-id': lv.id,
      'aria-label': `${lv.name}${unlocked ? '' : ' (잠김)'}`,
    });
    if (!unlocked) { card.disabled = true; card.setAttribute('aria-disabled', 'true'); }
    card.append(el(d, 'div', { class: 'card__sky' }), el(d, 'div', { class: 'card__ridge' }));
    const stars = el(d, 'div', { class: 'card__stars' });
    for (let s = 0; s < 3; s++) stars.appendChild(starSvg(d, (rec?.stars ?? 0) > s));
    const meta = el(d, 'div', { class: 'card__meta' },
      el(d, 'span', {}, rec?.bestTicks ? fmtTicks(rec.bestTicks) : '—:——.——'),
      el(d, 'span', { class: 'shards' }, String(rec?.bestShards ?? 0)),
      rec?.relics ? el(d, 'span', { class: 'relic' }, '유물') : null,
      el(d, 'span', {}, `목표 ${fmtTime(lv.par).slice(0, -3)}`),
    );
    card.append(stars, el(d, 'div', { class: 'card__body' },
      el(d, 'div', { class: 'card__idx' }, `${biome.name} · ${String(idx + 1).padStart(2, '0')}`),
      el(d, 'div', { class: 'card__title' }, lv.name),
      meta));
    if (!unlocked) card.appendChild(el(d, 'div', { class: 'card__lock' }, lockSvg(d), el(d, 'span', {}, '잠김')));
    return card;
  }

  // ================================================================ echoes
  private buildEchoToggles(): void {
    for (const hostId of ['sel-echoes', 'daily-echoes']) {
      const host = this.doc.getElementById(hostId);
      if (!host) continue;
      host.replaceChildren(this.echoToggle('self', '내 메아리'), this.echoToggle('world', '세계 메아리'));
    }
  }

  private echoToggle(which: 'self' | 'world', label: string): HTMLButtonElement {
    const b = el(this.doc, 'button', {
      class: `echo echo--${which}`, type: 'button', role: 'switch', 'data-echo': which, 'aria-checked': 'false',
    }, label);
    b.addEventListener('click', () => {
      if (!this.settings) return;
      const key = which === 'self' ? 'echoSelf' : 'echoWorld';
      const on = !this.settings[key];
      this.settings[key] = on;
      this.syncEcho();
      this.sound('toggle');
      this.emit({ type: 'toggleEcho', which, on });
    });
    return b;
  }

  private syncEcho(): void {
    const s = this.settings;
    for (const b of this.doc.querySelectorAll<HTMLElement>('[data-echo]')) {
      const on = s ? (b.dataset.echo === 'self' ? s.echoSelf : s.echoWorld) : false;
      b.setAttribute('aria-checked', String(!!on));
    }
  }

  // ================================================================ pause / result rows
  private fillPause(): void {
    const stats = this.doc.getElementById('pause-stats');
    if (!stats) return;
    const h = this.lastHud;
    const stat = (v: string, label: string) => el(this.doc, 'div', {}, el(this.doc, 'b', {}, v), label);
    stats.replaceChildren(
      stat(fmtTime(h?.time ?? 0), '경과'),
      stat(`${h?.shards ?? 0}/${h?.totalShards ?? 0}`, '파편'),
      stat(String(h?.hp ?? 0), '체력'),
    );
  }

  private resRow(label: string, value: string, best = false): HTMLElement {
    return el(this.doc, 'div', { class: best ? 'res__row best' : 'res__row' },
      el(this.doc, 'span', {}, label), el(this.doc, 'b', {}, value));
  }

  /** 전송 중… / 세계 N위 / 거절됨: 이유 / 오프라인, plus the board when the server sent one. */
  private paintSubmission(submitId: string, lbId: string, view: ResultView): void {
    const d = this.doc;
    const submit = d.getElementById(submitId);
    const sub = view.submit;
    if (submit) {
      submit.className = `submit submit--${sub.state}`;
      submit.replaceChildren();
      switch (sub.state) {
        case 'pending': submit.append('전송 중… 서버가 기록을 다시 재생한다'); break;
        case 'accepted': {
          const total = sub.total ? ` / ${sub.total.toLocaleString('ko-KR')}명` : '';
          submit.append('세계 ', el(d, 'b', {}, `${sub.rank ?? '—'}위`), total, ' · 검증 완료');
          break;
        }
        case 'rejected': submit.append(`거절됨: ${reasonKr(sub.reason)}`); break;
        case 'offline': submit.append('오프라인 · 기록은 이 기기에만 남는다'); break;
        case 'queued': submit.append('오프라인 · 온라인이 되면 보낸다'); break;
        default: break;
      }
      submit.hidden = sub.state === 'idle';
    }
    const lbHost = d.getElementById(lbId);
    if (lbHost) {
      const lb = view.leaderboard ?? null;
      if (lb) {
        lbHost.hidden = false;
        renderLeaderboard(lbHost, lb, { status: 'ok', limit: 3 });
      } else {
        lbHost.hidden = true;
        lbHost.replaceChildren();
      }
    }
  }

  // ================================================================ daily
  private renderDaily(): void {
    const d = this.doc;
    const date = d.getElementById('daily-date');
    const seed = d.getElementById('daily-seed');
    const status = d.getElementById('daily-status');
    const daily = this.daily;
    if (date) {
      // No seed at all: the daily cannot start. With a cached seed the date shows and the board reads offline.
      date.textContent = daily ? fmtDateKr(daily.date) : this.dailyStatus === 'error' ? '오프라인 · 오늘의 시드를 아직 받지 못했다' : '오늘의 탑을 받는 중…';
    }
    if (seed) seed.textContent = daily ? daily.seed.toString(16).toUpperCase().padStart(8, '0') : '—';
    if (status) {
      status.textContent = this.dailyStatus === 'loading' ? '불러오는 중…' : this.dailyStatus === 'error' ? (daily ? '오프라인 · 저장된 시드' : '오프라인') : '';
    }
    const start = d.querySelector<HTMLButtonElement>('#scr-daily [data-act="daily"]');
    if (start) start.disabled = !daily;
    this.renderDailyMine();
    this.renderDailyExpires();
    const host = d.getElementById('daily-lb');
    if (host) renderLeaderboard(host, this.dailyLb, { status: this.dailyStatus });
    if (this.screens.top === 'daily') this.nav.refresh(this.screens.el('daily'), true);
  }

  private renderDailyMine(): void {
    const mine = this.doc.getElementById('daily-mine');
    if (!mine) return;
    const rec = this.daily ? this.progress?.daily[this.daily.date] : undefined;
    if (!rec) { mine.textContent = '—'; return; }
    mine.textContent = rec.cleared ? fmtTicks(rec.bestTicks) : `높이 ${Math.floor(rec.height)}`;
  }

  private renderDailyExpires(): void {
    const exp = this.doc.getElementById('daily-expires');
    if (!exp) return;
    if (!this.daily) { exp.textContent = '—'; return; }
    const ms = Date.parse(this.daily.expiresAt) - this.now();
    exp.textContent = Number.isFinite(ms) ? fmtCountdown(ms) : '—';
  }

  private tickDaily(dt: number): void {
    if (this.screens.top !== 'daily' || !this.daily) return;
    this.dailyClock += dt;
    if (this.dailyClock >= 1) {
      this.dailyClock = 0;
      this.renderDailyExpires();
    }
  }

  // ================================================================ name
  private nameInput(): HTMLInputElement | null {
    return this.doc.getElementById('name-input') as HTMLInputElement | null;
  }

  private wireName(): void {
    const input = this.nameInput();
    const form = this.doc.getElementById('name-form');
    const count = this.doc.getElementById('name-count');
    if (!input) return;
    // The input layer ignores keys typed into editable elements, so gameplay
    // keys (WASD, Space…) are already safe here and the event may bubble.
    // Native Enter submits the form; Escape closes the dialog.
    input.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' || e.key === 'Escape') {
        e.preventDefault();
        this.goBack();
      }
    });
    input.addEventListener('input', () => {
      if (count) count.textContent = `${input.value.trim().length} / ${NAME_MAX}`;
      const err = this.doc.getElementById('name-err');
      if (err) err.hidden = true;
    });
    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.submitName();
    });
  }

  private prepName(): void {
    const input = this.nameInput();
    if (!input) return;
    input.value = this.playerName;
    const count = this.doc.getElementById('name-count');
    if (count) count.textContent = `${input.value.length} / ${NAME_MAX}`;
    const err = this.doc.getElementById('name-err');
    if (err) err.hidden = true;
    try { input.focus(); input.select?.(); } catch { /* focus is best-effort */ }
  }

  private submitName(): void {
    if (this.screens.top !== 'name') return;
    const input = this.nameInput();
    if (!input) return;
    const raw = input.value;
    const problem = validateName(raw);
    const err = this.doc.getElementById('name-err');
    if (problem) {
      if (err) { err.textContent = problem; err.hidden = false; }
      this.sound('error');
      return;
    }
    const name = raw.trim();
    this.playerName = name;
    if (this.progress) this.progress.player.name = name;
    this.sound('confirm');
    this.emit({ type: 'setName', name });
    this.screens.pop();
    this.afterShow();
    this.refreshTitle();
  }

  // ================================================================ credits
  private buildCredits(): void {
    const body = this.doc.getElementById('credits-body');
    if (!body) return;
    // Static, author-written markup: no user data, no style attributes (CSP).
    body.innerHTML = `
      <h3>메아리</h3>
      <ul>
        <li>시뮬레이션은 1/120초마다 <b>입력 마스크 1바이트</b>를 먹는 결정론적 엔진. 같은 코드가 브라우저와 서버에서 함께 돈다.</li>
        <li>구역을 돌파하면 입력 기록만 서버로 보낸다. 서버는 기록을 <b>처음부터 다시 재생</b>해 시간·파편·완주를 확인한 뒤에야 순위표에 올린다.</li>
        <li>내 최고 기록과 세계 최고 기록은 <b>메아리</b>로 함께 달린다 — 두 번째 시뮬레이션이 같은 틱에 같은 입력을 재생한다.</li>
        <li>데일리 타워의 시드는 서버가 날짜에서 만든다. 하루 동안 모두가 같은 탑을 오른다.</li>
      </ul>
      <h3>설계</h3>
      <ul>
        <li>월드는 <code>&lt;canvas&gt;</code>, 읽는 모든 글자는 DOM — 어떤 해상도에서도 선명하고 스크린리더가 읽는다.</li>
        <li>캐릭터는 스프라이트 시트가 아니라 <b>절차적 리그</b>. 착지 스쿼시, 도약 스트레치가 물리값에서 직접 나온다.</li>
        <li>발광체는 1/4 해상도 버퍼에 그린 뒤 블러·가산 합성. 지형은 보이는 타일을 하나의 <code>Path2D</code>로 병합해 한 번에 칠한다.</li>
        <li>결정론을 위해 <code>sin</code>·<code>cos</code>·<code>pow</code> 대신 다항 근사만 쓴다. IEEE-754가 비트 단위로 보장하는 연산만 남겼다.</li>
      </ul>
      <h3>감각</h3>
      <ul>
        <li>코요테 타임 · 점프 버퍼 · 가변 점프 높이 · 정점 중력 완화 · 모서리 보정</li>
        <li>8방향 대시 · 대시 결정 (공중 재충전) · 스위치 블록 · 벽 슬라이드 / 벽 점프 · 스톰프</li>
        <li>차오르는 조류 — 데일리 타워와 끝없는 등반에서는 멈추면 잠긴다</li>
      </ul>
      <h3>사운드</h3>
      <ul>
        <li>게임 에셋 0바이트. 모든 효과음과 음악이 <code>WebAudio</code>로 실시간 합성된다. 외부에서 받는 것은 UI 서체뿐이다.</li>
        <li>층마다 조성·모드·템포가 다르고, 위협에 따라 편성 밀도가 변한다.</li>
      </ul>
      <h3>인프라</h3>
      <ul>
        <li>CloudFront → (CloudFront 프리픽스 리스트만 여는 보안 그룹) ALB → ECS Fargate (Graviton) → DynamoDB.</li>
        <li>ALB는 CloudFront가 붙여 주는 비밀 헤더가 맞을 때만 응답한다. 에셋은 해시 이름으로 1년 캐시.</li>
      </ul>
      <h3>조작</h3>
      <ul>
        <li>키보드 · 게임패드 · 터치 모두 같은 액션 레이어로 들어온다. 메뉴 커서도 하나다.</li>
        <li>모든 키 재지정 가능 · 보조 모드 · 섬광 억제 · <code>prefers-reduced-motion</code> 반영</li>
      </ul>
      <p class="build">CLAWD JUMP: ECHO TOWER · MIT · Clawd Jump (Azure Ascent)의 후속작</p>`;
  }
}
