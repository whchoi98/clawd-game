/**
 * The title's landmark: a broken observatory rebuilt by a ribbon of echoes.
 * Coordinates are normalised to the height of the vista, so the silhouette
 * survives the expanded viewport. This is decorative; no simulation state.
 */
import { alpha, type QualityTier } from './stage.js';

const LIGHTS = ['#7FE3D6', '#F4C95D', '#F68ACD', '#ADFFD7'] as const;
type Point = readonly [number, number];

function polygon(ctx: CanvasRenderingContext2D, points: readonly Point[], fill: string, edge?: string): void {
  ctx.beginPath();
  points.forEach(([x, y], i) => i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y));
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (edge) { ctx.strokeStyle = edge; ctx.lineWidth = 0.65; ctx.stroke(); }
}

/** Draw after the sky and before the foreground and character. */
export function drawTitleTower(
  ctx: CanvasRenderingContext2D, width: number, height: number, time: number, quality: QualityTier,
): void {
  const x = width * 0.715;
  const y = height * 0.77;
  const scale = height / 355;
  const detail = quality !== 'low';
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);

  // An atmospheric pool behind the stone keeps its outline readable without
  // a full-screen bloom pass or an expensive Canvas2D shadow filter.
  const aura = ctx.createRadialGradient(0, -105, 6, 0, -105, 145);
  aura.addColorStop(0, 'rgba(116,219,209,.13)');
  aura.addColorStop(0.58, 'rgba(88,149,174,.065)');
  aura.addColorStop(1, 'rgba(32,70,86,0)');
  ctx.fillStyle = aura;
  ctx.fillRect(-150, -260, 300, 310);

  // Distant buttresses establish depth and a tapering, asymmetric silhouette.
  polygon(ctx, [[-60, 29], [-53, -52], [-39, -62], [-33, -119], [-23, -144], [-20, 20]], '#142C38', '#31525B');
  polygon(ctx, [[18, 30], [23, -132], [35, -115], [38, -62], [51, -49], [60, 22]], '#11232E', '#294952');
  polygon(ctx, [[-49, 27], [-35, -16], [-20, -30], [23, -27], [47, 7], [36, 38], [-12, 55]], '#162D35', '#46626A');
  polygon(ctx, [[-12, 55], [3, -21], [23, -27], [47, 7], [36, 38]], '#0C1C26');

  // Four floating landings — the same ascent and palette as the campaign.
  for (let i = 0; i < 4; i++) {
    const h = -18 - i * 43;
    const half = 42 - i * 5.5;
    const shift = i % 2 ? -5 : 3;
    const colour = LIGHTS[i];
    const glow = ctx.createRadialGradient(shift, h - 13, 1, shift, h - 13, half * 1.35);
    glow.addColorStop(0, alpha(colour, 0.14));
    glow.addColorStop(1, alpha(colour, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(shift - half * 1.5, h - half * 1.6, half * 3, half * 2.4);

    polygon(ctx, [[shift - half, h], [shift - half + 8, h - 6], [shift + half - 5, h - 6],
      [shift + half, h], [shift + half - 9, h + 10], [shift + 12, h + 11],
      [shift + 3, h + 23], [shift - 6, h + 12], [shift - half + 6, h + 9]], '#1A333F', '#527079');
    polygon(ctx, [[shift, h], [shift + half, h], [shift + half - 9, h + 10],
      [shift + 12, h + 11], [shift + 3, h + 23]], '#0D202C');
    ctx.strokeStyle = alpha(colour, 0.82);
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.moveTo(shift - half + 2, h - 3);
    ctx.lineTo(shift + half - 1, h - 3);
    ctx.stroke();

    // Pillars, with an open arch instead of a solid slab across the sky.
    const arch = half * 0.57;
    polygon(ctx, [[shift - arch - 5, h - 6], [shift - arch - 5, h - 31],
      [shift - arch + 1, h - 36], [shift - arch + 4, h - 31], [shift - arch + 4, h - 6]], '#233F4A', '#48636B');
    polygon(ctx, [[shift + arch - 3, h - 6], [shift + arch - 3, h - 32],
      [shift + arch + 3, h - 37], [shift + arch + 6, h - 31], [shift + arch + 6, h - 6]], '#16313D', '#42626C');
    ctx.beginPath();
    ctx.moveTo(shift - arch, h - 29);
    ctx.quadraticCurveTo(shift, h - 52, shift + arch + 1, h - 29);
    ctx.strokeStyle = '#385966';
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.strokeStyle = alpha(colour, 0.23);
    ctx.lineWidth = 0.65;
    ctx.stroke();

    // Small floating waystones point around the outside of each landing.
    if (detail) {
      for (let j = 0; j < 3; j++) {
        const side = i % 2 ? -1 : 1;
        const sx = shift + side * (half + 9 + j * 5);
        const sy = h - 7 - j * 8;
        polygon(ctx, [[sx - 3, sy], [sx + 3, sy - 1], [sx + 2, sy + 3], [sx - 2, sy + 4]], '#264651', alpha(colour, 0.44));
      }
    }
    // One inlaid crystal per floor, readable even on the low quality tier.
    polygon(ctx, [[shift, h - 24], [shift + 3, h - 19], [shift, h - 14], [shift - 3, h - 19]], alpha(colour, 0.9));
  }

  // A split crown and a steady summit signal, never a flashing beacon.
  polygon(ctx, [[-21, -161], [-18, -184], [-11, -193], [-7, -177], [0, -201],
    [7, -178], [13, -192], [18, -182], [21, -161]], '#234852', '#81B6B3');
  ctx.strokeStyle = 'rgba(173,255,215,.4)';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.ellipse(0, -200, 21, 6, -0.2, 0, Math.PI * 2);
  ctx.stroke();
  const beacon = ctx.createRadialGradient(0, -202, 0, 0, -202, 21);
  beacon.addColorStop(0, 'rgba(220,255,236,.9)');
  beacon.addColorStop(0.12, 'rgba(173,255,215,.58)');
  beacon.addColorStop(1, 'rgba(127,227,214,0)');
  ctx.fillStyle = beacon;
  ctx.fillRect(-22, -224, 44, 44);
  polygon(ctx, [[0, -210], [3, -203], [0, -196], [-3, -203]], '#E7FFEF');

  // Sparse travelling echoes follow a single helical ascent. Passing time=0
  // gives a composed still for reduced motion; low quality omits the trail.
  if (detail) {
    ctx.lineWidth = 0.55;
    ctx.beginPath();
    for (let k = 0; k <= 80; k++) {
      const p = k / 80;
      const px = Math.sin(p * Math.PI * 4 + 0.6) * (57 - p * 31);
      const py = -5 - p * 185;
      k ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.strokeStyle = 'rgba(184,231,223,.15)';
    ctx.stroke();
    for (let k = 0; k < 5; k++) {
      const p = ((time * 0.018 + k / 5) % 1 + 1) % 1;
      const px = Math.sin(p * Math.PI * 4 + 0.6) * (57 - p * 31);
      const py = -5 - p * 185;
      ctx.fillStyle = alpha(LIGHTS[Math.min(3, Math.floor(p * 4))], 0.84);
      ctx.beginPath(); ctx.arc(px, py, 1.25, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(240,255,245,.75)';
      ctx.fillRect(px - 0.4, py - 2.7, 0.8, 1.3);
    }
  }
  ctx.restore();
}
