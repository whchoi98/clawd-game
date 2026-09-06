/**
 * Level = a rectangular char grid plus metadata. Terrain lives in the grid;
 * everything that moves or can be collected is extracted into `spawns` at
 * load time and removed from the grid so it can never also be collided with.
 *
 * Mutable per-run state on the level: crumbling tiles and the switch-block
 * polarity. The Sim owns and resets both; the renderer only reads them.
 */
import { TILE } from './types.js';
import type { LevelDef, Spawn } from './types.js';
import { CRUMBLE, ONE_WAY, SOLID_CH, SPAWN_CH, SPIKES, SWITCH_A, SWITCH_B, WATER_BODY, WATER_SURFACE } from './legend.js';
import { PHYS } from './config.js';

export class Level {
  readonly def: LevelDef;
  readonly id: string;
  readonly w: number;
  readonly h: number;
  readonly pxW: number;
  readonly pxH: number;
  readonly grid: string[][];
  readonly spawns: Spawn[] = [];
  /** Player start: feet position (x centre, y = bottom of the start tile). */
  readonly start: { x: number; y: number };
  readonly totalShards: number;
  readonly totalRelics: number;
  /** true → '%' solid, '&' passable. Toggled by the Sim. */
  switchA = true;

  /** key = ty * w + tx → seconds remaining before the tile breaks. */
  private readonly crumble = new Map<number, number>();
  private readonly broken = new Set<number>();

  constructor(def: LevelDef) {
    this.def = def;
    this.id = def.id;
    const rows = def.rows;
    this.h = rows.length;
    this.w = rows.reduce((m, r) => Math.max(m, r.length), 0);
    this.grid = new Array(this.h);
    for (let y = 0; y < this.h; y++) {
      const src = rows[y].padEnd(this.w, '.');
      const line = new Array<string>(this.w);
      for (let x = 0; x < this.w; x++) {
        const ch = src[x];
        if (SPAWN_CH.includes(ch)) {
          this.spawns.push({ ch, tx: x, ty: y, x: x * TILE + TILE / 2, y: y * TILE + TILE / 2 });
          line[x] = '.';
        } else {
          line[x] = ch === ' ' ? '.' : ch;
        }
      }
      this.grid[y] = line;
    }
    this.pxW = this.w * TILE;
    this.pxH = this.h * TILE;
    const p = this.spawns.find((s) => s.ch === 'P');
    this.start = p ? { x: p.x, y: p.ty * TILE + TILE } : { x: TILE * 2, y: TILE * 2 };
    this.totalShards = this.spawns.filter((s) => s.ch === 'o').length;
    this.totalRelics = this.spawns.filter((s) => s.ch === 'R').length;
  }

  /** Raw character with bounds semantics: sides read solid, above and below read empty. */
  at(tx: number, ty: number): string {
    if (ty >= this.h || ty < 0) return '.';
    if (tx < 0 || tx >= this.w) return '#';
    if (this.broken.has(ty * this.w + tx)) return '.';
    return this.grid[ty][tx];
  }

  /** Solid for collision purposes, honouring switch-block polarity. Below the map is a death pit. */
  solid(tx: number, ty: number): boolean {
    if (ty >= this.h) return false;
    if (tx < 0 || tx >= this.w) return true;
    if (ty < 0) return false;
    const ch = this.at(tx, ty);
    if (SOLID_CH.includes(ch)) return true;
    if (ch === SWITCH_A) return this.switchA;
    if (ch === SWITCH_B) return !this.switchA;
    return false;
  }

  oneWay(tx: number, ty: number): boolean { return this.at(tx, ty) === ONE_WAY; }
  solidPx(x: number, y: number): boolean { return this.solid(Math.floor(x / TILE), Math.floor(y / TILE)); }
  hazardPx(x: number, y: number): boolean {
    const ch = this.at(Math.floor(x / TILE), Math.floor(y / TILE));
    return ch.length === 1 && SPIKES.includes(ch);
  }
  waterPx(x: number, y: number): boolean {
    const ch = this.at(Math.floor(x / TILE), Math.floor(y / TILE));
    return ch === WATER_SURFACE || ch === WATER_BODY;
  }
  isSwitchBlock(tx: number, ty: number): boolean {
    const ch = this.grid[ty]?.[tx];
    return ch === SWITCH_A || ch === SWITCH_B;
  }

  // ------------------------------------------------------------ crumbling
  touchCrumble(tx: number, ty: number): void {
    if (this.at(tx, ty) !== CRUMBLE) return;
    const k = ty * this.w + tx;
    if (!this.crumble.has(k)) this.crumble.set(k, PHYS.crumbleDelay);
  }

  /** Advance timers; returns the tiles that broke this tick (or null). */
  updateCrumble(dt: number): { tx: number; ty: number }[] | null {
    if (!this.crumble.size) return null;
    let broke: { tx: number; ty: number }[] | null = null;
    for (const [k, v] of this.crumble) {
      const nv = v - dt;
      if (nv <= 0) {
        this.crumble.delete(k);
        this.broken.add(k);
        (broke ||= []).push({ tx: k % this.w, ty: Math.floor(k / this.w) });
      } else {
        this.crumble.set(k, nv);
      }
    }
    return broke;
  }

  /** Seconds until the tile breaks, or undefined when it is not counting down. */
  crumbleRemaining(tx: number, ty: number): number | undefined { return this.crumble.get(ty * this.w + tx); }
  isBroken(tx: number, ty: number): boolean { return this.broken.has(ty * this.w + tx); }
  resetCrumble(): void { this.crumble.clear(); this.broken.clear(); }
  resetRunState(): void { this.resetCrumble(); this.switchA = true; }

  /** How far a marker can travel from (tx,ty) in direction (dx,dy) before rock, in world units. */
  patrolSpan(tx: number, ty: number, dx: number, dy: number, max = 12): number {
    let n = 0;
    while (n < max && !this.solid(tx + dx * (n + 1), ty + dy * (n + 1))) n++;
    return n * TILE;
  }
}
