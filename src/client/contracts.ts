/**
 * Client subsystem contracts. `main.ts` composes these; each subsystem is
 * developed and tested against this file, never against another subsystem's
 * internals. Everything here is presentation: the Sim is the only authority on
 * game state, and it is read-only from the client's point of view.
 */
import type { Sim } from '../sim/sim.js';
import type { InputMask, LevelDef, PlayerState, RunSummary, SimEvent } from '../sim/types.js';
import type { Biome } from '../shared/biomes.js';
import type { DailyResponse, LeaderboardResponse } from '../shared/protocol.js';
import type { GoalId, GoalPreference } from './goal-settings.js';
import type { GoalView } from './goals.js';

// ---------------------------------------------------------------- save.ts
export type BindAction = 'left' | 'right' | 'up' | 'down' | 'jump' | 'dash' | 'pause' | 'confirm' | 'cancel' | 'restart';
export type Binds = Record<BindAction, string[]>;

export interface Settings {
  v: 1;
  master: number; music: number; sfx: number;
  /** 0..1 screen-shake scale. */
  shake: number;
  bloom: boolean; grain: boolean;
  quality: 'auto' | 'high' | 'balanced' | 'low';
  /** Photosensitivity: disables full-screen flashes when false. */
  flashes: boolean;
  showTimer: boolean;
  skin: string;
  assist: boolean;
  invincible: boolean;
  /** Draw my best run / the world's best run as translucent echoes. */
  echoSelf: boolean; echoWorld: boolean;
  /** Which board entry the world echo follows: the leader, or the rival ranked just above you (default). */
  echoWorldMode?: 'top' | 'rival';
  /** Vibration / gamepad rumble on impacts (default on for coarse pointers, off under prefers-reduced-motion). */
  haptics?: boolean;
  /** Touch control layout: size and opacity scale, per-side offsets (CSS px), floating stick (appears where the thumb lands). */
  touch?: { scale: number; opacity: number; leftX: number; leftY: number; rightX: number; rightY: number; floating: boolean };
  binds: Binds;
  /** Optional per-zone focus; earned progress remains independent. */
  goalTargets?: Record<string, GoalPreference>;
}

export interface LevelRecord {
  done: boolean;
  /** 0 = no record. Ticks at 120 Hz. */
  bestTicks: number;
  bestShards: number;
  stars: number;
  relics: number;
  deaths: number;
  /** Server run id of the submitted best, when accepted. */
  runId?: string;
  /** Locally kept replay of the best run (encoded masks), for the self-echo. */
  masks?: string;
  /** SIM_VERSION the masks were recorded on; masks from another version are dropped on load. */
  sim?: number;
  /** Deaths in this zone during the current install (stuck detector input). */
  sessionDeaths?: number;
  /** Best time per checkpoint segment (ticks, cumulative), echo-safe story runs only. */
  segBest?: number[];
  /** Zone medals earned: 'nodeath' | 'par' | 'shards' | 'relic' (unordered, no duplicates). */
  medals?: string[];
}

export interface Progress {
  v: 1;
  levels: Record<string, LevelRecord>;
  endless: {
    bestHeight: number; bestShards: number; runs: number;
    /** Replay of the best endless run (encoded masks, SIM_VERSION) and its seed — for the self echo on "같은 탑 다시". */
    bestMasks?: string; bestSeed?: number; bestSim?: number;
    /** GEN_VERSION the best endless tower was generated with; a different generator makes the self echo meaningless. */
    bestGen?: number;
  };
  daily: Record<string, {
    bestTicks: number; cleared: boolean; height: number; runId?: string; masks?: string; sim?: number; seed: number;
    /** Last known world rank of the best (accepted submission / a board that flagged our row) — the 7-day strip's number. */
    rank?: number;
  }>;
  totals: { deaths: number; shards: number };
  seen: Record<string, boolean>;
  lastLevel: string | null;
  player: { id: string; name: string };
  /** Times the install card on the result screen was dismissed (hidden for good after 3). */
  installCardDismissed?: number;
  /** Skins unlocked by medals / tier completion (ids from the renderer's skin table). 'clawd' is always available. */
  unlockedSkins?: string[];
  /** Tiers whose every zone is cleared, for the one-time tier-break ceremony. */
  tiersBroken?: string[];
  /** The ending was shown once (after the last zone). */
  endingSeen?: boolean;
  /** First boot (ms epoch) and distinct UTC days played — the only inputs of the anonymous retention buckets. */
  firstSeen?: number;
  playDays?: number;
  lastPlayDay?: string;
}

// ---------------------------------------------------------------- input
export type MenuAction = 'up' | 'down' | 'left' | 'right' | 'confirm' | 'cancel' | 'pause' | 'restart';
export type Device = 'keyboard' | 'gamepad' | 'touch';

/** Written by the UI's virtual controls, read by the input layer. */
export interface TouchState {
  active: boolean;
  /** Virtual stick, -1..1. */
  x: number; y: number;
  jump: boolean; dash: boolean;
  /** Edge flags set by the UI when a virtual button goes down; consumed by the input layer. */
  jumpPressed: boolean; dashPressed: boolean;
}

export interface InputPort {
  /** Call once per rendered frame before reading. Polls gamepads and drains DOM events. */
  poll(): void;
  /** Mask of actions currently held. */
  held(): InputMask;
  /**
   * Bits that went down since the previous call, even if already released. The
   * loop ORs these into the FIRST tick of the frame only, so a tap shorter than
   * a frame still produces exactly one press edge in the sim. The 'restart' bind
   * contributes IN.RETRY (a tap = checkpoint retry inside the replay; the UI
   * turns a ≥0.6 s hold into a full zone restart).
   */
  takeLatched(): InputMask;
  /** Edge-triggered menu actions since the last call (repeat handled by the UI). */
  takeMenu(): MenuAction[];
  /** Is a menu/gameplay action currently held (for held-to-repeat menu nav). */
  menuHeld(a: MenuAction): boolean;
  setBinds(b: Binds): void;
  /** Rebind capture: the next key code (or null on Escape) goes to `cb`; normal handling is suppressed meanwhile. */
  capture(cb: (code: string | null) => void): void;
  reset(): void;
  readonly lastDevice: Device;
  readonly touch: TouchState;
  /** Human label for a KeyboardEvent.code ('Space' → 'Space', 'KeyA' → 'A', 'ArrowLeft' → '←'). */
  keyLabel(code: string): string;
}

// ---------------------------------------------------------------- render
export interface FxState {
  /** Screen-space shake offset (world units) and roll (radians) for this frame. */
  shakeX: number; shakeY: number; shakeRot: number;
  flash: number; flashColor: string;
  /** 0 = clear, 1 = black. */
  fade: number;
  zoom: number;
  /** Chromatic aberration strength 0..1. */
  aberr: number;
  vignette: number;
}

export interface WorldView { camX: number; camY: number; zoom: number }

export interface GhostView {
  player: PlayerState;
  color: string;
  alpha: number;
  /** Shown as a small tag above the echo. */
  label?: string;
}

/** Feet position as fractions of a portrait box, shared with scenes that place it on a surface. */
export const PORTRAIT_FEET = { x: 0.5, y: 0.88 } as const;

export interface RendererPort {
  /** Rebuild terrain caches for a new level. */
  setLevel(sim: Sim, biome: Biome): void;
  /** Draw one frame of the world. `dtFrame` advances visual-only state (particles, trails). */
  draw(sim: Sim, view: WorldView, fx: FxState, ghosts: GhostView[], dtFrame: number): void;
  /** Spawn particles / visual reactions for a sim event. */
  onEvent(ev: SimEvent, sim: Sim): void;
  /** Title-screen backdrop (sky + parallax + idle Clawd). */
  drawTitle(t: number, dtFrame: number, biome: Biome): void;
  /** Draw a portrait into a size-square box, with the feet at PORTRAIT_FEET (settings / result screens). */
  drawPortrait(ctx: CanvasRenderingContext2D, skin: string, size: number, t: number): void;
  resize(): void;
  /** Design-box size in world units after the current viewport expansion. */
  readonly viewW: number;
  readonly viewH: number;
  /** Last measured render FPS and the quality tier the adaptive scaler settled on. */
  readonly fps: number;
  readonly qualityTier: 'high' | 'balanced' | 'low';
  applySettings(s: Settings): void;
  clearParticles(): void;
  /** Skins available for the settings screen: id → { name, kr }. */
  readonly skins: Record<string, { name: string; kr: string }>;
  /**
   * Where the goal sits on screen after the last draw (CSS px relative to the
   * canvas), or null while no level is set. `onScreen` false means the renderer
   * drew an edge beacon toward it; the UI hides #hud-level when the goal is
   * under the HUD's top-right block.
   */
  readonly goalScreen: { x: number; y: number; onScreen: boolean } | null;
  /** Session death positions (world units) drawn as small X marks; the client owns the list. */
  setDeathMarks?(marks: ReadonlyArray<{ x: number; y: number }>): void;
}

// ---------------------------------------------------------------- audio
export type UiSound = 'move' | 'confirm' | 'cancel' | 'toggle' | 'unlock' | 'error';

export interface AudioPort {
  /** Create the AudioContext; call from the first user gesture. Idempotent. */
  init(): void;
  /**
   * Full gesture-time unlock: init, resume a suspended context and kick the
   * output with a silent buffer (iOS starts its audio session only for sound
   * started inside the gesture). Must be called from an activation-triggering
   * event handler (pointerup / touchend / click / keydown — NOT a touch
   * pointerdown). Idempotent; cheap once `running`.
   */
  unlock(): void;
  /** True while the context is running (sound can actually be heard). */
  readonly running: boolean;
  applySettings(s: Settings): void;
  onEvent(ev: SimEvent, sim: Sim): void;
  /** Start a sequenced track ('title' | biome.track | null to stop). Cross-fades. */
  setTrack(key: string | null): void;
  /** 0..1 danger/arrangement density. */
  setIntensity(v: number): void;
  ui(name: UiSound): void;
  suspend(): void;
  resume(): void;
  readonly ready: boolean;
}

// ---------------------------------------------------------------- ui
export type Screen =
  | 'boot' | 'title' | 'select' | 'daily' | 'settings' | 'credits' | 'data' | 'play' | 'pause' | 'result' | 'over' | 'name' | 'replay' | 'journal'
  /** Stuck-detector offer (a modal over play; answered with assistAccept / assistDecline). */
  | 'assist';

export type UIAction =
  | { type: 'start'; levelId: string }
  | { type: 'daily' }
  | { type: 'endless' }
  | { type: 'resume' }
  | { type: 'checkpointRetry' }
  | { type: 'watchReplay'; levelId?: string }
  | { type: 'closeReplay' }
  | { type: 'replayToggle' }
  | { type: 'replayRestart' }
  | { type: 'replaySeek'; tick: number }
  | { type: 'replaySpeed'; speed: 0.5 | 1 | 2 }
  | { type: 'replayCheckpoint'; direction: -1 | 1 }
  | { type: 'restart' }
  | { type: 'quit' }
  | { type: 'next' }
  | { type: 'retry' }
  | { type: 'openSelect' }
  | { type: 'openDaily' }
  | { type: 'openSettings' }
  | { type: 'openCredits' }
  | { type: 'openJournal' }
  | { type: 'pinGoal'; levelId: string; preference: GoalPreference }
  | { type: 'equipSkin'; skin: string }
  | { type: 'retryGoal'; goal: GoalId }
  | { type: 'back' }
  | { type: 'settingsChanged' }
  | { type: 'rebind'; binds: Binds }
  | { type: 'resetProgress' }
  | { type: 'setName'; name: string }
  | { type: 'toggleEcho'; which: 'self' | 'world'; on: boolean }
  | { type: 'requestLeaderboard'; mode: 'story' | 'daily'; board: string }
  /** Game-over comeback: replay the same tower seed, or draw a new one. */
  | { type: 'sameTower' }
  | { type: 'newTower' }
  /** Daily screen: play yesterday's tower (still accepted by the server). */
  | { type: 'retryYesterday' }
  /** Stuck-detector offer: restart the zone in assist mode, or decline (never = do not ask again for this zone). */
  | { type: 'assistAccept' }
  | { type: 'assistDecline'; never: boolean }
  /** Settings → 데이터: move progress to another device (creates a one-time code) / restore from a code. */
  | { type: 'transferExport' }
  | { type: 'transferImport'; code: string }
  /** Result screen: share a race link to my echo (Web Share API / clipboard). */
  | { type: 'shareEcho' }
  /** Result / game-over screens: share a procedurally drawn result card image (falls back to the race link). */
  | { type: 'shareCard' }
  /** Install card on the result screen: dismissed (counts toward hiding it) or accepted (install prompt). */
  | { type: 'installCardDismiss' };

export interface HudState {
  hp: number; maxHp: number;
  shards: number; totalShards: number;
  relics: number; totalRelics: number;
  /** Run time in seconds. */
  time: number;
  showTimer: boolean;
  levelName: string; biomeName: string;
  /** Stable story id, used by the pause screen's demonstration entry point. */
  levelId?: string;
  /** Tide modes: height in tiles; undefined hides the meter. */
  height?: number;
  combo: number;
  dashReady: boolean;
  assist: boolean;
  /** Read-only projection of the current run's selected focus. */
  objective?: GoalView | null;
}

export interface ResultView {
  summary: RunSummary;
  levelName: string;
  personalBest: boolean;
  stars: number;
  /** Server round trip state for the submission. */
  /** 'queued' = stored locally while offline; sent automatically when the connection returns. */
  submit: { state: 'idle' | 'pending' | 'accepted' | 'rejected' | 'offline' | 'queued'; rank?: number; total?: number; reason?: string };
  leaderboard?: LeaderboardResponse;
  nextLevelId?: string;
  /** The zone this clear just opened (shown as "다음 구역 해금"), when any. */
  unlocked?: { levelId: string; name: string };
  objective?: GoalView | null;
  nextGoal?: { id: GoalId; label: string; detail: string };
}

export interface ReplayView {
  levelId: string;
  name: string;
  biomeName: string;
  cursor: number;
  duration: number;
  playing: boolean;
  speed: 0.5 | 1 | 2;
  mask: number;
  checkpoints: readonly { tick: number; label: string }[];
  finished: boolean;
}

export interface UIPort {
  on(cb: (a: UIAction) => void): void;
  show(screen: Screen): void;
  readonly screen: Screen;
  /** Called once per rendered frame: menu navigation, HUD live region throttling, toasts. */
  frame(dt: number, input: InputPort): void;
  hud(h: HudState): void;
  /** Isolated demonstration transport; no progress or run-stat mutation. */
  setReplay?(view: ReplayView): void;
  /** Fractions of the canvas covered by the replay header and transport. */
  replayInsets?(): { top: number; bottom: number };
  hint(text: string | null): void;
  toast(text: string): void;
  /** Populate zone select with progress and lock state; `justUnlocked` cards play the unlock moment. */
  refreshSelect(progress: Progress, levels: LevelDef[], justUnlocked?: ReadonlySet<string>): void;
  /** Renderer goal projection each frame; the UI hides #hud-level when the goal sits under the HUD. */
  setGoalScreen?(g: RendererPort['goalScreen']): void;
  /** The server runs a newer SIM_VERSION than this bundle: highlight the update bar. */
  setVersionBehind?(on: boolean): void;
  /** Daily screen: seed/date, your best, and the leaderboard (or its loading / error state). */
  setDaily(daily: DailyResponse | null, lb: LeaderboardResponse | null, status: 'loading' | 'ok' | 'error'): void;
  showResult(view: ResultView): void;
  /** Update the submission state of the result screen in place. */
  updateResult(view: ResultView): void;
  showOver(summary: RunSummary, bestHeight: number, extra?: { worldBest?: number; sameTowerAvailable?: boolean }): void;
  /** Stuck-detector modal: "보조 모드로 이 구역을 다시 시작할까?" — answers arrive as assistAccept / assistDecline actions. */
  offerAssist?(zoneName: string): void;
  /** Result screen: ask for a display name inline before the first eligible submission; resolves with the chosen name (null = skipped). */
  askNameInline?(): Promise<string | null>;
  /** Live split chip against the echo at a checkpoint ('+0.84s' behind = 1, '−1.20s' ahead = -1, '—' = 0). */
  split?(text: string | null, sign: -1 | 0 | 1): void;
  /** Pause screen: per-checkpoint-segment session deaths and segment bests (null clears the list). */
  segments?(rows: ReadonlyArray<{ idx: number; deaths: number; best: number | null; current: boolean }> | null): void;
  /** Result screen: "라이벌보다 0.62s 빠름/느림" row; null hides it. */
  setVersus?(v: { label: string; deltaTicks: number } | null): void;
  applySettings(s: Settings): void;
  /** Virtual controls state for the input layer. */
  readonly touch: TouchState;
  setPortraitPainter(fn: (ctx: CanvasRenderingContext2D, skin: string, size: number, t: number) => void): void;
}

// ---------------------------------------------------------------- net
export interface ApiPort {
  daily(): Promise<DailyResponse>;
  submitRun(body: import('../shared/protocol.js').RunSubmit): Promise<import('../shared/protocol.js').RunResponse>;
  leaderboard(q: import('../shared/protocol.js').LeaderboardQuery): Promise<LeaderboardResponse>;
  ghost(runId: string): Promise<import('../shared/protocol.js').GhostResponse>;
  health(): Promise<import('../shared/protocol.js').HealthResponse>;
  /** Personal board row (no-store); the public leaderboard call no longer carries `yours` when edge-cached. */
  me?(q: import('../shared/protocol.js').LeaderboardQuery): Promise<import('../shared/protocol.js').MeResponse>;
  transferCreate?(body: import('../shared/protocol.js').TransferCreateRequest): Promise<import('../shared/protocol.js').TransferCreateResponse>;
  transferGet?(code: string): Promise<import('../shared/protocol.js').TransferGetResponse>;
}
