/**
 * Tower-climbing cat, rabbit and robot — drawn procedurally every frame.
 *
 * A rig lets the silhouette deform continuously (squash on landing, stretch at
 * take-off, lean into acceleration, legs that actually reach for the ground)
 * and stays sharp at any resolution. A baked sprite can only ever show the
 * poses you drew.
 *
 * Local space: origin at the feet, +y down; ears/antennae reach ~21–26 units up.
 * The rig state is assembled by the renderer from PlayerState plus its own
 * visual-only timers (squash, blink, anim phase); the sim knows none of this.
 *
 * All secondary motion is visual-only and optional on RigState:
 *   expressions   brows + mouth per pose (`expressionFor`), a 0.4 s smile after a
 *                 pickup, X eyes when hurt or dead; idle behaviours (look around,
 *                 stretch) once `idle` passes IDLE_AFTER
 *   secondary     `stalk` — ear spring offsets lagging acceleration;
 *                 `chain` — a CHAIN_N-point scarf simulated by PlayerVisual
 *   accessories   `Skin.accessory` drawn by the rig and the portrait alike
 * The original skin ids and palette fields stay stable for saved costumes.
 * test/fixtures/clawd-baseline.json pins the cat's idle and portrait call logs.
 */
import { TAU, alpha, clamp, clamp01, mixHex } from './stage.js';
import { PORTRAIT_FEET } from '../contracts.js';

/** Visual-only costume piece; 'none' / missing draws the cat without a costume. */
export type SkinAccessory = 'none' | 'scarf' | 'antenna' | 'crown' | 'fins' | 'hood' | 'halo' | 'goggles';

/** Every accessory value, for tests and tooling. */
export const SKIN_ACCESSORIES: readonly SkinAccessory[] = ['none', 'scarf', 'antenna', 'crown', 'fins', 'hood', 'halo', 'goggles'];

export type CharacterKind = 'cat' | 'rabbit' | 'robot';

export interface Skin {
  id: string; name: string; kr: string;
  /** Geometry independent of the palette; older costumes default to the cat. */
  character?: CharacterKind;
  /** Fur or metal palette; the original keys remain shared with trails and costumes. */
  shell: string; shellHi: string; shellLo: string;
  belly: string; limb: string; eye: string; pupil: string;
  glow: string;
  /** Costume piece; robots keep their antenna by default. */
  accessory?: SkinAccessory;
  /** Accessory / trail colour; defaults to `glow`. */
  trim?: string;
}

export const SKINS: Record<string, Skin> = {
  clawd: {
    id: 'clawd', name: 'CLAWD', kr: '클로드',
    shell: '#E8825C', shellHi: '#FFC09B', shellLo: '#A8422F',
    belly: '#FFD9C0', limb: '#C4553D', eye: '#FFFFFF', pupil: '#1A1020',
    glow: '#FFB088', accessory: 'scarf', trim: '#65E4D4',
  },
  rabbit: {
    id: 'rabbit', name: 'BUNNY', kr: '토끼', character: 'rabbit',
    shell: '#F6EEE8', shellHi: '#FFFFFF', shellLo: '#B884A3',
    belly: '#FFF7F3', limb: '#C396AE', eye: '#FFFFFF', pupil: '#48243D',
    glow: '#FFD4E5', accessory: 'scarf', trim: '#ED91B0',
  },
  robot: {
    id: 'robot', name: 'ROBOT', kr: '로봇', character: 'robot',
    shell: '#75BFCB', shellHi: '#DDF9F4', shellLo: '#2C637D',
    belly: '#A7F5DF', limb: '#34556F', eye: '#A9FFF1', pupil: '#102939',
    glow: '#75F5E1', accessory: 'antenna', trim: '#8EFFD9',
  },
  azure: {
    id: 'azure', name: 'AMAZONI', kr: '아마조니',
    shell: '#5BB8FF', shellHi: '#C4EAFF', shellLo: '#245E9A',
    belly: '#E4F6FF', limb: '#2F6FAF', eye: '#FFFFFF', pupil: '#0A1830',
    glow: '#8FE6FF',
  },
  ember: {
    id: 'ember', name: 'EMBER', kr: '엠버',
    shell: '#FF6B4A', shellHi: '#FFD08A', shellLo: '#8E1F14',
    belly: '#FFE0B0', limb: '#B33218', eye: '#FFF3D0', pupil: '#200A06',
    glow: '#FF9A5A',
  },
  void: {
    id: 'void', name: 'VOID', kr: '보이드',
    shell: '#6B5CC4', shellHi: '#B9A8FF', shellLo: '#2C2258',
    belly: '#D8CEFF', limb: '#3E3178', eye: '#E6FFFA', pupil: '#0B0716',
    glow: '#A78BFA',
  },
  // ---- Phase 5 (P5-2): four costume skins; unlock rules live in src/client/unlocks.ts
  coral: {
    id: 'coral', name: 'CORAL', kr: '코랄',
    shell: '#FF7E8F', shellHi: '#FFD1D8', shellLo: '#B03050',
    belly: '#FFE6EA', limb: '#C94468', eye: '#FFFFFF', pupil: '#2A0E1E',
    glow: '#FFA3B8', accessory: 'fins', trim: '#FFE0B8',
  },
  frost: {
    id: 'frost', name: 'FROST', kr: '프로스트',
    shell: '#9ED9F2', shellHi: '#F0FBFF', shellLo: '#3F7FA8',
    belly: '#F4FCFF', limb: '#4E8AB4', eye: '#FFFFFF', pupil: '#0F2438',
    glow: '#CFF3FF', accessory: 'hood', trim: '#5F9FD0',
  },
  gold: {
    id: 'gold', name: 'GOLD', kr: '골드',
    shell: '#F2B93B', shellHi: '#FFF0B0', shellLo: '#9A6210',
    belly: '#FFF3CC', limb: '#B87A1C', eye: '#FFFFFF', pupil: '#2A1A08',
    glow: '#FFD966', accessory: 'crown', trim: '#FFF2A8',
  },
  nova: {
    id: 'nova', name: 'NOVA', kr: '노바',
    shell: '#DCCBFF', shellHi: '#FFFFFF', shellLo: '#7C5CC9',
    belly: '#FFFFFF', limb: '#8F72D8', eye: '#FFFFFF', pupil: '#221244',
    glow: '#F2E8FF', accessory: 'halo', trim: '#FFF6C8',
  },
};

export function skinById(id: string | undefined): Skin {
  return (id && SKINS[id]) || SKINS.clawd;
}

// ---------------------------------------------------------------- eye lead (P3-9)
/** The goal draws Clawd's eyes from this many tiles away. */
export const GOAL_LOOK_TILES = 6;
/** How much of the pupil offset the look target takes over from the velocity lead. */
export const LOOK_WEIGHT = 0.7;

/**
 * A point of interest the eyes lead toward, as a unit-ish direction (-1..1 per
 * axis) — the goal within GOAL_LOOK_TILES. Module state on purpose: the rig is
 * assembled by the player visual (which knows nothing about the level), so the
 * renderer sets the target right before the live player's draw and clears it
 * right after; echoes and portraits, drawn outside that window, never see it.
 */
let look: { x: number; y: number } | null = null;
export function setLookTarget(t: { x: number; y: number } | null): void { look = t; }
export function lookTarget(): { x: number; y: number } | null { return look; }

/** Echo palettes retain the chosen geometry, cached by colour and character. */
const tintCache = new Map<string, Skin>();
export function tintedSkin(color: string, character: CharacterKind = 'cat'): Skin {
  const key = `${character}:${color}`;
  let s = tintCache.get(key);
  if (s) return s;
  s = {
    id: `echo:${key}`, name: 'ECHO', kr: '메아리', character,
    shell: color,
    shellHi: mixHex(color, '#ffffff', 0.45),
    shellLo: mixHex(color, '#000000', 0.4),
    belly: mixHex(color, '#ffffff', 0.65),
    limb: mixHex(color, '#000000', 0.25),
    eye: mixHex(color, '#ffffff', 0.85),
    pupil: mixHex(color, '#000000', 0.7),
    glow: color,
  };
  tintCache.set(key, s);
  return s;
}

export type RigPose = 'idle' | 'run' | 'jump' | 'fall' | 'dash' | 'wall' | 'stomp' | 'hurt' | 'swim' | 'dead' | 'crouch';

/** Every pose, for tests and tooling. */
export const RIG_POSES: readonly RigPose[] = ['idle', 'run', 'jump', 'fall', 'dash', 'wall', 'stomp', 'hurt', 'swim', 'dead', 'crouch'];

// ---------------------------------------------------------------- Phase 5 constants
/** Seconds standing still before the idle behaviours (look around, stretch) start. */
export const IDLE_AFTER = 4;
/** Period of the idle stretch once the behaviours run, how long into each period it starts (after the 1 s ramp) and how long it lasts. */
export const STRETCH_PERIOD = 7;
export const STRETCH_DELAY = 1;
export const STRETCH_T = 1.4;
/** How long the pickup smile lasts (seconds; RigState.smile is the 0..1 remainder). */
export const SMILE_T = 0.4;
/** Scarf chain: point count and rest length between points (world units). */
export const CHAIN_N = 5;
export const CHAIN_SEG = 2.4;
/** Where the scarf hangs from, as an offset from the feet: `dx` is multiplied by -facing (behind the neck). */
export const CHAIN_ANCHOR = { dx: 3.2, dy: -6.2 } as const;

export interface RigState {
  /** Feet position in the current user space. */
  x: number; y: number;
  vx: number; vy: number;
  grounded: boolean;
  facing: 1 | -1;
  state: RigPose;
  /** Visual clock (seconds). */
  t: number;
  /** Run-cycle phase (advances with ground speed). */
  anim: number;
  /** >0 squashed (wide), <0 stretched (tall). */
  squash: number;
  invuln: number;
  /** 0 open .. 1 closed. */
  blink: number;
  skin: Skin;
  dashReady: boolean;
  /** 0..1 pulse when the dash refills. */
  dashFlash: number;
  deadSpin?: number;
  alpha?: number;
  /** Seconds standing still (PlayerVisual); idle behaviours start at IDLE_AFTER. Missing = 0. */
  idle?: number;
  /** 0..1 remainder of the pickup smile (1 right after the pickup). Missing = 0. */
  smile?: number;
  /** Ear spring offsets [x0, y0, x1, y1] in rig units (the tips lag acceleration). Missing = velocity drag only. */
  stalk?: ArrayLike<number>;
  /** Scarf chain, CHAIN_N points as [x, y, …] offsets from the feet in unrotated world units. Missing = a static drape. */
  chain?: ArrayLike<number>;
}

// ---------------------------------------------------------------- expressions
export type Brow = 'none' | 'focus' | 'raise' | 'sad';
export type Mouth = 'none' | 'smile' | 'o' | 'grit' | 'open' | 'flat';
export interface Expression { brow: Brow; mouth: Mouth; xEyes: boolean }

const EXPRESSIONS: Readonly<Record<RigPose, Expression>> = {
  idle: { brow: 'none', mouth: 'none', xEyes: false },
  run: { brow: 'focus', mouth: 'none', xEyes: false },
  jump: { brow: 'raise', mouth: 'none', xEyes: false },
  fall: { brow: 'raise', mouth: 'o', xEyes: false },
  dash: { brow: 'focus', mouth: 'grit', xEyes: false },
  wall: { brow: 'focus', mouth: 'none', xEyes: false },
  stomp: { brow: 'focus', mouth: 'grit', xEyes: false },
  hurt: { brow: 'sad', mouth: 'open', xEyes: true },
  swim: { brow: 'none', mouth: 'o', xEyes: false },
  dead: { brow: 'none', mouth: 'flat', xEyes: true },
  crouch: { brow: 'focus', mouth: 'none', xEyes: false },
};
/** Poses whose mouth the pickup smile may take over (a dash grits its teeth, a fall gasps, the hurt stay hurt). */
const SMILE_POSES: ReadonlySet<RigPose> = new Set(['idle', 'run', 'jump', 'wall', 'crouch']);
const SMILE_EXPR: Readonly<Record<Brow, Expression>> = {
  none: { brow: 'none', mouth: 'smile', xEyes: false },
  focus: { brow: 'focus', mouth: 'smile', xEyes: false },
  raise: { brow: 'raise', mouth: 'smile', xEyes: false },
  sad: { brow: 'sad', mouth: 'smile', xEyes: false },
};

/**
 * The face for a pose: run focuses, a fall gasps, a dash grits, hurt and dead
 * cross the eyes out; a smile (`smile` > 0, the pickup remainder) replaces the
 * mouth of the relaxed poses. Idle with no smile keeps the cat's neutral muzzle.
 */
export function expressionFor(state: RigPose, smile = 0): Expression {
  const e = EXPRESSIONS[state] ?? EXPRESSIONS.idle;
  return smile > 0 && SMILE_POSES.has(state) ? SMILE_EXPR[e.brow] : e;
}

// ---------------------------------------------------------------- accessory palette
interface AccessoryPalette { trim: string; trimHi: string; trimLo: string; trimEdge: string }
const accCache = new Map<string, AccessoryPalette>();
/** Trim shades for a skin, cached by skin id so the rig allocates no colour strings per frame. */
function accessoryPalette(sk: Skin): AccessoryPalette {
  let p = accCache.get(sk.id);
  if (p) return p;
  const trim = sk.trim ?? sk.glow;
  p = {
    trim,
    trimHi: mixHex(trim, '#ffffff', 0.5),
    trimLo: mixHex(trim, '#000000', 0.35),
    trimEdge: alpha(mixHex(trim, '#000000', 0.55), 0.6),
  };
  accCache.set(sk.id, p);
  return p;
}

const HEAD_Y = -11.2;
const HEAD_RX = 6.3;
const HEAD_RY = 5.4;

function idleStretch(s: RigState): number {
  const idle = s.idle ?? 0;
  const k = idle > IDLE_AFTER ? clamp01(idle - IDLE_AFTER) : 0;
  if (k === 0 || s.state !== 'idle') return 0;
  const u = (idle - IDLE_AFTER) % STRETCH_PERIOD - STRETCH_DELAY;
  return u >= 0 && u < STRETCH_T ? Math.sin(Math.PI * u / STRETCH_T) * k : 0;
}

/** The rig and its label must use the same squash, stretch and lean. */
function rigTransform(s: RigState, stretch: number): { sx: number; sy: number; lean: number } {
  let sx = 1, sy = 1;
  if (s.squash > 0) { sx = 1 + s.squash * 0.55; sy = 1 - s.squash * 0.42; }
  else if (s.squash < 0) { sx = 1 + s.squash * 0.32; sy = 1 - s.squash * 0.52; }
  if (!s.grounded) {
    const v = clamp(s.vy / 420, -0.5, 0.7);
    sx *= 1 - v * 0.1;
    sy *= 1 + v * 0.12;
  }
  if (s.state === 'dash') { sx *= 1.3; sy *= 0.78; }
  if (s.state === 'crouch') { sx *= 1.22; sy *= 0.7; }
  if (s.state === 'stomp') { sx *= 0.86; sy *= 1.16; }
  if (stretch > 0) { sx *= 1 - stretch * 0.07; sy *= 1 + stretch * 0.15; }
  const lean = clamp(s.vx / 220, -1, 1) * 0.2 + (s.state === 'dash' ? s.facing * 0.16 : 0);
  return { sx, sy, lean };
}

/** Conservative animated headroom in world units, including ear/antenna motion. */
export function characterHeadroom(s: RigState): number {
  const { sx, sy, lean } = rigTransform(s, idleStretch(s));
  const character = s.skin.character ?? 'cat';
  let height = character === 'rabbit' ? 28 : character === 'robot' ? 27 : 24;
  if (s.skin.accessory === 'antenna') height = Math.max(height, 27);
  const rotation = lean + (s.deadSpin ?? 0);
  return Math.abs(sy * Math.cos(rotation)) * height + Math.abs(sx * Math.sin(rotation)) * 16;
}

/** Rounded cheeks, with a flatter forehead between the pointed ears. */
function headPath(ctx: CanvasRenderingContext2D, rx: number, ry: number, n = 2.5): void {
  ctx.beginPath();
  const steps = 30;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * TAU;
    const ca = Math.cos(a), sa = Math.sin(a);
    const x = Math.sign(ca) * Math.pow(Math.abs(ca), 2 / n) * rx;
    const y = Math.sign(sa) * Math.pow(Math.abs(sa), 2 / n) * ry;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/** Add an oval subpath without connecting it to the previous silhouette part. */
function silhouetteOval(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, rotation = 0): void {
  ctx.moveTo(x + Math.cos(rotation) * rx, y + Math.sin(rotation) * rx);
  ctx.ellipse(x, y, rx, ry, rotation, 0, TAU);
}

/** Lightweight character outline for dash afterimages, in feet space, using the current fill. */
export function drawClawdSilhouette(ctx: CanvasRenderingContext2D, facing: number, character: CharacterKind = 'cat'): void {
  const face = facing >= 0 ? 1 : -1;
  if (character !== 'cat') {
    ctx.beginPath();
    if (character === 'rabbit') {
      silhouetteOval(ctx, -face * 5.7, -3.2, 2.2, 2.2);
      silhouetteOval(ctx, 0, -4.5, 4.5, 4);
      silhouetteOval(ctx, 0, HEAD_Y, HEAD_RX, HEAD_RY);
      for (const side of [-1, 1]) {
        silhouetteOval(ctx, side * 3 - face, -19.8, 1.7, 4.8, side * 0.12 - face * 0.35);
        silhouetteOval(ctx, side * 2.8, -0.7, 2.2, 0.95);
      }
    } else {
      ctx.roundRect(-4.3, -8.1, 8.6, 7.3, 1.3);
      ctx.roundRect(-HEAD_RX, HEAD_Y - HEAD_RY, HEAD_RX * 2, HEAD_RY * 2, 2);
      ctx.rect(-0.6, HEAD_Y - HEAD_RY - 4.4, 1.2, 4.8);
      silhouetteOval(ctx, 0, HEAD_Y - HEAD_RY - 4.6, 1.3, 1.3);
      for (const side of [-1, 1]) ctx.roundRect(side * 2.8 - 1.9, -1.6, 4.1, 1.8, 0.6);
    }
    ctx.fill();
    return;
  }
  ctx.strokeStyle = ctx.fillStyle;
  ctx.lineWidth = 3.0;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-face * 3, -3);
  ctx.bezierCurveTo(-face * 10.8, -1.7, -face * 13.6, -6.4, -face * 11.4, -9.6);
  ctx.quadraticCurveTo(-face * 8.2, -12.2, -face * 7.9, -9.6);
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(0, -4.5, 4.5, 4.0, 0, 0, TAU);
  ctx.moveTo(HEAD_RX, HEAD_Y);
  ctx.ellipse(0, HEAD_Y, HEAD_RX, HEAD_RY, 0, 0, TAU);
  for (const side of [-1, 1]) {
    ctx.moveTo(side * 1.8, HEAD_Y - HEAD_RY + 1.2);
    // Keep both ears clockwise so their overlap with the head stays filled.
    if (side < 0) {
      ctx.lineTo(side * 5.8, HEAD_Y - 1.8);
      ctx.lineTo(side * 5.6 - face, HEAD_Y - HEAD_RY - 3);
    } else {
      ctx.lineTo(side * 5.6 - face, HEAD_Y - HEAD_RY - 3);
      ctx.lineTo(side * 5.8, HEAD_Y - 1.8);
    }
    ctx.closePath();
    ctx.moveTo(side * 2.8 + 1.8, -0.7);
    ctx.ellipse(side * 2.8, -0.7, 1.8, 0.95, 0, 0, TAU);
  }
  ctx.fill();
}

/**
 * The scarf: CHAIN_N points behind the neck. Drawn in unrotated feet space (the
 * chain was simulated in world units, so the body's lean and squash are undone
 * first); without a simulated chain a static drape hangs from the anchor.
 */
function drawChain(ctx: CanvasRenderingContext2D, s: RigState, pal: AccessoryPalette, lean: number, sx: number, sy: number, headY: number): void {
  const face = s.facing, t = s.t;
  const chain = s.chain;
  ctx.save();
  ctx.translate(0, -headY);
  ctx.scale(1 / sx, 1 / sy);
  ctx.rotate(-lean);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (let pass = 0; pass < 2; pass++) {
    ctx.strokeStyle = pass === 0 ? pal.trim : pal.trimHi;
    ctx.lineWidth = pass === 0 ? 2.3 : 0.8;
    ctx.beginPath();
    for (let i = 0; i < CHAIN_N; i++) {
      let px: number, py: number;
      if (chain && chain.length >= CHAIN_N * 2) {
        px = chain[i * 2]; py = chain[i * 2 + 1];
      } else {
        // static drape: back and down from the anchor, a gentle wave along it
        const k = i / (CHAIN_N - 1);
        px = -face * (CHAIN_ANCHOR.dx + i * CHAIN_SEG * 0.82) + Math.sin(t * 2.6 + i * 0.9) * 0.35 * i;
        py = CHAIN_ANCHOR.dy + k * k * 4.6 + Math.cos(t * 2.1 + i) * 0.22 * i;
      }
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * @param ctx  main buffer
 * @param gctx glow buffer (null → no emissive pass, e.g. portraits and echoes)
 */
export function drawClawd(ctx: CanvasRenderingContext2D, gctx: CanvasRenderingContext2D | null, s: RigState): void {
  const sk = s.skin;
  const character = sk.character ?? 'cat';
  const t = s.t;
  const face = s.facing;
  const air = !s.grounded;
  const st = s.state;
  const acc: SkinAccessory = sk.accessory ?? (character === 'robot' ? 'antenna' : 'none');
  const pal = acc !== 'none' ? accessoryPalette(sk) : null;
  const smile = s.smile ?? 0;
  const expr = expressionFor(st, smile);

  // idle behaviours (P5-2): after IDLE_AFTER seconds still, the eyes wander and every STRETCH_PERIOD a stretch
  const idle = s.idle ?? 0;
  const idleK = idle > IDLE_AFTER ? clamp01(idle - IDLE_AFTER) : 0;
  const stretch = idleStretch(s);

  // ---------- body-space deformation ----------
  const { sx, sy, lean } = rigTransform(s, stretch);
  const bob = s.grounded && Math.abs(s.vx) > 12 ? Math.sin(s.anim * TAU * 2) * 0.7 : 0;
  const breathe = s.grounded && Math.abs(s.vx) < 12 ? Math.sin(t * 2.2) * 0.35 : 0;
  const swimBob = st === 'swim' ? Math.sin(t * 3.1) * 0.8 : 0;

  ctx.save();
  ctx.translate(s.x, s.y);
  if (s.deadSpin) ctx.rotate(s.deadSpin);
  ctx.rotate(lean);
  ctx.scale(sx, sy);

  const flick = s.invuln > 0 ? (Math.sin(s.invuln * 42) > -0.2 ? 1 : 0.28) : 1;
  ctx.globalAlpha *= flick * (s.alpha ?? 1);

  const headY = HEAD_Y + bob + breathe + swimBob;

  // ---------- tails: curled fur for the cat, a cotton puff for the rabbit ----------
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const back = -face;
  const speed = clamp(Math.abs(s.vx) / 240, 0, 1);
  const tailWave = Math.sin(t * 3.2) * (st === 'dash' ? 0.25 : 0.8);
  const tailLift = st === 'stomp' ? -2 : air ? -1 : 0;
  const tailY = bob + breathe + tailLift;
  if (character === 'rabbit') {
    ctx.fillStyle = sk.shellHi;
    ctx.strokeStyle = sk.shellLo;
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.ellipse(back * 5.6, -3.5 + tailY, 2.35, 2.25, 0, 0, TAU);
    ctx.fill(); ctx.stroke();
  } else if (character === 'cat') {
    for (let pass = 0; pass < 2; pass++) {
      ctx.strokeStyle = pass === 0 ? sk.shellLo : sk.shell;
      ctx.lineWidth = pass === 0 ? 3.7 : 2.7;
      ctx.beginPath();
      ctx.moveTo(back * 3.0, -3.0 + tailY);
      ctx.bezierCurveTo(
        back * 10.8, -1.7 + tailY, back * (12.6 + speed), -6.4 + tailY,
        back * (10.4 + speed), -9.6 + tailWave + tailY,
      );
      ctx.quadraticCurveTo(back * 8.2, -12.2 + tailWave + tailY, back * 7.9, -9.6 + tailWave + tailY);
      ctx.stroke();
    }
    ctx.strokeStyle = sk.belly;
    ctx.lineWidth = 2.1;
    ctx.beginPath();
    ctx.moveTo(back * (10.4 + speed), -9.6 + tailWave + tailY);
    ctx.quadraticCurveTo(back * 8.2, -12.2 + tailWave + tailY, back * 7.9, -9.6 + tailWave + tailY);
    ctx.stroke();
  }

  // ---------- two hind paws, reaching for the ground ----------
  const running = s.grounded && Math.abs(s.vx) > 14;
  const gait = s.anim * TAU * 2;
  for (let side = -1; side <= 1; side += 2) {
    const hipX = side * 2.2;
    const hipY = -4.2 + bob;
    const phase = gait + (side > 0 ? 0 : Math.PI);
    let footX = side * 2.8, footY = -0.7;
    if (st === 'wall') {
      footX += face * 1.6;
      footY -= side === face ? 3.2 : 1.4;
    } else if (st === 'swim') {
      footX += Math.sin(t * 6 + side) * 2;
      footY -= 1.2 + Math.cos(t * 6 + side) * 0.7;
    } else if (st === 'stomp') {
      footX = side * 1.9;
    } else if (air) {
      footX += -face * (st === 'dash' ? 2.4 : 0.7);
      footY -= s.vy < 0 ? 2.3 : 1.1;
    } else if (running) {
      footX += Math.cos(phase) * 3.3 * face;
      footY -= Math.max(0, Math.sin(phase)) * 2.4;
    }
    ctx.strokeStyle = sk.limb;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(hipX, hipY);
    ctx.quadraticCurveTo(hipX + side * 0.7, (hipY + footY) / 2, footX, footY);
    ctx.stroke();
    ctx.fillStyle = sk.belly;
    ctx.strokeStyle = sk.shellLo;
    ctx.lineWidth = 0.55;
    ctx.beginPath();
    if (character === 'robot') ctx.roundRect(footX + face * 0.35 - 1.9, footY - 0.9, 4.1, 1.8, 0.6);
    else ctx.ellipse(footX + face * 0.35, footY, character === 'rabbit' ? 2.25 : 1.8, 0.95, -side * 0.1, 0, TAU);
    ctx.fill(); ctx.stroke();
  }

  // ---------- compact torso and cream chest ----------
  const torsoY = -4.5 + bob + breathe;
  const fur = ctx.createLinearGradient(-4.5, torsoY - 4, 4.5, torsoY + 4);
  fur.addColorStop(0, sk.shellHi);
  fur.addColorStop(0.45, sk.shell);
  fur.addColorStop(1, sk.shellLo);
  ctx.fillStyle = fur;
  ctx.strokeStyle = sk.shellLo;
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  if (character === 'robot') ctx.roundRect(-4.3, torsoY - 3.6, 8.6, 7.3, 1.3);
  else ctx.ellipse(0, torsoY, 4.5, 4.0, 0, 0, TAU);
  ctx.fill(); ctx.stroke();
  if (character === 'robot') {
    ctx.fillStyle = sk.pupil;
    ctx.beginPath(); ctx.roundRect(-2.7, torsoY - 1.8, 5.4, 3.8, 0.7); ctx.fill();
    ctx.fillStyle = sk.glow;
    ctx.fillRect(-0.5 + face * 0.2, torsoY - 1.2, 1, 2.6);
    ctx.fillRect(-1.3 + face * 0.2, torsoY - 0.4, 2.6, 1);
  } else {
    ctx.fillStyle = sk.belly;
    ctx.beginPath();
    ctx.ellipse(face * 0.4, torsoY + 0.9, 2.6, 2.7, 0, 0, TAU);
    ctx.fill();
  }

  // ---------- front paws: swing, reach, paddle and stretch ----------
  for (let side = -1; side <= 1; side += 2) {
    const shoulderX = side * 3.7, shoulderY = torsoY - 1.7;
    let pawX = side * 5.0, pawY = torsoY + 1.6;
    if (st === 'dash') {
      pawX = face * (side === face ? 9 : 5.8); pawY = torsoY - 3;
    } else if (st === 'wall') {
      pawX = face * 7.8; pawY = torsoY - (side === face ? 7 : 3.5);
    } else if (st === 'stomp') {
      pawX = side * 5.8; pawY = torsoY - 5;
    } else if (st === 'hurt' || st === 'dead') {
      pawX = side * 7.2; pawY = torsoY - 3.8;
    } else if (st === 'swim') {
      pawX = side * (6.2 + Math.sin(t * 6 + side));
      pawY = torsoY + Math.cos(t * 6 + side) * 2;
    } else if (air) {
      pawX = side * 6.1; pawY = torsoY - (s.vy < 0 ? 5.0 : 3.4);
    } else if (running) {
      pawX += Math.sin(gait + side) * 1.5;
      pawY -= Math.sin(gait + side) * face * 1.8;
    }
    if (stretch > 0) {
      pawX += side * stretch;
      pawY -= stretch * 14;
    }
    ctx.strokeStyle = sk.limb;
    ctx.lineWidth = 2.3;
    ctx.beginPath();
    ctx.moveTo(shoulderX, shoulderY);
    ctx.quadraticCurveTo(side * 5.6, (shoulderY + pawY) / 2, pawX, pawY);
    ctx.stroke();
    ctx.fillStyle = sk.belly;
    ctx.strokeStyle = sk.shellLo;
    ctx.lineWidth = 0.55;
    ctx.beginPath();
    if (character === 'robot') ctx.roundRect(pawX - 1.7, pawY - 1.6, 3.4, 3.2, 0.75);
    else ctx.ellipse(pawX, pawY, 1.65, 1.8, side * -0.25, 0, TAU);
    ctx.fill(); ctx.stroke();
  }

  // ---------- head and ears ----------
  ctx.save();
  ctx.translate(0, headY);

  // Costume tails sit behind the head; the simulated scarf remains in feet space.
  if (pal && (acc === 'scarf' || acc === 'hood')) drawChain(ctx, s, pal, lean, sx, sy, headY);
  if (pal && acc === 'fins') drawFins(ctx, s, pal);

  const stalk = s.stalk && s.stalk.length >= 4 ? s.stalk : null;
  for (const side of [-1, 1]) {
    if (character === 'robot') continue;
    const i = side < 0 ? 0 : 2;
    const drag = clamp(-s.vx / 320 + (stalk ? stalk[i] / 7 : 0), -1.1, 1.1);
    const lift = stalk ? clamp(stalk[i + 1] / 6, -1, 1) : 0;
    const fold = st === 'dash' || st === 'hurt' || st === 'dead' ? 1.1 : 0;
    if (character === 'rabbit') {
      const earX = side * 3.2 + drag * 0.8;
      const earY = -HEAD_RY - 3.4 + lift * 0.5 + fold - stretch * 0.4;
      const angle = side * 0.12 + drag * 0.3 - face * fold * 0.45;
      ctx.fillStyle = sk.shellHi;
      ctx.strokeStyle = sk.shellLo;
      ctx.lineWidth = 0.65;
      ctx.beginPath(); ctx.ellipse(earX, earY, 1.75, 5.1, angle, 0, TAU); ctx.fill(); ctx.stroke();
      ctx.fillStyle = sk.trim ?? sk.shellLo;
      ctx.beginPath(); ctx.ellipse(earX, earY - 0.15, 0.8, 3.9, angle, 0, TAU); ctx.fill();
      continue;
    }
    const tipX = side * 5.6 + drag * 1.5;
    const tipY = -HEAD_RY - 4.1 + lift * 0.8 + fold - stretch * 0.6 + Math.sin(t * 3 + side) * 0.15;
    ctx.fillStyle = sk.shell;
    ctx.strokeStyle = sk.shellLo;
    ctx.lineWidth = 0.65;
    ctx.beginPath();
    ctx.moveTo(side * 1.8, -HEAD_RY + 1.2);
    ctx.lineTo(tipX, tipY);
    ctx.quadraticCurveTo(side * 7.2 + drag, -HEAD_RY - 0.3, side * 5.8, -1.8);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = sk.belly;
    ctx.beginPath();
    ctx.moveTo(side * 3.3, -HEAD_RY + 0.2);
    ctx.lineTo(tipX, tipY + 1.5);
    ctx.lineTo(side * 5.4 + drag * 0.25, -HEAD_RY + 0.8);
    ctx.closePath(); ctx.fill();
  }

  const bg = ctx.createLinearGradient(-HEAD_RX, -HEAD_RY, HEAD_RX * 0.4, HEAD_RY);
  bg.addColorStop(0, sk.shellHi);
  bg.addColorStop(0.42, sk.shell);
  bg.addColorStop(1, sk.shellLo);
  const headRoundness = character === 'robot' ? 4 : 2.4;
  headPath(ctx, HEAD_RX, HEAD_RY, headRoundness);
  ctx.fillStyle = bg;
  ctx.fill();

  if (character === 'robot') {
    // A dark screen makes the robot's LED eyes distinct from the animal faces.
    ctx.fillStyle = sk.pupil;
    ctx.beginPath(); ctx.roundRect(-5.25, -4.3, 10.5, 5.6, 1.5); ctx.fill();
    ctx.strokeStyle = sk.shellLo;
    ctx.lineWidth = 0.65;
    ctx.stroke();
  } else {
    // Cream muzzle, with a small nose and whiskers that read at gameplay size.
    ctx.beginPath();
    ctx.ellipse(face * 0.55, 1.9, HEAD_RX * 0.62, HEAD_RY * 0.47, 0, 0, TAU);
    ctx.fillStyle = sk.belly;
    ctx.fill();
  }

  // Short tabby marks on the forehead.
  if (character === 'cat') {
    ctx.strokeStyle = alpha(sk.shellLo, 0.65);
    ctx.lineWidth = 0.85;
    for (const x of [-1.7, 0, 1.7]) {
      ctx.beginPath();
      ctx.moveTo(x, -HEAD_RY + 0.4);
      ctx.lineTo(x * 0.8, -HEAD_RY + (x === 0 ? 2.0 : 1.5));
      ctx.stroke();
    }
  }

  // rim light along the upper-left arc
  ctx.save();
  headPath(ctx, HEAD_RX, HEAD_RY, headRoundness);
  ctx.clip();
  const rl = ctx.createLinearGradient(-HEAD_RX, -HEAD_RY, 0, 0);
  rl.addColorStop(0, alpha('#ffffff', 0.5));
  rl.addColorStop(0.55, alpha('#ffffff', 0));
  ctx.fillStyle = rl;
  ctx.fillRect(-HEAD_RX, -HEAD_RY, HEAD_RX * 2, HEAD_RY * 2);
  ctx.restore();

  // outline keeps the silhouette readable against busy terrain
  headPath(ctx, HEAD_RX, HEAD_RY, headRoundness);
  ctx.strokeStyle = alpha(mixHex(sk.shellLo, '#000000', 0.45), 0.55);
  ctx.lineWidth = 0.7;
  ctx.stroke();

  // accessories on the head: crown, hood, the tall antenna, the halo
  if (pal) {
    if (acc === 'crown') drawCrown(ctx, sk, pal);
    else if (acc === 'hood') drawHood(ctx, s, pal);
    else if (acc === 'antenna') drawAntenna(ctx, s, pal);
    else if (acc === 'halo') drawHalo(ctx, s, pal);
    else if (acc === 'goggles') drawGoggleStrap(ctx, pal);
  }

  // ---------- eyes ----------
  const blink = s.blink;
  const eyeY = -1.9;
  const squint = st === 'dash' ? 0.55 : st === 'hurt' ? 0.7 : st === 'stomp' ? 0.35 : 0;
  const xEyes = expr.xEyes;
  for (const side of [-1, 1]) {
    const ex = side * 2.6 + face * 0.7;
    const rx = 1.9, ry = 2.05 * (1 - blink) * (1 - squint * 0.55);
    if (ry < 0.22 || xEyes) {
      ctx.strokeStyle = character === 'robot' ? sk.eye : sk.pupil;
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      if (xEyes) {
        ctx.moveTo(ex - 1.2, eyeY - 1.2); ctx.lineTo(ex + 1.2, eyeY + 1.2);
        ctx.moveTo(ex + 1.2, eyeY - 1.2); ctx.lineTo(ex - 1.2, eyeY + 1.2);
      } else {
        ctx.moveTo(ex - rx * 0.8, eyeY); ctx.lineTo(ex + rx * 0.8, eyeY);
      }
      ctx.stroke();
      continue;
    }
    if (character !== 'robot') {
      ctx.fillStyle = sk.eye;
      ctx.beginPath(); ctx.ellipse(ex, eyeY, rx, ry, 0, 0, TAU); ctx.fill();
    }

    // pupil leads the movement — reads as intent; near the goal the eyes lead there instead (P3-9)
    let px = clamp(s.vx / 240, -1, 1) * 0.85 + face * 0.5;
    let py = clamp(s.vy / 340, -1, 1) * 0.7;
    if (look && st !== 'dash' && st !== 'hurt') {
      px = px * (1 - LOOK_WEIGHT) + clamp(look.x, -1, 1) * 1.05 * LOOK_WEIGHT;
      py = py * (1 - LOOK_WEIGHT) + clamp(look.y, -1, 1) * 0.8 * LOOK_WEIGHT;
    }
    // idle look-around: the pupils wander slowly once the behaviours run
    if (idleK > 0 && !look) {
      px += Math.sin(t * 1.1) * 1.0 * idleK;
      py += (Math.cos(t * 0.7) * 0.35 - 0.2) * idleK;
    }
    px = clamp(px, -rx * 0.45, rx * 0.45);
    py = clamp(py, -ry * 0.4, ry * 0.4);
    if (character === 'robot') {
      ctx.fillStyle = sk.eye;
      ctx.beginPath();
      ctx.roundRect(ex - 1.1 + px * 0.45, eyeY - ry * 0.6 + py * 0.4, 2.2, ry * 1.2, 0.4);
      ctx.fill();
      continue;
    }
    ctx.fillStyle = sk.pupil;
    ctx.beginPath();
    ctx.ellipse(ex + px, eyeY + py, rx * 0.5, ry * 0.52, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = alpha('#ffffff', 0.9);
    ctx.beginPath();
    ctx.arc(ex + px - 0.6, eyeY + py - 0.7, 0.42, 0, TAU);
    ctx.fill();
  }

  const noseX = face * 0.7;
  if (character === 'robot') {
    ctx.fillStyle = sk.eye;
    if (expr.mouth === 'o' || expr.mouth === 'open') {
      ctx.beginPath(); ctx.ellipse(noseX, 2.65, 0.85, 0.85, 0, 0, TAU); ctx.fill();
    } else {
      for (let i = -1; i <= 1; i++) ctx.fillRect(noseX + i * 1.05 - 0.35, 2.4 + (smile > 0 ? (i === 0 ? 0.3 : 0) : 0), 0.7, 0.6);
    }
  } else {
    ctx.fillStyle = character === 'rabbit' ? sk.trim ?? sk.shellLo : sk.pupil;
    ctx.beginPath();
    ctx.moveTo(noseX - 0.8, 0.6);
    ctx.lineTo(noseX + 0.8, 0.6);
    ctx.quadraticCurveTo(noseX + 0.6, 1.3, noseX, 1.4);
    ctx.quadraticCurveTo(noseX - 0.6, 1.3, noseX - 0.8, 0.6);
    ctx.fill();
    ctx.strokeStyle = alpha(sk.pupil, 0.7);
    ctx.lineWidth = 0.45;
    for (const side of [-1, 1]) {
      for (const y of [0.7, 2.0]) {
        ctx.beginPath();
        ctx.moveTo(noseX + side * 3.1, y);
        ctx.lineTo(noseX + side * 6.6, y + (y < 1 ? -0.6 : 0.5));
        ctx.stroke();
      }
    }

    // ---------- expression: brows and mouth ----------
    if (expr.brow !== 'none') drawBrows(ctx, sk, face, eyeY, expr.brow);
    if (expr.mouth !== 'none') drawMouth(ctx, sk, face, expr.mouth, smile);
    else {
      ctx.strokeStyle = sk.pupil;
      ctx.lineWidth = 0.55;
      ctx.beginPath();
      ctx.moveTo(noseX, 1.4);
      ctx.quadraticCurveTo(noseX - 0.3, 2.6, noseX - 1.5, 2.0);
      ctx.moveTo(noseX, 1.4);
      ctx.quadraticCurveTo(noseX + 0.3, 2.6, noseX + 1.5, 2.0);
      ctx.stroke();
    }
    if (character === 'rabbit' && (expr.mouth === 'none' || expr.mouth === 'smile')) {
      ctx.fillStyle = sk.eye;
      ctx.strokeStyle = sk.shellLo;
      ctx.lineWidth = 0.3;
      ctx.beginPath(); ctx.rect(noseX - 0.8, 2.0, 1.6, 1.5); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(noseX, 2.0); ctx.lineTo(noseX, 3.4); ctx.stroke();
    }
  }

  // accessories over the face: goggle lenses, the scarf collar
  if (pal) {
    if (acc === 'goggles') drawGoggles(ctx, pal, face, eyeY);
    else if (acc === 'scarf') drawCollar(ctx, pal, face);
  }
  ctx.restore();  // body translate
  ctx.restore();  // outer

  // ---------- emissive pass ----------
  if (gctx) {
    const strength =
      st === 'dash' ? 0.85 :
      s.dashReady && s.dashFlash > 0 ? 0.5 * s.dashFlash :
      s.invuln > 0 ? 0.3 : 0.12;
    if (strength > 0.02) {
      gctx.save();
      gctx.globalAlpha *= strength * (s.alpha ?? 1);
      gctx.fillStyle = sk.glow;
      gctx.beginPath();
      gctx.ellipse(s.x, s.y + HEAD_Y, HEAD_RX * 1.5, HEAD_RY * 1.7, 0, 0, TAU);
      gctx.fill();
      gctx.restore();
    }
    // glowing accessories: the halo ring and the antenna bulb (approximate, ignoring lean and squash)
    if (pal && (acc === 'halo' || acc === 'antenna')) {
      gctx.save();
      gctx.globalAlpha *= 0.55 * (s.alpha ?? 1);
      gctx.fillStyle = pal.trim;
      gctx.beginPath();
      if (acc === 'halo') gctx.ellipse(s.x, s.y + HEAD_Y - HEAD_RY - 4.2 + Math.sin(t * 2) * 0.4, 5.2, 2.2, 0, 0, TAU);
      else gctx.arc(s.x - s.vx / 320 * 3, s.y + HEAD_Y - HEAD_RY - 7.6, 2.2, 0, TAU);
      gctx.fill();
      gctx.restore();
    }
  }
}

// ---------------------------------------------------------------- face parts
function drawBrows(ctx: CanvasRenderingContext2D, sk: Skin, face: number, eyeY: number, brow: Brow): void {
  ctx.strokeStyle = sk.shellLo;
  ctx.lineWidth = 0.75;
  for (const side of [-1, 1]) {
    const ex = side * 2.6 + face * 0.7;
    const inner = -side;                 // toward the face centre
    let y = eyeY - 3.3, innerDy = 0, outerDy = 0, arch = 0;
    if (brow === 'focus') { y += 0.5; innerDy = 0.7; }
    else if (brow === 'raise') { y -= 0.9; arch = -0.8; }
    else { innerDy = -0.8; outerDy = 0.2; }   // sad: inner ends up
    const x0 = ex - inner * 1.7, x1 = ex + inner * 1.7;
    ctx.beginPath();
    ctx.moveTo(x0, y + outerDy);
    ctx.quadraticCurveTo(ex, y + arch + (innerDy + outerDy) / 2, x1, y + innerDy);
    ctx.stroke();
  }
}

function drawMouth(ctx: CanvasRenderingContext2D, sk: Skin, face: number, mouth: Mouth, smile: number): void {
  const mx = face * 0.7;
  const col = alpha(sk.pupil, 0.85);
  ctx.strokeStyle = col;
  ctx.fillStyle = col;
  ctx.lineWidth = 0.7;
  switch (mouth) {
    case 'smile': {
      const k = Math.min(1, smile * 2.5);      // holds, then fades over the last part of SMILE_T
      const w = 0.6 + 1.7 * k;
      ctx.beginPath();
      ctx.moveTo(mx - w, 1.8);
      ctx.quadraticCurveTo(mx, 1.8 + 1.6 * k, mx + w, 1.8);
      ctx.stroke();
      return;
    }
    case 'o':
      ctx.beginPath(); ctx.ellipse(mx, 2.3, 0.75, 0.95, 0, 0, TAU); ctx.fill();
      return;
    case 'grit':
      ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.moveTo(mx - 1.7, 2.4); ctx.lineTo(mx + 1.7, 2.4); ctx.stroke();
      ctx.fillStyle = alpha(sk.eye, 0.9);
      ctx.fillRect(mx - 1.1, 1.85, 0.7, 0.55);
      ctx.fillRect(mx + 0.3, 1.85, 0.7, 0.55);
      return;
    case 'open':
      ctx.beginPath(); ctx.ellipse(mx, 2.5, 1.15, 1.1, 0, 0, TAU); ctx.fill();
      return;
    case 'flat':
      ctx.beginPath(); ctx.moveTo(mx - 1.2, 2.4); ctx.lineTo(mx + 1.2, 2.4); ctx.stroke();
      return;
    default:
      return;
  }
}

// ---------------------------------------------------------------- accessories (origin at the head centre)
/** Coral: a dorsal fin along the top-back and two side fins, fluttering with speed. */
function drawFins(ctx: CanvasRenderingContext2D, s: RigState, pal: AccessoryPalette): void {
  const face = s.facing, t = s.t;
  const flutter = Math.sin(t * 7) * (0.4 + Math.min(1, Math.abs(s.vx) / 200) * 0.8);
  ctx.fillStyle = alpha(pal.trim, 0.85);
  ctx.strokeStyle = pal.trimEdge;
  ctx.lineWidth = 0.5;
  // dorsal fin
  const bx = -face * 1.4;
  ctx.beginPath();
  ctx.moveTo(bx + face * 2.6, -HEAD_RY + 1.2);
  ctx.quadraticCurveTo(bx - face * 1.5 + flutter, -HEAD_RY - 4.6, bx - face * 5.4 + flutter * 1.6, -HEAD_RY - 2.2);
  ctx.quadraticCurveTo(bx - face * 4.0, -HEAD_RY, bx - face * 3.2, -HEAD_RY + 2.4);
  ctx.closePath();
  ctx.fill(); ctx.stroke();
  // side fins, upper and lower on the back
  for (const [y0, len, dir] of [[-1.6, 5.2, -1], [2.2, 4.0, 1]] as const) {
    const x0 = -face * HEAD_RX * 0.9;
    ctx.beginPath();
    ctx.moveTo(x0, y0 - 1.2);
    ctx.quadraticCurveTo(x0 - face * len * 0.6, y0 + dir * 2.4 + flutter * 0.8, x0 - face * len, y0 + dir * 0.6 + flutter);
    ctx.quadraticCurveTo(x0 - face * len * 0.5, y0 + 1.4, x0, y0 + 1.6);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
  }
  // rib lines on the dorsal fin
  ctx.strokeStyle = alpha(pal.trimHi, 0.7);
  ctx.lineWidth = 0.4;
  for (let i = 0; i < 3; i++) {
    const k = 0.3 + i * 0.25;
    ctx.beginPath();
    ctx.moveTo(bx + face * (2.2 - k * 5.0), -HEAD_RY + 1.4);
    ctx.lineTo(bx - face * (1.0 + k * 3.6) + flutter * k * 1.6, -HEAD_RY - 4.2 + k * 2.6);
    ctx.stroke();
  }
}

/** Gold: a three-point crown between the ears, gems in the belly colour. */
function drawCrown(ctx: CanvasRenderingContext2D, sk: Skin, pal: AccessoryPalette): void {
  const top = -HEAD_RY - 0.2;
  ctx.fillStyle = pal.trim;
  ctx.strokeStyle = pal.trimEdge;
  ctx.lineWidth = 0.5;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(-3.4, top + 1.2);
  ctx.lineTo(-3.4, top - 2.6);
  ctx.lineTo(-1.7, top - 0.6);
  ctx.lineTo(0, top - 3.6);
  ctx.lineTo(1.7, top - 0.6);
  ctx.lineTo(3.4, top - 2.6);
  ctx.lineTo(3.4, top + 1.2);
  ctx.closePath();
  ctx.fill(); ctx.stroke();
  // band highlight
  ctx.strokeStyle = alpha(pal.trimHi, 0.8);
  ctx.lineWidth = 0.5;
  ctx.beginPath(); ctx.moveTo(-3.0, top + 0.6); ctx.lineTo(3.0, top + 0.6); ctx.stroke();
  // gems
  ctx.fillStyle = sk.pupil;
  for (const gx of [-1.9, 0, 1.9]) { ctx.beginPath(); ctx.arc(gx, top + 0.2, 0.42, 0, TAU); ctx.fill(); }
  ctx.fillStyle = alpha('#ffffff', 0.8);
  ctx.beginPath(); ctx.arc(0, top - 3.6, 0.5, 0, TAU); ctx.fill();
}

/** Frost: a hood over the head and neck, its rim above the eyes, with a soft trim edge. */
function drawHood(ctx: CanvasRenderingContext2D, s: RigState, pal: AccessoryPalette): void {
  const f = s.facing;
  ctx.fillStyle = pal.trim;
  ctx.strokeStyle = pal.trimEdge;
  ctx.lineWidth = 0.6;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(f * 3.0, -3.6);                                                   // front rim, above the eyes
  ctx.quadraticCurveTo(f * 1.6, -HEAD_RY - 2.4, -f * 2.6, -HEAD_RY - 1.8);     // over the top
  ctx.quadraticCurveTo(-f * (HEAD_RX + 2.2), -HEAD_RY - 0.4, -f * (HEAD_RX + 1.2), 2.6);   // down the back
  ctx.quadraticCurveTo(-f * (HEAD_RX - 1.0), 4.4, -f * 2.0, 3.8);              // under the back
  ctx.quadraticCurveTo(-f * 4.2, -1.0, -f * 0.6, -3.2);                        // inner edge back up
  ctx.closePath();
  ctx.fill(); ctx.stroke();
  // fur trim along the rim
  ctx.strokeStyle = pal.trimHi;
  ctx.lineWidth = 1.1;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(f * 3.0, -3.6);
  ctx.quadraticCurveTo(f * 1.0, -6.4, -f * 2.0, -6.8);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-f * 0.6, -3.2);
  ctx.quadraticCurveTo(-f * 3.4, 0.4, -f * 2.0, 3.8);
  ctx.stroke();
}

/** Antenna costume: a headband's tall stalk ends in a pulsing bulb. */
function drawAntenna(ctx: CanvasRenderingContext2D, s: RigState, pal: AccessoryPalette): void {
  const t = s.t;
  const drag = clamp(-s.vx / 320, -1, 1);
  const tipX = drag * 3 + Math.sin(t * 3.4) * 0.3, tipY = -HEAD_RY - 7.6;
  ctx.strokeStyle = pal.trimLo;
  ctx.lineWidth = 0.9;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(0, -HEAD_RY + 0.4);
  ctx.quadraticCurveTo(drag * 1.2, -HEAD_RY - 4.2, tipX, tipY);
  ctx.stroke();
  const pulse = 0.6 + 0.4 * Math.sin(t * 6);
  ctx.fillStyle = pal.trim;
  ctx.beginPath(); ctx.arc(tipX, tipY, 1.1 + pulse * 0.25, 0, TAU); ctx.fill();
  ctx.fillStyle = alpha('#ffffff', 0.5 + pulse * 0.4);
  ctx.beginPath(); ctx.arc(tipX - 0.3, tipY - 0.3, 0.45, 0, TAU); ctx.fill();
}

/** Nova: a floating ring above the head, bobbing slowly, a bright core line along it. */
function drawHalo(ctx: CanvasRenderingContext2D, s: RigState, pal: AccessoryPalette): void {
  const t = s.t;
  const y = -HEAD_RY - 4.2 + Math.sin(t * 2) * 0.4;
  ctx.strokeStyle = alpha(pal.trim, 0.9);
  ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.ellipse(0, y, 4.4, 1.35, 0, 0, TAU); ctx.stroke();
  ctx.strokeStyle = alpha('#ffffff', 0.7 + 0.2 * Math.sin(t * 5));
  ctx.lineWidth = 0.45;
  ctx.beginPath(); ctx.ellipse(0, y, 4.4, 1.35, 0, 0, TAU); ctx.stroke();
}

/** Goggles, part one: the strap across the head behind the eyes. */
function drawGoggleStrap(ctx: CanvasRenderingContext2D, pal: AccessoryPalette): void {
  ctx.strokeStyle = pal.trimLo;
  ctx.lineWidth = 1.2;
  ctx.lineCap = 'butt';
  ctx.beginPath();
  ctx.moveTo(-HEAD_RX * 0.98, -2.2);
  ctx.quadraticCurveTo(0, -3.4, HEAD_RX * 0.98, -2.2);
  ctx.stroke();
}

/** Goggles, part two: tinted lenses over the eyes with a rim and a highlight streak. */
function drawGoggles(ctx: CanvasRenderingContext2D, pal: AccessoryPalette, face: number, eyeY: number): void {
  for (const side of [-1, 1]) {
    const ex = side * 2.6 + face * 0.7;
    ctx.fillStyle = alpha(pal.trim, 0.22);
    ctx.beginPath(); ctx.ellipse(ex, eyeY, 2.35, 2.5, 0, 0, TAU); ctx.fill();
    ctx.strokeStyle = pal.trimLo;
    ctx.lineWidth = 0.9;
    ctx.beginPath(); ctx.ellipse(ex, eyeY, 2.35, 2.5, 0, 0, TAU); ctx.stroke();
    ctx.strokeStyle = alpha('#ffffff', 0.55);
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(ex - 1.6, eyeY - 1.4); ctx.lineTo(ex - 0.4, eyeY - 2.2); ctx.stroke();
  }
  // bridge
  ctx.strokeStyle = pal.trimLo;
  ctx.lineWidth = 0.8;
  ctx.beginPath(); ctx.moveTo(face * 0.7 - 0.4, eyeY - 0.6); ctx.lineTo(face * 0.7 + 0.4, eyeY - 0.6); ctx.stroke();
}

/** Scarf: the collar below the muzzle and a knot at the chain's neck anchor. */
function drawCollar(ctx: CanvasRenderingContext2D, pal: AccessoryPalette, face: number): void {
  ctx.strokeStyle = pal.trim;
  ctx.lineWidth = 1.7;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-HEAD_RX * 0.72, 4.2);
  ctx.quadraticCurveTo(0, 6.0, HEAD_RX * 0.72, 4.2);
  ctx.stroke();
  ctx.strokeStyle = alpha(pal.trimHi, 0.7);
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.moveTo(-HEAD_RX * 0.62, 4.3);
  ctx.quadraticCurveTo(0, 5.7, HEAD_RX * 0.62, 4.3);
  ctx.stroke();
  ctx.fillStyle = pal.trim;
  ctx.beginPath(); ctx.arc(-face * CHAIN_ANCHOR.dx, 5.0, 1.1, 0, TAU); ctx.fill();
  ctx.fillStyle = alpha(pal.trimHi, 0.8);
  ctx.beginPath(); ctx.arc(-face * (CHAIN_ANCHOR.dx + 0.3), 4.6, 0.4, 0, TAU); ctx.fill();
}

/** Menu / card portrait. Draws at unit scale into a `size`-tall box. */
export function drawClawdPortrait(ctx: CanvasRenderingContext2D, size: number, skin: Skin, t = 0): void {
  ctx.save();
  ctx.translate(size * PORTRAIT_FEET.x, size * PORTRAIT_FEET.y);
  const frameSize = skin.character === 'rabbit' ? 36 : 32;
  ctx.scale(size / frameSize, size / frameSize);
  drawClawd(ctx, null, {
    x: 0, y: 0, vx: 0, vy: 0, grounded: true, facing: 1, state: 'idle',
    t, anim: 0, squash: 0, invuln: 0, blink: Math.sin(t * 1.7) > 0.97 ? 1 : 0,
    skin, dashReady: true, dashFlash: 0,
  });
  ctx.restore();
}
