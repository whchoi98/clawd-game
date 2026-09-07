/**
 * Foes. Each is small and readable: one silhouette, one signature behaviour.
 *
 * Kind-specific use of the shared FoeState fields:
 *   walker / spiker  state unused
 *   hopper           state = seconds until the next hop
 *   flyer            state unused (orbits its spawn point)
 *   turret           state = reload seconds · (vx, vy) = aim unit vector (it never moves)
 *   chaser           state > 0 wind-up seconds · state < 0 charge seconds remaining · 0 idle
 *   bubble           dead = popped · state = seconds until it re-forms (0 while it floats) · never leaves the list
 * A foe only thinks while awake (near the player) or while dying; see Sim. A
 * popped bubble is the exception: it keeps counting down wherever the player is.
 */
import { TICK_HZ, TILE } from './types.js';
import type { FoeKind, FoeState, Spawn } from './types.js';
import { PHYS } from './config.js';
import type { Level } from './level.js';
import type { Player, SimHost } from './player.js';
import { damp, nextId } from './entities.js';
import { TAU, dlen, dsin, sign } from './dmath.js';

const DYING_T = 0.28;
const BOLT_SPEED = 150;
const TURRET_RANGE = 190;
/** Ticks a popped bubble stays away (PHYS.bubbleRespawn at 120 Hz), counted in whole ticks so the boundary never depends on float accumulation. */
export const BUBBLE_RESPAWN_TICKS = Math.round(PHYS.bubbleRespawn * TICK_HZ);
/** Margin around a popped bubble's home box that must be clear of the player before it re-forms. */
const BUBBLE_REFORM_MARGIN = 2;

interface FoeHome { x: number; y: number; face: 1 | -1; hp: number }

export abstract class Foe {
  readonly s: FoeState;
  protected readonly home: FoeHome;
  stompable = true;
  /**
   * True for a foe that comes back after being taken out (the bubble): it stays
   * in the Sim's foe list and in SimState.foes while dead, and keeps updating
   * so its countdown runs. Every other foe is dropped from the list once dead.
   */
  readonly reforms: boolean = false;
  protected grounded = false;

  constructor(kind: FoeKind, sp: Spawn, w: number, h: number, hp = 1) {
    this.s = {
      id: nextId(), kind, x: sp.x, y: sp.y, w, h, vx: 0, vy: 0, face: -1, hp,
      dying: 0, dead: false, flash: 0, t: (sp.tx * 7 + sp.ty * 3) % 10, state: 0,
    };
    this.home = { x: sp.x, y: sp.y, face: -1, hp };
  }

  /** Back to the spawn snapshot (player respawn). */
  reset(): void {
    const s = this.s;
    s.x = this.home.x; s.y = this.home.y; s.face = this.home.face;
    s.vx = 0; s.vy = 0; s.hp = this.home.hp;
    s.dying = 0; s.dead = false; s.flash = 0; s.state = 0;
    this.grounded = false;
    this.onReset();
  }
  protected onReset(): void {}

  /** [x, y, w, h] top-left box. */
  box(): [number, number, number, number] {
    return [this.s.x - this.s.w / 2, this.s.y - this.s.h / 2, this.s.w, this.s.h];
  }

  protected gravity(dt: number, level: Level, g = 900, maxFall = 320): void {
    const s = this.s;
    s.vy = Math.min(maxFall, s.vy + g * dt);
    const ny = s.y + s.vy * dt;
    const half = s.h / 2;
    if (s.vy > 0 && (level.solidPx(s.x - s.w / 2 + 2, ny + half) || level.solidPx(s.x + s.w / 2 - 2, ny + half))) {
      s.y = Math.floor((ny + half) / TILE) * TILE - half - 0.01;
      s.vy = 0; this.grounded = true;
    } else if (s.vy < 0 && (level.solidPx(s.x - s.w / 2 + 2, ny - half) || level.solidPx(s.x + s.w / 2 - 2, ny - half))) {
      s.y = Math.floor((ny - half) / TILE) * TILE + TILE + half + 0.01;
      s.vy = 0;
    } else { s.y = ny; this.grounded = false; }
  }

  protected walkStep(dt: number, level: Level, speed: number, turnAtLedge = true): void {
    const s = this.s;
    const nx = s.x + s.face * speed * dt;
    const lead = nx + s.face * (s.w / 2 + 1);
    const hitWall = level.solidPx(lead, s.y) || level.solidPx(lead, s.y - s.h / 2 + 2);
    const noFloor = turnAtLedge && this.grounded && !level.solidPx(lead, s.y + s.h / 2 + 3);
    if (hitWall || noFloor) { s.face = s.face > 0 ? -1 : 1; return; }
    s.x = nx;
  }

  /** Contact resolution shared by all foes. */
  protected contact(host: SimHost, player: Player): void {
    const p = player.s, s = this.s;
    if (p.dead || s.dying > 0) return;
    const [bx, by, bw, bh] = this.box();
    if (p.x + p.w < bx || p.x > bx + bw || p.y + p.h < by || p.y > by + bh) return;

    const fromAbove = p.vy > 40 && p.y + p.h - p.vy * 0.016 <= by + bh * 0.55;
    if (this.stompable && (fromAbove || p.stomping)) {
      const strong = p.stomping;
      this.damage(host, strong ? 2 : 1);
      player.bounce(strong);
      return;
    }
    if (p.dashT > 0) { this.damage(host, 2); return; }
    player.hurt(s.x, 'foe');
  }

  damage(host: SimHost, n = 1): void {
    const s = this.s;
    if (s.dying > 0 || s.dead) return;
    s.hp -= n;
    s.flash = 1;
    if (s.hp <= 0) this.die(host);
    else host.emit({ type: 'foeHit', x: s.x, y: s.y, kind: s.kind });
  }

  die(host: SimHost): void {
    const s = this.s;
    if (s.dying > 0) return;
    s.dying = 0.001;
    host.emit({ type: 'foeKilled', x: s.x, y: s.y, kind: s.kind });
    host.onFoeKilled(s.x, s.y);
  }

  /** Caught in a stomp-landing shockwave (Sim.stompShock): one point of damage for every foe but the bubble. */
  shock(host: SimHost): void {
    this.damage(host, 1);
  }

  update(dt: number, host: SimHost, player: Player): void {
    const s = this.s;
    s.t += dt;
    s.flash = Math.max(0, s.flash - dt * 5);
    if (s.dying > 0) {
      s.dying += dt;
      if (s.dying > DYING_T) { s.dead = true; s.dying = 0; }
      return;
    }
    this.step(dt, host, player);
    if (host.interactive) this.contact(host, player);
  }

  protected abstract step(dt: number, host: SimHost, player: Player): void;
}

// ============================================================ WALKER
export class Walker extends Foe {
  protected speed = 44;
  constructor(sp: Spawn, kind: FoeKind = 'walker', hp = 1) { super(kind, sp, 15, 12, hp); }
  protected step(dt: number, host: SimHost): void {
    this.gravity(dt, host.level);
    this.walkStep(dt, host.level, this.speed);
  }
}

// ============================================================ SPIKER (armoured walker, no stomp)
export class Spiker extends Walker {
  constructor(sp: Spawn) {
    super(sp, 'spiker', 2);
    this.stompable = false;
    this.speed = 34;
  }
}

// ============================================================ HOPPER
export class Hopper extends Foe {
  constructor(sp: Spawn, rngRoll: number) {
    super('hopper', sp, 13, 13);
    this.s.state = 0.6 + rngRoll;
  }
  protected override onReset(): void { this.s.state = 0.9; }
  protected step(dt: number, host: SimHost, player: Player): void {
    const s = this.s;
    this.gravity(dt, host.level, 1000);
    if (this.grounded) {
      s.vx = damp(s.vx, 0, 0.08, dt);
      s.state -= dt;
      if (s.state <= 0) {
        s.face = (sign(player.s.x - s.x) || s.face) as 1 | -1;
        s.vy = -300;
        s.vx = s.face * 76;
        s.state = 1.1 + host.rng() * 0.7;
        this.grounded = false;
      }
    }
    const nx = s.x + s.vx * dt;
    if (!host.level.solidPx(nx + sign(s.vx) * (s.w / 2), s.y)) s.x = nx;
    else s.vx *= -0.5;
  }
}

// ============================================================ FLYER
export class Flyer extends Foe {
  private readonly amp: number;
  constructor(sp: Spawn) {
    super('flyer', sp, 14, 15);
    this.amp = 26 + (sp.tx % 3) * 8;
  }
  protected step(dt: number, _host: SimHost, player: Player): void {
    const s = this.s;
    const px = player.s.x, py = player.s.y;
    const near = dlen(px - s.x, py - s.y) < 110;
    // idle bob and sway use triangle waves in place of sines
    s.y = this.home.y + triWave(s.t * 1.15) * this.amp * 0.5;
    if (near) {
      // drifts toward the player, but slowly enough to dodge
      s.x = damp(s.x, player.cx, 1.4, dt);
      s.y = damp(s.y, player.cy - 24, 1.9, dt);
    } else {
      s.x = this.home.x + triWave(s.t * 0.8) * this.amp;
    }
    s.face = player.cx < s.x ? -1 : 1;
  }
}

/** Smooth-ish wave in [-1, 1] with period 2π·(radians), mirroring sin(t) usage. */
function triWave(t: number): number {
  const p = 6.283185307179586;
  const u = t / p - Math.floor(t / p);
  const v = u < 0.5 ? u * 4 - 1 : 3 - u * 4;
  // soften the corners: v * (1.5 - 0.5 v²) keeps |v| ≤ 1 and is C¹ at the peaks
  return v * (1.5 - 0.5 * v * v);
}

// ============================================================ TURRET
export class Turret extends Foe {
  constructor(sp: Spawn) {
    super('turret', sp, 15, 15, 2);
    this.s.state = 1.2;
    this.s.vx = -1; this.s.vy = 0;
  }
  protected override onReset(): void { this.s.state = 1.2; this.s.vx = -1; this.s.vy = 0; }
  protected step(dt: number, host: SimHost, player: Player): void {
    const s = this.s;
    const dx = player.cx - s.x, dy = player.cy - s.y;
    const d = dlen(dx, dy);
    if (d < TURRET_RANGE && d > 0.001) {
      // aim is a unit vector eased toward the player
      let ax = damp(s.vx, dx / d, 0.16, dt);
      let ay = damp(s.vy, dy / d, 0.16, dt);
      const m = dlen(ax, ay) || 1;
      ax /= m; ay /= m;
      s.vx = ax; s.vy = ay;
      s.face = ax < 0 ? -1 : 1;
      s.state -= dt;
      if (s.state <= 0) {
        s.state = 1.5;
        host.spawnBolt(s.x + ax * 9, s.y + ay * 9, ax * BOLT_SPEED, ay * BOLT_SPEED);
        host.emit({ type: 'bolt', x: s.x + ax * 10, y: s.y + ay * 10 });
      }
    } else {
      s.state = Math.min(s.state + dt, 1.2);
    }
  }
}

// ============================================================ CHASER
export class Chaser extends Foe {
  constructor(sp: Spawn) {
    super('chaser', sp, 15, 15, 2);
    this.stompable = false;
  }
  protected step(dt: number, host: SimHost, player: Player): void {
    const s = this.s;
    const dx = player.cx - s.x, dy = player.cy - s.y;
    const d = dlen(dx, dy);
    if (s.state === 0) {
      // idle
      s.vx = damp(s.vx, 0, 0.2, dt);
      s.vy = damp(s.vy, 0, 0.2, dt);
      if (d < 130) s.state = 0.5;
    } else if (s.state > 0) {
      // wind-up
      s.state -= dt;
      s.face = (sign(dx) || s.face) as 1 | -1;
      if (s.state <= 0) {
        const m = d || 1;
        s.vx = (dx / m) * 210; s.vy = (dy / m) * 210;
        s.state = -0.85;
      }
    } else {
      // charge
      s.state += dt;
      s.vx = damp(s.vx, 0, 0.5, dt);
      s.vy = damp(s.vy, 0, 0.5, dt);
      if (s.state >= 0) s.state = 0;
    }
    const L = host.level;
    const nx = s.x + s.vx * dt, ny = s.y + s.vy * dt;
    if (!L.solidPx(nx + sign(s.vx) * (s.w / 2), s.y)) s.x = nx;
    else { s.vx *= -0.35; s.state = 0; }
    if (!L.solidPx(s.x, ny + sign(s.vy) * (s.h / 2))) s.y = ny;
    else s.vy *= -0.35;
  }
}

// ============================================================ BUBBLE (P5-5, SIM_VERSION 4)
/**
 * A soap bubble hanging in the air over its spawn tile, bobbing vertically by
 * PHYS.bubbleBobAmp over PHYS.bubbleBobPeriod (dsin — no Math.sin in the sim).
 * It never moves sideways and has no hit points.
 *
 *   • stomped from above (the usual fromAbove test, or DOWN held) → it POPS:
 *     `bubblePop`, the player is launched at PHYS.bubbleBounce (between a stomp
 *     bounce and a spring) with the air jump and the dash refilled like a stomp.
 *     A pop is not a kill — no `foeKilled`, no stats.foes, no combo.
 *   • dashed through → it pops too, without the launch (a dash is an attack).
 *   • side or underside contact → a death like any other foe (cause 'bubble');
 *     the usual hurt path in assist mode.
 *   • a stomp-landing shockwave leaves it alone.
 *
 * Popped, it is `dead`, parked at its home y and collides with nothing; `state`
 * counts the seconds until it re-forms at home (`bubbleBack`),
 * BUBBLE_RESPAWN_TICKS later — or the first tick after that on which the player
 * is clear of its home envelope, so it never re-forms on top of anyone (while
 * held that way `state` sits at 1 / TICK_HZ, never 0). It stays in the foe list
 * the whole time (`reforms`), so the renderer can telegraph the return.
 */
export class Bubble extends Foe {
  override readonly reforms = true;
  /** Ticks left before the bubble may re-form (0 while it floats). */
  private respawnTicks = 0;

  constructor(sp: Spawn) {
    super('bubble', sp, 12, 12);
  }

  protected override onReset(): void { this.respawnTicks = 0; }

  /** Home box grown by the bob envelope: what must be clear of the player before the bubble re-forms. */
  private homeEnvelope(): [number, number, number, number] {
    const s = this.s, m = BUBBLE_REFORM_MARGIN;
    const amp = PHYS.bubbleBobAmp;
    return [this.home.x - s.w / 2 - m, this.home.y - s.h / 2 - amp - m, s.w + 2 * m, s.h + 2 * amp + 2 * m];
  }

  private bobY(): number {
    return this.home.y + PHYS.bubbleBobAmp * dsin((TAU * this.s.t) / PHYS.bubbleBobPeriod);
  }

  override update(dt: number, host: SimHost, player: Player): void {
    const s = this.s;
    if (s.dead) {
      if (this.respawnTicks > 0) this.respawnTicks--;
      s.state = this.respawnTicks / TICK_HZ;
      if (this.respawnTicks === 0) this.reform(host, player);
      return;
    }
    s.t += dt;
    this.step(dt, host, player);
    if (host.interactive) this.contact(host, player);
  }

  protected step(_dt: number, _host: SimHost, _player: Player): void {
    this.s.y = this.bobY();
  }

  protected override contact(host: SimHost, player: Player): void {
    const p = player.s, s = this.s;
    if (p.dead) return;
    const [bx, by, bw, bh] = this.box();
    if (p.x + p.w < bx || p.x > bx + bw || p.y + p.h < by || p.y > by + bh) return;

    const fromAbove = p.vy > 40 && p.y + p.h - p.vy * 0.016 <= by + bh * 0.55;
    if (fromAbove || p.stomping) {
      this.pop(host);
      player.bubbleBounce();
      return;
    }
    if (p.dashT > 0) { this.pop(host); return; }
    player.hurt(s.x, 'bubble');
  }

  /** Bursts. Not a kill: no foeKilled, no kill count. */
  pop(host: SimHost): void {
    const s = this.s;
    if (s.dead) return;
    s.dead = true;
    s.flash = 0;
    this.respawnTicks = BUBBLE_RESPAWN_TICKS;
    s.state = PHYS.bubbleRespawn;
    // the burst is drawn where the bubble was; the dead bubble then parks at its home y, so no bob phase lingers
    // under the renderer's return shimmer (it draws at f.x / f.y)
    host.emit({ type: 'bubblePop', x: s.x, y: s.y });
    s.y = this.home.y;
  }

  private reform(host: SimHost, player: Player): void {
    const s = this.s;
    const p = player.s;
    if (!p.dead) {
      const [ex, ey, ew, eh] = this.homeEnvelope();
      if (p.x + p.w > ex && p.x < ex + ew && p.y + p.h > ey && p.y < ey + eh) {
        // the spot is taken: try again next tick. The countdown is held at the smallest positive value rather than 0,
        // so the renderer keeps drawing the fully gathered return ring (it shimmers only while 0 < state < 0.5)
        s.state = 1 / TICK_HZ;
        return;
      }
    }
    s.dead = false;
    s.state = 0;
    s.y = this.bobY();
    host.emit({ type: 'bubbleBack', x: s.x, y: s.y });
  }

  /** Every damage path (a dash, stompShock via `shock`, a stray die) is a pop, never a kill. */
  override damage(host: SimHost): void { this.pop(host); }
  override die(host: SimHost): void { this.pop(host); }
  /** A stomp landing next to a bubble does not burst it: only a stomp onto it, or a dash through it, does. */
  override shock(): void {}
}

/** Build the foe for a spawn marker, or null for anything else. */
export function spawnFoe(sp: Spawn, rngRoll: number): Foe | null {
  switch (sp.ch) {
    case 'w': return new Walker(sp);
    case 'h': return new Hopper(sp, rngRoll);
    case 'f': return new Flyer(sp);
    case 't': return new Turret(sp);
    case 'c': return new Chaser(sp);
    case 'b': return new Bubble(sp);
    default: return null;
  }
}
