/**
 * The original bare-shell crab, restored from the rig before df102dc.
 * Shared pose timing, deformation, eye targets and glow remain in clawd.ts;
 * this painter owns the crab's four legs, two pincers, shell and antennae.
 */
import { TAU, alpha, clamp, mixHex } from './stage.js';
import type { Brow, Expression, Mouth, RigState, Skin } from './clawd.js';

const BODY_Y = -9.2;
const BODY_RX = 7.2;
const BODY_RY = 6.2;
export const CRAB_BODY = { y: BODY_Y, rx: BODY_RX, ry: BODY_RY } as const;

interface CrabFrame {
  bodyY: number;
  stretch: number;
  idleK: number;
  expression: Expression;
  look: { x: number; y: number } | null;
  lookWeight: number;
}

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

/** Draw in the shared rig's already deformed feet space. */
export function drawCrab(ctx: CanvasRenderingContext2D, s: RigState, frame: CrabFrame): void {
  const sk = s.skin, t = s.t, face = s.facing, st = s.state;
  const air = !s.grounded;
  const smile = s.smile ?? 0;
  const { bodyY, stretch, idleK, expression: expr, look, lookWeight } = frame;

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
      px = px * (1 - lookWeight) + clamp(look.x, -1, 1) * 1.05 * lookWeight;
      py = py * (1 - lookWeight) + clamp(look.y, -1, 1) * 0.8 * lookWeight;
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

  ctx.restore();  // body translate
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

/** The original dash trail: the shell with a hint of the forward pincers. */
export function drawCrabSilhouette(ctx: CanvasRenderingContext2D, facing: number): void {
  const face = facing >= 0 ? 1 : -1;
  ctx.beginPath(); ctx.ellipse(0, BODY_Y, BODY_RX, BODY_RY, 0, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.ellipse(face * (BODY_RX + 3.4), BODY_Y - 0.6, 2.4, 2, 0, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.ellipse(-face * (BODY_RX - 1.2), BODY_Y + 0.4, 1.8, 1.5, 0, 0, TAU); ctx.fill();
}
