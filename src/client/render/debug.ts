/**
 * Debug overlay for level authors, drawn on top of a finished frame by the
 * `?shot=<id>&grid=1` capture harness (src/client/shot.ts) and nowhere else:
 * the tile grid, tile coordinates every GRID_MAJOR tiles, every spawn
 * character at its tile, and the tile-length of each checkpoint segment
 * (P → C … → G). Pure canvas text and lines in device space, so it never
 * touches the renderer's buffers or the sim.
 *
 * Grid lines are drawn in a saturated yellow with crisp 1 px alignment so
 * tools/qa/grid.ts can find them by colour and check their spacing.
 */
import { TILE } from '../../sim/types.js';
import type { Level } from '../../sim/level.js';
import type { Spawn } from '../../sim/types.js';

/** The slice of the renderer's Stage the overlay needs (mirrors Stage.world without shake). */
export interface DebugStage {
  ctx: CanvasRenderingContext2D;
  /** Canvas size in device pixels. */
  w: number;
  h: number;
  /** Device pixels per world unit at zoom 1, and the current camera. */
  scale: number;
  zoom: number;
  camX: number;
  camY: number;
}

export const GRID_COLOR = '#FFE600';
export const GRID_MAJOR = 4;
export const SPAWN_COLOR = '#FF4FD8';
export const SEGMENT_COLOR = '#7FFFD4';

export interface GridSegment { from: string; to: string; dx: number; dy: number; tiles: number }
export interface GridStats { lines: number; labels: number; spawns: number; segments: GridSegment[] }

/** The renderer's stage when it exposes one (the concrete Renderer does; test fakes do not). */
export function debugStageOf(renderer: unknown): DebugStage | null {
  const st = (renderer as { stage?: Partial<DebugStage> } | null | undefined)?.stage;
  if (!st || !st.ctx) return null;
  for (const k of ['w', 'h', 'scale', 'zoom', 'camX', 'camY'] as const) if (typeof st[k] !== 'number') return null;
  return st as DebugStage;
}

/**
 * Checkpoint segments in course order: the player start, the checkpoints
 * sorted by tile x, then the goal. `tiles` is the Manhattan tile distance.
 */
export function checkpointSegments(spawns: readonly Spawn[]): GridSegment[] {
  const p = spawns.find((s) => s.ch === 'P');
  const g = spawns.find((s) => s.ch === 'G');
  if (!p || !g) return [];
  const cps = spawns.filter((s) => s.ch === 'C').sort((a, b) => a.tx - b.tx || a.ty - b.ty);
  const way = [p, ...cps, g];
  const out: GridSegment[] = [];
  for (let i = 1; i < way.length; i++) {
    const a = way[i - 1], b = way[i];
    const dx = b.tx - a.tx, dy = b.ty - a.ty;
    out.push({ from: `${a.ch}(${a.tx},${a.ty})`, to: `${b.ch}(${b.tx},${b.ty})`, dx, dy, tiles: Math.abs(dx) + Math.abs(dy) });
  }
  return out;
}

function outlined(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, fill: string): void {
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}

/** Draw the overlay for `level` over the frame the stage just rendered. */
export function drawDebugGrid(st: DebugStage, level: Level): GridStats {
  const ctx = st.ctx;
  const s = st.scale * st.zoom;
  const toX = (wx: number) => (wx - st.camX) * s + st.w / 2;
  const toY = (wy: number) => (wy - st.camY) * s + st.h / 2;
  // visible tile range, clipped to the level
  const tx0 = Math.max(0, Math.floor((st.camX - st.w / (2 * s)) / TILE));
  const tx1 = Math.min(level.w, Math.ceil((st.camX + st.w / (2 * s)) / TILE));
  const ty0 = Math.max(0, Math.floor((st.camY - st.h / (2 * s)) / TILE));
  const ty1 = Math.min(level.h, Math.ceil((st.camY + st.h / (2 * s)) / TILE));
  const stats: GridStats = { lines: 0, labels: 0, spawns: 0, segments: checkpointSegments(level.spawns) };

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';

  // ---- grid lines: crisp 1 px minors, 2 px majors every GRID_MAJOR tiles.
  // Minors stay near-opaque so a pixel probe (tools/qa/grid.ts) reads them as the grid colour.
  const top = Math.max(0, toY(ty0 * TILE)), bottom = Math.min(st.h, toY(ty1 * TILE));
  const left = Math.max(0, toX(tx0 * TILE)), right = Math.min(st.w, toX(tx1 * TILE));
  ctx.strokeStyle = GRID_COLOR;
  for (let tx = tx0; tx <= tx1; tx++) {
    const major = tx % GRID_MAJOR === 0;
    const x = Math.round(toX(tx * TILE)) + (major ? 0 : 0.5);
    ctx.globalAlpha = major ? 1 : 0.88;
    ctx.lineWidth = major ? 2 : 1;
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
    stats.lines++;
  }
  for (let ty = ty0; ty <= ty1; ty++) {
    const major = ty % GRID_MAJOR === 0;
    const y = Math.round(toY(ty * TILE)) + (major ? 0 : 0.5);
    ctx.globalAlpha = major ? 1 : 0.88;
    ctx.lineWidth = major ? 2 : 1;
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
    stats.lines++;
  }
  ctx.globalAlpha = 1;

  // ---- coordinates at every major intersection
  ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  for (let tx = tx0; tx <= tx1; tx++) {
    if (tx % GRID_MAJOR !== 0) continue;
    for (let ty = ty0; ty <= ty1; ty++) {
      if (ty % GRID_MAJOR !== 0) continue;
      outlined(ctx, `${tx},${ty}`, toX(tx * TILE) + 3, toY(ty * TILE) + 2, '#FFFFFF');
      stats.labels++;
    }
  }

  // ---- spawn characters at their tiles
  ctx.font = 'bold 14px ui-monospace, Menlo, Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const sp of level.spawns) {
    if (sp.tx < tx0 || sp.tx > tx1 || sp.ty < ty0 || sp.ty > ty1) continue;
    outlined(ctx, sp.ch, toX(sp.x), toY(sp.y), SPAWN_COLOR);
    stats.spawns++;
  }

  // ---- checkpoint segments: a dashed line between waypoints and its tile-length at the midpoint
  ctx.font = 'bold 12px ui-monospace, Menlo, Consolas, monospace';
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = SEGMENT_COLOR;
  const way = [level.spawns.find((sp) => sp.ch === 'P'), ...level.spawns.filter((sp) => sp.ch === 'C').sort((a, b) => a.tx - b.tx || a.ty - b.ty), level.spawns.find((sp) => sp.ch === 'G')];
  for (let i = 1; i < way.length; i++) {
    const a = way[i - 1], b = way[i];
    if (!a || !b) continue;
    const seg = stats.segments[i - 1];
    ctx.beginPath(); ctx.moveTo(toX(a.x), toY(a.y)); ctx.lineTo(toX(b.x), toY(b.y)); ctx.stroke();
    const arrow = `${seg.dx >= 0 ? '→' : '←'}${Math.abs(seg.dx)} ${seg.dy <= 0 ? '↑' : '↓'}${Math.abs(seg.dy)}`;
    outlined(ctx, `seg ${i}: ${seg.tiles} tiles (${arrow})`, toX((a.x + b.x) / 2), toY((a.y + b.y) / 2) - 14, SEGMENT_COLOR);
  }
  ctx.setLineDash([]);
  ctx.restore();
  return stats;
}
