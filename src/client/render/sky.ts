/**
 * Parallax backdrop: sky gradient, stars, celestial body with god rays, cloud
 * bands, three procedurally generated ridge silhouettes, mid-ground props, the
 * canyon wall behind the playfield, and per-biome weather.
 *
 *   tidepool   — dawn sky, low sun, sea-spray motes rising off the water
 *   stormspire — indigo night, rain streaks driven by wind, lightning flashes
 *   voidreef   — near-black, bioluminescent glow from below, drifting spores
 *
 * Ridges are drawn as paths rather than baked bitmaps — 72 segments per layer
 * is nothing for the rasteriser, and it buys sub-pixel parallax plus real
 * gradients that would band badly if they were pre-scaled.
 *
 * Weather lives in normalised screen space so it survives camera cuts.
 */
import type { Biome } from '../../shared/biomes.js';
import { makeRng } from '../../sim/rng.js';
import { Stage, TAU, VIEW_H, alpha, clamp01, fbm, lerp, mixHex } from './stage.js';

const RIDGE_SEGS = 72;
const RIDGE_SPAN = 1400; // world units per repeat

interface Layer { pts: Float32Array; par: number; col: string; span: number; yoff: number }
interface Cloud { x: number; y: number; r: number; sq: number; par: number; a: number; drift: number; seed: number }
interface Prop { x: number; par: number; h: number; w: number; dark: number; seed: number; kind: string; lean: number; arms: number }
interface Fissure { u: number; len: number; w: number; o: number }
interface Star { x: number; y: number; r: number; tw: number; sp: number; col: string }
interface Mote {
  x: number; y: number; vx: number; vy: number; r: number;
  ph: number; sp: number; col: string; glow: number; a: number; len: number;
}
interface Pt { x: number; y: number }

function buildRidge(rng: () => number, amp: number, base: number, rough: number): Float32Array {
  const pts = new Float32Array(RIDGE_SEGS + 1);
  const o = rng() * 100;
  for (let i = 0; i <= RIDGE_SEGS; i++) {
    const u = i / RIDGE_SEGS;
    // wrap the noise domain so the profile tiles seamlessly
    const a = u * TAU;
    const nx = Math.cos(a) * 2.1 + o, ny = Math.sin(a) * 2.1 + o;
    let h = fbm(nx * rough, ny * rough, 5);
    // ridged noise gives crests instead of rolling dunes
    h = 1 - Math.abs(h * 2 - 1);
    h = Math.pow(h, 0.75);
    pts[i] = base - h * amp;
  }
  pts[RIDGE_SEGS] = pts[0];
  return pts;
}

export class Sky {
  biome: Biome | null = null;
  /** Full-sky lightning intensity 0..1 (stormspire). */
  lightning = 0;
  /** When false, flashes are capped for photosensitive players. */
  flashesAllowed = true;

  private layers: Layer[] = [];
  private clouds: Cloud[] = [];
  private props: Prop[] = [];
  private wall: Float32Array = new Float32Array(RIDGE_SEGS + 1);
  private fissures: Fissure[] = [];
  private stars: Star[] = [];
  private readonly weather: Mote[] = [];
  private t = 0;
  private grad: CanvasGradient | null = null;
  private gradKey = '';
  private lastCamX = 0;
  private boltCd = 3;
  private bolt: Pt[] = [];
  private boltBranch: Pt[] = [];
  private flickerLeft = 0;

  constructor(private readonly stage: Stage) {}

  setBiome(biome: Biome, seed = 1): void {
    this.biome = biome;
    const rng = makeRng((seed * 7919 + 13) >>> 0);
    this.layers = [
      { pts: buildRidge(rng, 150, 220, 0.9), par: 0.08, col: biome.ridge[0], span: RIDGE_SPAN * 1.9, yoff: -30 },
      { pts: buildRidge(rng, 118, 250, 1.6), par: 0.17, col: biome.ridge[1], span: RIDGE_SPAN * 1.2, yoff: 6 },
      { pts: buildRidge(rng, 88, 280, 2.7), par: 0.30, col: biome.ridge[2], span: RIDGE_SPAN * 0.82, yoff: 30 },
    ];
    this.clouds = [];
    const nC = biome.id === 'voidreef' ? 4 : biome.id === 'stormspire' ? 12 : 9;
    for (let i = 0; i < nC; i++) {
      this.clouds.push({
        x: rng() * 2400, y: 30 + rng() * 150,
        r: 26 + rng() * 74, sq: 0.28 + rng() * 0.3,
        par: 0.05 + rng() * 0.09, a: (biome.id === 'stormspire' ? 0.1 : 0.06) + rng() * 0.14,
        drift: 2 + rng() * 6, seed: rng() * 100,
      });
    }
    // Mid-ground props fill the dead band between the horizon and the playfield.
    this.props = [];
    const propSets: [number, number, number, number][] = [[0.42, 13, 0.9, 0.2], [0.62, 9, 1.35, 0.05]];
    for (const [par, count, scale, dark] of propSets) {
      for (let i = 0; i < count; i++) {
        this.props.push({
          x: rng() * 3000, par,
          h: (52 + rng() * 66) * scale, w: (11 + rng() * 15) * scale,
          dark, seed: rng() * 1000, kind: biome.props[0],
          lean: (rng() - 0.5) * 0.18, arms: 3 + Math.floor(rng() * 3),
        });
      }
    }
    this.props.sort((a, b2) => a.par - b2.par);

    // The near canyon wall behind the playable terrain.
    this.wall = buildRidge(rng, 84, 220, 3.1);
    this.fissures = [];
    for (let i = 0; i < 11; i++) this.fissures.push({ u: rng(), len: 0.25 + rng() * 0.5, w: 0.5 + rng() * 1.6, o: rng() });

    this.stars = [];
    const nStars = biome.id === 'voidreef' ? 150 : biome.id === 'stormspire' ? 90 : 0;
    for (let i = 0; i < nStars; i++) {
      const magenta = biome.id === 'voidreef' && rng() < 0.2;
      this.stars.push({
        x: rng(), y: rng() * 0.62, r: rng() * 0.9 + 0.25, tw: rng() * TAU, sp: 1 + rng() * 3,
        col: magenta ? '#FFB5E8' : biome.id === 'voidreef' ? '#CFFBFF' : '#EAE4FF',
      });
    }
    this.weather.length = 0;
    this.lightning = 0;
    this.boltCd = 2 + Math.random() * 4;
    this.grad = null;
    this.gradKey = '';
  }

  private gradient(ctx: CanvasRenderingContext2D): CanvasGradient {
    const b = this.biome!;
    const key = `${b.id}|${this.stage.h}`;
    if (this.gradKey === key && this.grad) return this.grad;
    const g = ctx.createLinearGradient(0, 0, 0, this.stage.h);
    for (let i = 0; i < b.sky.length; i++) g.addColorStop(i / (b.sky.length - 1), b.sky[i]);
    this.grad = g; this.gradKey = key;
    return g;
  }

  // ------------------------------------------------------------ update
  update(dt: number, camX: number, _camY: number): void {
    this.t += dt;
    const b = this.biome;
    if (!b) return;
    const st = this.stage;
    const budget = st.quality === 'low' ? 0.35 : st.quality === 'balanced' ? 0.7 : 1;
    const want = Math.round((b.weather === 'rain' ? 120 : b.weather === 'spores' ? 80 : 70) * budget);

    while (this.weather.length < want) {
      const m: Mote = { x: 0, y: 0, vx: 0, vy: 0, r: 1, ph: 0, sp: 1, col: '#ffffff', glow: 0, a: 0.5, len: 0 };
      this.initMote(m, true);
      this.weather.push(m);
    }
    while (this.weather.length > want) this.weather.pop();

    const dx = camX - this.lastCamX;
    this.lastCamX = camX;

    for (const m of this.weather) {
      m.ph += dt * m.sp * 2.2;
      m.x += (m.vx * dt) / st.viewW - (dx * 0.16) / st.viewW;
      m.y += (m.vy * dt) / st.viewH;
      if (b.weather === 'spores') m.x += (Math.sin(m.ph) * 9 * dt) / st.viewW;
      else if (b.weather === 'spray') m.x += (Math.sin(m.ph) * 5 * dt) / st.viewW;
      if (m.y > 1.05 || m.y < -0.08 || m.x < -0.1 || m.x > 1.1) this.initMote(m, false);
    }

    // lightning: a strike, then one or two flickers as it decays
    if (b.lightning) {
      this.boltCd -= dt;
      if (this.boltCd <= 0) {
        this.boltCd = 4 + Math.random() * 7;
        this.lightning = 1;
        this.flickerLeft = 1 + Math.floor(Math.random() * 2);
        this.buildBolt();
      }
      if (this.lightning > 0) {
        this.lightning = Math.max(0, this.lightning - dt * 3.4);
        if (this.flickerLeft > 0 && this.lightning < 0.35 && Math.random() < dt * 9) {
          this.lightning = 0.55 + Math.random() * 0.3;
          this.flickerLeft--;
        }
      }
    } else {
      this.lightning = 0;
    }
  }

  private initMote(m: Mote, anywhere: boolean): void {
    const b = this.biome!;
    const R = Math.random;
    m.x = R() * 1.1 - 0.05;
    m.len = 0;
    if (b.weather === 'rain') {
      m.y = anywhere ? R() : -0.06;
      m.vy = 300 + R() * 170;
      m.vx = -70 - R() * 45;
      m.r = 0.45 + R() * 0.6;
      m.len = 7 + R() * 11;
      m.col = R() < 0.25 ? '#E6DCFF' : '#9F8CFF';
      m.glow = 0.2;
      m.a = 0.14 + R() * 0.3;
    } else if (b.weather === 'spray') {
      m.y = anywhere ? R() : 1.04;
      m.vy = -(18 + R() * 46);
      m.vx = (R() - 0.5) * 26;
      m.r = 0.5 + R() * 1.5;
      m.col = R() < 0.4 ? '#7FE3D6' : '#F4FFFD';
      m.glow = 0.55;
      m.a = 0.22 + R() * 0.45;
    } else {
      m.y = anywhere ? R() : 1.04;
      m.vy = -(3 + R() * 12);
      m.vx = (R() - 0.5) * 10;
      m.r = 0.6 + R() * 1.6;
      m.col = R() < 0.3 ? '#FF5BC8' : '#6FE7FF';
      m.glow = 0.9;
      m.a = 0.3 + R() * 0.45;
    }
    m.sp = 0.4 + R();
    m.ph = R() * TAU;
  }

  private buildBolt(): void {
    const R = Math.random;
    const pts: Pt[] = [];
    let x = 0.15 + R() * 0.7, y = -0.02;
    pts.push({ x, y });
    const n = 9 + Math.floor(R() * 5);
    const endY = 0.42 + R() * 0.16;
    for (let i = 1; i <= n; i++) {
      y = lerp(-0.02, endY, i / n);
      x += (R() - 0.5) * 0.08;
      pts.push({ x, y });
    }
    this.bolt = pts;
    // one branch off the middle
    const from = pts[Math.floor(n * 0.4)];
    const br: Pt[] = [{ x: from.x, y: from.y }];
    const dir = R() < 0.5 ? -1 : 1;
    for (let i = 1; i <= 4; i++) br.push({ x: from.x + dir * i * 0.025 + (R() - 0.5) * 0.02, y: from.y + i * 0.04 });
    this.boltBranch = br;
  }

  // ------------------------------------------------------------ draw
  /** Draw in device pixels (no world transform). `camX/camY` drive parallax. */
  draw(camX: number, camY: number): void {
    const b = this.biome;
    if (!b) return;
    const st = this.stage;
    const ctx = st.ctx, gctx = st.gctx;
    const W = st.w, H = st.h, S = st.scale;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.gradient(ctx);
    ctx.fillRect(0, 0, W, H);

    // vertical drift: climbing reveals more sky, sinking reveals more haze
    const vert = clamp01((camY + 200) / 900);

    // ---------- stars ----------
    if (this.stars.length) {
      for (const s of this.stars) {
        const tw = 0.45 + 0.55 * Math.sin(this.t * s.sp + s.tw);
        const x = ((s.x * W - camX * 0.02 * S) % W + W) % W;
        const y = s.y * H - camY * 0.02 * S;
        if (y < -4 || y > H) continue;
        ctx.fillStyle = alpha(s.col, tw * 0.8);
        ctx.fillRect(x, y, s.r * st.dpr, s.r * st.dpr);
      }
    }

    // ---------- lightning (behind the ridges: a distant strike) ----------
    if (this.lightning > 0.01) this.drawLightning(W, H, S);

    // ---------- celestial body ----------
    const sun = b.sun;
    const sx = sun.x * W - camX * 0.03 * S;
    const sy = sun.y * H - camY * 0.05 * S + vert * 40;
    const sr = sun.r * S * 0.6;

    if (st.quality !== 'low') {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const rays = 7;
      for (let i = 0; i < rays; i++) {
        const a = (i / rays) * TAU + this.t * 0.035 + (i % 2 ? 0.2 : 0);
        const w = 0.05 + 0.035 * Math.sin(this.t * 0.6 + i * 2.1);
        const len = H * (1.1 + 0.3 * Math.sin(this.t * 0.4 + i));
        ctx.fillStyle = alpha(sun.glow, 0.035 + 0.02 * Math.sin(this.t * 0.9 + i));
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(sx + Math.cos(a - w) * len, sy + Math.sin(a - w) * len);
        ctx.lineTo(sx + Math.cos(a + w) * len, sy + Math.sin(a + w) * len);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }

    const halo = ctx.createRadialGradient(sx, sy, 0, sx, sy, sr * 5.5);
    halo.addColorStop(0, alpha(sun.color, 0.5));
    halo.addColorStop(0.18, alpha(sun.glow, 0.34));
    halo.addColorStop(0.45, alpha(sun.glow, 0.1));
    halo.addColorStop(1, alpha(sun.glow, 0));
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = halo;
    ctx.fillRect(sx - sr * 7, sy - sr * 7, sr * 14, sr * 14);
    ctx.restore();
    if (sun.kind !== 'glow') {
      // An opaque core first, then an additive rim: purely additive over a mid
      // tone sky reads as haze, not as a body with an edge.
      const disc = ctx.createRadialGradient(sx - sr * 0.22, sy - sr * 0.26, sr * 0.04, sx, sy, sr * 0.86);
      disc.addColorStop(0, '#FFFFFF');
      disc.addColorStop(0.6, sun.color);
      disc.addColorStop(1, mixHex(sun.color, sun.glow, 0.55));
      ctx.fillStyle = disc;
      ctx.beginPath(); ctx.arc(sx, sy, sr * 0.86, 0, TAU); ctx.fill();
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const rim = ctx.createRadialGradient(sx, sy, sr * 0.7, sx, sy, sr * 1.25);
      rim.addColorStop(0, alpha(sun.color, 0.55));
      rim.addColorStop(1, alpha(sun.glow, 0));
      ctx.fillStyle = rim;
      ctx.beginPath(); ctx.arc(sx, sy, sr * 1.25, 0, TAU); ctx.fill();
      ctx.restore();
    }

    gctx.setTransform(1, 0, 0, 1, 0, 0);
    const gd = st.glowDiv;
    // Only a hint reaches the bloom buffer: the glow layer composites *over*
    // terrain, so a hot sun would shine straight through a cliff face.
    if (sun.kind !== 'glow') {
      gctx.fillStyle = alpha(sun.color, 0.3);
      gctx.beginPath(); gctx.arc(sx / gd, sy / gd, (sr * 0.7) / gd, 0, TAU); gctx.fill();
    } else {
      gctx.fillStyle = alpha(sun.glow, 0.16);
      gctx.beginPath(); gctx.arc(sx / gd, sy / gd, (sr * 1.6) / gd, 0, TAU); gctx.fill();
    }

    // ---------- cloud bands ----------
    for (const c of this.clouds) {
      const x = ((c.x + this.t * c.drift - camX * c.par) % 2400 + 2400) % 2400;
      const px = (x / 2400) * (W * 1.6) - W * 0.3;
      const py = c.y * S - camY * c.par * S * 0.5 + vert * 20;
      if (py > H + 100 || py < -160) continue;
      const r = c.r * S * 0.55;
      const g = ctx.createRadialGradient(px, py, 0, px, py, r);
      const lit = c.a * (1 + this.lightning * 1.6);
      g.addColorStop(0, alpha(b.skyLight, lit));
      g.addColorStop(0.55, alpha(b.fog, c.a * 0.5));
      g.addColorStop(1, alpha(b.fog, 0));
      ctx.save();
      ctx.translate(px, py); ctx.scale(1, c.sq); ctx.translate(-px, -py);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(px, py, r, 0, TAU); ctx.fill();
      ctx.restore();
    }

    // ---------- ridges / props / wall ----------
    this.ridges(camX, camY, 0, 2);
    this.drawProps(camX, camY, vert);
    this.ridges(camX, camY, 2, 3);
    this.backWall(camX, camY, vert);

    // ---------- atmospheric haze toward the horizon ----------
    const hz = ctx.createLinearGradient(0, H * 0.34, 0, H);
    const dense = b.id === 'voidreef' ? 1.4 : b.id === 'stormspire' ? 1.15 : 1;
    hz.addColorStop(0, alpha(b.fog, 0));
    hz.addColorStop(0.55, alpha(b.fog, 0.12 * dense));
    hz.addColorStop(1, alpha(b.fog, 0.3 * dense));
    ctx.fillStyle = hz;
    ctx.fillRect(0, H * 0.34, W, H * 0.66);

    // ---------- weather ----------
    this.drawWeather(W, H, S);
  }

  private drawLightning(W: number, H: number, S: number): void {
    const b = this.biome!;
    const st = this.stage;
    const ctx = st.ctx, gctx = st.gctx;
    const k = this.lightning;
    // full-sky flash, capped hard when the player opted out of flashes
    ctx.fillStyle = alpha('#FFFFFF', k * (this.flashesAllowed ? 0.26 : 0.05));
    ctx.fillRect(0, 0, W, H);
    if (this.bolt.length < 2) return;
    const draw = (g: CanvasRenderingContext2D, pts: Pt[], div: number, width: number, col: string) => {
      g.strokeStyle = col;
      g.lineWidth = width / div;
      g.lineJoin = 'round';
      g.lineCap = 'round';
      g.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const x = (pts[i].x * W) / div, y = (pts[i].y * H) / div;
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
    };
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    draw(ctx, this.bolt, 1, 4 * S * 0.5, alpha(b.skyLight, k * 0.35));
    draw(ctx, this.bolt, 1, 1.4 * S * 0.5, alpha('#FFFFFF', k * 0.95));
    draw(ctx, this.boltBranch, 1, 0.9 * S * 0.5, alpha('#FFFFFF', k * 0.7));
    ctx.restore();
    if (st.settings.bloom) {
      draw(gctx, this.bolt, st.glowDiv, 6 * S * 0.5, alpha(b.accent, k * 0.5));
    }
  }

  private drawWeather(W: number, H: number, S: number): void {
    const b = this.biome!;
    const st = this.stage;
    const ctx = st.ctx, gctx = st.gctx, gd = st.glowDiv;
    const bloom = st.settings.bloom;
    ctx.save();
    ctx.lineCap = 'round';
    if (b.weather === 'rain') {
      const bright = 1 + this.lightning * 1.6;
      for (const m of this.weather) {
        const x = m.x * W, y = m.y * H;
        const sp = Math.hypot(m.vx, m.vy) || 1;
        const nx = m.vx / sp, ny = m.vy / sp;
        const len = m.len * S * 0.5;
        ctx.strokeStyle = alpha(m.col, Math.min(1, m.a * bright));
        ctx.lineWidth = m.r * S * 0.5;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - nx * len, y - ny * len);
        ctx.stroke();
      }
    } else {
      for (const m of this.weather) {
        const x = m.x * W, y = m.y * H;
        const r = m.r * S * 0.5;
        const pulse = b.weather === 'spores' ? 0.5 + 0.5 * Math.sin(m.ph) : 0.6 + 0.4 * Math.sin(m.ph);
        const a = m.a * pulse;
        ctx.fillStyle = alpha(m.col, a);
        ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
        if (m.glow > 0.4 && bloom) {
          gctx.fillStyle = alpha(m.col, a * m.glow * 0.7);
          gctx.beginPath(); gctx.arc(x / gd, y / gd, (r * 1.8) / gd, 0, TAU); gctx.fill();
        }
      }
    }
    ctx.restore();
  }

  private ridges(camX: number, camY: number, from: number, to: number): void {
    const b = this.biome!;
    const st = this.stage, ctx = st.ctx;
    const W = st.w, H = st.h, S = st.scale;
    for (let li = from; li < to; li++) {
      const L = this.layers[li];
      const pts = L.pts;
      const spanPx = L.span * S;
      const off = ((-camX * L.par * S) % spanPx + spanPx) % spanPx;
      const baseY = (H * 0.52) + L.yoff * S - camY * L.par * S;

      const grd = ctx.createLinearGradient(0, baseY - 150 * S, 0, H);
      grd.addColorStop(0, mixHex(L.col, b.skyLight, 0.22 - li * 0.05 + this.lightning * 0.25));
      grd.addColorStop(0.3, L.col);
      grd.addColorStop(1, mixHex(L.col, '#000000', 0.5));
      ctx.fillStyle = grd;

      ctx.beginPath();
      ctx.moveTo(-spanPx + off, H + 10);
      const reps = Math.ceil(W / spanPx) + 1;
      for (let rep = -1; rep <= reps; rep++) {
        const x0 = rep * spanPx + off;
        for (let i = 0; i <= RIDGE_SEGS; i++) {
          const x = x0 + (i / RIDGE_SEGS) * spanPx;
          const y = baseY + (pts[i] - 220) * S * 0.55;
          ctx.lineTo(x, y);
        }
      }
      ctx.lineTo(W + spanPx, H + 10);
      ctx.closePath();
      ctx.fill();

      // rim light along the crest
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = alpha(b.skyLight, 0.1 + li * 0.04 + this.lightning * 0.3);
      ctx.lineWidth = Math.max(1, 1.2 * S * 0.5);
      ctx.beginPath();
      for (let rep = 0; rep <= reps; rep++) {
        const x0 = rep * spanPx + off - spanPx;
        for (let i = 0; i <= RIDGE_SEGS; i++) {
          const x = x0 + (i / RIDGE_SEGS) * spanPx;
          const y = baseY + (pts[i] - 220) * S * 0.55;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  /** The canyon wall directly behind the playfield: jagged crest, fissures, strata. */
  private backWall(camX: number, camY: number, vert: number): void {
    const b = this.biome!;
    const st = this.stage, ctx = st.ctx;
    const W = st.w, H = st.h, S = st.scale;
    const pts = this.wall;
    const par = 0.72;
    const spanPx = 1100 * S;
    const off = ((-camX * par * S) % spanPx + spanPx) % spanPx;
    const baseY = H * 0.70 - camY * par * S * 0.42 + vert * 34;

    const topOf = (x: number): number => {
      const u = (((x - off) / spanPx) % 1 + 1) % 1;
      const i = u * RIDGE_SEGS;
      const i0 = Math.floor(i);
      const a = pts[i0], c = pts[Math.min(RIDGE_SEGS, i0 + 1)];
      return baseY + (lerp(a, c, i - i0) - 220) * S * 0.42;
    };

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(-4, H + 8);
    const steps = 120;
    for (let i = 0; i <= steps; i++) {
      const x = (i / steps) * (W + 8) - 4;
      ctx.lineTo(x, topOf(x));
    }
    ctx.lineTo(W + 8, H + 8);
    ctx.closePath();

    // Darker and flatter than the playable terrain, or the depth cue inverts.
    const g = ctx.createLinearGradient(0, baseY - 90 * S, 0, H);
    g.addColorStop(0, mixHex(mixHex(b.rockDeep, b.fog, 0.26), '#000000', 0.34));
    g.addColorStop(0.3, mixHex(b.rockDeep, '#000000', 0.46));
    g.addColorStop(1, mixHex(b.rockDeep, '#000000', 0.72));
    ctx.fillStyle = g;
    ctx.fill();

    ctx.clip();
    ctx.globalAlpha = 0.07;
    ctx.strokeStyle = mixHex(b.rockHi, b.fog, 0.3);
    ctx.lineWidth = Math.max(1, 1.6 * S * 0.4);
    for (let k = 0; k < 7; k++) {
      const y = baseY + (k * 34 + 18) * S * 0.42;
      if (y > H) break;
      ctx.beginPath();
      for (let i = 0; i <= 24; i++) {
        const x = (i / 24) * W;
        const yy = y + Math.sin(i * 0.9 + k * 2.1) * 3 * S * 0.4;
        if (i === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 0.13;
    ctx.strokeStyle = mixHex(b.rockDeep, '#000000', 0.5);
    for (const f of this.fissures) {
      const x = ((f.u * spanPx + off) % spanPx) - spanPx * 0.5 + W * 0.5;
      for (const rep of [-1, 0, 1]) {
        const fx = x + rep * spanPx;
        if (fx < -20 || fx > W + 20) continue;
        const ty = topOf(fx);
        ctx.lineWidth = f.w * S * 0.5;
        ctx.beginPath();
        ctx.moveTo(fx, ty);
        ctx.quadraticCurveTo(fx + (f.o - 0.5) * 22 * S * 0.4, ty + (H - ty) * f.len * 0.5,
          fx + (f.o - 0.5) * 34 * S * 0.4, ty + (H - ty) * f.len);
        ctx.stroke();
      }
    }
    ctx.restore();

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = alpha(b.skyLight, 0.22 + this.lightning * 0.4);
    ctx.lineWidth = Math.max(1, 1.2 * S * 0.4);
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const x = (i / steps) * (W + 8) - 4;
      if (i === 0) ctx.moveTo(x, topOf(x)); else ctx.lineTo(x, topOf(x));
    }
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Silhouetted growths between the ridges and the playfield. Each is a single
   * filled path plus a one-sided rim light: anemone fans (tidepool), faceted
   * crystal spires with lanterns (stormspire), stacked polyps (voidreef).
   */
  private drawProps(camX: number, camY: number, vert: number): void {
    const b = this.biome!;
    const st = this.stage, ctx = st.ctx, gctx = st.gctx;
    const W = st.w, H = st.h, S = st.scale;
    const span = 3000;
    const sunSide = b.sun.x > 0.5 ? 1 : -1;
    const bloom = st.settings.bloom;

    for (const p of this.props) {
      const spanPx = span * S * 0.5;
      const px = ((p.x * S * 0.5 - camX * p.par * S) % spanPx + spanPx) % spanPx;
      for (const rep of [0, 1]) {
        const x = px - rep * spanPx;
        if (x < -140 * S || x > W + 140 * S) continue;
        const baseY = H * (0.60 + p.par * 0.22) - camY * p.par * S * 0.55 + vert * 26;
        const h = p.h * S * 0.5, w = p.w * S * 0.5;
        if (baseY - h > H || baseY < -40) continue;

        // atmospheric perspective: nearer props are darker, farther ones haze out
        const col = mixHex(mixHex(b.ridge[0], b.fog, p.dark), '#000000', 0.42 - p.par * 0.34);
        ctx.save();
        ctx.translate(x, baseY);
        ctx.rotate(p.lean * 0.4);
        ctx.fillStyle = col;

        if (p.kind === 'crystal') {
          ctx.beginPath();
          ctx.moveTo(0, -h);
          ctx.lineTo(w * 0.55, -h * 0.42);
          ctx.lineTo(w * 0.4, 0);
          ctx.lineTo(-w * 0.45, 0);
          ctx.lineTo(-w * 0.6, -h * 0.4);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = alpha(b.skyLight, 0.16 + this.lightning * 0.3);
          ctx.beginPath();
          ctx.moveTo(0, -h);
          ctx.lineTo(sunSide * w * 0.55, -h * 0.42);
          ctx.lineTo(sunSide * w * 0.4, 0);
          ctx.lineTo(0, 0);
          ctx.closePath();
          ctx.fill();
          // a lantern hung on every other spire
          if ((Math.floor(p.seed) & 1) === 0) {
            const ly = -h * 0.55, lx = -sunSide * w * 0.7;
            const flick = 0.7 + 0.3 * Math.sin(this.t * 6 + p.seed);
            ctx.fillStyle = alpha(b.accent, 0.75 * flick);
            ctx.beginPath(); ctx.arc(lx, ly, Math.max(1, w * 0.16), 0, TAU); ctx.fill();
            if (bloom) {
              gctx.fillStyle = alpha(b.accent, 0.3 * flick);
              gctx.beginPath();
              gctx.arc((x + lx) / st.glowDiv, (baseY + ly) / st.glowDiv, (w * 0.7) / st.glowDiv, 0, TAU);
              gctx.fill();
            }
          }
        } else if (p.kind === 'polyp') {
          // stacked bulbs tapering upward, tipped with a bioluminescent mouth
          const n = 3 + (p.arms % 2);
          for (let i = 0; i < n; i++) {
            const u = i / n;
            const by = -h * u;
            const rw = w * (0.9 - u * 0.5), rh = (h / n) * 0.62;
            ctx.beginPath();
            ctx.ellipse(p.lean * w * u * 2, by - rh * 0.5, rw, rh, 0, 0, TAU);
            ctx.fill();
          }
          const tipX = p.lean * w * 2, tipY = -h * 0.98;
          const pulse = 0.5 + 0.5 * Math.sin(this.t * 1.3 + p.seed);
          const tipCol = (Math.floor(p.seed) & 1) ? b.accent : b.crust;
          ctx.fillStyle = alpha(tipCol, 0.35 + 0.45 * pulse);
          ctx.beginPath(); ctx.ellipse(tipX, tipY, w * 0.32, w * 0.16, 0, 0, TAU); ctx.fill();
          if (bloom) {
            gctx.fillStyle = alpha(tipCol, 0.22 * pulse);
            gctx.beginPath();
            gctx.arc((x + tipX) / st.glowDiv, (baseY + tipY) / st.glowDiv, (w * 0.9) / st.glowDiv, 0, TAU);
            gctx.fill();
          }
        } else {
          // anemone / sea fan: a tapering trunk that forks into fine branches
          ctx.strokeStyle = col;
          ctx.lineCap = 'round';
          ctx.lineWidth = Math.max(1, w * 0.3);
          const sway = Math.sin(this.t * 0.7 + p.seed) * w * 0.15;
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.quadraticCurveTo(p.lean * w + sway, -h * 0.5, p.lean * w * 2 + sway * 2, -h * 0.72);
          ctx.stroke();
          for (let i = 0; i < p.arms; i++) {
            const u = 0.28 + (i / p.arms) * 0.62;
            const side = i % 2 ? 1 : -1;
            const bx = p.lean * w * u * 2 + sway * u, by = -h * u;
            const len = h * (0.34 - u * 0.16);
            ctx.lineWidth = Math.max(0.8, w * (0.2 - u * 0.09));
            ctx.beginPath();
            ctx.moveTo(bx, by);
            ctx.quadraticCurveTo(bx + side * w * 0.5, by - len * 0.5, bx + side * w * 0.66, by - len);
            ctx.stroke();
            ctx.lineWidth = Math.max(0.6, w * 0.08);
            for (const tw of [-0.5, 0.5]) {
              ctx.beginPath();
              ctx.moveTo(bx + side * w * 0.66, by - len);
              ctx.lineTo(bx + side * w * 0.66 + tw * w * 0.3, by - len - h * 0.07);
              ctx.stroke();
            }
          }
          ctx.fillStyle = col;
          ctx.beginPath();
          ctx.ellipse(0, 0, w * 0.42, w * 0.16, 0, Math.PI, TAU);
          ctx.fill();
        }

        ctx.strokeStyle = alpha(b.skyLight, 0.2 - p.par * 0.1);
        ctx.lineWidth = Math.max(0.8, 1.1 * S * 0.4);
        ctx.beginPath();
        ctx.moveTo(sunSide * w * 0.2, -h * 0.95);
        ctx.quadraticCurveTo(sunSide * w * 0.5, -h * 0.5, sunSide * w * 0.3, 0);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  /** Small standalone render used by level cards and thumbnails. */
  drawThumb(ctx: CanvasRenderingContext2D, w: number, h: number, biome: Biome, seed: number): void {
    const rng = makeRng(seed >>> 0);
    const g = ctx.createLinearGradient(0, 0, 0, h);
    for (let i = 0; i < biome.sky.length; i++) g.addColorStop(i / (biome.sky.length - 1), biome.sky[i]);
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    const sx = biome.sun.x * w, sy = biome.sun.y * h, sr = h * 0.09;
    const halo = ctx.createRadialGradient(sx, sy, 0, sx, sy, sr * 7);
    halo.addColorStop(0, alpha(biome.sun.color, 0.55));
    halo.addColorStop(1, alpha(biome.sun.glow, 0));
    ctx.fillStyle = halo; ctx.fillRect(0, 0, w, h);
    if (biome.sun.kind !== 'glow') {
      ctx.fillStyle = biome.sun.color;
      ctx.beginPath(); ctx.arc(sx, sy, sr, 0, TAU); ctx.fill();
    }
    for (let li = 0; li < 3; li++) {
      const pts = buildRidge(rng, 60 - li * 12, 220, 1 + li * 0.8);
      ctx.fillStyle = biome.ridge[li];
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let i = 0; i <= RIDGE_SEGS; i++) {
        const x = (i / RIDGE_SEGS) * w;
        const y = h * (0.52 + li * 0.07) + (pts[i] - 220) * (h / VIEW_H) * 0.6;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(w, h); ctx.closePath(); ctx.fill();
    }
    ctx.fillStyle = alpha(biome.fog, 0.3);
    ctx.fillRect(0, h * 0.6, w, h * 0.4);
  }
}
