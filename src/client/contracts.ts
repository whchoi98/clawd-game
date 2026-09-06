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
  binds: Binds;
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
}

export interface Progress {
  v: 1;
  levels: Record<string, LevelRecord>;
  endless: { bestHeight: number; bestShards: number; runs: number };
  daily: Record<string, { bestTicks: number; cleared: boolean; height: number; runId?: string; masks?: string; seed: number }>;
  totals: { deaths: number; shards: number };
  seen: Record<string, boolean>;
  lastLevel: string | null;
  player: { id: string; name: string };
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
   * a frame still produces exactly one press edge in the sim.
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

export interface RendererPort {
  /** Rebuild terrain caches for a new level. */
  setLevel(sim: Sim, biome: Biome): void;
  /** Draw one frame of the world. `dtFrame` advances visual-only state (particles, trails). */
  draw(sim: Sim, view: WorldView, fx: FxState, ghosts: GhostView[], dtFrame: number): void;
  /** Spawn particles / visual reactions for a sim event. */
  onEvent(ev: SimEvent, sim: Sim): void;
  /** Title-screen backdrop (sky + parallax + idle Clawd). */
  drawTitle(t: number, dtFrame: number, biome: Biome): void;
  /** Draw a portrait of the current skin into a small canvas (settings / result screens). */
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
}

// ---------------------------------------------------------------- audio
export type UiSound = 'move' | 'confirm' | 'cancel' | 'toggle' | 'unlock' | 'error';

export interface AudioPort {
  /** Create the AudioContext; call from the first user gesture. Idempotent. */
  init(): void;
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
export type Screen = 'boot' | 'title' | 'select' | 'daily' | 'settings' | 'credits' | 'play' | 'pause' | 'result' | 'over' | 'name';

export type UIAction =
  | { type: 'start'; levelId: string }
  | { type: 'daily' }
  | { type: 'endless' }
  | { type: 'resume' }
  | { type: 'restart' }
  | { type: 'quit' }
  | { type: 'next' }
  | { type: 'retry' }
  | { type: 'openSelect' }
  | { type: 'openDaily' }
  | { type: 'openSettings' }
  | { type: 'openCredits' }
  | { type: 'back' }
  | { type: 'settingsChanged' }
  | { type: 'rebind'; binds: Binds }
  | { type: 'resetProgress' }
  | { type: 'setName'; name: string }
  | { type: 'toggleEcho'; which: 'self' | 'world'; on: boolean }
  | { type: 'requestLeaderboard'; mode: 'story' | 'daily'; board: string };

export interface HudState {
  hp: number; maxHp: number;
  shards: number; totalShards: number;
  relics: number; totalRelics: number;
  /** Run time in seconds. */
  time: number;
  showTimer: boolean;
  levelName: string; biomeName: string;
  /** Tide modes: height in tiles; undefined hides the meter. */
  height?: number;
  combo: number;
  dashReady: boolean;
  assist: boolean;
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
}

export interface UIPort {
  on(cb: (a: UIAction) => void): void;
  show(screen: Screen): void;
  readonly screen: Screen;
  /** Called once per rendered frame: menu navigation, HUD live region throttling, toasts. */
  frame(dt: number, input: InputPort): void;
  hud(h: HudState): void;
  hint(text: string | null): void;
  toast(text: string): void;
  /** Populate zone select with progress and lock state. */
  refreshSelect(progress: Progress, levels: LevelDef[]): void;
  /** Daily screen: seed/date, your best, and the leaderboard (or its loading / error state). */
  setDaily(daily: DailyResponse | null, lb: LeaderboardResponse | null, status: 'loading' | 'ok' | 'error'): void;
  showResult(view: ResultView): void;
  /** Update the submission state of the result screen in place. */
  updateResult(view: ResultView): void;
  showOver(summary: RunSummary, bestHeight: number): void;
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
}
