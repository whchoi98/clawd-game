/**
 * The `?shot=<id>&grid=1` author overlay (src/client/render/debug.ts): grid
 * lines at every tile edge in view, coordinates at every 4th intersection,
 * every spawn character at its tile, and each checkpoint segment's tile-length.
 * Driven with a recording 2D context, so the assertions are about what is
 * drawn where, not about pixels.
 */
import { describe, expect, it } from 'vitest';
import { TILE } from '../../src/sim/types.js';
import { Level } from '../../src/sim/level.js';
import { LEVEL_BY_ID } from '../../src/sim/levels.generated.js';
import {
  GRID_COLOR, GRID_MAJOR, SPAWN_COLOR, checkpointSegments, debugStageOf, drawDebugGrid, type DebugStage,
} from '../../src/client/render/debug.js';

interface Rec { kind: 'line'; x0: number; y0: number; x1: number; y1: number; width: number; style: string; alpha: number }
interface Txt { kind: 'text'; text: string; x: number; y: number; fill: string }

/** A CanvasRenderingContext2D stand-in that records strokes and fills. */
function recorder() {
  const lines: Rec[] = [];
  const texts: Txt[] = [];
  let path: [number, number][] = [];
  const ctx = {
    lineWidth: 1, strokeStyle: '#000', fillStyle: '#000', globalAlpha: 1, globalCompositeOperation: 'source-over',
    font: '', textAlign: 'left', textBaseline: 'top',
    save() {}, restore() {}, setTransform() {}, setLineDash() {},
    beginPath() { path = []; },
    moveTo(x: number, y: number) { path.push([x, y]); },
    lineTo(x: number, y: number) { path.push([x, y]); },
    stroke() {
      if (path.length === 2) lines.push({ kind: 'line', x0: path[0][0], y0: path[0][1], x1: path[1][0], y1: path[1][1], width: ctx.lineWidth, style: String(ctx.strokeStyle), alpha: ctx.globalAlpha });
    },
    strokeText() {},
    fillText(text: string, x: number, y: number) { texts.push({ kind: 'text', text, x, y, fill: String(ctx.fillStyle) }); },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, lines, texts };
}

function stage(ctx: CanvasRenderingContext2D, over: Partial<DebugStage> = {}): DebugStage {
  // 1280x720 canvas at 2.5 device px per world unit, camera over the start yard of t1
  return { ctx, w: 1280, h: 720, scale: 2.5, zoom: 1, camX: 256, camY: 200, ...over };
}

describe('drawDebugGrid', () => {
  const t1 = new Level(LEVEL_BY_ID.t1);

  it('draws one yellow line per visible tile edge, crisp 1 px minors and 2 px majors every 4 tiles', () => {
    const { ctx, lines } = recorder();
    const st = stage(ctx);
    const stats = drawDebugGrid(st, t1);
    const grid = lines.filter((l) => l.style === GRID_COLOR);
    expect(grid.length).toBe(stats.lines);
    const vertical = grid.filter((l) => l.x0 === l.x1);
    const horizontal = grid.filter((l) => l.y0 === l.y1);
    // 1280 px / (2.5 px per unit) = 512 world units = 32 tiles wide → 33 edges; 720 px → world y 56..344 → rows 3..22, clipped to the 20-row level → edges 3..20 = 18
    expect(vertical.length).toBe(33);
    expect(horizontal.length).toBe(18);
    // spacing is exactly one tile in device px, and lines sit on pixel centres / boundaries
    const xs = vertical.map((l) => l.x0).sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) expect(Math.abs(xs[i] - xs[i - 1] - TILE * 2.5)).toBeLessThanOrEqual(1);
    for (const l of vertical) {
      const tx = Math.round((l.x0 - st.w / 2) / 2.5 + st.camX) / TILE;
      const major = Math.round(tx) % GRID_MAJOR === 0;
      expect(l.width).toBe(major ? 2 : 1);
      expect(l.x0 % 1).toBe(major ? 0 : 0.5);
      expect(l.alpha).toBeGreaterThanOrEqual(0.85);   // bright enough for the pixel probe in tools/qa/grid.ts
    }
  });

  it('labels every 4th intersection with its tile coordinate and every spawn with its character', () => {
    const { ctx, texts } = recorder();
    const stats = drawDebugGrid(stage(ctx), t1);
    const coords = texts.filter((t) => /^\d+,\d+$/.test(t.text));
    expect(coords.length).toBe(stats.labels);
    expect(coords.length).toBeGreaterThan(0);
    for (const c of coords) {
      const [x, y] = c.text.split(',').map(Number);
      expect(x % GRID_MAJOR).toBe(0);
      expect(y % GRID_MAJOR).toBe(0);
    }
    expect(coords.some((c) => c.text === '0,4')).toBe(true);      // row 0 is above the view, row 4 is the first major row in it
    expect(coords.some((c) => c.text === '16,16')).toBe(true);
    expect(coords.some((c) => c.text === '0,0')).toBe(false);
    // spawns inside the view: P at (3,15), the first shards, the walker at (24,15), the first checkpoint is off-screen (x 49)
    const spawns = texts.filter((t) => t.fill === SPAWN_COLOR);
    expect(spawns.length).toBe(stats.spawns);
    expect(spawns.map((s) => s.text)).toContain('P');
    expect(spawns.map((s) => s.text)).toContain('o');
    expect(spawns.map((s) => s.text)).toContain('w');
    expect(spawns.map((s) => s.text)).not.toContain('C');
    expect(spawns.map((s) => s.text)).not.toContain('G');
    const p = spawns.find((s) => s.text === 'P')!;
    // P sits at tile (3, 15): centre world (56, 248) → device ((56-256)*2.5+640, (248-200)*2.5+360)
    expect(p.x).toBeCloseTo((56 - 256) * 2.5 + 640, 5);
    expect(p.y).toBeCloseTo((248 - 200) * 2.5 + 360, 5);
  });

  it('reports the checkpoint segments P → C → G with Manhattan tile-lengths and writes one caption each', () => {
    const { ctx, texts } = recorder();
    const stats = drawDebugGrid(stage(ctx), t1);
    expect(stats.segments).toEqual(checkpointSegments(t1.spawns));
    expect(stats.segments).toHaveLength(2);           // t1 has one checkpoint
    expect(stats.segments[0]).toMatchObject({ from: 'P(3,15)', to: 'C(49,15)', dx: 46, dy: 0, tiles: 46 });
    expect(stats.segments[1]).toMatchObject({ from: 'C(49,15)', to: 'G(96,15)', dx: 47, dy: 0, tiles: 47 });
    const captions = texts.filter((t) => t.text.startsWith('seg '));
    expect(captions.map((c) => c.text)).toEqual(['seg 1: 46 tiles (→46 ↑0)', 'seg 2: 47 tiles (→47 ↑0)']);
    // a vertical zone: t3's checkpoint is up the first shaft
    const t3 = checkpointSegments(new Level(LEVEL_BY_ID.t3).spawns);
    expect(t3[0]).toMatchObject({ from: 'P(3,26)', to: 'C(24,18)', dx: 21, dy: -8, tiles: 29 });
    // no P or G → no segments
    expect(checkpointSegments([])).toEqual([]);
  });

  it('debugStageOf accepts the concrete Renderer shape only', () => {
    const { ctx } = recorder();
    expect(debugStageOf(null)).toBeNull();
    expect(debugStageOf({})).toBeNull();
    expect(debugStageOf({ stage: { ctx } })).toBeNull();
    const st = stage(ctx);
    expect(debugStageOf({ stage: st })).toBe(st);
    expect(debugStageOf({ stage: { ...st, extra: 1 } })).toMatchObject({ w: 1280 });
  });

  it('clips the grid to the level and the view when the camera sits at an edge', () => {
    const { ctx, lines } = recorder();
    // camera at the level's top-left corner: only tiles ≥ 0 are drawn
    const stats = drawDebugGrid(stage(ctx, { camX: 0, camY: 0 }), t1);
    const vertical = lines.filter((l) => l.style === GRID_COLOR && l.x0 === l.x1);
    expect(Math.min(...vertical.map((l) => l.x0))).toBeGreaterThanOrEqual(640);   // world x=0 is at the canvas centre
    expect(vertical.length).toBe(17);                                              // tiles 0..16 (256 world units to the right edge)
    expect(stats.lines).toBe(vertical.length + lines.filter((l) => l.style === GRID_COLOR && l.y0 === l.y1).length);
  });
});
