/**
 * Sky backdrop (P5-3): the new parallax layers — far structures, the flock,
 * the aurora ribbons, snow weather, the cloud deck of vertical zones and the
 * time-of-day drift of horizontal ones — their quality gating, and the
 * readability maths the summit palette was tuned against.
 */
import { describe, expect, it } from 'vitest';
import { BIOMES } from '../../src/shared/biomes.js';
import type { BiomeId } from '../../src/sim/types.js';
import {
  AURORA_RIBBONS, CLOUD_DECK_FRAC, CLOUD_DECK_SPAN, FLOCK_SIZE, Sky, TIME_OF_DAY_MAX, flockCountFor,
} from '../../src/client/render/sky.js';
import { Stage, contrastRatio, lumaHex, mixHex, relLuminance, rgbDistance, type QualityTier } from '../../src/client/render/stage.js';

// ------------------------------------------------------------------ a swallowing canvas stub
interface Rec { calls: Map<string, number> }

function stubCanvas(rec: Rec): HTMLCanvasElement {
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(t, p) {
      if (typeof p !== 'string') return undefined;
      if (p in t) return t[p];
      return (...args: unknown[]) => {
        rec.calls.set(p, (rec.calls.get(p) ?? 0) + 1);
        switch (p) {
          case 'createLinearGradient': case 'createRadialGradient': return { addColorStop() {} };
          case 'createPattern': return { setTransform() {} };
          case 'createImageData': case 'getImageData':
            return { width: 1, height: 1, data: new Uint8ClampedArray(Math.max(4, Number(args[2] ?? 1) * Number(args[3] ?? 1) * 4)) };
          case 'measureText': return { width: 10 };
          default: return undefined;
        }
      };
    },
    set(t, p, v) { if (typeof p === 'string') t[p] = v; return true; },
    has() { return true; },
  };
  const state: Record<string, unknown> = { globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '#000', strokeStyle: '#000', lineWidth: 1 };
  const ctx = new Proxy(state, handler);
  const cv = { width: 300, height: 150, getContext: () => ctx } as unknown as HTMLCanvasElement;
  (state as { canvas?: unknown }).canvas = cv;
  return cv;
}

function makeSky(quality: QualityTier = 'high', bloom = true): { sky: Sky; stage: Stage; rec: Rec } {
  const rec: Rec = { calls: new Map() };
  const stage = new Stage(stubCanvas(rec), {
    createCanvas: () => stubCanvas(rec),
    viewport: () => ({ w: 960, h: 540, dpr: 1 }),
    storage: null,
  });
  stage.setSettings({ bloom, grain: true, flashes: true, quality });
  return { sky: new Sky(stage), stage, rec };
}

/** Advance `seconds` of sim time in 1 s steps at (camX, camY), drawing every step. */
function runFrames(sky: Sky, seconds: number, camX: number, camY: number): void {
  for (let i = 0; i < seconds; i++) { sky.update(1, camX, camY); sky.draw(camX, camY); }
}

const HORIZONTAL = { pxW: 1600, pxH: 320 };
const VERTICAL = { pxW: 704, pxH: 1152 };
const BIOME_IDS = Object.keys(BIOMES) as BiomeId[];

describe('Sky · P5-3 layers and quality gating', () => {
  it('flockCountFor: the full V at high, half at balanced, none at low', () => {
    expect(flockCountFor('high')).toBe(FLOCK_SIZE);
    expect(flockCountFor('balanced')).toBe(Math.floor(FLOCK_SIZE / 2));
    expect(flockCountFor('low')).toBe(0);
    expect(FLOCK_SIZE).toBeGreaterThanOrEqual(8);
  });

  it.each(BIOME_IDS)('%s at high: setBiome + update + draw do not throw with and without a level box, and the counters move', (id) => {
    const { sky } = makeSky('high');
    sky.setBiome(BIOMES[id], 3);                 // the title vista: no box
    expect(() => runFrames(sky, 40, 0, 0)).not.toThrow();
    expect(sky.counters.structures).toBeGreaterThan(0);
    expect(sky.counters.flock).toBeGreaterThan(0);
    expect(sky.counters.aurora).toBe(id === 'summit' ? 40 * AURORA_RIBBONS : 0);
    expect(sky.counters.deck).toBe(0);           // no box → no cloud deck
    sky.setBiome(BIOMES[id], 7, HORIZONTAL);
    expect(() => runFrames(sky, 10, 400, 100)).not.toThrow();
    sky.setBiome(BIOMES[id], 7, VERTICAL);
    expect(() => runFrames(sky, 10, 352, 500)).not.toThrow();
    expect(sky.counters.deck).toBeGreaterThan(0);
  });

  it('low tier draws none of the new layers: zero flock, aurora, structure and deck-puff primitives', () => {
    const { sky } = makeSky('low');
    sky.setBiome(BIOMES.summit, 5, HORIZONTAL);
    runFrames(sky, 60, 300, 100);
    expect(sky.counters.flock).toBe(0);
    expect(sky.counters.aurora).toBe(0);
    expect(sky.counters.structures).toBe(0);
    sky.setBiome(BIOMES.summit, 5, VERTICAL);
    runFrames(sky, 20, 352, 400);
    expect(sky.counters.deck).toBe(0);
    // the cheap layers still paint: the gradient fill and the wall
    const { sky: high } = makeSky('high');
    high.setBiome(BIOMES.summit, 5, HORIZONTAL);
    runFrames(high, 60, 300, 100);
    expect(high.counters.flock).toBeGreaterThan(0);
    expect(high.counters.aurora).toBe(60 * AURORA_RIBBONS);
    expect(high.counters.structures).toBeGreaterThan(0);
  });

  it('balanced tier halves the flock: never more than FLOCK_SIZE / 2 birds in a frame', () => {
    const { sky } = makeSky('balanced');
    sky.setBiome(BIOMES.tidepool, 3, HORIZONTAL);
    let maxPerFrame = 0, last = 0;
    for (let i = 0; i < 80; i++) {
      sky.update(1, 100, 60);
      sky.draw(100, 60);
      maxPerFrame = Math.max(maxPerFrame, sky.counters.flock - last);
      last = sky.counters.flock;
    }
    expect(maxPerFrame).toBeGreaterThan(0);
    expect(maxPerFrame).toBeLessThanOrEqual(Math.floor(FLOCK_SIZE / 2));
    const { sky: full } = makeSky('high');
    full.setBiome(BIOMES.tidepool, 3, HORIZONTAL);
    let maxFull = 0; last = 0;
    for (let i = 0; i < 80; i++) {
      full.update(1, 100, 60);
      full.draw(100, 60);
      maxFull = Math.max(maxFull, full.counters.flock - last);
      last = full.counters.flock;
    }
    expect(maxFull).toBeGreaterThan(Math.floor(FLOCK_SIZE / 2));
    expect(maxFull).toBeLessThanOrEqual(FLOCK_SIZE);
  });

  it('weather particle counts per biome and tier: snow 90 at high, 63 balanced, 32 low; the others unchanged', () => {
    const want = (id: BiomeId, q: QualityTier): number => {
      const { sky } = makeSky(q);
      sky.setBiome(BIOMES[id], 1, HORIZONTAL);
      sky.update(1 / 60, 0, 0);
      return sky.weatherCount;
    };
    expect(BIOMES.summit.weather).toBe('snow');
    expect(want('summit', 'high')).toBe(90);
    expect(want('summit', 'balanced')).toBe(63);
    expect(want('summit', 'low')).toBe(Math.round(90 * 0.35));   // 31: the low budget is 0.35 (31.4999… in floating point)
    expect(want('tidepool', 'high')).toBe(70);
    expect(want('stormspire', 'high')).toBe(120);
    expect(want('voidreef', 'high')).toBe(80);
    // snow keeps falling and wrapping without throwing over a long stretch, at any tier
    const { sky } = makeSky('high');
    sky.setBiome(BIOMES.summit, 1, HORIZONTAL);
    expect(() => { for (let i = 0; i < 600; i++) { sky.update(1 / 30, i * 2, 50); } sky.draw(1200, 50); }).not.toThrow();
    expect(sky.weatherCount).toBe(90);
  });

  it('cloud deck: only vertical boxes have one; the factor is 0 at the deck, 1 above it and monotonic in camY', () => {
    const { sky } = makeSky('high');
    sky.setBiome(BIOMES.tidepool, 37, VERTICAL);
    expect(sky.hasCloudDeck).toBe(true);
    const deckY = VERTICAL.pxH * CLOUD_DECK_FRAC;
    expect(sky.deckFactor(VERTICAL.pxH)).toBe(0);
    expect(sky.deckFactor(deckY)).toBe(0);
    expect(sky.deckFactor(deckY - VERTICAL.pxH * CLOUD_DECK_SPAN)).toBeCloseTo(1, 9);
    expect(sky.deckFactor(0)).toBe(1);
    let prev = -1;
    for (let camY = VERTICAL.pxH; camY >= -100; camY -= 8) {
      const k = sky.deckFactor(camY);
      expect(k).toBeGreaterThanOrEqual(0);
      expect(k).toBeLessThanOrEqual(1);
      expect(k).toBeGreaterThanOrEqual(prev);   // climbing (camY falling) never lowers the factor
      prev = k;
    }
    // the last draw records the factor it used
    sky.update(1 / 60, 352, deckY - 40);
    sky.draw(352, deckY - 40);
    expect(sky.deckLast).toBeCloseTo(sky.deckFactor(deckY - 40), 9);
    // horizontal zones and the title have no deck at all
    sky.setBiome(BIOMES.tidepool, 37, HORIZONTAL);
    expect(sky.hasCloudDeck).toBe(false);
    for (let camY = 400; camY >= -400; camY -= 50) expect(sky.deckFactor(camY)).toBe(0);
    sky.setBiome(BIOMES.tidepool, 37);
    expect(sky.hasCloudDeck).toBe(false);
    expect(sky.deckFactor(-1000)).toBe(0);
  });

  it('time of day drifts with camX across a horizontal zone up to TIME_OF_DAY_MAX, and not at all on vertical zones or the title', () => {
    const { sky, rec } = makeSky('high');
    sky.setBiome(BIOMES.tidepool, 3, HORIZONTAL);
    sky.update(1 / 60, 0, 0);
    expect(sky.dayShift).toBe(0);
    sky.update(1 / 60, HORIZONTAL.pxW / 2, 0);
    expect(sky.dayShift).toBeCloseTo(TIME_OF_DAY_MAX / 2, 9);
    sky.update(1 / 60, HORIZONTAL.pxW, 0);
    expect(sky.dayShift).toBeCloseTo(TIME_OF_DAY_MAX, 9);
    sky.update(1 / 60, HORIZONTAL.pxW * 3, 0);
    expect(sky.dayShift).toBeCloseTo(TIME_OF_DAY_MAX, 9);   // clamped
    expect(TIME_OF_DAY_MAX).toBeLessThanOrEqual(0.15);
    // the gradient is cached: a still camera re-creates no sky gradient frame to frame
    sky.draw(HORIZONTAL.pxW, 0);
    const before = rec.calls.get('createLinearGradient') ?? 0;
    sky.update(1 / 60, HORIZONTAL.pxW, 0); sky.draw(HORIZONTAL.pxW, 0);
    sky.update(1 / 60, HORIZONTAL.pxW, 0); sky.draw(HORIZONTAL.pxW, 0);
    const perFrame = ((rec.calls.get('createLinearGradient') ?? 0) - before) / 2;
    sky.update(1 / 60, HORIZONTAL.pxW - 400, 0);           // a different drift step → exactly one more gradient than a cached frame
    sky.draw(HORIZONTAL.pxW - 400, 0);
    expect((rec.calls.get('createLinearGradient') ?? 0) - before - 3 * perFrame).toBe(1);
    sky.setBiome(BIOMES.tidepool, 3, VERTICAL);
    sky.update(1 / 60, 5000, 0);
    expect(sky.dayShift).toBe(0);
    sky.setBiome(BIOMES.tidepool, 3);
    sky.update(1 / 60, 5000, 0);
    expect(sky.dayShift).toBe(0);
  });

  it('setBiome resets the counters and the drawn primitives are bounded per frame', () => {
    const { sky } = makeSky('high');
    sky.setBiome(BIOMES.voidreef, 21, HORIZONTAL);
    runFrames(sky, 30, 200, 100);
    expect(sky.counters.structures).toBeGreaterThan(0);
    const perFrameStructures = sky.counters.structures / 30;
    expect(perFrameStructures).toBeLessThanOrEqual(8);      // 4 kinds × 2 repeats at most
    sky.setBiome(BIOMES.voidreef, 21, HORIZONTAL);
    expect(sky.counters).toEqual({ structures: 0, flock: 0, aurora: 0, deck: 0 });
  });
});

// ------------------------------------------------------------------ readability maths of the palettes
describe('biome palettes · readability maths (tools/qa/readability.ts thresholds)', () => {
  /** The spike's dark outline (#050810 at alpha 0.85) over the darkest thing behind a tip: near black. */
  const OUTLINE_L = relLuminance(mixHex('#050810', '#000000', 0.15));
  /** actors.ts UPDRAFT_HI: the column core is filled with it at alpha 0.38 plus a 0.14 gradient. */
  const UPDRAFT_HI = '#DFF6FF';
  const ACCENT_TOLERANCE = 24;

  it.each(BIOME_IDS)('%s: spike outline vs crust >= 3:1, updraft column gain >= 25/255 over the wall, wall darker than the crust', (id) => {
    const b = BIOMES[id];
    const crustL = relLuminance(b.crust);
    expect(contrastRatio(OUTLINE_L, crustL)).toBeGreaterThanOrEqual(3);
    // the back wall's top band under the horizon haze is the background beside an updraft column
    const wallTop = mixHex(mixHex(b.rockDeep, b.fog, 0.26), '#000000', 0.34);
    const bg = mixHex(wallTop, b.fog, 0.3);
    const centre = mixHex(bg, UPDRAFT_HI, 0.52);
    expect(lumaHex(centre) - lumaHex(bg)).toBeGreaterThanOrEqual(25);
    expect(lumaHex(wallTop)).toBeLessThan(lumaHex(b.crust));
    // the accent (goal beacon, rims) is unambiguous against every sky and terrain colour
    for (const other of [...b.sky, b.skyLight, b.fog, b.crust, b.crustHi, b.rock, b.rockHi, b.spike.hi, b.spike.mid, UPDRAFT_HI]) {
      expect(rgbDistance(b.accent, other)).toBeGreaterThan(ACCENT_TOLERANCE * 2);
    }
  });

  it('summit palette: icy crust with margin, snow-friendly fog, aurora colours distinct from the terrain', () => {
    const b = BIOMES.summit;
    expect(b.weather).toBe('snow');
    expect(contrastRatio(OUTLINE_L, relLuminance(b.crust))).toBeGreaterThanOrEqual(4.5);
    // the crust lip must still read against the snow cap and the ice sheen sits on
    expect(rgbDistance(b.crust, '#FFFFFF')).toBeGreaterThan(120);
    expect(lumaHex(b.fog)).toBeLessThan(lumaHex(b.crust));
    // aurora ribbons blend accent ↔ skyLight: both ends far from the crust and the spike blades
    for (const c of [b.accent, b.skyLight, mixHex(b.accent, b.skyLight, 0.5)]) {
      expect(rgbDistance(c, b.crust)).toBeGreaterThan(ACCENT_TOLERANCE * 2);
    }
    // a horizon-tinted sky stop still leaves the accent beacon unambiguous (the tightest pair)
    expect(rgbDistance(b.accent, b.sky[3])).toBeGreaterThan(ACCENT_TOLERANCE * 2);
  });
});
