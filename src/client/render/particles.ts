/**
 * Pooled particle system.
 *
 * One flat pre-allocated array; emitters overwrite the oldest slot when
 * saturated. No allocation, no GC spikes, and the draw loop is a single pass
 * over contiguous memory. Emissive particles are additionally stamped onto the
 * low-res glow buffer so they bloom.
 *
 * Purely presentational: nothing here feeds back into the simulation.
 */
import { Stage, TAU, alpha, clamp01 } from './stage.js';

const CAP = 1400;

const Kind = { Dot: 0, Square: 1, Spark: 2, Smoke: 3, Ring: 4, Tri: 5, Text: 6 } as const;
type Kind = (typeof Kind)[keyof typeof Kind];

class P {
  life = 0; max = 1;
  x = 0; y = 0; vx = 0; vy = 0;
  r = 1; r2 = 0;
  grav = 0; drag = 0.9;
  rot = 0; vrot = 0;
  kind: Kind = Kind.Dot;
  col = '#ffffff';
  glow = 0; a0 = 1;
  txt = '';
  bounce = 0;
  wobble = 0;
}

export type SolidAt = (x: number, y: number) => boolean;

export class Particles {
  private readonly pool: P[] = new Array(CAP);
  private head = 0;

  constructor(private readonly stage: Stage) {
    for (let i = 0; i < CAP; i++) this.pool[i] = new P();
  }

  private take(): P {
    const p = this.pool[this.head];
    this.head = (this.head + 1) % CAP;
    p.bounce = 0; p.wobble = 0; p.vrot = 0; p.rot = 0; p.r2 = 0; p.txt = '';
    return p;
  }

  clear(): void { for (const p of this.pool) p.life = 0; }

  /** Live particle count (for tests and debug overlays). */
  get count(): number {
    let n = 0;
    for (const p of this.pool) if (p.life > 0) n++;
    return n;
  }

  private budget(): number {
    const q = this.stage.quality;
    return q === 'low' ? 0.4 : q === 'balanced' ? 0.7 : 1;
  }

  // ------------------------------------------------------------ emitters
  /** Ground/landing dust: heavy, short-lived, spreads sideways. */
  dust(x: number, y: number, n = 8, dir = 0, col = '#ffffff', spd = 60): void {
    n = Math.max(1, Math.round(n * this.budget()));
    for (let i = 0; i < n; i++) {
      const p = this.take();
      const a = dir + (Math.random() - 0.5) * (dir ? 1.5 : TAU);
      const s = spd * (0.35 + Math.random() * 0.9);
      p.kind = Kind.Smoke; p.life = p.max = 0.28 + Math.random() * 0.4;
      p.x = x + (Math.random() - 0.5) * 6; p.y = y + (Math.random() - 0.5) * 3;
      p.vx = Math.cos(a) * s; p.vy = Math.sin(a) * s * 0.5 - Math.random() * 24;
      p.r = 2 + Math.random() * 4; p.grav = -14; p.drag = 0.86;
      p.col = col; p.glow = 0; p.a0 = 0.5; p.rot = Math.random() * TAU;
    }
  }

  /** Sharp directional sparks that streak along their velocity. */
  spark(x: number, y: number, n = 10, col = '#ffffff', spd = 200, dir: number | null = null, spread = TAU, glow = 1): void {
    n = Math.max(1, Math.round(n * this.budget()));
    for (let i = 0; i < n; i++) {
      const p = this.take();
      const a = (dir ?? 0) + (Math.random() - 0.5) * spread;
      const s = spd * (0.4 + Math.random() * 1.1);
      p.kind = Kind.Spark; p.life = p.max = 0.16 + Math.random() * 0.3;
      p.x = x; p.y = y;
      p.vx = Math.cos(a) * s; p.vy = Math.sin(a) * s;
      p.r = 1 + Math.random() * 1.6; p.grav = 320; p.drag = 0.9;
      p.col = col; p.glow = glow; p.a0 = 1;
    }
  }

  /** Tumbling debris chunks that bounce off terrain. */
  chunk(x: number, y: number, n = 6, col = '#ffffff', spd = 130, glow = 0): void {
    n = Math.max(1, Math.round(n * this.budget()));
    for (let i = 0; i < n; i++) {
      const p = this.take();
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.4;
      const s = spd * (0.4 + Math.random());
      p.kind = Kind.Square; p.life = p.max = 0.5 + Math.random() * 0.6;
      p.x = x; p.y = y;
      p.vx = Math.cos(a) * s; p.vy = Math.sin(a) * s;
      p.r = 1.6 + Math.random() * 3; p.grav = 520; p.drag = 0.985;
      p.rot = Math.random() * TAU; p.vrot = (Math.random() - 0.5) * 16;
      p.col = col; p.glow = glow; p.a0 = 1; p.bounce = 0.4;
    }
  }

  /** Expanding stroked ring — reads as a shockwave. */
  ring(x: number, y: number, r0: number, r1: number, dur: number, col: string, width = 2, glow = 1): void {
    const p = this.take();
    p.kind = Kind.Ring; p.life = p.max = dur;
    p.x = x; p.y = y; p.vx = 0; p.vy = 0;
    p.r = r0; p.r2 = r1; p.grav = 0; p.drag = 1;
    p.col = col; p.glow = glow; p.a0 = 1; p.rot = width;
  }

  /** Soft drifting smoke/steam. */
  smoke(x: number, y: number, n = 4, col = '#ffffff', rise = 30, size = 6): void {
    n = Math.max(1, Math.round(n * this.budget()));
    for (let i = 0; i < n; i++) {
      const p = this.take();
      p.kind = Kind.Smoke; p.life = p.max = 0.8 + Math.random() * 1.1;
      p.x = x + (Math.random() - 0.5) * 8; p.y = y + (Math.random() - 0.5) * 6;
      p.vx = (Math.random() - 0.5) * 18; p.vy = -rise * (0.5 + Math.random());
      p.r = size * (0.6 + Math.random() * 0.9); p.grav = -8; p.drag = 0.96;
      p.col = col; p.glow = 0; p.a0 = 0.32; p.wobble = Math.random() * TAU;
    }
  }

  /** Triangular glass/shell fragments. */
  tri(x: number, y: number, n = 5, col = '#ffffff', spd = 150, glow = 0.6): void {
    n = Math.max(1, Math.round(n * this.budget()));
    for (let i = 0; i < n; i++) {
      const p = this.take();
      const a = Math.random() * TAU;
      const s = spd * (0.3 + Math.random());
      p.kind = Kind.Tri; p.life = p.max = 0.5 + Math.random() * 0.5;
      p.x = x; p.y = y;
      p.vx = Math.cos(a) * s; p.vy = Math.sin(a) * s - 40;
      p.r = 2 + Math.random() * 3.5; p.grav = 480; p.drag = 0.99;
      p.rot = Math.random() * TAU; p.vrot = (Math.random() - 0.5) * 12;
      p.col = col; p.glow = glow; p.a0 = 1;
    }
  }

  /** Floating label, e.g. a shard combo count. */
  text(x: number, y: number, txt: string, col = '#ffffff', dur = 0.9, glow = 0.7): void {
    const p = this.take();
    p.kind = Kind.Text; p.life = p.max = dur;
    p.x = x; p.y = y; p.vx = 0; p.vy = -34; p.grav = 26; p.drag = 0.97;
    p.txt = txt; p.col = col; p.glow = glow; p.a0 = 1; p.r = 9;
  }

  /** A single ambient mote. */
  mote(x: number, y: number, vx: number, vy: number, r: number, col: string, life: number, glow = 0): void {
    const p = this.take();
    p.kind = Kind.Dot; p.life = p.max = life;
    p.x = x; p.y = y; p.vx = vx; p.vy = vy;
    p.r = r; p.grav = 0; p.drag = 1;
    p.col = col; p.glow = glow; p.a0 = 0.8; p.wobble = Math.random() * TAU;
  }

  // ------------------------------------------------------------ update
  update(dt: number, solidAt: SolidAt | null = null): void {
    for (let i = 0; i < CAP; i++) {
      const p = this.pool[i];
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) continue;
      if (p.kind === Kind.Ring) continue;

      const d = Math.pow(p.drag, dt * 60);
      p.vx *= d; p.vy *= d;
      p.vy += p.grav * dt;
      if (p.wobble) { p.wobble += dt * 2.4; p.x += Math.sin(p.wobble) * 6 * dt; }
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.rot += p.vrot * dt;

      if (p.bounce && solidAt && p.vy > 0 && solidAt(p.x, p.y + p.r)) {
        p.y -= p.r * 0.5;
        p.vy = -p.vy * p.bounce;
        p.vx *= 0.7;
        p.vrot *= 0.6;
        if (Math.abs(p.vy) < 24) { p.bounce = 0; p.vy = 0; p.grav = 0; p.drag = 0.8; }
      }
    }
  }

  // ------------------------------------------------------------ draw
  draw(font: string): void {
    const st = this.stage;
    const ctx = st.ctx, gctx = st.gctx;
    const bloom = st.settings.bloom;
    ctx.save(); gctx.save();
    ctx.lineCap = 'round';
    gctx.lineCap = 'round';

    for (let i = 0; i < CAP; i++) {
      const p = this.pool[i];
      if (p.life <= 0) continue;
      const t = p.life / p.max;             // 1 -> 0
      const age = 1 - t;
      if (!st.visible(p.x - 20, p.y - 20, 40, 40, 8)) continue;

      const a = clamp01(t * 1.4) * p.a0;
      const g = bloom && p.glow > 0 ? gctx : null;

      switch (p.kind) {
        case Kind.Dot: {
          const r = p.r * (0.6 + t * 0.6);
          ctx.fillStyle = alpha(p.col, a);
          ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, TAU); ctx.fill();
          if (g) { g.fillStyle = alpha(p.col, a * p.glow); g.beginPath(); g.arc(p.x, p.y, r * 1.6, 0, TAU); g.fill(); }
          break;
        }
        case Kind.Square: {
          const s = p.r * (0.5 + t * 0.7);
          ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
          ctx.fillStyle = alpha(p.col, a); ctx.fillRect(-s, -s, s * 2, s * 2);
          ctx.restore();
          if (g) { g.fillStyle = alpha(p.col, a * p.glow * 0.8); g.fillRect(p.x - s, p.y - s, s * 2, s * 2); }
          break;
        }
        case Kind.Spark: {
          const sp = Math.hypot(p.vx, p.vy);
          const len = Math.min(16, sp * 0.028 + p.r);
          const nx = sp > 1 ? p.vx / sp : 0, ny = sp > 1 ? p.vy / sp : 1;
          ctx.strokeStyle = alpha(p.col, a);
          ctx.lineWidth = p.r * (0.5 + t);
          ctx.beginPath();
          ctx.moveTo(p.x - nx * len, p.y - ny * len);
          ctx.lineTo(p.x + nx * len * 0.35, p.y + ny * len * 0.35);
          ctx.stroke();
          if (g) {
            g.strokeStyle = alpha(p.col, a * p.glow);
            g.lineWidth = p.r * 2.2;
            g.beginPath();
            g.moveTo(p.x - nx * len, p.y - ny * len);
            g.lineTo(p.x + nx * len * 0.4, p.y + ny * len * 0.4);
            g.stroke();
          }
          break;
        }
        case Kind.Smoke: {
          const r = p.r * (0.7 + age * 1.5);
          const grd = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
          grd.addColorStop(0, alpha(p.col, a * 0.75));
          grd.addColorStop(1, alpha(p.col, 0));
          ctx.fillStyle = grd;
          ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, TAU); ctx.fill();
          break;
        }
        case Kind.Ring: {
          const r = p.r + (p.r2 - p.r) * (1 - Math.pow(t, 2.2));
          ctx.strokeStyle = alpha(p.col, a * 0.9);
          ctx.lineWidth = Math.max(0.4, p.rot * t);
          ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, TAU); ctx.stroke();
          if (g) {
            g.strokeStyle = alpha(p.col, a * p.glow);
            g.lineWidth = Math.max(0.6, p.rot * t * 1.8);
            g.beginPath(); g.arc(p.x, p.y, r, 0, TAU); g.stroke();
          }
          break;
        }
        case Kind.Tri: {
          const s = p.r * (0.6 + t * 0.7);
          ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
          ctx.fillStyle = alpha(p.col, a);
          ctx.beginPath();
          ctx.moveTo(0, -s); ctx.lineTo(s * 0.9, s * 0.7); ctx.lineTo(-s * 0.9, s * 0.7);
          ctx.closePath(); ctx.fill();
          ctx.restore();
          if (g) {
            g.fillStyle = alpha(p.col, a * p.glow);
            g.beginPath(); g.arc(p.x, p.y, s * 1.4, 0, TAU); g.fill();
          }
          break;
        }
        case Kind.Text: {
          ctx.font = `800 ${p.r}px ${font}`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = alpha('#000000', a * 0.45);
          ctx.fillText(p.txt, p.x, p.y + 1);
          ctx.fillStyle = alpha(p.col, a);
          ctx.fillText(p.txt, p.x, p.y);
          if (g) {
            g.font = `800 ${p.r}px ${font}`;
            g.textAlign = 'center'; g.textBaseline = 'middle';
            g.fillStyle = alpha(p.col, a * p.glow * 0.9);
            g.fillText(p.txt, p.x, p.y);
          }
          break;
        }
      }
    }
    ctx.restore(); gctx.restore();
  }
}
