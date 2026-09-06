/**
 * Simulation contract — the single source of truth shared by the client,
 * the server and the tests. Nothing in `src/sim` may import from the DOM,
 * Canvas, WebAudio or Node APIs: the same bundle runs in the browser and on
 * the server to verify replays.
 *
 * Units are world units (1 tile = 16) and seconds. Positions of the player
 * are the top-left of its AABB; entity and foe positions are centres.
 */

export const TILE = 16;
export const TICK_HZ = 120;
/**
 * Bumped whenever a change alters what a mask log reproduces (physics, phase
 * timing, level geometry that ships with the sim). Replays and leaderboard
 * boards are keyed by it; the server refuses submissions from another version.
 * v1 = launch · v2 = free-failure loop (fast respawn, RETRY input).
 */
export const SIM_VERSION = 2;
/**
 * Bumped when the daily / endless tower generators change their output.
 * v1 = launch · v2 = authored chunks spliced into every band (levels/chunks).
 */
export const GEN_VERSION = 2;
export const DT = 1 / TICK_HZ;
/** Hard cap on replay length accepted anywhere (10 minutes at 120 Hz). */
export const MAX_TICKS = TICK_HZ * 60 * 10;

// ---------------------------------------------------------------- input
/** One byte per tick. Press edges are derived inside the sim from the previous tick. */
export const IN = {
  LEFT: 1,
  RIGHT: 2,
  UP: 4,
  DOWN: 8,
  JUMP: 16,
  DASH: 32,
  /** Press edge = instant respawn at the last checkpoint (counts as a death). In the log so replays reproduce it. */
  RETRY: 64,
} as const;
/** Every meaningful mask bit; the RLE codec masks with this. */
export const IN_ALL = 0x7f;
export type InputMask = number;

// ---------------------------------------------------------------- levels
export type BiomeId = 'tidepool' | 'stormspire' | 'voidreef';

export interface LevelDef {
  /** 't1'..'t3', 's1'..'s3', 'v1'..'v3', 'daily', 'endless' */
  id: string;
  /** Korean display name (the game's UI language). */
  name: string;
  /** English display name. */
  en: string;
  biome: BiomeId;
  /** Par time in seconds (3-star threshold). */
  par: number;
  seed: number;
  /** One Korean hint line shown at the start of the zone. */
  hint?: string;
  /** Rectangular char grid, top row first. Legend in legend.ts. */
  rows: string[];
  /** Tide mode: a rising flood chases the player upward. */
  tide?: boolean;
  /** Tide modes: the row the height counter measures from. */
  baseY?: number;
  /** Armoured walkers placed by tile coordinate. */
  spikers?: [number, number][];
  /** Geometry revision; bump when a shipped zone's tiles change (part of the story board key). Missing = 0. */
  rev?: number;
}

export interface Spawn {
  ch: string;
  tx: number;
  ty: number;
  /** Tile centre in world units. */
  x: number;
  y: number;
}

// ---------------------------------------------------------------- state
export type PlayerPose =
  | 'spawn' | 'idle' | 'run' | 'jump' | 'fall' | 'dash' | 'wall'
  | 'stomp' | 'hurt' | 'swim' | 'dead';

export interface PlayerState {
  x: number; y: number; w: number; h: number;
  vx: number; vy: number;
  facing: 1 | -1;
  grounded: boolean;
  /** Side of the wall being slid: -1 wall on the left, 1 wall on the right, 0 none. */
  onWall: -1 | 0 | 1;
  /** Air jumps used since the last time the player was supported. */
  jumps: number;
  /** Seconds remaining in the current dash (0 = not dashing). */
  dashT: number;
  dashDirX: number; dashDirY: number;
  dashReady: boolean;
  dashCd: number;
  stomping: boolean;
  hp: number;
  invuln: number;
  dead: boolean;
  deadT: number;
  inWater: boolean;
  pose: PlayerPose;
  /** Seconds since spawn (sim time; visual-only timers live in the client). */
  t: number;
}

export type EntityKind =
  | 'shard' | 'relic' | 'checkpoint' | 'goal' | 'spring' | 'crystal' | 'toggle'
  | 'platH' | 'platV' | 'saw' | 'updraft';

export interface EntityState {
  id: number;
  kind: EntityKind;
  /** Centre. */
  x: number; y: number;
  w: number; h: number;
  /** False once collected / consumed. Collected shards and relics stay in the array for the renderer's fade-out. */
  alive: boolean;
  /** Seconds since spawn — animation phase for the renderer, respawn timer for crystals. */
  t: number;
  /**
   * Kind-specific scalar:
   *  checkpoint 1 = active · spring compress 0..1 · crystal 0 = ready, >0 = seconds until respawn
   *  toggle 1 = switchA on · platH/platV/saw: travel phase in units · updraft: unused
   */
  state: number;
  /** Moving platforms and saws. */
  vx?: number; vy?: number;
  /** Platform / saw travel span in world units and current direction. */
  span?: number; dir?: 1 | -1;
}

export type FoeKind = 'walker' | 'hopper' | 'flyer' | 'turret' | 'chaser' | 'spiker';

export interface FoeState {
  id: number;
  kind: FoeKind;
  x: number; y: number; w: number; h: number;
  vx: number; vy: number;
  face: 1 | -1;
  hp: number;
  /** Seconds remaining in the death animation; 0 = alive. */
  dying: number;
  dead: boolean;
  /** Hit flash timer for the renderer. */
  flash: number;
  t: number;
  /** Kind-specific (hopper charge, turret reload, chaser aggro …). */
  state: number;
}

export interface BoltState {
  id: number;
  x: number; y: number; vx: number; vy: number;
  dead: boolean;
  t: number;
}

export type SimPhase = 'intro' | 'play' | 'dying' | 'clear' | 'over';

export interface RunStats {
  shards: number; relics: number; deaths: number;
  jumps: number; dashes: number; wallJumps: number; foes: number;
  combo: number; bestCombo: number;
}

export interface TideState {
  /** World y of the water line. */
  y: number;
  speed: number;
  /** Current and best height above baseY, in tiles. */
  height: number;
  maxHeight: number;
}

export interface SimState {
  /** Ticks stepped in total (all phases). */
  tick: number;
  /** Seconds spent in the 'play' phase — the run timer. */
  time: number;
  phase: SimPhase;
  phaseT: number;
  player: PlayerState;
  entities: EntityState[];
  foes: FoeState[];
  bolts: BoltState[];
  respawn: { x: number; y: number };
  /** Switch blocks: true → '%' is solid and '&' is passable; false → the reverse. */
  switchA: boolean;
  stats: RunStats;
  tide?: TideState;
}

// ---------------------------------------------------------------- events
export type Rank = 'S' | 'A' | 'B' | 'C';

export interface RunSummary {
  levelId: string;
  cleared: boolean;
  ticks: number;
  /** Seconds in 'play' (= play ticks / 120). */
  time: number;
  shards: number; totalShards: number;
  relics: number; totalRelics: number;
  deaths: number;
  par: number;
  rank: Rank;
  /** Tide modes only: best height reached, in tiles. 0 otherwise. */
  height: number;
}

export type SimEvent =
  | { type: 'phase'; phase: SimPhase }
  | { type: 'jump'; x: number; y: number; air: boolean }
  | { type: 'land'; x: number; y: number; impact: number }
  | { type: 'dash'; x: number; y: number; dx: number; dy: number }
  | { type: 'dashEnd'; x: number; y: number }
  | { type: 'wallJump'; x: number; y: number; dir: -1 | 1 }
  | { type: 'wallSlide'; x: number; y: number; dir: -1 | 1 }
  | { type: 'stomp'; x: number; y: number }
  | { type: 'stompLand'; x: number; y: number }
  | { type: 'shard'; x: number; y: number; n: number; total: number; combo: number }
  | { type: 'relic'; x: number; y: number; n: number; total: number }
  | { type: 'crystal'; x: number; y: number }
  | { type: 'toggle'; x: number; y: number; switchA: boolean }
  | { type: 'checkpoint'; x: number; y: number }
  | { type: 'spring'; x: number; y: number }
  | { type: 'hurt'; x: number; y: number; hp: number }
  | { type: 'death'; x: number; y: number; cause: string; deaths: number }
  | { type: 'respawn'; x: number; y: number }
  | { type: 'goal'; x: number; y: number; summary: RunSummary }
  | { type: 'foeHit'; x: number; y: number; kind: FoeKind }
  | { type: 'foeKilled'; x: number; y: number; kind: FoeKind }
  | { type: 'bolt'; x: number; y: number }
  | { type: 'crumble'; tx: number; ty: number }
  | { type: 'splash'; x: number; y: number; enter: boolean }
  | { type: 'tideOver'; summary: RunSummary };

// ---------------------------------------------------------------- sim api
export interface SimOptions {
  seed?: number;
  /** Softer gravity, a third jump, shorter dash cooldown. Runs with assist are not leaderboard-eligible. */
  assist?: boolean;
  /** Debug only; never set by replays. */
  invincible?: boolean;
}

// ---------------------------------------------------------------- replay
export interface Replay {
  /** SIM_VERSION the log was recorded against. */
  v: number;
  levelId: string;
  seed: number;
  assist: boolean;
  /** One InputMask per tick, from the first tick of 'intro'. */
  masks: Uint8Array;
}

export interface VerifyResult {
  ok: boolean;
  /** Set when !ok: 'sim-version' | 'too-long' | 'not-finished' | 'claim-mismatch' | 'bad-level' | 'assist' */
  reason?: string;
  summary: RunSummary;
}

/** The fields of a RunSummary a client may claim; the server recomputes all of them. */
export type RunClaim = Pick<RunSummary, 'ticks' | 'shards' | 'deaths' | 'cleared' | 'height'>;
