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
  AudioPort, Binds, Device, HudState, InputPort, MenuAction, Progress, ResultView, Screen, Settings, TouchState,
  UIAction, UIPort, UiSound,
} from '../contracts.js';
import type { LevelDef, RunSummary } from '../../sim/types.js';
import type { DailyResponse, LeaderboardResponse, RejectReason } from '../../shared/protocol.js';
import type { Biome } from '../../shared/biomes.js';
import { BIOMES, BIOME_ORDER } from '../../shared/biomes.js';
import { DEFAULT_BINDS } from '../input/binds.js';
import {
  MS_PER_DAY, bestRankOf, isMuted, streakFor, toggleMute, touchLayout, unlockedZones, utcDateStr, worldRankOf, type TouchLayout,
} from '../save.js';
import { skinAvailable, skinHint, totalsText, worldRankText } from '../unlocks.js';
import { fmtVersus } from '../echo/rival.js';
import {
  LEAVE_MS, MODAL_SCREENS, Navigator, ScreenStack, el, lockSvg, replay, starSvg, validateName, NAME_MAX,
} from './screens.js';
import { Hud, fmtTicks, fmtTime } from './hud.js';
import { renderHint } from './hints.js';
import { SettingsPanel, type PortraitPainter } from './settings.js';
import { TRANSFER_KR, TransferPanel, normalizeCode, type TransferStatusKind } from './transfer.js';
import { TouchControls, wantsRotatePrompt } from './touch.js';
import { renderLeaderboard, type LbStatus } from './leaderboard.js';
import {
  CLEAR_TIMELINE, MEDAL_KR, MEDAL_ORDER, SUMMIT, TITLE_HOOK, Timeline, drawEndingSky, endingTimeline, endingView, medalsOf, prefersReducedMotion,
  tierCardView, tierTimeline,
  type ClearStage, type EndingStage, type EndingView, type TierCardView, type TierStage,
} from './ceremony.js';
import type { StingerKind } from '../audio/sfx.js';
import { isShotHarness } from '../pwa.js';

/** Seconds the restart bind must stay held during play to restart the whole zone (a tap is a checkpoint retry inside the sim). */
export const RESTART_HOLD_S = 0.6;
/** The HUD's top-right block (CSS px from the canvas's top-right corner) where the zone name sits; the goal under it hides the name. */
export const HUD_TOPRIGHT_W = 220;
export const HUD_TOPRIGHT_H = 90;
/** The virtual pad hides while a gamepad was used within the last this many seconds; any touch brings it back (P3-7). */
export const GAMEPAD_HIDE_S = 2;
/** Seconds the pad stays previewed over the settings after a touch layout change (P3-7). */
export const TOUCH_PREVIEW_S = 1.2;
/** HUD mute chip copy (aria labels). */
export const MUTE_KR = { mute: '소리 끄기', unmute: '소리 켜기' } as const;
/** Install card copy (P3-4): the prompt variant and the iOS share-sheet variant. */
export const INSTALL_CARD_KR = {
  prompt: '홈 화면에 추가하면 오프라인에서도 바로 이어진다',
  ios: '공유 → 홈 화면에 추가 하면 오프라인에서도 바로 이어진다',
} as const;

/** UI sounds, the first-gesture unlock and — when the engine offers them — the ceremony stingers (P3-9). */
export interface UiAudio extends Pick<AudioPort, 'ui' | 'init'> {
  stinger?(kind: StingerKind, idx?: number): void;
}

export interface UIOptions {
  /** Defaults to the global document. */
  document?: Document;
  /** The input layer; also picked up from every `frame()` call. */
  input?: InputPort | null;
  /** UI sounds and the first-gesture AudioContext unlock. */
  audio?: UiAudio | null;
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
  /** Reload the page (the update bar's button when no service worker switch is pending). Default: location.reload(). */
  reload?: () => void;
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
  'sim-version': '새 버전이 나왔다. 새로고침 후 다시 도전한다',
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

/** Yesterday's tower as the shell reports it (see Scenes.loadYesterday): date, seed (null = not climbable) and its board. */
export interface YesterdayView {
  date: string;
  seed: number | null;
  lb: LeaderboardResponse | null;
}

/** One checkpoint segment of the current run as the shell reports it (see Scenes.segmentRows): deaths this session, best ticks on this install. */
export interface SegmentView {
  idx: number;
  deaths: number;
  best: number | null;
  current: boolean;
}

/** How the finished run compares with the world echo it raced: our ticks − theirs (negative = faster). */
export interface VersusView {
  /** '라이벌' or '1위'. */
  label: string;
  deltaTicks: number;
}

/** What a clear adds to the result beyond its summary (P3-6, see Scenes.ClearExtras): fresh medals and the longest combo. */
export interface ClearExtrasView {
  newMedals: readonly string[];
  combo: number;
  comboRecord: boolean;
}

/** Result-line copy for a run kept in the queue: offline, or the server asked for a retry (503 busy / 429). */
export const QUEUED_KR = {
  offline: '오프라인 · 온라인이 되면 보낸다',
  busy: '서버가 붐빈다 · 잠시 후 자동으로 다시 보낸다',
} as const;

/** The inline name prompt while it is open on the result / game-over modal. */
interface InlineName {
  root: HTMLElement;
  input: HTMLInputElement;
  err: HTMLElement;
  /** The modal it was inserted into; leaving that screen is a skip. */
  screen: Screen;
  resolve: (name: string | null) => void;
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
  /** 다른 기기로 옮기기 widgets of the data pane (P3-5). */
  private readonly transferPanel: TransferPanel;
  private readonly touchCtl: TouchControls;
  private readonly audio: UiAudio | null;
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
  private yesterday: YesterdayView | null = null;
  /** Pause-screen segment rows (deaths · best per checkpoint segment), as the shell last reported them. */
  private segRows: SegmentView[] | null = null;
  /** The result screen's 라이벌보다 row, as the shell last set it (null = no world echo was raced). */
  private versus: VersusView | null = null;
  /** The clear's fresh medals and longest combo (P3-6), as the shell last set them before showResult. */
  private clearExtras: ClearExtrasView | null = null;
  /** The inline name prompt, while open. */
  private inlineName: InlineName | null = null;
  /** Whole-tile best height the game-over screen shows (rewritten with the world best when the board arrives). */
  private overBest = 0;
  private portrait: PortraitPainter | null = null;
  private resetArmed = false;
  private playerName = '';
  private nagDismissed = false;
  private iosHintWanted = false;
  private iosHintDismissed = false;
  /** The browser holds a deferred install prompt (setInstallable) — the install card's 설치 variant (P3-4). */
  private installable = false;
  /** The shell allows the install card on the current result (ShellUI.installCard). */
  private installCardOn = false;
  /** Set by showUpdate(); the bar stays until the player applies the update. */
  private updateApply: (() => void) | null = null;
  /** The server runs a newer sim than this bundle (setVersionBehind): the bar is urgent and reloads even without a waiting worker. */
  private versionBehind = false;
  private readonly reload: () => void;
  /** The data notice (#scr-data) is an overlay on top of the modal stack; true while it is open. */
  private dataOpen = false;
  /** The hint template on screen (tokens unresolved) and the device it was rendered for. */
  private hintTemplate: string | null = null;
  private hintDevice: Device | null = null;
  /** Seconds the restart bind has been held during play, and whether this hold already restarted. */
  private restartHold = 0;
  private restartFired = false;
  /** Zones opened by the latest clear: their cards animate and the unlock sound plays when select comes up. */
  private unlocking = new Set<string>();
  private unlockSoundPending = false;
  /** What the title's first entry starts: the last zone, or the first zone on a fresh save. */
  private continueId: string | null = null;
  /** Seconds left of the gamepad auto-hide of the virtual pad (P3-7); 0 = not hiding. */
  private gamepadHideT = 0;
  /** Seconds left of the touch layout preview over the settings (P3-7); 0 = none. */
  private previewT = 0;
  /** Whether the pad was last shown / previewed, so frame() only touches the DOM on a change. */
  private padShown = false;
  private padPreview = false;
  /** The result modal's staged reveal (P3-9) while it runs. */
  private clearCeremony: Timeline<ClearStage> | null = null;
  /** The 층 돌파 card while it is up, and the shell's callback for when it ends. */
  private tierTimeline: Timeline<TierStage> | null = null;
  private tierDone: (() => void) | null = null;
  /** The ending overlay while it is up: its reveal, the sky clock and the redraw accumulator. */
  private endingOpen = false;
  private endingTimeline: Timeline<EndingStage> | null = null;
  private endingT = 0;
  private endingAcc = 0;

  constructor(opts: UIOptions = {}) {
    this.doc = opts.document ?? document;
    this.win = this.doc.defaultView ?? null;
    this.input = opts.input ?? null;
    this.audio = opts.audio ?? null;
    this.skins = opts.skins ?? {};
    this.defaultBinds = opts.defaultBinds ?? DEFAULT_BINDS;
    this.now = opts.now ?? (() => Date.now());
    this.onInstall = opts.onInstall ?? null;
    this.reload = opts.reload ?? (() => { try { this.win?.location.reload(); } catch { /* unloading */ } });
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
    this.transferPanel = new TransferPanel({ doc: this.doc, sound: (n) => this.sound(n), onSubmit: () => this.importTransfer() });
    this.settingsPanel = new SettingsPanel({
      doc: this.doc,
      settings: () => this.settings,
      extraDataRows: () => this.transferPanel.rows(),
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
      onTouchLayout: (layout) => this.previewTouchLayout(layout),
      // Skin locks (P3-6): the rules over the current save; the selected skin is always available (grandfathering).
      skinLocked: (id) => (skinAvailable(id, this.progress, this.settings, this.levels) ? null : skinHint(id) ?? '잠김'),
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

  get screen(): Screen {
    if (this.dataOpen) return 'data';
    const top = this.screens.top;
    // The ending overlay stands in for the last zone's result (Screen has no name of its own for it, P3-9).
    if (this.endingOpen && !MODAL_SCREENS.has(top)) return 'result';
    return top;
  }

  show(screen: Screen): void {
    // The data notice lives outside the screen stack (ScreenStack does not
    // register it): it is an overlay opened here and closed by any other show().
    if (screen === 'data') { this.openData(); return; }
    // QA only: the `?shot=title&ui=tier|ending` harness previews the ceremony surfaces with sample data (Screen has no names for them).
    if ((screen as string) === 'tier' || (screen as string) === 'ending') { this.previewCeremony(screen as unknown as 'tier' | 'ending'); return; }
    if (this.dataOpen) this.closeData();
    // A base screen ends the ceremony overlays (P3-9); a modal — the credits over the ending — stacks above them.
    if (!MODAL_SCREENS.has(screen)) { this.closeEnding(); this.endTierCard(); }
    if (screen !== 'result') this.clearCeremony = null;
    const baseChanged = this.screens.show(screen);
    if (screen === 'play' && baseChanged) { this.hudCtl.reset(); this.hintTemplate = null; }
    this.restartHold = 0;
    this.restartFired = false;
    this.afterShow();
  }

  frame(dt: number, input: InputPort): void {
    this.input = input;
    // A long frame (tab switch) simply expires toasts and reopens the live region.
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    this.hudCtl.frame(step);
    this.tickDaily(step);
    this.tickTouchVisibility(step, input);

    const edges = input.takeMenu();
    const actions = new Set<MenuAction>(edges);
    if (this.settingsPanel.capturing) return;
    const top = this.screens.top;
    if (top === 'boot') return;
    // Ceremony overlays (P3-9) own the frame: the tier card skips on any edge; the ending reveal skips, then its menu takes the edges.
    if (this.tierTimeline) { this.tickTierCard(step, edges.length > 0); return; }
    if (this.endingOpen && !MODAL_SCREENS.has(top)) { this.tickEnding(step, edges, input); return; }
    if (this.clearCeremony) this.tickClearCeremony(step, top);
    // The inline name field has focus: Enter confirms, Escape skips, up / down leave the field for the buttons.
    const inline = this.inlineName;
    if (inline && this.doc.activeElement === inline.input) {
      if (actions.has('confirm')) { this.confirmInlineName(); return; }
      if (actions.has('cancel')) { this.skipInlineName(); return; }
      if (actions.has('up') || actions.has('down')) { try { inline.input.blur(); } catch { /* best-effort */ } }
      else return;
    }
    if (top === 'play') {
      if (this.hintTemplate !== null && input.lastDevice !== this.hintDevice) this.paintHint();
      if (actions.has('pause')) { this.pause(); return; }
      // A tap of the restart bind is IN.RETRY inside the sim (instant checkpoint
      // retry, recorded in the replay); only a hold restarts the whole zone, once.
      if (input.menuHeld('restart')) {
        // A stalled frame (tab switch) must not count as a long hold.
        this.restartHold += Math.min(step, 0.5);
        if (this.restartHold >= RESTART_HOLD_S && !this.restartFired) {
          this.restartFired = true;
          this.sound('confirm');
          this.emit({ type: 'restart' });
        }
      } else {
        this.restartHold = 0;
        this.restartFired = false;
      }
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
    // The result reveal still running: the first press completes it instead of acting on a menu that is not up yet.
    if (this.clearCeremony && top === 'result' && edges.length) { this.skipClearCeremony(); return; }
    this.nav.update(step, edges, input);
  }

  // ================================================================ ceremonies (P3-9)
  /** The result reveal's current stage, or null while none runs (tests). */
  get clearStage(): ClearStage | null { return this.clearCeremony?.stage ?? null; }
  /** The 층 돌파 card is up. */
  get tierCardOpen(): boolean { return this.tierTimeline !== null; }
  /** The ending overlay is up. */
  get endingShown(): boolean { return this.endingOpen; }

  /** Reduced motion, or the capture harness (no frames run there): every timeline jumps straight to its end. */
  private instantMotion(): boolean {
    return prefersReducedMotion(this.win) || isShotHarness(this.win);
  }

  /**
   * The record's medals as chips (hidden without any); the reveal shows the row
   * at its 'medals' stage. The ones this clear just earned (setClearExtras) carry
   * `is-new`: they pop and the unlock sound plays with their stage.
   */
  private paintMedals(view: ResultView): void {
    const host = this.doc.getElementById('res-medals');
    if (!host) return;
    const medals = medalsOf(this.progress?.levels[view.summary.levelId]);
    const fresh = new Set(this.clearExtras?.newMedals ?? []);
    host.replaceChildren(...medals.map((m) => el(this.doc, 'span', {
      class: `medal medal--${m}${fresh.has(m) ? ' is-new' : ''}`, role: 'listitem',
      'aria-label': fresh.has(m) ? `${MEDAL_KR[m]} · 새 메달` : MEDAL_KR[m],
    }, MEDAL_KR[m])));
    host.hidden = medals.length === 0;
  }

  /** Start the staged reveal of the result modal: rank → stars → medals → board (data-stage on the modal drives the CSS). */
  private startClearCeremony(): void {
    const modal = this.doc.querySelector<HTMLElement>('#scr-result .modal');
    if (!modal) return;
    const tl = new Timeline(CLEAR_TIMELINE, (stage) => this.applyClearStage(modal, stage), this.instantMotion());
    this.clearCeremony = tl;
    tl.start();
    if (tl.done) this.clearCeremony = null;
  }

  private applyClearStage(modal: HTMLElement, stage: ClearStage): void {
    modal.dataset.stage = stage;
    if (stage === 'stars') {
      const n = this.result?.stars ?? 0;
      for (let i = 0; i < n; i++) this.audio?.stinger?.('star', i);
    } else if (stage === 'medals') {
      const medals = this.doc.getElementById('res-medals');
      if (medals && !medals.hidden) {
        this.audio?.stinger?.('medal');
        // a medal earned by this very clear: the unlock chime on top of the landing
        if (medals.querySelector('.medal.is-new')) this.sound('unlock');
      }
    }
  }

  private tickClearCeremony(step: number, top: Screen): void {
    const tl = this.clearCeremony;
    if (!tl) return;
    if (top !== 'result') { this.clearCeremony = null; return; }
    tl.update(step);
    if (tl.done) this.clearCeremony = null;
  }

  private skipClearCeremony(): void {
    const tl = this.clearCeremony;
    if (!tl) return;
    tl.skip();
    this.clearCeremony = null;
  }

  /**
   * 층 돌파: the vista card for a completed tier, over the finished run. Ends
   * on its own after TIER_CARD_S or on any key / tap; `done` fires exactly once
   * either way (also when a base screen replaces the card). Not part of UIPort.
   */
  tierBreak(card: TierCardView, done: () => void, opts: { hold?: boolean } = {}): void {
    this.endTierCard();
    const sec = this.doc.getElementById('scr-tier');
    if (!sec) { done(); return; }
    const d = this.doc;
    const set = (id: string, text: string): void => { const e = d.getElementById(id); if (e) e.textContent = text; };
    set('tier-num', card.roman);
    set('tier-floor', `${card.floor}층`);
    set('tier-name', card.kr);
    set('tier-line', card.line);
    set('tier-next', card.next);
    sec.style.setProperty('--tier-a', card.sky[0]);
    sec.style.setProperty('--tier-b', card.sky[2]);
    sec.style.setProperty('--tier-d', card.ridge);
    sec.style.setProperty('--tier-c', card.accent);
    delete sec.dataset.stage;
    sec.classList.remove('is-leaving');
    sec.classList.add('is-active');
    this.tierDone = done;
    // `hold` (the QA preview): everything is up at once and the card never dismisses itself — only a key or a tap ends it.
    const steps = opts.hold ? tierTimeline(true).filter((s) => s.stage !== 'out' && s.stage !== 'done') : tierTimeline(prefersReducedMotion(this.win));
    const tl = new Timeline(steps, (stage) => {
      sec.dataset.stage = stage;
      if (stage === 'done') this.endTierCard();
    }, !opts.hold && isShotHarness(this.win));
    this.tierTimeline = tl;
    this.nav.refresh(null);
    this.updateTouchVisibility();
    // the 'done' stage (also what an instant start jumps to) ends the card from its handler; a held preview waits for a key
    tl.start();
  }

  private tickTierCard(step: number, pressed: boolean): void {
    const tl = this.tierTimeline;
    if (!tl) return;
    if (pressed) { this.sound('confirm'); tl.skip(); this.endTierCard(); return; }
    tl.update(step);
  }

  /** Take the card down (leave animation) and tell the shell once. */
  private endTierCard(): void {
    const tl = this.tierTimeline;
    const done = this.tierDone;
    this.tierTimeline = null;
    this.tierDone = null;
    if (!tl) return;
    this.leave(this.doc.getElementById('scr-tier'));
    this.updateTouchVisibility();
    done?.();
  }

  /**
   * 엔딩: shown once in place of the last zone's result. The night sky is drawn
   * on the overlay's own canvas with Clawd on the summit; the three lines and
   * the tower totals reveal on a timeline (any key / tap skips), then the menu:
   * 다시 오르기 (quit → the tower), 공유, 만든 것들. The last clear's submission
   * line rides along and updateResult keeps it current. Not part of UIPort.
   */
  showEnding(view: EndingView): void {
    const sec = this.doc.getElementById('scr-ending');
    const body = this.doc.getElementById('ending-body');
    if (!sec || !body) { this.showResult(view.result); return; }
    this.closeEnding();
    this.result = view.result;
    const d = this.doc;
    const lines = d.getElementById('ending-lines');
    if (lines) lines.replaceChildren(...view.lines.map((t) => el(d, 'p', {}, t)));
    const totals = d.getElementById('ending-totals');
    if (totals) {
      const t = view.totals;
      const cell = (label: string, value: string): HTMLElement => el(d, 'div', {}, el(d, 'dt', {}, label), el(d, 'dd', {}, value));
      totals.replaceChildren(
        cell('구역', `${t.zones}`), cell('별', `${t.stars} / ${t.maxStars}`), cell('유물', `${t.relics} / ${t.maxRelics}`),
        cell('쓰러진 횟수', String(t.deaths)), cell('최고 기록 합', fmtTicks(t.ticks)),
      );
    }
    this.paintSubmission('end-submit', 'end-lb', view.result);
    this.endingOpen = true;
    this.endingT = 0;
    this.endingAcc = 0;
    delete body.dataset.stage;
    sec.classList.remove('is-leaving');
    sec.classList.add('is-active');
    this.drawEnding();
    const tl = new Timeline(endingTimeline(prefersReducedMotion(this.win)), (stage) => {
      body.dataset.stage = stage;
      if (stage === 'done') this.nav.refresh(sec);
    }, isShotHarness(this.win));
    this.endingTimeline = tl;
    this.nav.refresh(sec);
    this.updateTouchVisibility();
    this.syncUpdateBar();
    tl.start();
  }

  private tickEnding(step: number, edges: readonly MenuAction[], input: InputPort): void {
    this.endingT += step;
    this.endingAcc += step;
    if (this.endingAcc >= 1 / 30) { this.endingAcc = 0; this.drawEnding(); }
    const tl = this.endingTimeline;
    if (tl && !tl.done) {
      if (edges.length) { this.sound('confirm'); tl.skip(); } else tl.update(step);
      return;
    }
    this.nav.update(step, edges, input);
  }

  /** The ending's sky on its own canvas (device pixels), then Clawd on the summit through the portrait painter. */
  private drawEnding(): void {
    const canvas = this.doc.getElementById('ending-sky') as HTMLCanvasElement | null;
    if (!canvas || typeof canvas.getContext !== 'function') return;
    const w = Math.max(1, Math.round(canvas.clientWidth || this.win?.innerWidth || 960));
    const h = Math.max(1, Math.round(canvas.clientHeight || this.win?.innerHeight || 540));
    const dpr = Math.min(2, this.win?.devicePixelRatio || 1);
    const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    let ctx: CanvasRenderingContext2D | null = null;
    try { ctx = canvas.getContext('2d'); } catch { ctx = null; }
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawEndingSky(ctx, w, h, this.endingT);
    if (!this.portrait) return;
    const size = Math.max(40, Math.round(h * 0.16));
    ctx.save();
    ctx.translate(w * SUMMIT.x - size / 2, h * SUMMIT.y - size * 0.82);
    try { this.portrait(ctx, this.settings?.skin ?? 'clawd', size, this.endingT); } catch { /* the portrait is decoration */ }
    ctx.restore();
  }

  private closeEnding(): void {
    if (!this.endingOpen) return;
    this.endingOpen = false;
    this.endingTimeline = null;
    this.leave(this.doc.getElementById('scr-ending'));
  }

  /** Deactivate an overlay section with the leave animation (the same beat as ScreenStack.deactivate). */
  private leave(e: HTMLElement | null): void {
    if (!e || !e.classList.contains('is-active')) return;
    e.classList.remove('is-active');
    e.classList.add('is-leaving');
    const timer = this.win?.setTimeout ?? setTimeout;
    timer(() => e.classList.remove('is-leaving'), LEAVE_MS);
  }

  /** `?shot=title&ui=tier|ending`: the surfaces with sample data, so the QA harness can capture them and read the console. */
  private previewCeremony(kind: 'tier' | 'ending'): void {
    if (kind === 'tier') { this.tierBreak(tierCardView('tidepool'), () => undefined, { hold: true }); return; }
    const last = this.levels[this.levels.length - 1];
    const summary: RunSummary = {
      levelId: last?.id ?? 'v3', cleared: true, ticks: 4166, time: 34.72, shards: 23, totalShards: 25, relics: 1, totalRelics: 1,
      deaths: 1, par: last?.par ?? 60, rank: 'A', height: 0,
    };
    const result: ResultView = { summary, levelName: last?.name ?? '메아리의 정점', personalBest: true, stars: 2, submit: { state: 'accepted', rank: 12, total: 340 } };
    this.showEnding(endingView({ levels: this.progress?.levels ?? {} }, this.levels, result));
  }

  /** A tap on a ceremony surface: the tier card ends, the ending reveal jumps to its menu, the result reveal completes. */
  private skipCeremony(): void {
    const tier = this.tierTimeline;
    if (tier) {
      this.sound('confirm');
      tier.skip();
      this.endTierCard();
      return;
    }
    const ending = this.endingTimeline;
    if (this.endingOpen && ending && !ending.done) { this.sound('confirm'); ending.skip(); return; }
    this.skipClearCeremony();
  }

  hud(h: HudState): void {
    this.lastHud = h;
    this.hudCtl.update(h);
  }

  /**
   * Show a hint template ({move} {jump} {dash} {stomp} {down} tokens) rendered
   * for the device the player used last; re-rendered when the device changes.
   */
  hint(text: string | null): void {
    this.hintTemplate = text && text !== '' ? text : null;
    this.paintHint();
  }

  private paintHint(): void {
    const t = this.hintTemplate;
    if (t === null) { this.hudCtl.hint(null); this.hintDevice = null; return; }
    const device: Device = this.input?.lastDevice ?? (this.touchCtl.coarse ? 'touch' : 'keyboard');
    this.hintDevice = device;
    this.hudCtl.hint(renderHint(t, device, {
      binds: this.settings?.binds,
      keyLabel: (code) => this.input?.keyLabel(code) ?? code,
    }));
  }

  toast(text: string): void { this.hudCtl.toast(text); }

  /** Checkpoint split chip ('+0.84s' / '−1.20s' / '—'; sign −1 ahead · 0 even · 1 behind); null hides it. Not part of UIPort. */
  split(text: string | null, sign: -1 | 0 | 1 = 0): void { this.hudCtl.split(text, sign); }

  /** Pause screen rows: one per checkpoint segment with the session's deaths and the install's best; repainted when the pause is up. */
  segments(rows: SegmentView[] | null): void {
    this.segRows = rows;
    if (this.screens.top === 'pause') this.fillPause();
  }

  /** Result screen: "라이벌보다 0.62s 빠름 / 느림" when a world echo was raced; null hides the row. Call before showResult. */
  setVersus(v: VersusView | null): void {
    this.versus = v;
    this.paintVersus();
  }

  /** Result screen (P3-6): the medals this clear just earned and its longest combo; null for a run without them. Call before showResult. */
  setClearExtras(x: ClearExtrasView | null): void {
    this.clearExtras = x ? { newMedals: [...x.newMedals], combo: x.combo, comboRecord: x.comboRecord } : null;
  }

  /**
   * Where the renderer drew the goal (canvas CSS px) after the last frame, or
   * null: the zone name chip hides while the goal sits under the HUD's
   * top-right block so the two never overlap.
   */
  setGoalScreen(g: { x: number; y: number; onScreen: boolean } | null): void {
    let hide = false;
    if (g && g.onScreen) {
      const canvas = this.doc.getElementById('world');
      const w = (canvas && (canvas as HTMLElement).clientWidth) || this.win?.innerWidth || 0;
      hide = w > 0 && g.x >= w - HUD_TOPRIGHT_W && g.y <= HUD_TOPRIGHT_H && g.x <= w && g.y >= 0;
    }
    this.hudCtl.setLevelHidden(hide);
  }

  /** Big centred banner (zone name at start, "끝없는 등반" …). Not part of UIPort but handy for the shell. */
  banner(text: string): void { this.hudCtl.banner(text); }

  /** Boot progress: 0..1 and an optional status line. */
  boot(k: number, label?: string): void {
    const fill = this.doc.getElementById('boot-fill');
    if (fill) fill.style.width = `${Math.round(Math.min(1, Math.max(0, k)) * 100)}%`;
    const hint = this.doc.getElementById('boot-hint');
    if (hint && label) hint.textContent = label;
  }

  /**
   * Rebuild the tower. `justUnlocked` names zones this call opens: their cards
   * get `is-unlocking` and the unlock sound plays once — now when the select
   * screen is up, otherwise the moment it next appears.
   */
  refreshSelect(progress: Progress, levels: LevelDef[], justUnlocked?: Iterable<string>): void {
    this.progress = progress;
    this.levels = levels;
    this.playerName = progress.player.name;
    if (justUnlocked) {
      for (const id of justUnlocked) this.unlocking.add(id);
      if (this.unlocking.size) this.unlockSoundPending = true;
    }
    const host = this.doc.getElementById('sel-tiers');
    if (host) {
      host.replaceChildren();
      // Clearing zone N opens N+1 and N+2 within the tier; a tier's first zone still needs the previous one cleared.
      const unlocked = unlockedZones(levels, progress);
      let done = 0;
      let lastUnlocked: HTMLElement | null = null;
      // The cursor rests on the next challenge: the first open zone not yet cleared (else the last open one).
      let nextUp: HTMLElement | null = null;
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
          if (isOpen) {
            lastUnlocked = card;
            if (!rec?.done && !nextUp) nextUp = card;
          }
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
      const cursorCard = (nextUp ?? lastUnlocked) as HTMLElement | null;
      if (cursorCard) cursorCard.setAttribute('data-default', '');
      const prog = this.doc.getElementById('sel-progress');
      if (prog) prog.textContent = `${done} / ${levels.length} 구역 돌파 · ${unlocked.size} 해금`;
      // "별 N/36 · 메달 N/48" — the denominators follow LEVELS (a new zone widens them by 3 and 4).
      const totals = this.doc.getElementById('sel-totals');
      if (totals) totals.textContent = totalsText(progress, levels);
    }
    // A clear may have opened a skin: the picker's locks follow the save (P3-6).
    this.settingsPanel.syncSkins();
    this.refreshTitle();
    this.renderDailyStrip();
    if (this.screens.top === 'select') {
      this.nav.refresh(this.screens.el('select'));
      this.revealUnlocks();
    }
  }

  /** The select screen is visible with the freshly opened cards: sound once, then forget them. */
  private revealUnlocks(): void {
    if (this.unlockSoundPending) {
      this.unlockSoundPending = false;
      this.sound('unlock');
    }
    this.unlocking.clear();
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
      // the run's longest shard combo (P3-6); 신기록 when it beat the zone's stored best
      const x = this.clearExtras;
      if (x && x.combo > 0) {
        const row = this.resRow(x.comboRecord ? '최고 콤보 · 신기록!' : '최고 콤보', `×${x.combo}`, x.comboRecord);
        row.id = 'res-combo';
        list.push(row);
      }
      if (s.height > 0) list.push(this.resRow('도달 높이', String(Math.floor(s.height))));
      rows.replaceChildren(...list);
    }
    const stars = d.getElementById('res-stars');
    if (stars) {
      stars.replaceChildren();
      for (let i = 0; i < 3; i++) stars.appendChild(starSvg(d, view.stars > i));
      stars.setAttribute('aria-label', `별 ${view.stars} / 3`);
    }
    const unlock = d.getElementById('res-unlock');
    if (unlock) {
      const u = view.unlocked;
      unlock.hidden = !u;
      if (u) unlock.replaceChildren('다음 구역 해금: ', el(d, 'b', {}, u.name));
      else unlock.replaceChildren();
    }
    const next = d.querySelector<HTMLElement>('#scr-result [data-act="next"]');
    if (next) next.hidden = !view.nextLevelId;
    this.paintMedals(view);
    this.paintVersus();
    this.paintSubmission('res-submit', 'res-lb', view);
    this.paintInstallCard();
    this.show('result');
    // the rank letter pops once the modal has landed (CSS keyframes; reduced motion disables them)
    if (rank) replay(rank, 'pop');
    // then the staged reveal: stars → medals → board (P3-9; instant under reduced motion)
    this.startClearCeremony();
  }

  updateResult(view: ResultView): void {
    this.result = view;
    // The ending stands in for the result: its own submission line is the one to keep current (P3-9).
    if (this.endingOpen) { this.paintSubmission('end-submit', 'end-lb', view); return; }
    const top = this.screens.top;
    const over = top === 'over' || this.screens.isActive('over');
    if (over) this.paintSubmission('over-submit', 'over-lb', view);
    else this.paintSubmission('res-submit', 'res-lb', view);
    // The daily board arrived after the game-over screen: its top height is the 세계 최고 of the best-height row.
    if (over && view.leaderboard) {
      let world = -1;
      for (const e of view.leaderboard.entries) world = Math.max(world, Math.floor(e.height));
      if (view.leaderboard.yours) world = Math.max(world, Math.floor(view.leaderboard.yours.height));
      if (world >= 0) this.paintOverBest(world);
    }
  }

  /**
   * Game over (tide modes). `extra.sameTowerAvailable` swaps the single 다시 도전
   * for 같은 탑 다시 / 새 탑 (endless); `extra.worldBest` adds the daily's world
   * best to the best-height row. The bar below the rows fills toward the
   * personal best (--pct) and reads 신기록까지 N칸, or 신기록! once beaten.
   */
  showOver(summary: RunSummary, bestHeight: number, extra: { worldBest?: number; sameTowerAvailable?: boolean } = {}): void {
    const d = this.doc;
    // Heights are whole tiles everywhere the player reads them, so compare
    // floors: a sub-tile climb that displays as 0 is never a record, and a
    // run that displays the same height as the best is a tie, not a record.
    const h = Math.max(0, Math.floor(summary.height));
    const prevBest = Math.max(0, Math.floor(bestHeight));
    const best = h > 0 && h > prevBest;
    this.overBest = Math.max(prevBest, h);
    const rows = d.getElementById('over-rows');
    if (rows) {
      const bestRow = this.resRow('최고 높이', String(this.overBest));
      bestRow.id = 'over-best';
      rows.replaceChildren(
        this.resRow(best ? '도달 높이 · 신기록!' : '도달 높이', String(h), best),
        bestRow,
        this.resRow('파편', String(summary.shards)),
        this.resRow('버틴 시간', fmtTime(summary.time)),
      );
    }
    if (extra.worldBest !== undefined) this.paintOverBest(extra.worldBest);
    const bar = d.getElementById('over-bar');
    if (bar) {
      const pct = best ? 1 : prevBest > 0 ? Math.min(1, h / prevBest) : h > 0 ? 1 : 0;
      bar.style.setProperty('--pct', String(Math.round(pct * 10_000) / 10_000));
      bar.setAttribute('aria-valuenow', String(Math.round(pct * 100)));
      bar.classList.toggle('is-best', best);
      const text = d.getElementById('over-bar-text');
      if (text) text.textContent = best ? '신기록!' : `신기록까지 ${prevBest - h + 1}칸`;
    }
    const twoWay = !!extra.sameTowerAvailable;
    const same = d.querySelector<HTMLElement>('#scr-over [data-act="sameTower"]');
    const fresh = d.querySelector<HTMLElement>('#scr-over [data-act="newTower"]');
    const retry = d.querySelector<HTMLElement>('#scr-over [data-act="retry"]');
    if (same) same.hidden = !twoWay;
    if (fresh) fresh.hidden = !twoWay;
    if (retry) retry.hidden = twoWay;
    const submit = d.getElementById('over-submit');
    if (submit) submit.hidden = true;
    const lb = d.getElementById('over-lb');
    if (lb) { lb.hidden = true; lb.replaceChildren(); }
    this.show('over');
  }

  /** The game-over best row with the world's best next to ours: "내 최고 높이 · 세계 최고 — 63 · 120". */
  private paintOverBest(worldBest: number): void {
    const row = this.doc.getElementById('over-best');
    if (!row) return;
    const label = row.querySelector('span');
    const value = row.querySelector('b');
    if (label) label.textContent = '내 최고 높이 · 세계 최고';
    if (value) value.textContent = `${this.overBest} · ${Math.max(0, Math.floor(worldBest))}`;
  }

  // ================================================================ stuck detector
  /** "보조 모드로 이 구역을 다시 시작할까?" — a modal over the run; the answer comes back as assistAccept / assistDecline. */
  offerAssist(zoneName: string): void {
    const lead = this.doc.getElementById('assist-lead');
    if (lead) lead.textContent = `${zoneName}에서 자꾸 쓰러진다. 보조 모드로 이 구역을 다시 시작할까? 기록은 순위표에 오르지 않는다 · 설정에서 언제든 끈다`;
    this.sound('toggle');
    this.show('assist');
  }

  // ================================================================ inline name prompt
  /**
   * Ask for a display name inside the result / game-over modal (before the
   * first eligible submission). Resolves with the confirmed name, or null
   * for 건너뛰기 — also when the player leaves the screen. The submission line
   * stays hidden meanwhile; the shell paints it once the run goes out.
   */
  askNameInline(): Promise<string | null> {
    this.resolveInlineName(null);
    const top = this.screens.top;
    const modal = top === 'result' || top === 'over' ? this.screens.el(top)?.querySelector<HTMLElement>('.modal') ?? null : null;
    if (!modal) return Promise.resolve(null);
    const d = this.doc;
    const input = el(d, 'input', {
      class: 'name__input', id: 'name-inline-input', type: 'text', maxlength: String(NAME_MAX), autocomplete: 'off',
      spellcheck: 'false', enterkeyhint: 'done', 'aria-label': '이름', placeholder: '이름',
    });
    const count = el(d, 'span', { class: 'name__count mono' }, `0 / ${NAME_MAX}`);
    const err = el(d, 'p', { class: 'name__err', id: 'name-inline-err', role: 'alert', hidden: true });
    const form = el(d, 'form', { class: 'name', autocomplete: 'off' }, input, count);
    const root = el(d, 'div', { class: 'name-inline', id: 'name-inline', role: 'group', 'aria-label': '이름 정하기' },
      el(d, 'p', { class: 'name-inline__lead' },
        '순위표에 올릴 이름을 정하자. 1–12자, 한글도 좋다. 건너뛰면 ', el(d, 'b', {}, '클로드 #····'), '로 오른다.'),
      form, err,
      el(d, 'div', { class: 'name-inline__btns' },
        el(d, 'button', { class: 'chip chip--primary', type: 'button', 'data-act': 'nameInlineOk', 'data-default': '' }, '이 이름으로'),
        el(d, 'button', { class: 'chip', type: 'button', 'data-act': 'nameInlineSkip' }, '건너뛰기')));
    input.addEventListener('input', () => {
      count.textContent = `${input.value.trim().length} / ${NAME_MAX}`;
      err.hidden = true;
    });
    input.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' || e.key === 'Escape') { e.preventDefault(); this.skipInlineName(); }
    });
    form.addEventListener('submit', (e) => { e.preventDefault(); this.confirmInlineName(); });
    const submitLine = modal.querySelector<HTMLElement>('.submit');
    if (submitLine) { modal.insertBefore(root, submitLine); submitLine.hidden = true; } else modal.appendChild(root);
    return new Promise<string | null>((resolve) => {
      this.inlineName = { root, input, err, screen: top, resolve };
      this.nav.refresh(this.screens.el(top));
      try { input.focus(); } catch { /* focus is best-effort */ }
    });
  }

  private confirmInlineName(): void {
    const p = this.inlineName;
    if (!p) return;
    const problem = validateName(p.input.value);
    if (problem) {
      p.err.textContent = problem;
      p.err.hidden = false;
      this.sound('error');
      return;
    }
    const name = p.input.value.trim();
    this.playerName = name;
    if (this.progress) this.progress.player.name = name;
    this.sound('confirm');
    this.resolveInlineName(name);
    this.refreshTitle();
  }

  private skipInlineName(): void {
    if (!this.inlineName) return;
    this.sound('cancel');
    this.resolveInlineName(null);
  }

  /** Tear the prompt down and answer the shell; the submission line it hid comes back with the current result. */
  private resolveInlineName(name: string | null): void {
    const p = this.inlineName;
    if (!p) return;
    this.inlineName = null;
    if (this.doc.activeElement === p.input) { try { p.input.blur(); } catch { /* detached */ } }
    p.root.remove();
    if (this.result) this.updateResult(this.result);
    if (this.screens.top === p.screen) this.nav.refresh(this.screens.el(p.screen), true);
    p.resolve(name);
  }

  applySettings(s: Settings): void {
    // Rebuild only for a new settings object; the shell may re-apply on every
    // change, and replacing a slider mid-drag would break the drag.
    const rebuild = s !== this.settings || !this.settingsPanel.built;
    this.settings = s;
    if (rebuild) this.settingsPanel.build();
    else this.settingsPanel.sync();
    this.syncEcho();
    // The pad layout is CSSOM on the real elements; the mute chip mirrors the master volume.
    this.touchCtl.applyLayout(touchLayout(s));
    this.syncMute();
  }

  // ================================================================ touch layout · mute (P3-7)
  /** A touch layout slider moved: push it to the pad now and keep the pad previewed for a moment. */
  private previewTouchLayout(layout: TouchLayout): void {
    this.touchCtl.applyLayout(layout);
    this.previewT = TOUCH_PREVIEW_S;
    this.updateTouchVisibility();
  }

  /**
   * Per frame: the gamepad auto-hide (a pad used within GAMEPAD_HIDE_S hides the
   * virtual controls; the first touch brings them back) and the preview timer.
   */
  private tickTouchVisibility(dt: number, input: InputPort): void {
    const dev = input.lastDevice;
    if (dev === 'gamepad') this.gamepadHideT = GAMEPAD_HIDE_S;
    else if (dev === 'touch') this.gamepadHideT = 0;
    else if (this.gamepadHideT > 0) this.gamepadHideT = Math.max(0, this.gamepadHideT - dt);
    if (this.previewT > 0) this.previewT = Math.max(0, this.previewT - dt);
    this.updateTouchVisibility();
  }

  /** The HUD mute chip: pressed state and label follow Settings.master. */
  private syncMute(): void {
    const chip = this.doc.getElementById('hud-mute');
    if (!chip) return;
    const muted = this.settings ? isMuted(this.settings) : false;
    chip.setAttribute('aria-pressed', String(muted));
    chip.setAttribute('aria-label', muted ? MUTE_KR.unmute : MUTE_KR.mute);
    chip.classList.toggle('is-muted', muted);
  }

  /** Mute chip tap: master volume ↔ 0 (the previous level is remembered), persisted like any setting. */
  private toggleMuteChip(): void {
    const s = this.settings;
    if (!s) return;
    const muted = toggleMute(s);
    this.syncMute();
    this.settingsPanel.sync();
    this.sound(muted ? 'cancel' : 'toggle');
    this.emit({ type: 'settingsChanged' });
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

  /** The browser offered a deferred install prompt: reveal "홈 화면에 추가" in the title menu (and the card's 설치 variant). */
  setInstallable(on: boolean): void {
    this.installable = on;
    this.paintInstallCard();
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
    this.paintInstallCard();
  }

  // ================================================================ install card (P3-4)
  /**
   * The shell allows (or withdraws) the install card for the current result.
   * It shows only when there is a way to install: the captured prompt (설치 /
   * 나중에) or iOS Safari's share sheet (hint / 나중에). Not part of UIPort.
   */
  installCard(on: boolean): void {
    this.installCardOn = on;
    this.paintInstallCard();
  }

  /** 'prompt' (Android / desktop Chromium with a stashed beforeinstallprompt), 'ios' (Safari tab), or null. */
  private installVariant(): 'prompt' | 'ios' | null {
    return this.installable ? 'prompt' : this.iosHintWanted ? 'ios' : null;
  }

  private paintInstallCard(): void {
    const card = this.doc.getElementById('res-install');
    if (!card) return;
    const variant = this.installVariant();
    const show = this.installCardOn && variant !== null;
    const changed = card.hidden !== !show;
    card.hidden = !show;
    if (variant) card.dataset.variant = variant;
    const text = this.doc.getElementById('res-install-text');
    if (text) text.textContent = variant === 'ios' ? INSTALL_CARD_KR.ios : INSTALL_CARD_KR.prompt;
    const ok = card.querySelector<HTMLElement>('[data-act="installCardOk"]');
    if (ok) ok.hidden = variant !== 'prompt';
    if (changed && this.screens.top === 'result' && this.screens.isActive('result')) this.nav.refresh(this.screens.el('result'), true);
  }

  private hideInstallCard(): void {
    this.installCardOn = false;
    this.paintInstallCard();
  }

  /** navigator.onLine mirror: the title badge and an `is-offline` class on #ui for styling. */
  setOffline(on: boolean): void {
    const badge = this.doc.getElementById('offline-badge');
    if (badge) badge.hidden = !on;
    this.doc.getElementById('ui')?.classList.toggle('is-offline', on);
  }

  /**
   * The server runs a newer sim (health / daily version, or a 'sim-version'
   * rejection): the update bar shows urgently on every screen but play, and
   * its button reloads even when no waiting worker has been found yet.
   */
  setVersionBehind(on: boolean): void {
    if (this.versionBehind === on) return;
    this.versionBehind = on;
    this.syncUpdateBar();
  }

  private syncUpdateBar(): void {
    const bar = this.doc.getElementById('upbar');
    if (!bar) return;
    const pending = !!this.updateApply || this.versionBehind;
    bar.hidden = !pending || this.screens.top === 'play';
    bar.classList.toggle('upbar--urgent', this.versionBehind);
    const label = bar.querySelector('span');
    if (label) label.textContent = this.versionBehind ? '새 버전이 나왔다 · 새로고침이 필요하다' : '새 버전이 준비됐다';
  }

  private applyUpdate(): void {
    const apply = this.updateApply;
    if (!apply && !this.versionBehind) return;
    this.updateApply = null;
    this.syncUpdateBar();
    this.sound('confirm');
    if (apply) apply();
    else this.reload();
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
    // Leaving the modal the inline name prompt sits on is a skip (the run still goes out under the fallback name).
    if (this.inlineName && top !== this.inlineName.screen) this.resolveInlineName(null);
    switch (top) {
      case 'title': this.refreshTitle(); break;
      case 'select': this.revealUnlocks(); break;
      case 'pause': this.fillPause(); break;
      case 'name': this.prepName(); break;
      case 'daily': this.renderDaily(); break;
      case 'settings': this.resetArmed = false; break;
      default: break;
    }
    this.updateTouchVisibility();
    this.syncUpdateBar();
    const root = this.dataOpen ? this.doc.getElementById('scr-data')
      : this.endingOpen && !MODAL_SCREENS.has(top) ? this.doc.getElementById('scr-ending')
        : top === 'play' || top === 'boot' ? null : this.screens.el(top);
    this.nav.refresh(root);
    if (top !== 'name' && this.doc.activeElement === this.nameInput()) this.nameInput()?.blur();
  }

  // ================================================================ data notice
  private openData(): void {
    const e = this.doc.getElementById('scr-data');
    if (!e) return;
    this.renderData();
    this.dataOpen = true;
    e.classList.remove('is-leaving');
    e.classList.add('is-active');
    this.nav.refresh(e);
  }

  private closeData(): void {
    this.dataOpen = false;
    const e = this.doc.getElementById('scr-data');
    if (!e || !e.classList.contains('is-active')) return;
    e.classList.remove('is-active');
    e.classList.add('is-leaving');
    const timer = this.win?.setTimeout ?? setTimeout;
    timer(() => e.classList.remove('is-leaving'), LEAVE_MS);
  }

  /** The run ids of this player's accepted bests — what a deletion request has to quote (the player tag cannot be computed here). */
  private renderData(): void {
    const host = this.doc.getElementById('data-runs');
    if (!host) return;
    const d = this.doc;
    const rows: HTMLElement[] = [];
    const prog = this.progress;
    if (prog) {
      for (const lv of this.levels) {
        const runId = prog.levels[lv.id]?.runId;
        if (runId) rows.push(el(d, 'li', {}, el(d, 'span', {}, lv.name), el(d, 'b', {}, runId)));
      }
      for (const date of Object.keys(prog.daily).sort()) {
        const runId = prog.daily[date]?.runId;
        if (runId) rows.push(el(d, 'li', {}, el(d, 'span', {}, `데일리 ${date}`), el(d, 'b', {}, runId)));
      }
    }
    if (!rows.length) rows.push(el(d, 'li', {}, el(d, 'span', { class: 'data__none' }, '서버에 올린 기록이 없다')));
    host.replaceChildren(...rows);
  }

  private pause(): void {
    // A ceremony over the finished run (the tier card, the ending) is not play: nothing to pause.
    if (this.screens.top !== 'play' || this.endingOpen || this.tierTimeline) return;
    this.sound('toggle');
    this.show('pause');
  }

  /** Back / Escape: pop a modal or return to the title; the shell hears `back` either way. */
  private goBack(): void {
    if (this.dataOpen) {
      this.sound('cancel');
      this.closeData();
      this.afterShow();
      this.emit({ type: 'back' });
      return;
    }
    const top = this.screens.top;
    if (top === 'pause') { this.emit({ type: 'resume' }); return; }
    // Backing out of the assist offer is 이번엔 괜찮다: the shell resumes the run.
    if (top === 'assist') { this.sound('cancel'); this.emit({ type: 'assistDecline', never: false }); return; }
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
        const id = this.continueId;
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
      case 'sameTower': this.sound('confirm'); this.emit({ type: 'sameTower' }); break;
      case 'newTower': this.sound('confirm'); this.emit({ type: 'newTower' }); break;
      case 'retryYesterday': this.sound('confirm'); this.emit({ type: 'retryYesterday' }); break;
      case 'assistAccept': this.sound('confirm'); this.emit({ type: 'assistAccept' }); break;
      case 'assistDecline': this.sound('cancel'); this.emit({ type: 'assistDecline', never: false }); break;
      case 'assistNever': this.sound('cancel'); this.emit({ type: 'assistDecline', never: true }); break;
      case 'nameInlineOk': this.confirmInlineName(); break;
      case 'nameInlineSkip': this.skipInlineName(); break;
      case 'openSelect': this.sound('confirm'); this.show('select'); this.emit({ type: 'openSelect' }); break;
      case 'openDaily': this.sound('confirm'); this.show('daily'); this.emit({ type: 'openDaily' }); break;
      case 'openSettings': this.sound('confirm'); this.show('settings'); this.emit({ type: 'openSettings' }); break;
      case 'openCredits': this.sound('confirm'); this.show('credits'); this.emit({ type: 'openCredits' }); break;
      case 'openData': this.sound('confirm'); this.show('data'); break;
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
      case 'transferExport':
        this.sound('confirm');
        this.transferPanel.setStatus(TRANSFER_KR.creating, 'busy');
        this.emit({ type: 'transferExport' });
        break;
      case 'transferImport': this.importTransfer(); break;
      case 'transferCopy': void this.copyTransferCode(); break;
      case 'dismissNag': this.dismissNag(); break;
      case 'install':
        this.sound('confirm');
        try { this.onInstall?.(); } catch { /* the prompt is best-effort */ }
        break;
      case 'dismissIos': this.dismissIosHint(); break;
      case 'applyUpdate': this.applyUpdate(); break;
      case 'mute': this.toggleMuteChip(); break;
      // Result / game-over: a race link to my accepted echo (the shell builds and shares it).
      case 'shareEcho': this.sound('confirm'); this.emit({ type: 'shareEcho' }); break;
      // Result / game-over: the drawn result card (P3-4); the shell renders and shares it.
      case 'shareCard': this.sound('confirm'); this.emit({ type: 'shareCard' }); break;
      // Install card (P3-4): 설치 reuses the title entry's prompt; 나중에 counts toward hiding it for good.
      case 'installCardOk':
        this.sound('confirm');
        this.hideInstallCard();
        try { this.onInstall?.(); } catch { /* the prompt is best-effort */ }
        break;
      case 'installCardLater':
        this.sound('cancel');
        this.hideInstallCard();
        this.emit({ type: 'installCardDismiss' });
        break;
      // A tap on a ceremony surface (P3-9): skip the tier card / the ending reveal / the result reveal.
      case 'skipCeremony': this.skipCeremony(); break;
      default: break;
    }
  }

  // ================================================================ progress transfer (P3-5)
  /** The shell created a one-time code: show it big with the code picture. Not part of UIPort. */
  showTransferCode(code: string, expiresAt: string): void {
    this.transferPanel.setCode(code, expiresAt);
  }

  /** Progress / error line under the transfer widgets ('이미 사용된 코드다' …); null clears it. Not part of UIPort. */
  transferStatus(text: string | null, kind: TransferStatusKind = 'ok'): void {
    this.transferPanel.setStatus(text, kind);
    // A redeemed code is spent: clear the field. A refused one stays put so a typo can be fixed.
    if (text && kind === 'ok') this.transferPanel.clearInput();
  }

  /** 가져오기: a typed code is normalised (case, separators) and checked against the wire alphabet before it leaves the UI. */
  private importTransfer(): void {
    const code = normalizeCode(this.transferPanel.inputValue());
    if (!code) {
      this.transferPanel.setStatus(TRANSFER_KR.badCodeHint, 'error');
      this.sound('error');
      return;
    }
    this.sound('confirm');
    this.transferPanel.setStatus(TRANSFER_KR.importing, 'busy');
    this.emit({ type: 'transferImport', code });
  }

  /** 복사: the clipboard when the platform grants it, else the code text is selected for a manual copy. */
  private async copyTransferCode(): Promise<void> {
    const code = this.transferPanel.code;
    if (!code) return;
    let ok = false;
    try {
      const clip = this.win?.navigator?.clipboard;
      if (clip && typeof clip.writeText === 'function') { await clip.writeText(code); ok = true; }
    } catch { ok = false; }
    if (!ok) ok = this.transferPanel.selectCode();
    this.sound(ok ? 'confirm' : 'error');
    this.toast(ok ? TRANSFER_KR.copied : TRANSFER_KR.copyFailed);
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

  /**
   * The pad shows during play on a touch-first device unless a gamepad was
   * used in the last GAMEPAD_HIDE_S; while a touch layout slider moves it is
   * previewed over the menus instead. DOM is touched only on a change.
   */
  private updateTouchVisibility(): void {
    const coarse = this.touchCtl.coarse;
    const inPlay = this.screens.top === 'play' && !this.dataOpen && !this.endingOpen && this.tierTimeline === null;
    const preview = coarse && !inPlay && this.previewT > 0;
    const show = (coarse && inPlay && this.gamepadHideT <= 0) || preview;
    if (show !== this.padShown) { this.padShown = show; this.touchCtl.setVisible(show); }
    if (preview !== this.padPreview) { this.padPreview = preview; this.touchCtl.setPreview(preview); }
    const ui = this.doc.getElementById('ui');
    if (ui && ui.classList.contains('is-touch') !== coarse) ui.classList.toggle('is-touch', coarse);
    const mute = this.doc.getElementById('hud-mute');
    if (mute && mute.hidden !== !coarse) mute.hidden = !coarse;
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
  /**
   * The title's first entry. With a zone in progress it reads 이어하기; on a
   * fresh save (nothing played, nothing cleared) it reads '바로 시작 · <first
   * zone>' and starts that zone directly, so the first Enter is already play —
   * the tower and its eight locked cards wait until the first clear.
   */
  private refreshTitle(): void {
    const cont = this.doc.querySelector<HTMLElement>('#title-menu [data-act="continue"]');
    const note = this.doc.getElementById('continue-note');
    const prog = this.progress;
    const last = prog?.lastLevel;
    const lv = last ? this.levels.find((l) => l.id === last) : undefined;
    const fresh = !!prog && !lv && !this.levels.some((l) => prog.levels[l.id]?.done);
    const first = fresh ? this.levels[0] : undefined;
    const target = lv ?? first;
    this.continueId = target?.id ?? null;
    if (cont) {
      cont.hidden = !target;
      if (target) {
        const label = first ? `바로 시작 · ${first.name}` : '이어하기';
        const text = cont.firstChild;
        if (text && text.nodeType === 3) text.textContent = label;
        else cont.insertBefore(this.doc.createTextNode(label), cont.firstChild);
        if (note) note.textContent = first ? `${BIOMES[first.biome].kr} · 첫 구역 · 조작을 배운다` : `${BIOMES[target.biome].kr} · ${target.name}`;
      }
    }
    const chip = this.doc.getElementById('title-name');
    if (chip) chip.textContent = this.playerName || '—';
    // The one-line story hook once the ending has played (P3-9).
    const hook = this.doc.getElementById('title-hook');
    if (hook) {
      const seen = prog?.endingSeen === true;
      hook.hidden = !seen;
      hook.textContent = seen ? TITLE_HOOK : '';
    }
    this.refreshDailyNote();
    if (this.screens.top === 'title') this.nav.refresh(this.screens.el('title'), true);
  }

  /** Today's UTC date: the server's when the daily was fetched, else the device clock. */
  private todayStr(): string {
    return this.daily?.date ?? utcDateStr(this.now());
  }

  /** Our world rank on a daily board when known: a live board's `yours` row (today / yesterday) first, else the record's. */
  private rankFor(date: string, rec: Progress['daily'][string] | undefined): number | undefined {
    if (this.dailyLb?.board === date && this.dailyLb.yours) return this.dailyLb.yours.rank;
    if (this.yesterday?.date === date && this.yesterday.lb?.yours) return this.yesterday.lb.yours.rank;
    return rec?.rank || undefined;
  }

  /** The 데일리 타워 subtitle: 오늘 미도전 · 3일 연속 / 오늘 클리어 · 세계 12위 / 오늘 높이 63 · 2일 연속. */
  private refreshDailyNote(): void {
    const note = this.doc.getElementById('daily-note');
    const prog = this.progress;
    if (!note || !prog) return;
    const today = this.todayStr();
    const rec = prog.daily[today];
    const streak = streakFor(prog.daily, today);
    const rank = this.rankFor(today, rec);
    const tail = rank ? `세계 ${rank}위` : streak > 0 ? `${streak}일 연속` : null;
    if (!rec) note.textContent = streak > 0 ? `오늘 미도전 · ${streak}일 연속` : '매일 바뀌는 탑 · 세계 순위';
    else if (rec.cleared) note.textContent = `오늘 클리어${tail ? ` · ${tail}` : ''}`;
    else note.textContent = `오늘 높이 ${Math.floor(rec.height)}${tail ? ` · ${tail}` : ''}`;
  }

  // ================================================================ select
  private card(lv: LevelDef, idx: number, rec: Progress['levels'][string] | undefined, unlocked: boolean, biome: Biome): HTMLButtonElement {
    const d = this.doc;
    const card = el(d, 'button', {
      class: 'card', type: 'button', 'data-act': 'start', 'data-id': lv.id,
      'aria-label': `${lv.name}${unlocked ? '' : ' (잠김)'}`,
    });
    if (!unlocked) { card.disabled = true; card.setAttribute('aria-disabled', 'true'); }
    if (unlocked && this.unlocking.has(lv.id)) card.classList.add('is-unlocking');
    card.append(el(d, 'div', { class: 'card__sky' }), el(d, 'div', { class: 'card__ridge' }));
    const stars = el(d, 'div', { class: 'card__stars' });
    for (let s = 0; s < 3; s++) stars.appendChild(starSvg(d, (rec?.stars ?? 0) > s));
    // P3-6: the best rank letter, the four medal slots (earned / empty) and the world rank of the submitted best, when known.
    const top = el(d, 'div', { class: 'card__top' });
    const rank = bestRankOf(rec);
    if (rank) top.appendChild(el(d, 'span', { class: 'card__rank', 'data-rank': rank, 'aria-label': `최고 등급 ${rank}` }, rank));
    const have = new Set(rec?.medals ?? []);
    const slots = el(d, 'div', { class: 'card__medals', role: 'img', 'aria-label': `메달 ${MEDAL_ORDER.filter((m) => have.has(m)).length} / ${MEDAL_ORDER.length}` });
    for (const m of MEDAL_ORDER) {
      slots.appendChild(el(d, 'i', { class: `cmedal cmedal--${m}${have.has(m) ? ' is-on' : ''}`, title: have.has(m) ? MEDAL_KR[m] : `${MEDAL_KR[m]} · 미획득` }));
    }
    top.appendChild(slots);
    const meta = el(d, 'div', { class: 'card__meta' },
      el(d, 'span', {}, rec?.bestTicks ? fmtTicks(rec.bestTicks) : '—:——.——'),
      el(d, 'span', { class: 'shards' }, String(rec?.bestShards ?? 0)),
      rec?.relics ? el(d, 'span', { class: 'relic' }, '유물') : null,
      el(d, 'span', {}, `목표 ${fmtTime(lv.par).slice(0, -3)}`),
    );
    card.append(stars, top, el(d, 'div', { class: 'card__body' },
      el(d, 'div', { class: 'card__idx' }, `${biome.name} · ${String(idx + 1).padStart(2, '0')}`),
      el(d, 'div', { class: 'card__title' }, lv.name),
      meta));
    const world = rec?.done ? worldRankOf(rec) : undefined;
    if (world) card.appendChild(el(d, 'span', { class: 'card__world', 'data-rank': String(world) }, worldRankText(world)));
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
    this.fillSegments();
  }

  /** 구간 N · 쓰러짐 M · best — one row per checkpoint segment, the current one highlighted; empty without rows. */
  private fillSegments(): void {
    const host = this.doc.getElementById('pause-segs');
    if (!host) return;
    const d = this.doc;
    const rows = this.segRows ?? [];
    host.replaceChildren(...rows.map((r) => el(d, 'div', {
      class: r.current ? 'segrow is-current' : 'segrow', role: 'listitem', 'data-seg': String(r.idx),
      'aria-label': `구간 ${r.idx + 1} · 쓰러짐 ${r.deaths}회 · 최고 ${r.best ? fmtTicks(r.best) : '없음'}${r.current ? ' · 현재' : ''}`,
    },
    el(d, 'span', {}, `구간 ${r.idx + 1}`),
    el(d, 'em', { class: r.deaths > 0 ? 'is-hot' : undefined }, `쓰러짐 ${r.deaths}`),
    el(d, 'b', { class: r.best ? undefined : 'is-none' }, r.best ? fmtTicks(r.best) : '—'))));
  }

  /** The 라이벌보다 row: hidden without a raced world echo, else the two-decimal gap and 빠름 / 느림 coloured by sign. */
  private paintVersus(): void {
    const row = this.doc.getElementById('res-vs-world');
    if (!row) return;
    const v = this.versus;
    row.classList.remove('is-ahead', 'is-behind', 'is-even');
    if (!v) { row.hidden = true; row.replaceChildren(); delete row.dataset.sign; return; }
    const f = fmtVersus(v.label, v.deltaTicks);
    const d = this.doc;
    if (f.sign === 0) row.replaceChildren(f.text);
    else row.replaceChildren(`${v.label}보다 `, el(d, 'b', {}, f.secs), f.sign < 0 ? ' 빠름' : ' 느림');
    row.dataset.sign = String(f.sign);
    row.classList.add(f.sign < 0 ? 'is-ahead' : f.sign > 0 ? 'is-behind' : 'is-even');
    row.hidden = false;
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
        // queued: offline, or the server asked for a retry (503 busy / 429 — the queue's timer resends it)
        case 'queued': submit.append(sub.reason === 'busy' ? QUEUED_KR.busy : QUEUED_KR.offline); break;
        default: break;
      }
      submit.hidden = sub.state === 'idle';
    }
    // '메아리 링크 공유' (P3-3): only an accepted submission has a run id a friend can race (the ending card has the entry too).
    const modal = submit?.closest('.modal, .ending') ?? null;
    const share = modal?.querySelector<HTMLElement>('[data-act="shareEcho"]') ?? null;
    if (share) {
      const on = sub.state === 'accepted';
      if (share.hidden !== !on) {
        share.hidden = !on;
        const top = this.screens.top;
        if ((top === 'result' || top === 'over') && this.screens.el(top)?.contains(share)) this.nav.refresh(this.screens.el(top), true);
      }
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
    this.renderDailyStrip();
    this.renderDailyExpires();
    const host = d.getElementById('daily-lb');
    if (host) renderLeaderboard(host, this.dailyLb, { status: this.dailyStatus });
    this.refreshDailyNote();
    if (this.screens.top === 'daily') this.nav.refresh(this.screens.el('daily'), true);
  }

  /** Yesterday's tower (the shell fetched its board once today): the row under the strip and the 재도전 entry. */
  setYesterday(info: YesterdayView | null): void {
    this.yesterday = info;
    this.renderDailyStrip();
    this.refreshDailyNote();
    if (this.screens.top === 'daily') this.nav.refresh(this.screens.el('daily'), true);
  }

  /** Our record for a date as a short cell / row text: the clear time, or the height reached. */
  private recordText(rec: Progress['daily'][string]): string {
    return rec.cleared ? fmtTicks(rec.bestTicks) : `높이 ${Math.floor(rec.height)}`;
  }

  /**
   * The last seven UTC days, oldest → today: 미도전 / 도전 / 클리어 per cell with
   * the world rank when known, today's record and the streak badge above,
   * yesterday's tower below.
   */
  private renderDailyStrip(): void {
    const d = this.doc;
    const prog = this.progress;
    const today = this.todayStr();
    const todayMs = Date.parse(`${today}T00:00:00.000Z`);
    const week = d.getElementById('daily-week');
    if (week && Number.isFinite(todayMs)) {
      week.replaceChildren();
      for (let k = 6; k >= 0; k--) {
        const date = utcDateStr(todayMs - k * MS_PER_DAY);
        const rec = prog?.daily[date];
        const state = rec ? (rec.cleared ? 'cleared' : 'tried') : 'none';
        const rank = rec ? this.rankFor(date, rec) : undefined;
        const stateKr = state === 'cleared' ? '클리어' : state === 'tried' ? '도전' : '미도전';
        const label = `${Number(date.slice(5, 7))}월 ${Number(date.slice(8, 10))}일 · ${stateKr}${rank ? ` · 세계 ${rank}위` : ''}`;
        week.appendChild(el(d, 'div', {
          class: `daily__day is-${state}${k === 0 ? ' is-today' : ''}`, role: 'listitem',
          'data-date': date, 'data-state': state, 'aria-label': label, title: label,
        },
        el(d, 'small', {}, k === 0 ? '오늘' : String(Number(date.slice(8, 10)))),
        el(d, 'b', {}, rank ? `${rank}위` : state === 'cleared' ? '✓' : state === 'tried' ? '·' : '')));
      }
    }
    const badge = d.getElementById('daily-streak');
    if (badge) {
      const n = prog ? streakFor(prog.daily, today) : 0;
      badge.hidden = n <= 0;
      badge.textContent = `${n}일 연속`;
    }
    const mine = d.getElementById('daily-mine');
    if (mine) {
      const rec = prog?.daily[today];
      mine.textContent = rec ? `오늘 ${this.recordText(rec)}` : '오늘 미도전';
    }
    this.renderYesterday(today);
  }

  /** "어제의 탑 · 세계 N위 / M명" (확정 once the board is closed, i.e. the date is 2+ days old) and the 재도전 entry. */
  private renderYesterday(today: string): void {
    const d = this.doc;
    const row = d.getElementById('daily-yday');
    const btn = d.querySelector<HTMLElement>('#scr-daily [data-act="retryYesterday"]');
    const y = this.yesterday;
    if (!y) {
      if (row) { row.hidden = true; row.replaceChildren(); }
      if (btn) btn.hidden = true;
      return;
    }
    const age = Math.round((Date.parse(`${today}T00:00:00.000Z`) - Date.parse(`${y.date}T00:00:00.000Z`)) / MS_PER_DAY);
    const final = age >= 2;
    const name = final ? `${Number(y.date.slice(5, 7))}월 ${Number(y.date.slice(8, 10))}일의 탑` : '어제의 탑';
    const rec = this.progress?.daily[y.date];
    const yours = y.lb?.yours;
    const total = y.lb ? Math.max(y.lb.total, y.lb.entries.length).toLocaleString('ko-KR') : '';
    let parts: (string | Node)[] | null = null;
    if (yours) parts = [`${name} · 세계 `, el(d, 'b', {}, `${yours.rank}위`), ` / ${total}명`];
    else if (y.lb && rec) parts = [`${name} · `, el(d, 'b', {}, this.recordText(rec)), ` · ${total}명 참가`];
    else if (y.lb) parts = [`${name} · 미도전 · ${total}명 참가`];
    else if (rec) parts = [`${name} · `, el(d, 'b', {}, this.recordText(rec))];
    if (row) {
      row.hidden = !parts;
      row.replaceChildren(...(parts ?? []));
      if (parts && final) row.appendChild(el(d, 'b', { class: 'daily__badge daily__badge--final' }, '확정'));
    }
    if (btn) btn.hidden = y.seed === null || final;
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
