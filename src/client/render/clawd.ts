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
 */
import { TAU, alpha, clamp, mixHex } from './stage.js';

export interface Skin {
  id: string; name: string; kr: string;
  shell: string; shellHi: string; shellLo: string;
  belly: string; limb: string; eye: string; pupil: string;
  glow: string;
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
};

export function skinById(id: string | undefined): Skin {
  return (id && SKINS[id]) || SKINS.clawd;
}

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
 * @param ctx  main buffer
 * @param gctx glow buffer (null → no emissive pass, e.g. portraits and echoes)
 */
export function drawClawd(ctx: CanvasRenderingContext2D, gctx: CanvasRenderingContext2D | null, s: RigState): void {
  const sk = s.skin;
  const t = s.t;
  const face = s.facing;
  const air = !s.grounded;
  const st = s.state;

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

  // ---------- antennae (trail behind motion) ----------
  ctx.strokeStyle = sk.shellLo;
  ctx.lineWidth = 0.85;
  for (const side of [-1, 1]) {
    const drag = clamp(-s.vx / 320, -0.9, 0.9);
    const wob = Math.sin(t * 5 + side) * 0.5;
    ctx.beginPath();
    ctx.moveTo(side * 2.4, -BODY_RY + 0.6);
    ctx.quadraticCurveTo(
      side * 3.4 + drag * 3, -BODY_RY - 2.6 + wob,
      side * 3.0 + drag * 6.5, -BODY_RY - 5.0 + wob * 1.6);
    ctx.stroke();
    ctx.fillStyle = sk.shellHi;
    ctx.beginPath();
    ctx.arc(side * 3.0 + drag * 6.5, -BODY_RY - 5.0 + wob * 1.6, 0.75, 0, TAU);
    ctx.fill();
  }

  // ---------- eyes ----------
  const blink = s.blink;
  const eyeY = -1.9;
  const squint = st === 'dash' ? 0.55 : st === 'hurt' ? 0.7 : st === 'stomp' ? 0.35 : 0;
  for (const side of [-1, 1]) {
    const ex = side * 2.9 + face * 0.9;
    const rx = 2.25, ry = 2.45 * (1 - blink) * (1 - squint * 0.55);
    if (ry < 0.22 || st === 'dead') {
      ctx.strokeStyle = sk.pupil;
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      if (st === 'dead') {
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

    // pupil leads the movement — reads as intent
    const px = clamp(s.vx / 240, -1, 1) * 0.85 + face * 0.5;
    const py = clamp(s.vy / 340, -1, 1) * 0.7;
    ctx.fillStyle = sk.pupil;
    ctx.beginPath();
    ctx.ellipse(ex + px, eyeY + py, rx * 0.5, ry * 0.52, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = alpha('#ffffff', 0.9);
    ctx.beginPath();
    ctx.arc(ex + px - 0.6, eyeY + py - 0.7, 0.42, 0, TAU);
    ctx.fill();
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
  }
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
