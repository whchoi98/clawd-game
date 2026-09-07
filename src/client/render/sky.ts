/**
 * Parallax backdrop: sky gradient, stars, aurora ribbons (summit), celestial
 * body with god rays, cloud bands, three procedurally generated ridge
 * silhouettes with far structures between them, mid-ground props, an animated
 * flock, the cloud deck of vertical zones, the canyon wall behind the
 * playfield, and per-biome weather.
 *
 *   tidepool   — dawn sky, low sun, sea-spray motes rising off the water;
 *                lighthouse / wreck / palms on the far ridge, gulls
 *   stormspire — indigo night, rain streaks driven by wind, lightning flashes;
 *                spires whose windows brighten with the lightning, bats
 *   voidreef   — near-black, bioluminescent glow from below, drifting spores;
 *                jellyfish bells and coral arches, light-bugs
 *   summit     — aurora night, slow snow swaying in the wind; snow peaks and a
 *                floating shrine, snow petrels, aurora ribbons (P5-3)
 *
 * Ridges are drawn as paths rather than baked bitmaps — 72 segments per layer
 * is nothing for the rasteriser, and it buys sub-pixel parallax plus real
 * gradients that would band badly if they were pre-scaled.
 *
 * Every layer here is drawn in device space before the world transform, so
 * nothing in this file can ever sit over the playfield; the flock is further
 * confined to the upper band of the screen so it never reads as an actor.
 * Weather lives in normalised screen space so it survives camera cuts.
 *
 * Quality gating (P5-3): `low` draws none of the new layers (structures,
 * flock, aurora, cloud-deck puffs); `balanced` halves the flock. `counters`
 * records how many primitives each new layer drew, for the tests.
 */
import type { Biome } from '../../shared/biomes.js';
import type { BiomeId } from '../../sim/types.js';
import { makeRng } from '../../sim/rng.js';
import { Stage, TAU, VIEW_H, alpha, clamp01, fbm, lerp, mixHex } from './stage.js';

const RIDGE_SEGS = 72;
const RIDGE_SPAN = 1400; // world units per repeat

/** The level box the sky is configured for; the title vista passes none (no cloud deck, no time of day). */
export interface SkyLevelBox { pxW: number; pxH: number }

type StructureKind = 'lighthouse' | 'wreck' | 'palm' | 'tower' | 'jelly' | 'arch' | 'peak' | 'shrine';
type FlockKind = 'gull' | 'bat' | 'bug' | 'petrel';

/** Far silhouettes per biome, placed in this order along the repeat span. */
const STRUCTURES: Record<BiomeId, StructureKind[]> = {
  tidepool: ['lighthouse', 'palm', 'wreck', 'palm'],
  stormspire: ['tower', 'tower', 'tower', 'tower'],
  voidreef: ['jelly', 'arch', 'jelly', 'arch'],
  summit: ['peak', 'shrine', 'peak', 'peak'],
};
const FLOCK_KIND: Record<BiomeId, FlockKind> = { tidepool: 'gull', stormspire: 'bat', voidreef: 'bug', summit: 'petrel' };
/** Biomes with aurora ribbons. */
const AURORA_BIOMES: ReadonlySet<BiomeId> = new Set<BiomeId>(['summit']);
/** Flock size at `high`; `balanced` draws half, `low` none. */
export const FLOCK_SIZE = 14;
/** Number of aurora ribbons on an aurora biome. */
export const AURORA_RIBBONS = 3;
/** World units per repeat of the structure band. */
const STRUCTURE_SPAN = 3400;
/** Parallax of the structure band: between the far ridge (0.08) and the middle one (0.17). */
const STRUCTURE_PAR = 0.12;
/** The flock's parallax and its vertical band (fractions of the canvas height) — always above the playfield band. */
const FLOCK_PAR = 0.22;
const FLOCK_Y_MIN = 0.1;
const FLOCK_Y_MAX = 0.42;
/**
 * Cloud deck of a vertical zone (pxH > pxW): the deck's altitude as a fraction
 * of the level height, the height band over which the "above the deck" factor
 * ramps 0 → 1 while climbing past it, and the deck's parallax.
 */
export const CLOUD_DECK_FRAC = 0.55;
export const CLOUD_DECK_SPAN = 0.22;
const CLOUD_DECK_PAR = 0.5;
const CLOUD_DECK_PUFFS = 14;
/** Time-of-day drift: the sky gradient blends this far toward its "later" stops across a horizontal zone. */
export const TIME_OF_DAY_MAX = 0.15;
/** The gradient cache quantises the drift to this many steps. */
const TIME_OF_DAY_STEPS = 48;

interface Layer { pts: Float32Array; par: number; col: string; span: number; yoff: number }
interface Cloud { x: number; y: number; r: number; sq: number; par: number; a: number; drift: number; seed: number }
interface Prop { x: number; par: number; h: number; w: number; dark: number; seed: number; kind: string; lean: number; arms: number }
interface Fissure { u: number; len: number; w: number; o: number }
interface Star { x: number; y: number; r: number; tw: number; sp: number; col: string; deck: boolean }
interface Mote {
  x: number; y: number; vx: number; vy: number; r: number;
  ph: number; sp: number; col: string; glow: number; a: number; len: number;
}
interface Pt { x: number; y: number }
interface Structure { x: number; kind: StructureKind; h: number; w: number; seed: number; lean: number; windows: number }
interface Bird { off: number; row: number; ph: number; sp: number; size: number; wob: number }
interface Ribbon { y: number; amp: number; thick: number; speed: number; seed: number; a: number }
interface Puff { u: number; dy: number; r: number; a: number; sq: number }

/** Primitive counts of the P5-3 layers since the last setBiome (tests and the fps overlay). */
export interface SkyCounters { structures: number; flock: number; aurora: number; deck: number }

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

/** Birds in the flock at a quality tier: none at low, half at balanced. */
export function flockCountFor(quality: 'high' | 'balanced' | 'low'): number {
  return quality === 'low' ? 0 : quality === 'balanced' ? Math.floor(FLOCK_SIZE / 2) : FLOCK_SIZE;
}

export class Sky {
  biome: Biome | null = null;
  /** Full-sky lightning intensity 0..1 (stormspire). */
  lightning = 0;
  /** When false, flashes are capped for photosensitive players. */
  flashesAllowed = true;
  /** How many primitives the P5-3 layers drew since setBiome. */
  readonly counters: SkyCounters = { structures: 0, flock: 0, aurora: 0, deck: 0 };

  private layers: Layer[] = [];
  private clouds: Cloud[] = [];
  private props: Prop[] = [];
  private structures: Structure[] = [];
  private birds: Bird[] = [];
  private ribbons: Ribbon[] = [];
  private puffs: Puff[] = [];
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
  /** Level box (null for the title vista) and what follows from it. */
  private box: SkyLevelBox | null = null;
  private vertical = false;
  private deckY = 0;
  private deckSpan = 1;
  /** Time-of-day drift 0..TIME_OF_DAY_MAX of the current frame (horizontal zones only). */
  private dayK = 0;
  /** The cloud-deck factor of the last draw (0 below the deck, 1 well above it). */
  private lastDeck = 0;

  constructor(private readonly stage: Stage) {}

  /**
   * Configure the backdrop for a biome. `box` is the level's pixel box: a
   * vertical box (taller than wide) gets the cloud deck, a horizontal one the
   * time-of-day drift; the title vista passes none and gets neither.
   */
  setBiome(biome: Biome, seed = 1, box: SkyLevelBox | null = null): void {
    this.biome = biome;
    this.box = box;
    this.vertical = !!box && box.pxH > box.pxW;
    this.deckY = this.vertical && box ? box.pxH * CLOUD_DECK_FRAC : 0;
    this.deckSpan = this.vertical && box ? Math.max(1, box.pxH * CLOUD_DECK_SPAN) : 1;
    this.dayK = 0;
    this.lastDeck = 0;
    this.counters.structures = this.counters.flock = this.counters.aurora = this.counters.deck = 0;
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
    // Far structures stand between the far and the middle ridge, one set per repeat span.
    this.structures = [];
    const kinds = STRUCTURES[biome.id] ?? STRUCTURES.tidepool;
    for (let i = 0; i < kinds.length; i++) {
      const kind = kinds[i];
      const tall = kind === 'lighthouse' || kind === 'tower' || kind === 'peak';
      this.structures.push({
        x: (i + 0.15 + rng() * 0.7) * (STRUCTURE_SPAN / kinds.length), kind,
        h: (tall ? 64 : 34) + rng() * (tall ? 40 : 18), w: (kind === 'peak' ? 90 : kind === 'arch' ? 44 : 16) + rng() * (kind === 'peak' ? 60 : 14),
        seed: rng() * 1000, lean: (rng() - 0.5) * 0.3, windows: 3 + Math.floor(rng() * 4),
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

    // The flock: a V behind a leader; `off` is the slot along the V, `row` its side.
    this.birds = [];
    for (let i = 0; i < FLOCK_SIZE; i++) {
      const slot = Math.ceil(i / 2);
      this.birds.push({
        off: slot * (0.022 + rng() * 0.006), row: i === 0 ? 0 : (i % 2 ? -1 : 1),
        ph: rng() * TAU, sp: 6 + rng() * 3, size: 0.75 + rng() * 0.5, wob: rng() * TAU,
      });
    }
    // Aurora ribbons (summit): stacked, each with its own drift speed.
    this.ribbons = [];
    if (AURORA_BIOMES.has(biome.id)) {
      for (let i = 0; i < AURORA_RIBBONS; i++) {
        // stacked in the open sky above the far ridge crests (the ridges start near 0.3 H)
        this.ribbons.push({
          y: 0.03 + i * 0.065 + rng() * 0.02, amp: 0.03 + rng() * 0.02, thick: 0.1 + rng() * 0.06,
          speed: 0.02 + rng() * 0.02, seed: rng() * 100, a: 0.5 + rng() * 0.15,
        });
      }
    }
    // Cloud-deck puffs (vertical zones only; generated regardless, drawn only there).
    this.puffs = [];
    for (let i = 0; i < CLOUD_DECK_PUFFS; i++) {
      this.puffs.push({ u: (i + rng()) / CLOUD_DECK_PUFFS, dy: (rng() - 0.5) * 26, r: 44 + rng() * 56, a: 0.35 + rng() * 0.25, sq: 0.4 + rng() * 0.25 });
    }

    // The near canyon wall behind the playable terrain.
    this.wall = buildRidge(rng, 84, 220, 3.1);
    this.fissures = [];
    for (let i = 0; i < 11; i++) this.fissures.push({ u: rng(), len: 0.25 + rng() * 0.5, w: 0.5 + rng() * 1.6, o: rng() });

    this.stars = [];
    const nStars = biome.id === 'voidreef' ? 150 : biome.id === 'stormspire' ? 90 : biome.id === 'summit' ? 120 : 0;
    for (let i = 0; i < nStars; i++) {
      const magenta = biome.id === 'voidreef' && rng() < 0.2;
      this.stars.push({
        x: rng(), y: rng() * 0.62, r: rng() * 0.9 + 0.25, tw: rng() * TAU, sp: 1 + rng() * 3,
        col: magenta ? '#FFB5E8' : biome.id === 'voidreef' ? '#CFFBFF' : biome.id === 'summit' ? '#F4FDFF' : '#EAE4FF',
        deck: false,
      });
    }
    // Above the cloud deck of a vertical zone the sky deepens: extra stars that fade in with the deck factor.
    if (this.vertical) {
      for (let i = 0; i < 90; i++) {
        this.stars.push({ x: rng(), y: rng() * 0.7, r: rng() * 0.8 + 0.3, tw: rng() * TAU, sp: 1 + rng() * 2.5, col: biome.skyLight, deck: true });
      }
    }
    this.weather.length = 0;
    this.lightning = 0;
    this.boltCd = 2 + Math.random() * 4;
    this.grad = null;
    this.gradKey = '';
  }

  /** Snow / rain / spray / spore motes currently alive (tests). */
  get weatherCount(): number { return this.weather.length; }
  /** Time-of-day drift of the last update, 0..TIME_OF_DAY_MAX (horizontal zones only). */
  get dayShift(): number { return this.dayK; }
  /** The cloud-deck factor the last draw used. */
  get deckLast(): number { return this.lastDeck; }
  /** True when the configured level box is a vertical zone (has a cloud deck). */
  get hasCloudDeck(): boolean { return this.vertical; }

  /**
   * Cloud-deck factor for a camera height: 0 at or below the deck altitude,
   * rising to 1 over CLOUD_DECK_SPAN of the level height above it. Monotonic
   * non-increasing in camY (world y grows downward), 0 on horizontal zones.
   */
  deckFactor(camY: number): number {
    if (!this.vertical) return 0;
    return clamp01((this.deckY - camY) / this.deckSpan);
  }

  private gradient(ctx: CanvasRenderingContext2D): CanvasGradient {
    const b = this.biome!;
    const step = Math.round((this.dayK / TIME_OF_DAY_MAX) * TIME_OF_DAY_STEPS);
    const key = `${b.id}|${this.stage.h}|${step}`;
    if (this.gradKey === key && this.grad) return this.grad;
    const g = ctx.createLinearGradient(0, 0, 0, this.stage.h);
    const k = (step / TIME_OF_DAY_STEPS) * TIME_OF_DAY_MAX;
    for (let i = 0; i < b.sky.length; i++) {
      // time of day: every stop drifts toward the stop below it — the horizon light climbs the sky
      const later = b.sky[Math.min(b.sky.length - 1, i + 1)];
      g.addColorStop(i / (b.sky.length - 1), k > 0 ? mixHex(b.sky[i], later, k) : b.sky[i]);
    }
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
    const want = Math.round((b.weather === 'rain' ? 120 : b.weather === 'spores' ? 80 : b.weather === 'snow' ? 90 : 70) * budget);

    // time of day drifts with progress across a horizontal zone; vertical zones and the title keep the base sky
    const box = this.box;
    this.dayK = box && !this.vertical && box.pxW > 0 ? TIME_OF_DAY_MAX * clamp01(camX / box.pxW) : 0;

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
      else if (b.weather === 'snow') m.x += (Math.sin(m.ph * 0.6) * 12 * dt) / st.viewW;   // wind sway
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
    } else if (b.weather === 'snow') {
      // slow fall, a steady side wind; the sway comes from the phase in update()
      m.y = anywhere ? R() : -0.05;
      m.vy = 16 + R() * 26;
      m.vx = -6 - R() * 12;
      m.r = 0.6 + R() * 1.3;
      m.col = R() < 0.3 ? b.skyLight : '#FFFFFF';
      m.glow = 0.3;
      m.a = 0.3 + R() * 0.45;
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
    const low = st.quality === 'low';

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.gradient(ctx);
    ctx.fillRect(0, 0, W, H);

    // vertical drift: climbing reveals more sky, sinking reveals more haze
    const vert = clamp01((camY + 200) / 900);
    // cloud deck (vertical zones): how far above the deck the camera is
    const deck = this.deckFactor(camY);
    this.lastDeck = deck;
    if (deck > 0) {
      // the sky deepens above the deck
      const dg = ctx.createLinearGradient(0, 0, 0, H * 0.7);
      dg.addColorStop(0, alpha(b.sky[0], deck * 0.5));
      dg.addColorStop(1, alpha(b.sky[0], 0));
      ctx.fillStyle = dg;
      ctx.fillRect(0, 0, W, H * 0.7);
    }

    // ---------- stars ----------
    if (this.stars.length) {
      for (const s of this.stars) {
        if (s.deck && deck <= 0.01) continue;
        const tw = 0.45 + 0.55 * Math.sin(this.t * s.sp + s.tw);
        const x = ((s.x * W - camX * 0.02 * S) % W + W) % W;
        const y = s.y * H - camY * 0.02 * S;
        if (y < -4 || y > H) continue;
        const a = s.deck ? tw * 0.85 * deck : tw * (0.8 + deck * 0.2);
        ctx.fillStyle = alpha(s.col, a);
        ctx.fillRect(x, y, s.r * st.dpr, s.r * st.dpr);
      }
    }

    // ---------- aurora (summit) ----------
    if (!low && this.ribbons.length) this.drawAurora(W, H);

    // ---------- lightning (behind the ridges: a distant strike) ----------
    if (this.lightning > 0.01) this.drawLightning(W, H, S);

    // ---------- celestial body ----------
    const sun = b.sun;
    const sx = sun.x * W - camX * 0.03 * S;
    // the time-of-day drift also lifts the body a little across the zone
    const sy = sun.y * H - camY * 0.05 * S + vert * 40 - this.dayK * 0.6 * H;
    const sr = sun.r * S * 0.6;

    if (!low) {
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

    // ---------- ridges / structures / props / wall ----------
    this.ridges(camX, camY, 0, 1);
    if (!low) this.drawStructures(camX, camY);
    this.ridges(camX, camY, 1, 2);
    this.drawProps(camX, camY, vert);
    this.ridges(camX, camY, 2, 3);
    if (!low) this.drawFlock(camX, camY);
    this.backWall(camX, camY, vert);
    // The deck drifts between the canyon wall and the playfield: in a tower the wall fills the
    // backdrop for most of the climb, so a deck behind it would never be seen.
    if (this.vertical) this.drawCloudDeck(camX, camY, deck, low);

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

  /**
   * Aurora ribbons: for each, a polygon whose top and bottom edges follow slow
   * fbm flow across the screen, filled additively with a vertical gradient
   * from the accent (bottom) to the sky light (top).
   */
  private drawAurora(W: number, H: number): void {
    const b = this.biome!;
    const st = this.stage, ctx = st.ctx, gctx = st.gctx;
    const segs = 40;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const r of this.ribbons) {
      const top: number[] = new Array(segs + 1), bot: number[] = new Array(segs + 1);
      const ph = this.t * r.speed;
      let yMin = Infinity, yMax = -Infinity;
      for (let i = 0; i <= segs; i++) {
        const u = i / segs;
        const n = fbm(u * 2.6 + ph + r.seed, r.seed * 0.37 + ph * 0.5, 3);
        const w = 0.55 + 0.45 * fbm(u * 3.1 - ph * 0.8 + r.seed, r.seed + 7.3, 2);
        const y0 = (r.y + (n - 0.5) * 2 * r.amp) * H;
        const y1 = y0 + r.thick * w * H;
        top[i] = y0; bot[i] = y1;
        if (y0 < yMin) yMin = y0;
        if (y1 > yMax) yMax = y1;
      }
      const g = ctx.createLinearGradient(0, yMin, 0, yMax);
      g.addColorStop(0, alpha(b.skyLight, 0));
      g.addColorStop(0.35, alpha(mixHex(b.skyLight, b.accent, 0.5), r.a * 0.8));
      g.addColorStop(0.75, alpha(b.accent, r.a));
      g.addColorStop(1, alpha(b.accent, r.a * 0.45));
      ctx.fillStyle = g;
      ctx.beginPath();
      for (let i = 0; i <= segs; i++) {
        const x = (i / segs) * (W + 40) - 20;
        if (i === 0) ctx.moveTo(x, top[i]); else ctx.lineTo(x, top[i]);
      }
      for (let i = segs; i >= 0; i--) ctx.lineTo((i / segs) * (W + 40) - 20, bot[i]);
      ctx.closePath();
      ctx.fill();
      // vertical curtain rays: a few faint strokes down from the ribbon's lower edge
      ctx.strokeStyle = alpha(b.accent, r.a * 0.45);
      ctx.lineWidth = Math.max(1, st.scale * 0.6);
      ctx.beginPath();
      for (let i = 2; i < segs; i += 5) {
        const x = (i / segs) * (W + 40) - 20 + Math.sin(this.t * 0.2 + i) * 6;
        ctx.moveTo(x, bot[i] - 2);
        ctx.lineTo(x, bot[i] + r.thick * H * 0.35);
      }
      ctx.stroke();
      this.counters.aurora++;
    }
    ctx.restore();
    if (st.settings.bloom) {
      // a whisper of the aurora in the bloom buffer: the ridges below catch a green cast
      const gd = st.glowDiv;
      gctx.fillStyle = alpha(b.accent, 0.05);
      gctx.fillRect(0, 0, W / gd, (H * 0.36) / gd);
    }
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
      const snow = b.weather === 'snow';
      for (const m of this.weather) {
        const x = m.x * W, y = m.y * H;
        const r = m.r * S * 0.5;
        // snow glints softly instead of pulsing like spores or spray
        const pulse = snow ? 0.8 + 0.2 * Math.sin(m.ph) : b.weather === 'spores' ? 0.5 + 0.5 * Math.sin(m.ph) : 0.6 + 0.4 * Math.sin(m.ph);
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

  /**
   * Far structures on the far ridge (P5-3): silhouettes a shade lighter than
   * the ridge they stand on, so they read against it, and darker than the sky,
   * each with one lit detail in the biome accent. Drawn between the far and
   * the middle ridge, so the middle ridge hides their feet.
   */
  private drawStructures(camX: number, camY: number): void {
    const b = this.biome!;
    const st = this.stage, ctx = st.ctx, gctx = st.gctx;
    const W = st.w, H = st.h, S = st.scale;
    const bloom = st.settings.bloom;
    const gd = st.glowDiv;
    const spanPx = STRUCTURE_SPAN * S * 0.5;
    const baseY = H * 0.52 - 14 * S - camY * STRUCTURE_PAR * S;
    const col = mixHex(mixHex(b.ridge[0], b.ridge[1], 0.55), b.fog, 0.12);
    const litBase = 0.5 + this.lightning * 0.5;
    for (const s of this.structures) {
      const px = ((s.x * S * 0.5 - camX * STRUCTURE_PAR * S) % spanPx + spanPx) % spanPx;
      for (const rep of [0, 1]) {
        const x = px - rep * spanPx;
        const h = s.h * S * 0.5, w = s.w * S * 0.5;
        if (x < -w - 60 * S || x > W + w + 60 * S) continue;
        ctx.save();
        ctx.translate(x, baseY);
        ctx.fillStyle = col;
        ctx.strokeStyle = col;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        let gx = 0, gy = 0, gr = 0, gcol = b.accent, ga = 0;
        switch (s.kind) {
          case 'lighthouse': {
            // tapered tower, gallery, lamp room; the lamp sweeps a faint beam
            ctx.beginPath();
            ctx.moveTo(-w * 0.55, 0); ctx.lineTo(-w * 0.34, -h * 0.82); ctx.lineTo(w * 0.34, -h * 0.82); ctx.lineTo(w * 0.55, 0);
            ctx.closePath(); ctx.fill();
            ctx.fillRect(-w * 0.55, -h * 0.86, w * 1.1, h * 0.05);
            ctx.fillRect(-w * 0.26, -h, w * 0.52, h * 0.15);
            ctx.beginPath(); ctx.moveTo(-w * 0.34, -h); ctx.lineTo(0, -h * 1.12); ctx.lineTo(w * 0.34, -h); ctx.closePath(); ctx.fill();
            const ang = this.t * 0.6 + s.seed;
            const beam = 0.5 + 0.5 * Math.cos(ang);
            ctx.fillStyle = alpha(b.skyLight, 0.55 + 0.4 * beam);
            ctx.beginPath(); ctx.arc(0, -h * 0.93, Math.max(1, w * 0.13), 0, TAU); ctx.fill();
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            ctx.fillStyle = alpha(b.skyLight, 0.05 + 0.05 * beam);
            const dir = Math.cos(ang) > 0 ? 1 : -1;
            ctx.beginPath();
            ctx.moveTo(0, -h * 0.93);
            ctx.lineTo(dir * W * 0.35, -h * 0.93 - h * 0.35 * Math.abs(Math.sin(ang)));
            ctx.lineTo(dir * W * 0.35, -h * 0.93 + h * 0.25 * Math.abs(Math.sin(ang)) + 4);
            ctx.closePath(); ctx.fill();
            ctx.restore();
            gx = 0; gy = -h * 0.93; gr = w * 0.6; gcol = b.skyLight; ga = 0.22 + 0.2 * beam;
            break;
          }
          case 'wreck': {
            // a beached hull listing to one side, a snapped mast and a slack boom
            ctx.save();
            ctx.rotate(s.lean);
            ctx.beginPath();
            ctx.moveTo(-w * 1.6, -h * 0.28);
            ctx.quadraticCurveTo(-w * 1.2, -h * 0.02, 0, 0);
            ctx.quadraticCurveTo(w * 1.3, -h * 0.02, w * 1.7, -h * 0.34);
            ctx.lineTo(w * 1.5, -h * 0.3); ctx.lineTo(-w * 1.4, -h * 0.3);
            ctx.closePath(); ctx.fill();
            ctx.lineWidth = Math.max(1, w * 0.12);
            ctx.beginPath(); ctx.moveTo(-w * 0.2, -h * 0.3); ctx.lineTo(w * 0.1, -h); ctx.stroke();
            ctx.lineWidth = Math.max(1, w * 0.08);
            ctx.beginPath(); ctx.moveTo(w * 0.02, -h * 0.72); ctx.lineTo(w * 0.9, -h * 0.5); ctx.stroke();
            ctx.restore();
            break;
          }
          case 'palm': {
            // a curved trunk with fronds that sway
            const sway = Math.sin(this.t * 0.5 + s.seed) * w * 0.25;
            ctx.lineWidth = Math.max(1, w * 0.18);
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.quadraticCurveTo(s.lean * w * 3, -h * 0.55, s.lean * w * 4 + sway, -h);
            ctx.stroke();
            const tx = s.lean * w * 4 + sway, ty = -h;
            ctx.lineWidth = Math.max(1, w * 0.1);
            for (let i = 0; i < 6; i++) {
              const a = -Math.PI * 0.9 + (i / 5) * Math.PI * 0.8;
              const len = w * (1.3 + (i % 2) * 0.3);
              ctx.beginPath();
              ctx.moveTo(tx, ty);
              ctx.quadraticCurveTo(tx + Math.cos(a) * len * 0.6, ty + Math.sin(a) * len * 0.6 - w * 0.2,
                tx + Math.cos(a) * len + sway * 0.3, ty + Math.sin(a) * len + w * 0.5);
              ctx.stroke();
            }
            break;
          }
          case 'tower': {
            // a spire with a pointed roof; its windows brighten with the lightning
            ctx.beginPath();
            ctx.moveTo(-w * 0.5, 0); ctx.lineTo(-w * 0.42, -h * 0.8); ctx.lineTo(w * 0.42, -h * 0.8); ctx.lineTo(w * 0.5, 0);
            ctx.closePath(); ctx.fill();
            ctx.beginPath(); ctx.moveTo(-w * 0.5, -h * 0.8); ctx.lineTo(0, -h * 1.15); ctx.lineTo(w * 0.5, -h * 0.8); ctx.closePath(); ctx.fill();
            const n = s.windows;
            const flick = 0.8 + 0.2 * Math.sin(this.t * 3 + s.seed);
            ctx.fillStyle = alpha(b.accent, Math.min(0.85, (0.3 + this.lightning * 0.55) * flick));
            for (let i = 0; i < n; i++) {
              const wy = -h * (0.18 + (i / n) * 0.55);
              const side = ((Math.floor(s.seed) + i) & 1) ? -1 : 1;
              ctx.fillRect(side * w * 0.14 - w * 0.07, wy, Math.max(1, w * 0.14), Math.max(1, h * 0.04));
            }
            gx = 0; gy = -h * 0.5; gr = w * 1.2; gcol = b.accent; ga = 0.08 + this.lightning * 0.25;
            break;
          }
          case 'jelly': {
            // a bell that bobs, trailing tentacles that sway; the rim glows
            const bob = Math.sin(this.t * 0.45 + s.seed) * h * 0.08;
            const cy = -h * 0.9 + bob;
            const pulse = 0.5 + 0.5 * Math.sin(this.t * 1.1 + s.seed);
            ctx.fillStyle = alpha(mixHex(col, b.accent, 0.3), 0.85);
            ctx.beginPath(); ctx.ellipse(0, cy, w * 1.1, h * 0.36, 0, Math.PI, TAU); ctx.fill();
            ctx.fillStyle = alpha(b.accent, 0.25 + 0.3 * pulse);
            ctx.beginPath(); ctx.ellipse(0, cy, w * 1.1, h * 0.09, 0, 0, TAU); ctx.fill();
            ctx.strokeStyle = alpha(mixHex(col, b.accent, 0.5), 0.6);
            ctx.lineWidth = Math.max(1, w * 0.06);
            for (let i = 0; i < 5; i++) {
              const bx = (i / 4 - 0.5) * w * 1.6;
              const sw = Math.sin(this.t * 0.8 + s.seed + i) * w * 0.4;
              ctx.beginPath();
              ctx.moveTo(bx, cy + 2);
              ctx.quadraticCurveTo(bx + sw, cy + h * 0.5, bx + sw * 1.6, cy + h * (0.75 + (i % 2) * 0.15));
              ctx.stroke();
            }
            gx = 0; gy = cy; gr = w * 1.4; gcol = b.accent; ga = 0.12 + 0.12 * pulse;
            break;
          }
          case 'arch': {
            // a coral arch: a thick arc with a few polyps on its crown
            ctx.lineWidth = Math.max(1.5, w * 0.16);
            ctx.beginPath(); ctx.ellipse(0, 0, w, h * 0.9, 0, Math.PI, TAU); ctx.stroke();
            ctx.fillStyle = alpha(b.crust, 0.5 + 0.3 * Math.sin(this.t * 1.5 + s.seed));
            for (let i = -1; i <= 1; i++) {
              ctx.beginPath(); ctx.arc(i * w * 0.42, -h * 0.9 * Math.cos(i * 0.45) - w * 0.06, Math.max(1, w * 0.07), 0, TAU); ctx.fill();
            }
            gx = 0; gy = -h * 0.9; gr = w * 0.9; gcol = b.crust; ga = 0.1;
            break;
          }
          case 'peak': {
            // a mountain with a snow cap and a lit crest line
            ctx.beginPath();
            ctx.moveTo(-w, 0); ctx.lineTo(-w * 0.28 + s.lean * w, -h * 0.72); ctx.lineTo(s.lean * w * 0.6, -h); ctx.lineTo(w * 0.3 + s.lean * w, -h * 0.66); ctx.lineTo(w, 0);
            ctx.closePath(); ctx.fill();
            ctx.fillStyle = alpha(mixHex(b.skyLight, b.fog, 0.35), 0.8);
            ctx.beginPath();
            ctx.moveTo(-w * 0.28 + s.lean * w, -h * 0.72);
            ctx.lineTo(s.lean * w * 0.6, -h);
            ctx.lineTo(w * 0.3 + s.lean * w, -h * 0.66);
            ctx.lineTo(w * 0.12 + s.lean * w, -h * 0.6);
            ctx.lineTo(-w * 0.05 + s.lean * w, -h * 0.7);
            ctx.lineTo(-w * 0.2 + s.lean * w, -h * 0.62);
            ctx.closePath(); ctx.fill();
            break;
          }
          case 'shrine': {
            // a floating shrine: an island of rock under a two-tier roof, a lantern in the accent
            const bob = Math.sin(this.t * 0.5 + s.seed) * h * 0.06;
            const cy = -h * 0.9 + bob;
            ctx.beginPath(); ctx.ellipse(0, cy + h * 0.1, w * 1.3, h * 0.22, 0, 0, Math.PI); ctx.fill();
            ctx.fillRect(-w * 0.9, cy - h * 0.04, w * 1.8, h * 0.14);
            ctx.fillRect(-w * 0.4, cy - h * 0.5, w * 0.8, h * 0.48);
            ctx.beginPath(); ctx.moveTo(-w * 1.05, cy - h * 0.46); ctx.lineTo(w * 1.05, cy - h * 0.46); ctx.lineTo(w * 0.55, cy - h * 0.66); ctx.lineTo(-w * 0.55, cy - h * 0.66); ctx.closePath(); ctx.fill();
            ctx.beginPath(); ctx.moveTo(-w * 0.75, cy - h * 0.7); ctx.lineTo(w * 0.75, cy - h * 0.7); ctx.lineTo(0, cy - h * 0.98); ctx.closePath(); ctx.fill();
            ctx.fillStyle = alpha(mixHex(b.skyLight, b.fog, 0.3), 0.7);
            ctx.fillRect(-w * 1.05, cy - h * 0.49, w * 2.1, Math.max(1, h * 0.03));
            const flick = 0.75 + 0.25 * Math.sin(this.t * 4 + s.seed);
            ctx.fillStyle = alpha(b.accent, 0.7 * flick);
            ctx.beginPath(); ctx.arc(0, cy - h * 0.25, Math.max(1, w * 0.14), 0, TAU); ctx.fill();
            gx = 0; gy = cy - h * 0.25; gr = w * 0.9; gcol = b.accent; ga = 0.25 * flick;
            break;
          }
        }
        ctx.restore();
        if (ga > 0 && bloom) {
          gctx.fillStyle = alpha(gcol, ga);
          gctx.beginPath(); gctx.arc((x + gx) / gd, (baseY + gy) / gd, Math.max(1, gr) / gd, 0, TAU); gctx.fill();
        }
        this.counters.structures++;
      }
    }
  }

  /**
   * The mid-ground flock (P5-3): a V of birds following a leader who wanders
   * the upper band of the screen; gulls and petrels flap, bats flutter, and
   * the void's light-bugs drift as glowing motes. Never below FLOCK_Y_MAX.
   */
  private drawFlock(camX: number, camY: number): void {
    const b = this.biome!;
    const st = this.stage, ctx = st.ctx, gctx = st.gctx;
    const W = st.w, H = st.h, S = st.scale;
    const n = flockCountFor(st.quality);
    if (n <= 0) return;
    const kind = FLOCK_KIND[b.id] ?? 'gull';
    const bloom = st.settings.bloom;
    const gd = st.glowDiv;
    // the leader starts a third of the way in, crosses the screen slowly and wraps with a long pause off screen
    const speed = kind === 'bat' ? 0.05 : kind === 'bug' ? 0.02 : 0.035;
    const dir = kind === 'bat' ? -1 : 1;
    const lx = ((0.65 + this.t * speed * dir - (camX * FLOCK_PAR * S) / W) % 1.6 + 1.6) % 1.6 - 0.3;
    const ly = lerp(FLOCK_Y_MIN, FLOCK_Y_MAX, 0.5 + 0.5 * Math.sin(this.t * 0.11 + 1.7)) - (camY * 0.02 * S) / H;
    const col = kind === 'bat' ? mixHex(b.ridge[0], '#000000', 0.45)
      : kind === 'bug' ? b.accent
      : kind === 'petrel' ? '#FFFFFF' : b.skyLight;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = alpha(col, kind === 'bat' ? 0.9 : 0.62);
    for (let i = 0; i < n; i++) {
      const bd = this.birds[i];
      const wob = kind === 'bat' ? Math.sin(this.t * 5 + bd.wob) * 0.012 : Math.sin(this.t * 0.9 + bd.wob) * 0.004;
      const bx = (lx - dir * bd.off) * W;
      const by = clamp01(Math.min(FLOCK_Y_MAX, ly + bd.off * 0.55 * (bd.row === 0 ? 0 : 1) + wob + bd.row * 0.006)) * H;
      if (bx < -30 || bx > W + 30) continue;
      const sz = bd.size * S * (kind === 'bug' ? 0.9 : 2.2);
      if (kind === 'bug') {
        const pulse = 0.45 + 0.55 * Math.sin(this.t * bd.sp * 0.5 + bd.ph);
        ctx.fillStyle = alpha(col, 0.35 + 0.5 * pulse);
        ctx.beginPath(); ctx.arc(bx, by, Math.max(1, sz * 0.5), 0, TAU); ctx.fill();
        if (bloom) {
          gctx.fillStyle = alpha(col, 0.3 * pulse);
          gctx.beginPath(); gctx.arc(bx / gd, by / gd, (sz * 2) / gd, 0, TAU); gctx.fill();
        }
      } else {
        // two wing strokes; the flap is the wing tips' height
        const flap = Math.sin(this.t * bd.sp + bd.ph) * (kind === 'bat' ? 0.9 : 0.6);
        ctx.lineWidth = Math.max(1, sz * 0.18);
        ctx.beginPath();
        ctx.moveTo(bx - sz, by - flap * sz * 0.6);
        ctx.quadraticCurveTo(bx - sz * 0.4, by + sz * 0.1, bx, by);
        ctx.quadraticCurveTo(bx + sz * 0.4, by + sz * 0.1, bx + sz, by - flap * sz * 0.6);
        ctx.stroke();
      }
      this.counters.flock++;
    }
    ctx.restore();
  }

  /**
   * Cloud deck of a vertical zone (P5-3): a band of puffs at the deck altitude
   * that slides down the screen as the player climbs. Below the deck the sky
   * above the band hazes over (you are under the clouds); above it the band
   * turns into a sea of cloud below you and the stars deepen (see draw()).
   * `low` keeps the two cheap haze fills and drops the puffs.
   */
  private drawCloudDeck(camX: number, camY: number, deck: number, low: boolean): void {
    const b = this.biome!;
    const st = this.stage, ctx = st.ctx;
    const W = st.w, H = st.h, S = st.scale;
    const dy = H / 2 + (this.deckY - camY) * CLOUD_DECK_PAR * S;
    const under = 1 - deck;
    const cloudCol = mixHex(b.fog, b.skyLight, 0.45);
    // under the deck: the sky above the band is hazy; over it: a cloud sea below the band
    if (dy > -H * 0.6 && under > 0.01) {
      const top = Math.max(0, dy - H * 0.7);
      const g = ctx.createLinearGradient(0, top, 0, Math.min(H, dy));
      g.addColorStop(0, alpha(cloudCol, 0.04 * under));
      g.addColorStop(1, alpha(cloudCol, 0.26 * under));
      ctx.fillStyle = g;
      ctx.fillRect(0, top, W, Math.max(0, Math.min(H, dy) - top));
    }
    if (dy < H * 1.6 && deck > 0.01) {
      const bottom = Math.min(H, dy + H * 0.8);
      const y0 = Math.max(0, dy);
      const g = ctx.createLinearGradient(0, y0, 0, bottom);
      g.addColorStop(0, alpha(cloudCol, 0.3 * deck));
      g.addColorStop(1, alpha(cloudCol, 0.05 * deck));
      ctx.fillStyle = g;
      ctx.fillRect(0, y0, W, Math.max(0, bottom - y0));
    }
    if (low || dy < -140 * S || dy > H + 140 * S) return;
    // the band itself: puffs that drift slowly; one gradient at the origin, scaled per puff
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    g.addColorStop(0, alpha(mixHex(cloudCol, b.skyLight, 0.4), 0.6));
    g.addColorStop(0.55, alpha(cloudCol, 0.34));
    g.addColorStop(1, alpha(cloudCol, 0));
    const spanPx = W * 1.5;
    for (const p of this.puffs) {
      const px = (((p.u * spanPx + this.t * 4 * S - camX * CLOUD_DECK_PAR * S * 0.3) % spanPx) + spanPx) % spanPx - W * 0.25;
      const py = dy + p.dy * S * 0.5;
      const r = p.r * S * 0.55;
      ctx.save();
      ctx.globalAlpha = p.a * (0.8 + 0.2 * Math.sin(this.t * 0.3 + p.u * 9));
      ctx.translate(px, py);
      ctx.scale(r, r * p.sq);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(0, 0, 1, 0, TAU); ctx.fill();
      ctx.restore();
      this.counters.deck++;
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
   * crystal spires with lanterns (stormspire), stacked polyps (voidreef),
   * snow-laden pines (summit).
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
        } else if (p.kind === 'pine') {
          // a conifer: a trunk under three stacked tiers, each tier's top edge dusted with snow
          const tiers = 3 + (p.arms % 2);
          ctx.fillRect(-w * 0.08, -h * 0.35, w * 0.16, h * 0.35);
          for (let i = 0; i < tiers; i++) {
            const u = i / tiers;
            const by = -h * (0.25 + u * 0.75), th = h * 0.32, tw = w * (1.15 - u * 0.75);
            ctx.fillStyle = col;
            ctx.beginPath();
            ctx.moveTo(0, by - th); ctx.lineTo(tw, by); ctx.lineTo(-tw, by);
            ctx.closePath(); ctx.fill();
            ctx.fillStyle = alpha(mixHex(b.skyLight, b.fog, 0.4), 0.55 - p.par * 0.3);
            ctx.beginPath();
            ctx.moveTo(0, by - th); ctx.lineTo(sunSide * tw * 0.55, by - th * 0.45); ctx.lineTo(sunSide * tw * 0.25, by - th * 0.4);
            ctx.closePath(); ctx.fill();
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
