/**
 * Terrain renderer.
 *
 * Passes, in order:
 *   1. every visible '#' tile merged into ONE Path2D, filled twice (baked
 *      tileable rock texture, then the level-wide tint gradient) — strata run
 *      continuously across tile boundaries instead of repeating every 16 units
 *   2. depth shading: how deep a tile sits below the nearest surface drives a
 *      black overlay, which is what turns a flat mass into a cliff. Tiles are
 *      grouped into three cumulative depth bands (>=1, >=3, >=6), each ONE
 *      Path2D filled once — per-tile translucent rects would double-blend on
 *      every boundary and print seams
 *   3. exposed-face detail (crust, bevel, ambient occlusion, cracks) — only
 *      tiles with an open face pay for it
 *   4. crumbling blocks, switch blocks (polarity glow / ghost outline), decor
 *
 * The whole-screen terrain therefore costs at most 6 Path2D fills per frame:
 * rock + tint + 3 depth bands + sub-surface bounce light.
 *
 * Gradients and patterns are created once per level: CanvasGradient/Pattern
 * coordinates resolve in user space at paint time, so one object serves every
 * tile as long as the context is translated.
 */
import { TILE } from '../../sim/types.js';
import { PHYS } from '../../sim/config.js';
import { SWITCH_A, SWITCH_B } from '../../sim/legend.js';
import type { Level } from '../../sim/level.js';
import { C, type Biome } from '../../shared/biomes.js';
import { Stage, TAU, alpha, clamp01, fbm, hashStr, hexToRgb, lerp, mixHex, noise2 } from './stage.js';

const ROCK_PX = 128;      // one texture repeat == 128 world units == 8 tiles
const DEPTH_BANDS = [1, 3, 6];
const DEPTH_ALPHA = [0.1, 0.14, 0.2];

/**
 * Baked rock face: mottling + horizontal strata + pebbles, wrapped so it tiles.
 * Doing this once per biome means pass 1 is a single fill for the whole screen.
 */
function makeRockTexture(b: Biome, create: () => HTMLCanvasElement): HTMLCanvasElement {
  const cv = create();
  cv.width = cv.height = ROCK_PX;
  const g = cv.getContext('2d') as CanvasRenderingContext2D | null;
  if (!g) return cv;

  const img = g.createImageData(ROCK_PX, ROCK_PX);
  const base = hexToRgb(b.rock), hi = hexToRgb(b.rockHi), lo = hexToRgb(b.rockDeep);
  for (let y = 0; y < ROCK_PX; y++) {
    const bandRaw = y / 21 + noise2(y * 0.08, 3.1) * 0.7;
    const band = Math.abs((bandRaw % 1) - 0.5) * 2;
    for (let x = 0; x < ROCK_PX; x++) {
      const u = (x / ROCK_PX) * TAU, v = (y / ROCK_PX) * TAU;
      const nx = Math.cos(u) * 1.9 + 5, ny = Math.sin(u) * 1.9 + 11;
      const mx = Math.cos(v) * 1.9 + 23, my = Math.sin(v) * 1.9 + 31;
      let n = fbm(nx * 1.6 + my * 0.3, ny * 1.6 + mx * 0.3, 4);
      n = n * 0.72 + band * 0.28;
      const t = clamp01((n - 0.28) * 1.7);
      const i = (y * ROCK_PX + x) * 4;
      let r: number, gg: number, bb: number;
      if (t < 0.5) {
        const k = t * 2;
        r = lerp(lo[0], base[0], k); gg = lerp(lo[1], base[1], k); bb = lerp(lo[2], base[2], k);
      } else {
        const k = (t - 0.5) * 2;
        r = lerp(base[0], hi[0], k); gg = lerp(base[1], hi[1], k); bb = lerp(base[2], hi[2], k);
      }
      img.data[i] = r; img.data[i + 1] = gg; img.data[i + 2] = bb; img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);

  for (let i = 0; i < 190; i++) {
    const h = hashStr(`p${i}${b.id}`);
    const x = h % ROCK_PX, y = (h >>> 9) % ROCK_PX;
    const r = 0.7 + ((h >>> 18) % 5) * 0.42;
    g.fillStyle = alpha(b.rockHi, 0.2 + ((h >>> 21) % 5) * 0.05);
    g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
    g.fillStyle = alpha(b.rockDeep, 0.3);
    g.beginPath(); g.arc(x + 0.5, y + r * 0.8, r * 0.8, 0, TAU); g.fill();
  }
  return cv;
}

export class Terrain {
  private rockPat: CanvasPattern | string = '#000000';
  private gTint!: CanvasGradient;
  private gCrust!: CanvasGradient;
  private gSub!: CanvasGradient;
  private gAO!: CanvasGradient;
  private gSideL!: CanvasGradient;
  private gSideR!: CanvasGradient;
  private depthCol: string[] = [];

  constructor(
    private readonly stage: Stage,
    readonly level: Level,
    readonly biome: Biome,
    private readonly createCanvas: () => HTMLCanvasElement,
  ) {
    this.build();
  }

  private build(): void {
    const ctx = this.stage.ctx;
    const b = this.biome;

    const rockCv = makeRockTexture(b, this.createCanvas);
    this.rockPat = ctx.createPattern(rockCv, 'repeat') ?? b.rock;

    // global tint: shallower rock catches the sky, deep rock goes cold
    const tg = ctx.createLinearGradient(0, 0, 0, this.level.pxH);
    tg.addColorStop(0, alpha(b.skyLight, 0.16));
    tg.addColorStop(0.4, alpha(b.skyLight, 0.06));
    tg.addColorStop(1, alpha('#000010', 0.22));
    this.gTint = tg;

    const c = ctx.createLinearGradient(0, 0, 0, 9);
    c.addColorStop(0, mixHex(b.crustHi, '#ffffff', 0.15));
    c.addColorStop(0.16, b.crust);
    c.addColorStop(0.42, alpha(mixHex(b.crust, b.rockHi, 0.55), 0.7));
    c.addColorStop(1, alpha(b.rockHi, 0));
    this.gCrust = c;

    const ss = ctx.createLinearGradient(0, 0, 0, TILE * 2);
    ss.addColorStop(0, alpha(b.crust, 0.3));
    ss.addColorStop(1, alpha(b.crust, 0));
    this.gSub = ss;

    const ao = ctx.createLinearGradient(0, 0, 0, 11);
    ao.addColorStop(0, 'rgba(0,0,0,0.55)');
    ao.addColorStop(1, 'rgba(0,0,0,0)');
    this.gAO = ao;

    const sl = ctx.createLinearGradient(0, 0, 6, 0);
    sl.addColorStop(0, alpha(b.crustHi, 0.3));
    sl.addColorStop(1, alpha(b.crustHi, 0));
    this.gSideL = sl;
    const sr = ctx.createLinearGradient(0, 0, -6, 0);
    sr.addColorStop(0, 'rgba(0,0,0,0.34)');
    sr.addColorStop(1, 'rgba(0,0,0,0)');
    this.gSideR = sr;

    this.depthCol = DEPTH_ALPHA.map((a) => alpha('#0A0610', a));
  }

  private bounds(): [number, number, number, number] {
    const st = this.stage, L = this.level;
    return [
      Math.max(0, Math.floor(st.wLeft / TILE) - 1),
      Math.min(L.w - 1, Math.ceil(st.wRight / TILE) + 1),
      Math.max(0, Math.floor(st.wTop / TILE) - 1),
      Math.min(L.h - 1, Math.ceil(st.wBottom / TILE) + 1),
    ];
  }

  // ------------------------------------------------------------------ draw
  /** @param switchFlash 0..1 pulse after a polarity toggle. */
  draw(t: number, switchFlash = 0): void {
    const L = this.level, b = this.biome, ctx = this.stage.ctx;
    const [x0, x1, y0, y1] = this.bounds();
    if (x1 < x0 || y1 < y0) return;

    // ---------- pass 1: merged rock body ----------
    const path = new Path2D();
    let any = false;
    for (let ty = y0; ty <= y1; ty++) {
      let run = -1;
      for (let tx = x0; tx <= x1 + 1; tx++) {
        const solid = tx <= x1 && L.at(tx, ty) === '#';
        if (solid && run < 0) run = tx;
        else if (!solid && run >= 0) {
          path.rect(run * TILE, ty * TILE, (tx - run) * TILE, TILE);
          any = true;
          run = -1;
        }
      }
    }
    if (any) {
      ctx.save();
      ctx.fillStyle = this.rockPat;
      ctx.fill(path);
      ctx.fillStyle = this.gTint;
      ctx.fill(path);
      ctx.restore();
    }

    // ---------- pass 2: depth shading (three cumulative bands) ----------
    const bands: (Path2D | null)[] = [null, null, null];
    const subPath = new Path2D();
    let hasSub = false;
    for (let tx = x0; tx <= x1; tx++) {
      let depth = 0;
      for (let k = 1; k <= 10; k++) {
        if (L.solid(tx, y0 - k)) depth++; else break;
      }
      for (let ty = y0; ty <= y1; ty++) {
        if (!L.solid(tx, ty)) { depth = 0; continue; }
        if (depth > 0) {
          for (let bi = 0; bi < DEPTH_BANDS.length; bi++) {
            if (depth >= DEPTH_BANDS[bi]) (bands[bi] ||= new Path2D()).rect(tx * TILE, ty * TILE, TILE, TILE);
          }
        } else {
          // surface tile: warm bounce light spilling down from the crust
          subPath.rect(tx * TILE, ty * TILE, TILE, TILE * 2);
          hasSub = true;
        }
        depth++;
      }
    }
    ctx.save();
    for (let bi = 0; bi < bands.length; bi++) {
      const p = bands[bi];
      if (!p) continue;
      ctx.fillStyle = this.depthCol[bi];
      ctx.fill(p);
    }
    if (hasSub) {
      ctx.fillStyle = this.gSub;
      ctx.fill(subPath);
    }
    ctx.restore();

    // ---------- crumbling blocks ----------
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (L.at(tx, ty) !== 'X') continue;
        this.crumbleTile(ctx, tx, ty);
      }
    }

    // ---------- pass 3: exposed-face detail ----------
    ctx.save();
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (L.at(tx, ty) !== '#') continue;
        const up = L.solid(tx, ty - 1), dn = L.solid(tx, ty + 1);
        const lf = L.solid(tx - 1, ty), rt = L.solid(tx + 1, ty);
        if (up && dn && lf && rt) continue;

        ctx.save();
        ctx.translate(tx * TILE, ty * TILE);

        if (!lf) { ctx.fillStyle = this.gSideL; ctx.fillRect(0, 0, 6, TILE); }
        if (!rt) {
          ctx.save(); ctx.translate(TILE, 0);
          ctx.fillStyle = this.gSideR; ctx.fillRect(-6, 0, 6, TILE);
          ctx.restore();
        }

        if (!up) {
          ctx.fillStyle = this.gCrust;
          ctx.fillRect(0, 0, TILE, 9);
          // the lit lip varies slightly per tile so a long ledge is not a bar
          const lipH = 1.0 + ((hashStr(`l${tx},${ty}`) >>> 2) % 3) * 0.22;
          ctx.fillStyle = alpha(mixHex(b.crustHi, '#ffffff', 0.25), 0.8);
          ctx.fillRect(0, 0, TILE, lipH);
          const hs = hashStr(`s${tx},${ty}`);
          ctx.fillStyle = alpha(b.crustHi, 0.55);
          ctx.beginPath();
          ctx.arc(((hs >>> 3) % 13) + 1.5, 1.4, 1.1 + ((hs >>> 9) % 3) * 0.3, Math.PI, TAU);
          ctx.fill();
          if ((hs & 1) === 0) {
            ctx.beginPath();
            ctx.arc(((hs >>> 13) % 13) + 1.5, 1.4, 0.9, Math.PI, TAU);
            ctx.fill();
          }
          ctx.fillStyle = alpha(b.rockDeep, 0.5);
          ctx.fillRect(0, 8, TILE, 0.9);
        }

        if (!dn) {
          ctx.save();
          ctx.translate(0, TILE);
          ctx.scale(1, -1);
          ctx.fillStyle = this.gAO;
          ctx.fillRect(0, 0, TILE, 11);
          ctx.restore();
          ctx.fillStyle = alpha('#000000', 0.32);
          ctx.fillRect(0, TILE - 1.6, TILE, 1.6);
          const h3 = hashStr(`u${tx},${ty}`);
          if ((h3 & 3) === 0) {
            ctx.fillStyle = alpha(b.rockDeep, 0.85);
            const nx = (h3 >>> 4) % 11 + 3;
            ctx.beginPath();
            ctx.moveTo(nx - 1.6, TILE);
            ctx.lineTo(nx, TILE + 3 + ((h3 >>> 8) % 3));
            ctx.lineTo(nx + 1.6, TILE);
            ctx.closePath(); ctx.fill();
          }
        }

        const h2 = hashStr(`c${tx},${ty}`);
        if ((h2 & 7) === 0) {
          ctx.strokeStyle = alpha(b.rockDeep, 0.6);
          ctx.lineWidth = 0.8;
          const ax = (h2 >>> 3) % 12 + 2, ay = (h2 >>> 7) % 9 + 4;
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(ax + ((h2 >>> 11) % 5) - 2, ay + 4 + ((h2 >>> 13) % 4));
          ctx.stroke();
        }
        ctx.restore();
      }
    }
    ctx.restore();

    this.switchBlocks(t, switchFlash, x0, x1, y0, y1);
    this.decor(t, x0, x1, y0, y1);
  }

  /** Crumbling block: visibly fragile, and it shudders once triggered. */
  private crumbleTile(ctx: CanvasRenderingContext2D, tx: number, ty: number): void {
    const b = this.biome;
    const timer = this.level.crumbleRemaining(tx, ty);
    const px = tx * TILE, py = ty * TILE;
    const k = timer === undefined ? 0 : 1 - timer / PHYS.crumbleDelay;
    ctx.save();
    if (timer !== undefined) {
      const shake = k * 1.6;
      ctx.translate(px + (Math.random() - 0.5) * shake, py + (Math.random() - 0.5) * shake);
    } else {
      ctx.translate(px, py);
    }
    const g = ctx.createLinearGradient(0, 0, 0, TILE);
    g.addColorStop(0, mixHex(b.rockHi, b.crustHi, 0.3));
    g.addColorStop(0.5, b.rock);
    g.addColorStop(1, mixHex(b.rockDeep, '#000000', 0.2));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.roundRect(0.5, 0.5, TILE - 1, TILE - 1, 2);
    ctx.fill();
    ctx.strokeStyle = alpha(b.crustHi, timer !== undefined ? 0.95 : 0.5);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.strokeStyle = alpha('#000000', 0.5);
    ctx.lineWidth = 0.8;
    const h = hashStr(`X${tx},${ty}`);
    ctx.beginPath();
    ctx.moveTo(2, 4 + (h % 5));
    ctx.lineTo(7 + ((h >>> 4) % 4), 8);
    ctx.lineTo(TILE - 2, 5 + ((h >>> 8) % 6));
    ctx.moveTo(6, TILE - 2);
    ctx.lineTo(8 + ((h >>> 12) % 3), 8);
    ctx.stroke();
    if (timer !== undefined) {
      ctx.fillStyle = alpha(C.danger, 0.25 * k);
      ctx.beginPath(); ctx.roundRect(0.5, 0.5, TILE - 1, TILE - 1, 2); ctx.fill();
    }
    ctx.restore();
  }

  /**
   * Switch blocks: solid ones glow in their polarity colour; passable ones are
   * a ghosted outline so the player can plan the flip.
   */
  private switchBlocks(t: number, flash: number, x0: number, x1: number, y0: number, y1: number): void {
    const L = this.level, st = this.stage, ctx = st.ctx, gctx = st.gctx;
    const bloom = st.settings.bloom;
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (!L.isSwitchBlock(tx, ty)) continue;
        const ch = L.at(tx, ty);
        if (ch !== SWITCH_A && ch !== SWITCH_B) continue;   // broken / out of play
        const col = ch === SWITCH_A ? C.switchA : C.switchB;
        const solid = L.solid(tx, ty);
        const px = tx * TILE, py = ty * TILE;
        const pulse = 0.5 + 0.5 * Math.sin(t * 3 + tx * 0.6 + ty * 0.4);
        ctx.save();
        ctx.translate(px, py);
        if (solid) {
          const g = ctx.createLinearGradient(0, 0, TILE, TILE);
          g.addColorStop(0, mixHex(col, '#ffffff', 0.35 + flash * 0.4));
          g.addColorStop(0.5, col);
          g.addColorStop(1, mixHex(col, '#000000', 0.45));
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.roundRect(0.5, 0.5, TILE - 1, TILE - 1, 2.5); ctx.fill();
          // inner bevel + a bright seam so the block reads as a lit tile
          ctx.strokeStyle = alpha('#ffffff', 0.35 + 0.2 * pulse + flash * 0.4);
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.roundRect(2.5, 2.5, TILE - 5, TILE - 5, 1.5); ctx.stroke();
          ctx.fillStyle = alpha('#ffffff', 0.5);
          ctx.fillRect(3, 3, TILE - 6, 1.2);
          ctx.strokeStyle = alpha(mixHex(col, '#000000', 0.6), 0.8);
          ctx.beginPath(); ctx.roundRect(0.5, 0.5, TILE - 1, TILE - 1, 2.5); ctx.stroke();
          ctx.restore();
          if (bloom) {
            gctx.fillStyle = alpha(col, 0.22 + 0.1 * pulse + flash * 0.45);
            gctx.fillRect(px + 1, py + 1, TILE - 2, TILE - 2);
          }
        } else {
          ctx.fillStyle = alpha(col, 0.06 + flash * 0.1);
          ctx.beginPath(); ctx.roundRect(1.5, 1.5, TILE - 3, TILE - 3, 2.5); ctx.fill();
          ctx.strokeStyle = alpha(col, 0.3 + 0.1 * pulse);
          ctx.lineWidth = 0.9;
          ctx.setLineDash([2.5, 2.5]);
          ctx.lineDashOffset = -t * 6;
          ctx.beginPath(); ctx.roundRect(1.5, 1.5, TILE - 3, TILE - 3, 2.5); ctx.stroke();
          ctx.setLineDash([]);
          ctx.restore();
        }
      }
    }
  }

  /** Per-biome growth on ledges. Deterministic, so it never shimmers. */
  private decor(t: number, x0: number, x1: number, y0: number, y1: number): void {
    const L = this.level, b = this.biome, st = this.stage, ctx = st.ctx, gctx = st.gctx;
    const kind = b.props[0];
    const bloom = st.settings.bloom;
    ctx.save();
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (L.at(tx, ty) !== '#' || L.solid(tx, ty - 1)) continue;
        const hs = hashStr(`d${tx},${ty}`);
        if ((hs & 7) > 2) continue;
        const px = tx * TILE + ((hs >>> 6) % 12) + 2;
        const py = ty * TILE;
        const sway = Math.sin(t * 1.4 + tx * 0.7) * 1.6;
        const sc = 0.7 + ((hs >>> 10) % 7) / 10;

        if (kind === 'anemone') {
          // branching fan + a rounded polyp clump beside it
          const col = mixHex(b.crust, C.shard, ((hs >>> 3) & 1) ? 0.5 : 0.02);
          const fan = ctx.createRadialGradient(px, py - 4 * sc, 0, px, py - 4 * sc, 8 * sc);
          fan.addColorStop(0, alpha(col, 0.34));
          fan.addColorStop(1, alpha(col, 0));
          ctx.fillStyle = fan;
          ctx.beginPath();
          ctx.ellipse(px, py - 4 * sc, 7 * sc, 6 * sc, 0, Math.PI, TAU);
          ctx.fill();
          ctx.strokeStyle = alpha(col, 0.9);
          ctx.lineWidth = 1.5 * sc;
          ctx.lineCap = 'round';
          for (let i = -1; i <= 1; i++) {
            ctx.beginPath();
            ctx.moveTo(px, py);
            ctx.quadraticCurveTo(px + i * 3 + sway * 0.5, py - 6 * sc, px + i * 5 + sway, py - 11 * sc);
            ctx.stroke();
            if (i !== 0) {
              ctx.beginPath();
              ctx.moveTo(px + i * 2.4, py - 5 * sc);
              ctx.lineTo(px + i * 5.6, py - 7.5 * sc);
              ctx.stroke();
            }
          }
          ctx.fillStyle = alpha(mixHex(col, '#ffffff', 0.25), 0.75);
          for (let i = 0; i < 3; i++) {
            const bx = px - 4 + i * 3.4, br = 1.1 + ((hs >>> (i * 3)) % 3) * 0.35;
            ctx.beginPath(); ctx.arc(bx, py - br * 0.7, br, Math.PI, TAU); ctx.fill();
          }
        } else if (kind === 'crystal') {
          const h = (7 + ((hs >>> 8) % 8)) * sc;
          const w = 2.4 * sc;
          const col = ((hs >>> 5) & 1) ? b.crust : b.accent;
          const g2 = ctx.createLinearGradient(px - w, py - h, px + w, py);
          g2.addColorStop(0, mixHex(col, '#ffffff', 0.55));
          g2.addColorStop(1, col);
          ctx.fillStyle = g2;
          ctx.beginPath();
          ctx.moveTo(px, py - h); ctx.lineTo(px + w, py - h * 0.32); ctx.lineTo(px + w * 0.55, py);
          ctx.lineTo(px - w * 0.55, py); ctx.lineTo(px - w, py - h * 0.32);
          ctx.closePath(); ctx.fill();
          ctx.fillStyle = alpha('#ffffff', 0.55);
          ctx.fillRect(px - 0.45, py - h * 0.82, 0.9, h * 0.5);
          ctx.fillStyle = alpha(col, 0.8);
          ctx.beginPath();
          ctx.moveTo(px + w * 1.6, py - h * 0.5); ctx.lineTo(px + w * 2.3, py);
          ctx.lineTo(px + w * 0.9, py);
          ctx.closePath(); ctx.fill();
          if (bloom) {
            const pulse = 0.5 + 0.5 * Math.sin(t * 2 + tx);
            gctx.fillStyle = alpha(col, 0.3 * pulse);
            gctx.beginPath(); gctx.arc(px, py - h * 0.5, w * 1.8, 0, TAU); gctx.fill();
          }
        } else {
          // voidreef polyps: soft bumps with a bioluminescent mouth and a drifting wisp
          const pulse = 0.4 + 0.6 * Math.abs(Math.sin(t * 1.7 + tx * 1.3));
          const col = ((hs >>> 5) & 1) ? b.crust : b.accent;
          ctx.fillStyle = alpha(mixHex(b.rockHi, col, 0.35), 0.9);
          ctx.beginPath(); ctx.ellipse(px, py - 1.5 * sc, 4 * sc, 2.6 * sc, 0, Math.PI, TAU); ctx.fill();
          ctx.fillStyle = alpha(col, 0.55 * pulse);
          ctx.beginPath(); ctx.ellipse(px, py - 3 * sc, 2 * sc, 1.1 * sc, 0, 0, TAU); ctx.fill();
          ctx.fillStyle = alpha('#FFFFFF', 0.4 * pulse);
          ctx.fillRect(px - 1, py - 3.4 * sc, 2, 0.8);
          if (bloom) {
            gctx.fillStyle = alpha(col, 0.35 * pulse);
            gctx.beginPath(); gctx.arc(px, py - 3 * sc, 6 * sc, 0, TAU); gctx.fill();
          }
          if ((hs & 12) === 0) {
            ctx.strokeStyle = alpha(col, 0.18);
            ctx.lineWidth = 1.1;
            ctx.beginPath();
            ctx.moveTo(px, py - 3);
            ctx.quadraticCurveTo(px + Math.sin(t * 2 + tx) * 3, py - 9, px + Math.sin(t * 1.4 + tx) * 4, py - 16);
            ctx.stroke();
          }
        }
      }
    }
    ctx.restore();
  }

  /** Spikes, water and one-way platforms are tile-anchored but drawn as props. */
  drawHazards(t: number): void {
    const L = this.level, st = this.stage, ctx = st.ctx, gctx = st.gctx;
    const [x0, x1, y0, y1] = this.bounds();
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const ch = L.at(tx, ty);
        if (ch === '^' || ch === 'V' || ch === '{' || ch === '}') this.spike(ctx, gctx, tx, ty, ch, t);
        else if (ch === '=') this.platform(ctx, tx, ty);
        else if (ch === '~' || ch === 'W') this.water(ctx, gctx, tx, ty, ch, t);
      }
    }
  }

  private spike(ctx: CanvasRenderingContext2D, gctx: CanvasRenderingContext2D, tx: number, ty: number, ch: string, t: number): void {
    const px = tx * TILE, py = ty * TILE;
    const pulse = 0.55 + 0.45 * Math.sin(t * 4 + tx * 0.9 + ty);
    const sp = this.biome.spike;
    ctx.save();
    ctx.translate(px + TILE / 2, py + TILE / 2);
    if (ch === 'V') ctx.rotate(Math.PI);
    else if (ch === '{') ctx.rotate(Math.PI / 2);
    else if (ch === '}') ctx.rotate(-Math.PI / 2);
    ctx.translate(-TILE / 2, -TILE / 2);

    const bg = ctx.createLinearGradient(0, TILE, 0, TILE - 5);
    bg.addColorStop(0, mixHex(sp.lo, '#000000', 0.4));
    bg.addColorStop(1, sp.lo);
    ctx.fillStyle = bg;
    ctx.fillRect(0, TILE - 4.5, TILE, 4.5);

    for (let i = 0; i < 3; i++) {
      const bx = 1.6 + i * 4.6;
      const h = i === 1 ? 13.5 : 11;
      const g = ctx.createLinearGradient(bx, TILE - h, bx + 4, TILE);
      g.addColorStop(0, sp.hi);
      g.addColorStop(0.42, sp.mid);
      g.addColorStop(1, sp.lo);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(bx + 2, TILE - h);
      ctx.lineTo(bx + 4.1, TILE - 2);
      ctx.lineTo(bx - 0.1, TILE - 2);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = alpha(C.danger, 0.42 * pulse);
      ctx.beginPath();
      ctx.moveTo(bx + 2, TILE - h);
      ctx.lineTo(bx + 2.65, TILE - h * 0.58);
      ctx.lineTo(bx + 1.35, TILE - h * 0.58);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    if (this.stage.settings.bloom) {
      gctx.fillStyle = alpha(C.danger, 0.1 * pulse);
      gctx.fillRect(px + 3, py + 3, TILE - 6, TILE - 7);
    }
  }

  private platform(ctx: CanvasRenderingContext2D, tx: number, ty: number): void {
    const b = this.biome;
    ctx.save();
    ctx.translate(tx * TILE, ty * TILE);
    const g = ctx.createLinearGradient(0, 0, 0, 6);
    g.addColorStop(0, mixHex(b.crustHi, '#ffffff', 0.3));
    g.addColorStop(0.45, b.crust);
    g.addColorStop(1, mixHex(b.rock, '#000000', 0.25));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.roundRect(0, 0, TILE, 5.5, [2.5, 2.5, 1, 1]);
    ctx.fill();
    ctx.fillStyle = alpha('#000000', 0.34);
    ctx.fillRect(1, 5.5, TILE - 2, 1.4);
    ctx.restore();
  }

  private water(ctx: CanvasRenderingContext2D, gctx: CanvasRenderingContext2D, tx: number, ty: number, ch: string, t: number): void {
    const px = tx * TILE, py = ty * TILE;
    ctx.save();
    if (ch === '~') {
      const wob = Math.sin(t * 2.2 + tx * 0.8) * 1.5;
      const g = ctx.createLinearGradient(0, py, 0, py + TILE);
      g.addColorStop(0, alpha(C.tide, 0.5));
      g.addColorStop(1, alpha(C.water, 0.5));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(px, py + 2 + wob);
      ctx.quadraticCurveTo(px + TILE / 2, py - 1 + wob, px + TILE, py + 2 - wob);
      ctx.lineTo(px + TILE, py + TILE);
      ctx.lineTo(px, py + TILE);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = alpha('#CFF6FF', 0.65);
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(px, py + 2 + wob);
      ctx.quadraticCurveTo(px + TILE / 2, py - 1 + wob, px + TILE, py + 2 - wob);
      ctx.stroke();
      if (this.stage.settings.bloom) {
        gctx.fillStyle = alpha(C.tide, 0.12);
        gctx.fillRect(px, py, TILE, 4);
      }
    } else {
      ctx.fillStyle = alpha(C.water, 0.45);
      ctx.fillRect(px, py, TILE, TILE);
      const caustic = 0.05 + 0.05 * Math.sin(t * 1.6 + tx * 0.6 + ty * 0.4);
      ctx.fillStyle = alpha('#BFF0FF', caustic);
      ctx.fillRect(px, py, TILE, TILE);
    }
    ctx.restore();
  }
}
