/**
 * Clawd — drawn procedurally every frame, not blitted from a sprite sheet.
 *
 * A rig lets the silhouette deform continuously (squash on landing, stretch at
 * take-off, lean into acceleration, legs that actually reach for the ground)
 * and stays sharp at any resolution. A baked sprite can only ever show the
 * poses you drew.
 *
 * Local space: origin at the feet, +y down, character ~15 units tall.
 * The rig state is assembled by the renderer from PlayerState plus its own
 * visual-only timers (squash, blink, anim phase); the sim knows none of this.
 *
 * Phase 5 character pass (P5-2), all visual-only and all optional on RigState:
 *   expressions   brows + mouth per pose (`expressionFor`), a 0.4 s smile after a
 *                 pickup, X eyes when hurt or dead; idle behaviours (look around,
 *                 stretch) once `idle` passes IDLE_AFTER
 *   secondary     `stalk` — antenna spring offsets lagging acceleration;
 *                 `chain` — a CHAIN_N-point scarf simulated by PlayerVisual
 *   accessories   `Skin.accessory` drawn by the rig and the portrait alike
 * A rig without those fields and a skin without an accessory draw exactly the
 * pre-Phase-5 frame (test/fixtures/clawd-baseline.json pins the call log).
 */
import { TAU, alpha, clamp, clamp01, mixHex } from './stage.js';

/** Visual-only costume piece drawn by the rig (Phase 5 character pass); 'none' / missing = bare shell. */
export type SkinAccessory = 'none' | 'scarf' | 'antenna' | 'crown' | 'fins' | 'hood' | 'halo' | 'goggles';

/** Every accessory value, for tests and tooling. */
export const SKIN_ACCESSORIES: readonly SkinAccessory[] = ['none', 'scarf', 'antenna', 'crown', 'fins', 'hood', 'halo', 'goggles'];

export interface Skin {
  id: string; name: string; kr: string;
  shell: string; shellHi: string; shellLo: string;
  belly: string; limb: string; eye: string; pupil: string;
  glow: string;
  /** Costume piece (Phase 5); undefined draws the classic bare shell. */
  accessory?: SkinAccessory;
  /** Accessory / trail colour; defaults to `glow`. */
  trim?: string;
}

export const SKINS: Record<string, Skin> = {
  clawd: {
    id: 'clawd', name: 'CLAWD', kr: '클로드',
    shell: '#E8825C', shellHi: '#FFC09B', shellLo: '#A8422F',
    belly: '#FFD9C0', limb: '#C4553D', eye: '#FFFFFF', pupil: '#1A1020',
    glow: '#FFB088',
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

/** Echo skins: a whole palette derived from one accent colour, cached per colour. */
const tintCache = new Map<string, Skin>();
export function tintedSkin(color: string): Skin {
  let s = tintCache.get(color);
  if (s) return s;
  s = {
    id: `echo:${color}`, name: 'ECHO', kr: '메아리',
    shell: color,
    shellHi: mixHex(color, '#ffffff', 0.45),
    shellLo: mixHex(color, '#000000', 0.4),
    belly: mixHex(color, '#ffffff', 0.65),
    limb: mixHex(color, '#000000', 0.25),
    eye: mixHex(color, '#ffffff', 0.85),
    pupil: mixHex(color, '#000000', 0.7),
    glow: color,
  };
  tintCache.set(color, s);
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
  /** Antenna spring offsets [x0, y0, x1, y1] in rig units (the tips lag acceleration). Missing = velocity drag only. */
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
 * mouth of the relaxed poses. Idle with no smile is the neutral pre-Phase-5 face.
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

const BODY_Y = -9.2;
const BODY_RX = 7.2;
const BODY_RY = 6.2;

/** Superellipse — rounder than an ellipse at the shoulders, flatter on top. */
function shellPath(ctx: CanvasRenderingContext2D, rx: number, ry: number, n = 2.5): void {
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

/**
 * The scarf: CHAIN_N points behind the neck. Drawn in unrotated feet space (the
 * chain was simulated in world units, so the body's lean and squash are undone
 * first); without a simulated chain a static drape hangs from the anchor.
 */
function drawChain(ctx: CanvasRenderingContext2D, s: RigState, pal: AccessoryPalette, lean: number, sx: number, sy: number, bodyY: number): void {
  const face = s.facing, t = s.t;
  const chain = s.chain;
  ctx.save();
  ctx.translate(0, -bodyY);
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
  const t = s.t;
  const face = s.facing;
  const air = !s.grounded;
  const st = s.state;
  const acc: SkinAccessory = sk.accessory ?? 'none';
  const pal = acc !== 'none' ? accessoryPalette(sk) : null;
  const smile = s.smile ?? 0;
  const expr = expressionFor(st, smile);

  // idle behaviours (P5-2): after IDLE_AFTER seconds still, the eyes wander and every STRETCH_PERIOD a stretch
  const idle = s.idle ?? 0;
  const idleK = idle > IDLE_AFTER ? clamp01(idle - IDLE_AFTER) : 0;
  let stretch = 0;
  if (idleK > 0 && st === 'idle') {
    const u = (idle - IDLE_AFTER) % STRETCH_PERIOD - STRETCH_DELAY;
    if (u >= 0 && u < STRETCH_T) stretch = Math.sin(Math.PI * u / STRETCH_T) * idleK;
  }

  // ---------- body-space deformation ----------
  let sx = 1, sy = 1;
  if (s.squash > 0) { sx = 1 + s.squash * 0.55; sy = 1 - s.squash * 0.42; }
  else if (s.squash < 0) { sx = 1 + s.squash * 0.32; sy = 1 - s.squash * 0.52; }
  if (air) {
    const v = clamp(s.vy / 420, -0.5, 0.7);
    sx *= 1 - v * 0.1;
    sy *= 1 + v * 0.12;
  }
  if (st === 'dash') { sx *= 1.3; sy *= 0.78; }
  if (st === 'crouch') { sx *= 1.22; sy *= 0.7; }
  if (st === 'stomp') { sx *= 0.86; sy *= 1.16; }
  if (stretch > 0) { sx *= 1 - stretch * 0.07; sy *= 1 + stretch * 0.15; }

  const lean = clamp(s.vx / 220, -1, 1) * 0.2 + (st === 'dash' ? face * 0.16 : 0);
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

  const bodyY = BODY_Y + bob + breathe + swimBob;

  // ---------- legs (two per side, 2-bone with a procedural gait) ----------
  const legCol = sk.limb;
  ctx.strokeStyle = legCol;
  ctx.lineCap = 'round';
  const running = s.grounded && Math.abs(s.vx) > 14;
  const gait = s.anim * TAU * 2;

  for (let side = -1; side <= 1; side += 2) {
    for (let li = 0; li < 2; li++) {
      const hipX = side * (2.2 + li * 2.6);
      const hipY = bodyY + 3.6;
      const phase = gait + (side > 0 ? 0 : Math.PI) + li * 0.9;
      let footX: number, footY: number;
      if (running) {
        const stride = clamp(Math.abs(s.vx) / 132, 0, 1) * 4.4;
        footX = hipX + Math.cos(phase) * stride * Math.sign(s.vx || face) + side * 0.6;
        footY = Math.min(0, -Math.max(0, Math.sin(phase)) * 3.2);
      } else if (st === 'swim') {
        // paddling: legs sweep back and forth
        footX = hipX + side * 1.6 + Math.sin(t * 6 + li * 1.3 + side) * 1.4;
        footY = -1.4 + Math.cos(t * 6 + li) * 0.8;
      } else if (st === 'stomp') {
        footX = hipX + side * 0.4;
        footY = -0.4 + li * 0.5;
      } else if (air) {
        const tuck = s.vy < 0 ? 1 : 0.4;
        footX = hipX + side * 1.2;
        footY = -2.6 * tuck - 0.8;
      } else if (st === 'wall') {
        footX = hipX + face * -2.4;
        footY = -1.2 - li * 0.6;
      } else {
        footX = hipX + side * 1.4;
        footY = Math.sin(t * 1.6 + li) * 0.15;
      }
      // knee sits outside the hip→foot line so the joint reads clearly
      const mx = (hipX + footX) / 2 + side * 2.1;
      const my = (hipY + footY) / 2 + 0.6;
      ctx.lineWidth = 1.7 - li * 0.25;
      ctx.beginPath();
      ctx.moveTo(hipX, hipY);
      ctx.quadraticCurveTo(mx, my, footX, footY);
      ctx.stroke();
      ctx.fillStyle = sk.shellLo;
      ctx.beginPath();
      ctx.ellipse(footX, footY, 1.15, 0.65, 0, 0, TAU);
      ctx.fill();
    }
  }

  // ---------- claws ----------
  // Two-segment arm with a visible elbow, ending in a chunky pincer. The pincer
  // is drawn in its own rotated space so "forward" is always +x.
  const clawSwing = running ? -Math.sin(gait) * 0.5 : 0;
  for (let side = -1; side <= 1; side += 2) {
    const front = side === face;
    const shX = side * 5.6;
    const shY = bodyY - 0.8;
    let ang: number, len: number, open: number;
    if (st === 'dash') { ang = face > 0 ? -0.1 : Math.PI + 0.1; len = 7.2; open = 0.5; }
    else if (st === 'wall') { ang = face > 0 ? -0.95 : Math.PI + 0.95; len = 6.2; open = 0.3; }
    else if (st === 'stomp') { ang = side > 0 ? -1.9 : Math.PI + 1.9; len = 6.6; open = 0.55; }
    else if (st === 'swim') { ang = (side > 0 ? -0.6 : Math.PI + 0.6) + Math.sin(t * 6 + side) * 0.35; len = 6.4; open = 0.35; }
    else if (air) { ang = side > 0 ? -1.55 : Math.PI + 1.55; len = 6.4; open = 0.42; }
    else if (st === 'hurt' || st === 'dead') { ang = side > 0 ? -2.3 : Math.PI + 2.3; len = 6.0; open = 0.62; }
    else {
      ang = (side > 0 ? 0.42 : Math.PI - 0.42) + clawSwing * side;
      len = 5.8;
      open = 0.2 + Math.sin(t * 2.2 + side) * 0.06;
      // the idle stretch raises both claws overhead
      if (stretch > 0) { ang -= side * stretch * 1.9; open += stretch * 0.3; }
    }

    const ex = shX + Math.cos(ang) * len;
    const ey = shY + Math.sin(ang) * len * 0.8;
    const elX = shX + Math.cos(ang) * len * 0.45 + side * 1.4;
    const elY = shY + Math.sin(ang) * len * 0.3 - 1.2;

    ctx.strokeStyle = legCol;
    ctx.lineJoin = 'round';
    ctx.lineWidth = front ? 2.6 : 2.2;
    ctx.beginPath();
    ctx.moveTo(shX, shY);
    ctx.lineTo(elX, elY);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.fillStyle = sk.shellLo;
    ctx.beginPath(); ctx.arc(shX, shY, 1.5, 0, TAU); ctx.fill();

    // --- pincer ---
    ctx.save();
    ctx.translate(ex, ey);
    ctx.rotate(ang);
    const pg = ctx.createLinearGradient(0, -3, 3, 3);
    pg.addColorStop(0, sk.shellHi);
    pg.addColorStop(0.5, sk.shell);
    pg.addColorStop(1, sk.shellLo);
    ctx.fillStyle = pg;
    ctx.strokeStyle = alpha(mixHex(sk.shellLo, '#000000', 0.5), 0.5);
    ctx.lineWidth = 0.5;

    ctx.beginPath();
    ctx.ellipse(0.4, 0, 2.5, 2.1, 0, 0, TAU);
    ctx.fill(); ctx.stroke();

    for (const dir of [-1, 1]) {
      const sp = dir < 0 ? 1.15 : 0.95;        // upper jaw is the bigger one
      ctx.save();
      ctx.rotate(dir * open);
      ctx.beginPath();
      ctx.moveTo(1.4, dir * 0.3);
      ctx.quadraticCurveTo(4.2, dir * 0.5 * sp, 5.6, dir * 1.5 * sp);
      ctx.quadraticCurveTo(3.6, dir * 2.1 * sp, 1.2, dir * 1.7 * sp);
      ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.restore();
    }
    ctx.fillStyle = alpha('#ffffff', 0.4);
    ctx.beginPath(); ctx.ellipse(-0.2, -0.9, 1.1, 0.6, -0.4, 0, TAU); ctx.fill();
    ctx.restore();
  }

  // ---------- shell ----------
  ctx.save();
  ctx.translate(0, bodyY);

  // accessories behind the body: the scarf tail (scarf, hood) and the fins
  if (pal && (acc === 'scarf' || acc === 'hood')) drawChain(ctx, s, pal, lean, sx, sy, bodyY);
  if (pal && acc === 'fins') drawFins(ctx, s, pal);

  const bg = ctx.createLinearGradient(-BODY_RX, -BODY_RY, BODY_RX * 0.4, BODY_RY);
  bg.addColorStop(0, sk.shellHi);
  bg.addColorStop(0.42, sk.shell);
  bg.addColorStop(1, sk.shellLo);
  shellPath(ctx, BODY_RX, BODY_RY, 2.7);
  ctx.fillStyle = bg;
  ctx.fill();

  // belly plate
  ctx.beginPath();
  ctx.ellipse(0, 2.4, BODY_RX * 0.66, BODY_RY * 0.44, 0, 0, TAU);
  ctx.fillStyle = alpha(sk.belly, 0.5);
  ctx.fill();

  // carapace seams
  ctx.strokeStyle = alpha(sk.shellLo, 0.4);
  ctx.lineWidth = 0.6;
  for (const yy of [-1.6, 0.6]) {
    ctx.beginPath();
    ctx.moveTo(-BODY_RX * 0.72, yy);
    ctx.quadraticCurveTo(0, yy + 1.4, BODY_RX * 0.72, yy);
    ctx.stroke();
  }

  // rim light along the upper-left arc
  ctx.save();
  shellPath(ctx, BODY_RX, BODY_RY, 2.7);
  ctx.clip();
  const rl = ctx.createLinearGradient(-BODY_RX, -BODY_RY, 0, 0);
  rl.addColorStop(0, alpha('#ffffff', 0.5));
  rl.addColorStop(0.55, alpha('#ffffff', 0));
  ctx.fillStyle = rl;
  ctx.fillRect(-BODY_RX, -BODY_RY, BODY_RX * 2, BODY_RY * 2);
  ctx.restore();

  // specular dot
  ctx.fillStyle = alpha('#ffffff', 0.62);
  ctx.beginPath();
  ctx.ellipse(-2.8 + face * 0.6, -3.6, 1.5, 1.0, -0.5, 0, TAU);
  ctx.fill();

  // outline keeps the silhouette readable against busy terrain
  shellPath(ctx, BODY_RX, BODY_RY, 2.7);
  ctx.strokeStyle = alpha(mixHex(sk.shellLo, '#000000', 0.45), 0.55);
  ctx.lineWidth = 0.7;
  ctx.stroke();

  // ---------- antennae (trail behind motion; with `stalk`, lag acceleration on a spring) ----------
  ctx.strokeStyle = sk.shellLo;
  ctx.lineWidth = 0.85;
  const stalk = s.stalk && s.stalk.length >= 4 ? s.stalk : null;
  const perk = stretch * 0.9;      // the stretch perks the antennae up
  for (const side of [-1, 1]) {
    const wob = Math.sin(t * 5 + side) * 0.5;
    let drag: number, tipX: number, tipY: number;
    if (stalk) {
      const i = side < 0 ? 0 : 2;
      drag = clamp(-s.vx / 320 + stalk[i] / 7, -1.1, 1.1);
      const lift = clamp(stalk[i + 1] / 6, -1, 1);
      tipX = side * 3.0 + drag * 6.5;
      tipY = -BODY_RY - 5.0 + wob * 1.6 + lift * 1.8 - perk;
    } else {
      drag = clamp(-s.vx / 320, -0.9, 0.9);
      tipX = side * 3.0 + drag * 6.5;
      tipY = perk > 0 ? -BODY_RY - 5.0 + wob * 1.6 - perk : -BODY_RY - 5.0 + wob * 1.6;
    }
    ctx.beginPath();
    ctx.moveTo(side * 2.4, -BODY_RY + 0.6);
    ctx.quadraticCurveTo(
      side * 3.4 + drag * 3, -BODY_RY - 2.6 + wob,
      tipX, tipY);
    ctx.stroke();
    ctx.fillStyle = sk.shellHi;
    ctx.beginPath();
    ctx.arc(tipX, tipY, 0.75, 0, TAU);
    ctx.fill();
  }

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
    const ex = side * 2.9 + face * 0.9;
    const rx = 2.25, ry = 2.45 * (1 - blink) * (1 - squint * 0.55);
    if (ry < 0.22 || xEyes) {
      ctx.strokeStyle = sk.pupil;
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
    ctx.fillStyle = sk.eye;
    ctx.beginPath(); ctx.ellipse(ex, eyeY, rx, ry, 0, 0, TAU); ctx.fill();

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
    ctx.fillStyle = sk.pupil;
    ctx.beginPath();
    ctx.ellipse(ex + px, eyeY + py, rx * 0.5, ry * 0.52, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = alpha('#ffffff', 0.9);
    ctx.beginPath();
    ctx.arc(ex + px - 0.6, eyeY + py - 0.7, 0.42, 0, TAU);
    ctx.fill();
  }

  // ---------- expression: brows and mouth (P5-2) ----------
  if (expr.brow !== 'none') drawBrows(ctx, sk, face, eyeY, expr.brow);
  if (expr.mouth !== 'none') drawMouth(ctx, sk, face, expr.mouth, smile);

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
      gctx.ellipse(s.x, s.y + BODY_Y, BODY_RX * 1.5, BODY_RY * 1.7, 0, 0, TAU);
      gctx.fill();
      gctx.restore();
    }
    // glowing accessories: the halo ring and the antenna bulb (approximate, ignoring lean and squash)
    if (pal && (acc === 'halo' || acc === 'antenna')) {
      gctx.save();
      gctx.globalAlpha *= 0.55 * (s.alpha ?? 1);
      gctx.fillStyle = pal.trim;
      gctx.beginPath();
      if (acc === 'halo') gctx.ellipse(s.x, s.y + BODY_Y - BODY_RY - 4.2 + Math.sin(t * 2) * 0.4, 5.2, 2.2, 0, 0, TAU);
      else gctx.arc(s.x - s.vx / 320 * 3, s.y + BODY_Y - BODY_RY - 7.6, 2.2, 0, TAU);
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
    const ex = side * 2.9 + face * 0.9;
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
  const mx = face * 0.9;
  const col = alpha(sk.pupil, 0.85);
  ctx.strokeStyle = col;
  ctx.fillStyle = col;
  ctx.lineWidth = 0.7;
  switch (mouth) {
    case 'smile': {
      const k = Math.min(1, smile * 2.5);      // holds, then fades over the last part of SMILE_T
      const w = 0.6 + 1.7 * k;
      ctx.beginPath();
      ctx.moveTo(mx - w, 1.2);
      ctx.quadraticCurveTo(mx, 1.2 + 2.0 * k, mx + w, 1.2);
      ctx.stroke();
      return;
    }
    case 'o':
      ctx.beginPath(); ctx.ellipse(mx, 1.7, 0.75, 0.95, 0, 0, TAU); ctx.fill();
      return;
    case 'grit':
      ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.moveTo(mx - 1.7, 1.6); ctx.lineTo(mx + 1.7, 1.6); ctx.stroke();
      ctx.fillStyle = alpha(sk.eye, 0.9);
      ctx.fillRect(mx - 1.1, 1.05, 0.7, 0.55);
      ctx.fillRect(mx + 0.3, 1.05, 0.7, 0.55);
      return;
    case 'open':
      ctx.beginPath(); ctx.ellipse(mx, 1.9, 1.15, 1.35, 0, 0, TAU); ctx.fill();
      return;
    case 'flat':
      ctx.beginPath(); ctx.moveTo(mx - 1.2, 1.7); ctx.lineTo(mx + 1.2, 1.7); ctx.stroke();
      return;
    default:
      return;
  }
}

// ---------------------------------------------------------------- accessories (body space, origin at the shell centre)
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
  ctx.moveTo(bx + face * 2.6, -BODY_RY + 1.2);
  ctx.quadraticCurveTo(bx - face * 1.5 + flutter, -BODY_RY - 4.6, bx - face * 5.4 + flutter * 1.6, -BODY_RY - 2.2);
  ctx.quadraticCurveTo(bx - face * 4.0, -BODY_RY, bx - face * 3.2, -BODY_RY + 2.4);
  ctx.closePath();
  ctx.fill(); ctx.stroke();
  // side fins, upper and lower on the back
  for (const [y0, len, dir] of [[-1.6, 5.2, -1], [2.2, 4.0, 1]] as const) {
    const x0 = -face * BODY_RX * 0.9;
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
    ctx.moveTo(bx + face * (2.2 - k * 5.0), -BODY_RY + 1.4);
    ctx.lineTo(bx - face * (1.0 + k * 3.6) + flutter * k * 1.6, -BODY_RY - 4.2 + k * 2.6);
    ctx.stroke();
  }
}

/** Gold: a three-point crown on the shell top, gems in the belly colour. */
function drawCrown(ctx: CanvasRenderingContext2D, sk: Skin, pal: AccessoryPalette): void {
  const top = -BODY_RY - 0.2;
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

/** Frost: a hood over the top and back of the shell, its rim above the eyes, a fur edge in the trim highlight. */
function drawHood(ctx: CanvasRenderingContext2D, s: RigState, pal: AccessoryPalette): void {
  const f = s.facing;
  ctx.fillStyle = pal.trim;
  ctx.strokeStyle = pal.trimEdge;
  ctx.lineWidth = 0.6;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(f * 3.0, -3.6);                                                   // front rim, above the eyes
  ctx.quadraticCurveTo(f * 1.6, -BODY_RY - 2.4, -f * 2.6, -BODY_RY - 1.8);     // over the top
  ctx.quadraticCurveTo(-f * (BODY_RX + 2.2), -BODY_RY - 0.4, -f * (BODY_RX + 1.2), 2.6);   // down the back
  ctx.quadraticCurveTo(-f * (BODY_RX - 1.0), 4.4, -f * 2.0, 3.8);              // under the back
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

/** Antenna: one tall stalk from the shell top ending in a pulsing bulb, trailing behind motion. */
function drawAntenna(ctx: CanvasRenderingContext2D, s: RigState, pal: AccessoryPalette): void {
  const t = s.t;
  const drag = clamp(-s.vx / 320, -1, 1);
  const tipX = drag * 3 + Math.sin(t * 3.4) * 0.3, tipY = -BODY_RY - 7.6;
  ctx.strokeStyle = pal.trimLo;
  ctx.lineWidth = 0.9;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(0, -BODY_RY + 0.4);
  ctx.quadraticCurveTo(drag * 1.2, -BODY_RY - 4.2, tipX, tipY);
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
  const y = -BODY_RY - 4.2 + Math.sin(t * 2) * 0.4;
  ctx.strokeStyle = alpha(pal.trim, 0.9);
  ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.ellipse(0, y, 4.4, 1.35, 0, 0, TAU); ctx.stroke();
  ctx.strokeStyle = alpha('#ffffff', 0.7 + 0.2 * Math.sin(t * 5));
  ctx.lineWidth = 0.45;
  ctx.beginPath(); ctx.ellipse(0, y, 4.4, 1.35, 0, 0, TAU); ctx.stroke();
}

/** Goggles, part one: the strap across the shell behind the eyes. */
function drawGoggleStrap(ctx: CanvasRenderingContext2D, pal: AccessoryPalette): void {
  ctx.strokeStyle = pal.trimLo;
  ctx.lineWidth = 1.2;
  ctx.lineCap = 'butt';
  ctx.beginPath();
  ctx.moveTo(-BODY_RX * 0.98, -2.2);
  ctx.quadraticCurveTo(0, -3.4, BODY_RX * 0.98, -2.2);
  ctx.stroke();
}

/** Goggles, part two: tinted lenses over the eyes with a rim and a highlight streak. */
function drawGoggles(ctx: CanvasRenderingContext2D, pal: AccessoryPalette, face: number, eyeY: number): void {
  for (const side of [-1, 1]) {
    const ex = side * 2.9 + face * 0.9;
    ctx.fillStyle = alpha(pal.trim, 0.22);
    ctx.beginPath(); ctx.ellipse(ex, eyeY, 2.75, 2.95, 0, 0, TAU); ctx.fill();
    ctx.strokeStyle = pal.trimLo;
    ctx.lineWidth = 0.9;
    ctx.beginPath(); ctx.ellipse(ex, eyeY, 2.75, 2.95, 0, 0, TAU); ctx.stroke();
    ctx.strokeStyle = alpha('#ffffff', 0.55);
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(ex - 1.6, eyeY - 1.4); ctx.lineTo(ex - 0.4, eyeY - 2.2); ctx.stroke();
  }
  // bridge
  ctx.strokeStyle = pal.trimLo;
  ctx.lineWidth = 0.8;
  ctx.beginPath(); ctx.moveTo(face * 0.9 - 0.4, eyeY - 0.6); ctx.lineTo(face * 0.9 + 0.4, eyeY - 0.6); ctx.stroke();
}

/** Scarf: the collar band low on the shell and the knot at the back where the chain hangs. */
function drawCollar(ctx: CanvasRenderingContext2D, pal: AccessoryPalette, face: number): void {
  ctx.strokeStyle = pal.trim;
  ctx.lineWidth = 1.7;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-BODY_RX * 0.82, 2.6);
  ctx.quadraticCurveTo(0, 4.6, BODY_RX * 0.82, 2.6);
  ctx.stroke();
  ctx.strokeStyle = alpha(pal.trimHi, 0.7);
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.moveTo(-BODY_RX * 0.7, 2.7);
  ctx.quadraticCurveTo(0, 4.3, BODY_RX * 0.7, 2.7);
  ctx.stroke();
  ctx.fillStyle = pal.trim;
  ctx.beginPath(); ctx.arc(-face * 5.2, 3.0, 1.3, 0, TAU); ctx.fill();
  ctx.fillStyle = alpha(pal.trimHi, 0.8);
  ctx.beginPath(); ctx.arc(-face * 5.5, 2.6, 0.45, 0, TAU); ctx.fill();
}

/** Menu / card portrait. Draws at unit scale into a `size`-tall box. */
export function drawClawdPortrait(ctx: CanvasRenderingContext2D, size: number, skin: Skin, t = 0): void {
  ctx.save();
  ctx.translate(size / 2, size * 0.82);
  ctx.scale(size / 26, size / 26);
  drawClawd(ctx, null, {
    x: 0, y: 0, vx: 0, vy: 0, grounded: true, facing: 1, state: 'idle',
    t, anim: 0, squash: 0, invuln: 0, blink: Math.sin(t * 1.7) > 0.97 ? 1 : 0,
    skin, dashReady: true, dashFlash: 0,
  });
  ctx.restore();
}
