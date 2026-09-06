/**
 * Level furniture: pickups, checkpoints, the goal, springs, moving platforms,
 * saws, updrafts, dash crystals and switch toggles. Each entity owns one
 * EntityState (the public, serialisable view) plus whatever private constants
 * it needs (home position, travel end points). No drawing here.
 */
import { TILE } from './types.js';
import type { EntityKind, EntityState, PlayerState, Spawn } from './types.js';
import { PHYS } from './config.js';
import type { Level } from './level.js';
import type { Player, PlatformRide, SimHost } from './player.js';
import { dlen, lerp, tri } from './dmath.js';

const LN2 = 0.6931471805599453;

/**
 * Frame-rate independent exponential smoothing with a half-life, without a
 * power function: 2^(-dt/half) = e^(-u) ≈ 1 / (1 + u + u²/2), which is exact
 * enough at 120 Hz and uses only + * /, so it is bit-identical on every engine.
 */
export function damp(a: number, b: number, half: number, dt: number): number {
  const u = (dt / half) * LN2;
  const k = 1 / (1 + u + u * u * 0.5);
  return b + (a - b) * k;
}

/** Eased ping-pong in [0, 1] with the given period (there and back). */
export function pingPong(t: number, period: number): number {
  const k = (tri(t, period) + 1) * 0.5;
  return k * k * (3 - 2 * k);
}

/** The reference platforms swing at 0.62 rad/s, saws at 0.9 rad/s. */
const TAU_APPROX = 6.283185307179586;
const PLAT_PERIOD = TAU_APPROX / 0.62;
const SAW_PERIOD = TAU_APPROX / 0.9;

/** One id sequence shared by entities and foes so renderers can key on id alone. Reset per Sim. */
let nextActorId = 1;
export function resetActorIds(): void { nextActorId = 1; }
export function nextId(): number { return nextActorId++; }

function makeState(kind: EntityKind, x: number, y: number, w: number, h: number): EntityState {
  return { id: nextId(), kind, x, y, w, h, alive: true, t: 0, state: 0 };
}

export abstract class Entity {
  readonly s: EntityState;
  constructor(kind: EntityKind, x: number, y: number, w: number, h: number) {
    this.s = makeState(kind, x, y, w, h);
  }
  /** Advance one tick. Interactions with the player only when `host.interactive`. */
  update(dt: number, host: SimHost, player: Player): void {
    this.s.t += dt;
    this.motion(dt);
    if (host.interactive && !player.s.dead) this.interact(dt, host, player);
  }
  /** Autonomous motion (platforms, saws) — runs in every phase. */
  protected motion(_dt: number): void {}
  protected interact(_dt: number, _host: SimHost, _player: Player): void {}
  /** Called on respawn. Pickups stay collected; consumables reset. */
  onRespawn(): void {}
}

// ============================================================ SHARD
export class Shard extends Entity {
  private readonly hx: number;
  private readonly hy: number;
  constructor(sp: Spawn) {
    super('shard', sp.x, sp.y, 9, 9);
    this.hx = sp.x; this.hy = sp.y;
    this.s.t = (sp.tx * 3 + sp.ty * 7) % 100;
  }
  protected override interact(dt: number, host: SimHost, player: Player): void {
    const s = this.s;
    if (!s.alive) return;
    const cx = player.cx, cy = player.cy;
    const d = dlen(cx - this.hx, cy - this.hy);
    // gentle magnetism makes collection feel generous without widening the hitbox
    if (d < 34) {
      const k = 1 - d / 34;
      s.x = lerp(s.x, cx, k * k * 0.42);
      s.y = lerp(s.y, cy, k * k * 0.42);
    } else {
      s.x = damp(s.x, this.hx, 0.12, dt);
      s.y = damp(s.y, this.hy, 0.12, dt);
    }
    if (d < 11) {
      s.alive = false;
      host.onShard(s.x, s.y);
    }
  }
}

// ============================================================ RELIC
export class Relic extends Entity {
  constructor(sp: Spawn) {
    super('relic', sp.x, sp.y, 14, 14);
    this.s.t = (sp.tx * 5) % 100;
  }
  protected override interact(_dt: number, host: SimHost, player: Player): void {
    const s = this.s;
    if (!s.alive) return;
    if (Math.abs(player.cx - s.x) < 12 && Math.abs(player.cy - s.y) < 12) {
      s.alive = false;
      host.onRelic(s.x, s.y);
    }
  }
}

// ============================================================ CHECKPOINT
export class Checkpoint extends Entity {
  /** Base of the pillar (feet level of the tile the marker stood in). */
  readonly baseY: number;
  constructor(sp: Spawn) {
    const baseY = sp.ty * TILE + TILE;
    super('checkpoint', sp.x, baseY - 14, 16, 28);
    this.baseY = baseY;
  }
  protected override interact(_dt: number, host: SimHost, player: Player): void {
    const s = this.s;
    if (s.state === 1) return;
    if (Math.abs(player.cx - s.x) < 16 && Math.abs(player.feet - this.baseY) < 26) {
      s.state = 1;
      host.onCheckpoint(s.x, this.baseY);
    }
  }
}

// ============================================================ GOAL
export class Goal extends Entity {
  readonly baseY: number;
  private taken = false;
  constructor(sp: Spawn) {
    const baseY = sp.ty * TILE + TILE;
    super('goal', sp.x, baseY - 17, 22, 34);
    this.baseY = baseY;
  }
  protected override interact(_dt: number, host: SimHost, player: Player): void {
    if (this.taken) return;
    const s = this.s;
    if (Math.abs(player.cx - s.x) < 14 && Math.abs(player.feet - this.baseY) < 30) {
      this.taken = true;
      host.onGoal(s.x, this.baseY);
    }
  }
}

// ============================================================ SPRING
export class Spring extends Entity {
  /** Top of the pad at rest. */
  readonly topY: number;
  constructor(sp: Spawn) {
    const topY = sp.ty * TILE + TILE;
    super('spring', sp.x, topY - 4, 14, 8);
    this.topY = topY;
  }
  protected override motion(dt: number): void {
    // `state` is the compression 0..1; it doubles as the re-trigger cooldown
    this.s.state = damp(this.s.state, 0, 0.07, dt);
    if (this.s.state < 0.001) this.s.state = 0;
  }
  protected override interact(_dt: number, host: SimHost, player: Player): void {
    const s = this.s, p = player.s;
    if (s.state > 0.25) return;
    if (p.vy >= -10 && Math.abs(player.cx - s.x) < 12 && p.y + p.h >= this.topY - 9 && p.y + p.h <= this.topY + 5) {
      player.launch(this.topY);
      s.state = 1;
      host.emit({ type: 'spring', x: s.x, y: this.topY - 4 });
    }
  }
}

// ============================================================ MOVING PLATFORM
export class MovePlat extends Entity {
  readonly vertical: boolean;
  /** Home (start of travel) centre. */
  private readonly x0: number;
  private readonly y0: number;
  private readonly phase0: number;
  /** Displacement over the last tick — what riders are carried by. */
  ride: PlatformRide = { dx: 0, dy: 0 };

  constructor(sp: Spawn, level: Level, vertical: boolean) {
    const w = 3 * TILE, h = 6;
    const x0 = sp.tx * TILE + w / 2;
    const y0 = sp.ty * TILE + TILE / 2;
    super(vertical ? 'platV' : 'platH', x0, y0, w, h);
    this.vertical = vertical;
    this.x0 = x0; this.y0 = y0;
    const span = vertical
      ? Math.max(TILE * 2, level.patrolSpan(sp.tx, sp.ty, 0, 1, 8))
      : Math.max(TILE * 2, level.patrolSpan(sp.tx, sp.ty, 1, 0, 8));
    this.s.span = span;
    this.s.dir = 1;
    this.s.vx = 0; this.s.vy = 0;
    this.phase0 = (((sp.tx + sp.ty) % 4) / 4) * PLAT_PERIOD;
    this.place(0);
  }
  private place(dt: number): void {
    const s = this.s;
    const k = pingPong(s.t + this.phase0, PLAT_PERIOD);
    const off = k * (s.span ?? 0);
    const nx = this.vertical ? this.x0 : this.x0 + off;
    const ny = this.vertical ? this.y0 + off : this.y0;
    this.ride = { dx: nx - s.x, dy: ny - s.y };
    s.dir = off >= s.state ? 1 : -1;
    s.state = off;
    s.x = nx; s.y = ny;
    s.vx = dt > 0 ? this.ride.dx / dt : 0;
    s.vy = dt > 0 ? this.ride.dy / dt : 0;
  }
  protected override motion(dt: number): void { this.place(dt); }

  /** Top surface y (riders stand here). */
  get top(): number { return this.s.y - 3; }
  get left(): number { return this.s.x - this.s.w / 2; }
  get right(): number { return this.s.x + this.s.w / 2; }

  /** Reference `platformUnder` test: snaps the rider's feet onto the deck when it matches. */
  supports(p: PlayerState): boolean {
    if (p.x + p.w > this.left + 1 && p.x < this.right - 1 &&
        p.y + p.h >= this.s.y - 4 && p.y + p.h <= this.s.y + 5 && p.vy >= -1) {
      p.y = this.top - p.h;
      return true;
    }
    return false;
  }
}

// ============================================================ SAW
export class Saw extends Entity {
  private readonly vertical: boolean;
  private readonly a: number;
  private readonly b: number;
  private readonly phase0: number;
  private readonly cx: number;
  private readonly cy: number;
  readonly r = 9.5;

  constructor(sp: Spawn, level: Level) {
    super('saw', sp.x, sp.y, 19, 19);
    this.cx = sp.x; this.cy = sp.y;
    const spanR = level.patrolSpan(sp.tx, sp.ty, 1, 0, 7);
    const spanL = level.patrolSpan(sp.tx, sp.ty, -1, 0, 7);
    const spanD = level.patrolSpan(sp.tx, sp.ty, 0, 1, 7);
    this.vertical = spanR + spanL < TILE * 1.5 && spanD > TILE;
    this.a = this.vertical ? this.cy : this.cx - spanL;
    this.b = this.vertical ? this.cy + spanD : this.cx + spanR;
    this.s.span = this.b - this.a;
    this.s.dir = 1;
    this.phase0 = (((sp.tx * 3 + sp.ty * 5) % 7) / 7) * SAW_PERIOD;
    this.place(0);
  }
  private place(dt: number): void {
    const s = this.s;
    const k = pingPong(s.t + this.phase0, SAW_PERIOD);
    const pos = lerp(this.a, this.b, k);
    const nx = this.vertical ? this.cx : pos;
    const ny = this.vertical ? pos : this.cy;
    s.vx = dt > 0 ? (nx - s.x) / dt : 0;
    s.vy = dt > 0 ? (ny - s.y) / dt : 0;
    const off = pos - this.a;
    s.dir = off >= s.state ? 1 : -1;
    s.state = off;
    s.x = nx; s.y = ny;
  }
  protected override motion(dt: number): void { this.place(dt); }
  protected override interact(_dt: number, _host: SimHost, player: Player): void {
    if (dlen(player.cx - this.s.x, player.cy - this.s.y) < this.r + 4.5) player.hurt(this.s.x, 'saw');
  }
}

// ============================================================ UPDRAFT
export class Updraft extends Entity {
  constructor(sp: Spawn, level: Level) {
    const h = Math.max(TILE * 3, level.patrolSpan(sp.tx, sp.ty, 0, -1, 12) + TILE);
    const top = sp.ty * TILE + TILE - h;
    super('updraft', sp.tx * TILE + TILE / 2, top + h / 2, TILE, h);
  }
  protected override interact(dt: number, _host: SimHost, player: Player): void {
    const s = this.s, p = player.s;
    const x0 = s.x - s.w / 2, y0 = s.y - s.h / 2;
    if (p.x + p.w > x0 && p.x < x0 + s.w && p.y + p.h > y0 && p.y < y0 + s.h) {
      p.vy = Math.max(-260, p.vy - 900 * dt);
      p.stomping = false;
    }
  }
}

// ============================================================ DASH CRYSTAL (new)
export class Crystal extends Entity {
  constructor(sp: Spawn) {
    super('crystal', sp.x, sp.y, 12, 12);
    this.s.t = (sp.tx * 3 + sp.ty * 7) % 100;
  }
  protected override motion(dt: number): void {
    // `state` counts down to 0 = visible / ready again
    if (this.s.state > 0) this.s.state = Math.max(0, this.s.state - dt);
  }
  protected override interact(_dt: number, host: SimHost, player: Player): void {
    const s = this.s, p = player.s;
    if (s.state > 0) return;
    if (Math.abs(player.cx - s.x) < 12 && Math.abs(player.cy - s.y) < 12 && (!p.dashReady || p.jumps > 0)) {
      p.dashReady = true;
      p.jumps = 0;
      s.state = PHYS.crystalRespawn;
      host.onCrystal(s.x, s.y);
    }
  }
  override onRespawn(): void { this.s.state = 0; }
}

// ============================================================ SWITCH TOGGLE (new)
export const TOGGLE_COOLDOWN = 0.3;

export class Toggle extends Entity {
  private cool = 0;
  constructor(sp: Spawn, switchA: boolean) {
    super('toggle', sp.x, sp.y, TILE, TILE);
    this.s.state = switchA ? 1 : 0;
  }
  /** Mirror the level polarity into the renderer-facing state. */
  sync(switchA: boolean): void { this.s.state = switchA ? 1 : 0; }
  protected override motion(dt: number): void {
    if (this.cool > 0) this.cool -= dt;
  }
  protected override interact(_dt: number, host: SimHost, player: Player): void {
    const s = this.s, p = player.s;
    if (this.cool > 0 || p.dashT <= 0) return;
    const x0 = s.x - s.w / 2, y0 = s.y - s.h / 2;
    if (p.x + p.w > x0 && p.x < x0 + s.w && p.y + p.h > y0 && p.y < y0 + s.h) {
      this.cool = TOGGLE_COOLDOWN;
      host.onToggle(s.x, s.y);
    }
  }
  override onRespawn(): void { this.cool = 0; }
}

/** Build the entity for a spawn marker, or null for foes / the player. */
export function spawnEntity(sp: Spawn, level: Level): Entity | null {
  switch (sp.ch) {
    case 'o': return new Shard(sp);
    case 'R': return new Relic(sp);
    case 'C': return new Checkpoint(sp);
    case 'G': return new Goal(sp);
    case 'S': return new Spring(sp);
    case 'm': return new MovePlat(sp, level, false);
    case 'M': return new MovePlat(sp, level, true);
    case 's': return new Saw(sp, level);
    case 'z': return new Updraft(sp, level);
    case 'D': return new Crystal(sp);
    case 'k': return new Toggle(sp, level.switchA);
    default: return null;
  }
}
