/**
 * The player controller — a port of the reference feel model onto the
 * deterministic contract. Every tuning number comes from config.PHYS.
 *
 * Feel features, in the order a player notices them:
 *   • coyote time + jump buffering            — jumps land when you meant them
 *   • asymmetric gravity with an apex window  — snappy fall, generous peak
 *   • turn boost                              — direction changes bite immediately
 *   • corner correction                       — heads slide past 1-unit ledge lips
 *   • 8-way dash with carried end speed       — reads as an impact, not a teleport
 *   • wall slide / wall jump with input lock  — the kick always visually lands
 *
 * The controller owns no presentation: squash, trails, blinking and particles
 * live in the client. It reads one InputMask per tick and mutates the
 * PlayerState object that the Sim exposes.
 */
import { IN, TILE } from './types.js';
import type { InputMask, PlayerPose, PlayerState, RunStats, SimEvent } from './types.js';
import { ASSIST, PHYS, PLAYER_H, PLAYER_W } from './config.js';
import type { Level } from './level.js';
import type { Rng } from './rng.js';
import { approach, clamp01, dlen, sign } from './dmath.js';

/** How a moving platform displaced this tick, in world units. */
export interface PlatformRide { dx: number; dy: number }

/** What the player controller (and the entities / foes) need from the Sim. */
export interface SimHost {
  readonly level: Level;
  readonly assist: boolean;
  readonly invincible: boolean;
  readonly stats: RunStats;
  readonly rng: Rng;
  /** True while gameplay interactions (pickups, hazards, goal) are live. */
  readonly interactive: boolean;
  emit(ev: SimEvent): void;
  /** Moving platform supporting `p` (snaps the feet onto it), or null. */
  platformUnder(p: PlayerState): PlatformRide | null;
  /** True when the world point (x, y) lies inside an updraft column. */
  inUpdraft(x: number, y: number): boolean;
  /** Stomp landing shockwave at the feet. */
  stompShock(x: number, y: number): void;
  onDeath(cause: string): void;
  spawnBolt(x: number, y: number, vx: number, vy: number): void;
  onShard(x: number, y: number): void;
  onRelic(x: number, y: number): void;
  onCheckpoint(x: number, y: number): void;
  onGoal(x: number, y: number): void;
  onCrystal(x: number, y: number): void;
  onToggle(x: number, y: number): void;
  onFoeKilled(x: number, y: number): void;
}

/** Physics table with assist overrides folded in (built once per mode). */
interface PhysTable {
  gravity: number; gravityFall: number; gravityApex: number; apexWindow: number;
  jumpCut: number; waterGrav: number; maxJumps: number; hurtInvuln: number; dashCooldown: number;
}
const PHYS_NORMAL: PhysTable = {
  gravity: PHYS.gravity, gravityFall: PHYS.gravityFall, gravityApex: PHYS.gravityApex,
  apexWindow: PHYS.apexWindow, jumpCut: PHYS.jumpCut, waterGrav: PHYS.waterGrav,
  maxJumps: PHYS.maxJumps, hurtInvuln: PHYS.hurtInvuln, dashCooldown: PHYS.dashCooldown,
};
const PHYS_ASSIST: PhysTable = {
  ...PHYS_NORMAL,
  gravity: PHYS.gravity * ASSIST.gravity,
  gravityFall: PHYS.gravityFall * ASSIST.gravityFall,
  gravityApex: PHYS.gravityApex * ASSIST.gravity,
  maxJumps: ASSIST.maxJumps,
  hurtInvuln: ASSIST.hurtInvuln,
  dashCooldown: ASSIST.dashCooldown,
};

/** Spawn-in window during which the pose reads 'spawn'. */
const SPAWN_POSE_T = 0.42;
/**
 * Updraft columns are authoritative: the moment the player's centre is inside
 * one, any fall is cut to UPDRAFT_ENTRY_VY and the column accelerates the
 * player upward at UPDRAFT_ACCEL toward UPDRAFT_CAP, replacing gravity for
 * that tick — so a column over spikes always catches what drops into it.
 */
const UPDRAFT_ENTRY_VY = 40;
const UPDRAFT_ACCEL = 1600;
const UPDRAFT_CAP = -260;
/** Edge sample inset — avoids catching on tile seams. */
const EDGE_INSET = 1.2;
const FOOT_INSET = 1.5;

export function makePlayerState(x: number, y: number): PlayerState {
  return {
    x: x - PLAYER_W / 2, y: y - PLAYER_H, w: PLAYER_W, h: PLAYER_H,
    vx: 0, vy: 0, facing: 1, grounded: false, onWall: 0, jumps: 0,
    dashT: 0, dashDirX: 1, dashDirY: 0, dashReady: true, dashCd: 0,
    stomping: false, hp: PHYS.maxHp, invuln: 0, dead: false, deadT: 0,
    inWater: false, pose: 'spawn', t: 0,
  };
}

export class Player {
  readonly s: PlayerState;
  private readonly P: PhysTable;

  // controller-internal timers (deterministic, not part of the public state)
  private coyote = 0;
  private jumpBuf = -1;
  private jumpHeld = false;
  private dashBuf = -1;
  private wallStickT = 0;
  private wallLock = 0;
  private wasWater = false;
  private wasSliding = false;
  private spawnT = 0;

  constructor(private readonly host: SimHost, x: number, y: number) {
    this.P = host.assist ? PHYS_ASSIST : PHYS_NORMAL;
    this.s = makePlayerState(x, y);
    this.reset(x, y);
  }

  /** Place the player with its feet at (x, y) and clear every transient. */
  reset(x: number, y: number): void {
    const s = this.s;
    s.x = x - s.w / 2; s.y = y - s.h;
    s.vx = 0; s.vy = 0;
    s.facing = 1;
    s.onWall = 0;
    s.jumps = 0;
    s.dashT = 0; s.dashCd = 0; s.dashReady = true;
    s.dashDirX = 1; s.dashDirY = 0;
    s.stomping = false;
    s.invuln = 0;
    s.hp = PHYS.maxHp;
    s.dead = false; s.deadT = 0;
    s.t = 0;
    this.coyote = 0; this.jumpBuf = -1; this.jumpHeld = false; this.dashBuf = -1;
    this.wallStickT = 0; this.wallLock = 0; this.wasSliding = false;
    this.spawnT = SPAWN_POSE_T;
    // Seed the water flag, otherwise the first tick after every spawn reads as a splash.
    this.wasWater = this.host.level.waterPx(x, y - s.h * 0.6);
    s.inWater = this.wasWater;
    s.grounded = this.checkGround();
    s.pose = 'spawn';
  }

  get cx(): number { return this.s.x + this.s.w / 2; }
  get cy(): number { return this.s.y + this.s.h / 2; }
  get feet(): number { return this.s.y + this.s.h; }

  // ------------------------------------------------------------------ queries
  /** Sample the three points along an edge of the box at (x, y). axis 0 = vertical edge (left/right), 1 = horizontal edge (top/bottom). */
  private edge(x: number, y: number, axis: 0 | 1, dir: -1 | 1): boolean {
    const L = this.host.level;
    const w = this.s.w, h = this.s.h, i = EDGE_INSET;
    if (axis === 0) {
      const px = dir > 0 ? x + w : x;
      return L.solidPx(px, y + i) || L.solidPx(px, y + h / 2) || L.solidPx(px, y + h - i);
    }
    const py = dir > 0 ? y + h : y;
    return L.solidPx(x + i, py) || L.solidPx(x + w / 2, py) || L.solidPx(x + w - i, py);
  }

  private footXs(): [number, number, number] {
    const s = this.s;
    return [s.x + FOOT_INSET, s.x + s.w / 2, s.x + s.w - FOOT_INSET];
  }

  checkGround(): boolean {
    const L = this.host.level;
    const s = this.s;
    const y = s.y + s.h + 0.6;
    const xs = this.footXs();
    if (L.solidPx(xs[0], y) || L.solidPx(xs[1], y) || L.solidPx(xs[2], y)) return true;
    // one-way platforms count as ground when resting on the lip
    for (const px of xs) {
      const tx = Math.floor(px / TILE), ty = Math.floor(y / TILE);
      if (L.oneWay(tx, ty) && s.y + s.h <= ty * TILE + 2.5 && s.vy >= 0) return true;
    }
    return this.host.platformUnder(s) !== null;
  }

  /** True when the player's box overlaps a solid tile (used after switch flips). */
  overlapsSolid(): boolean {
    const s = this.s;
    return this.edge(s.x, s.y, 1, 1) || this.edge(s.x, s.y, 1, -1) || this.edge(s.x, s.y, 0, 1) || this.edge(s.x, s.y, 0, -1);
  }

  // ------------------------------------------------------------------ update
  /**
   * One tick. `mask` is this tick's input, `prev` the previous tick's; press
   * and release edges are derived here so a replay is just the mask log.
   */
  update(dt: number, mask: InputMask, prev: InputMask): void {
    const s = this.s;
    s.t += dt;
    if (s.dead) { this.updateDead(dt); this.setPose(); return; }
    if (this.spawnT > 0) this.spawnT -= dt;

    if (s.invuln > 0) s.invuln -= dt;
    if (s.dashCd > 0) s.dashCd -= dt;
    if (this.wallLock > 0) this.wallLock -= dt;

    const pressed = mask & ~prev;
    const released = prev & ~mask;

    // ---- buffered inputs ----
    if (pressed & IN.JUMP) this.jumpBuf = PHYS.jumpBuffer;
    else if (this.jumpBuf > 0) this.jumpBuf -= dt;
    if (pressed & IN.DASH) this.dashBuf = PHYS.dashGrace;
    else if (this.dashBuf > 0) this.dashBuf -= dt;
    this.jumpHeld = (mask & IN.JUMP) !== 0;
    const jumpReleased = (released & IN.JUMP) !== 0;

    const axisX = ((mask & IN.RIGHT) ? 1 : 0) - ((mask & IN.LEFT) ? 1 : 0);
    const axisY = ((mask & IN.DOWN) ? 1 : 0) - ((mask & IN.UP) ? 1 : 0);
    const ax = this.wallLock > 0 ? 0 : axisX;
    const ay = axisY;

    s.inWater = this.host.level.waterPx(this.cx, s.y + s.h * 0.4);
    // Water is the safety net: it restores the air jump and the dash, so
    // climbing out of a pool never depends on what was spent falling in.
    if (s.inWater) {
      s.jumps = 0;
      if (s.dashT <= 0) s.dashReady = true;
    }

    // ---- dash ----
    if (s.dashT > 0) {
      this.updateDash(dt);
    } else if (this.dashBuf > 0 && s.dashReady && s.dashCd <= 0 && !s.inWater) {
      this.startDash(ax, ay);
    } else {
      this.updateMove(dt, ax, ay, jumpReleased);
    }

    this.integrate(dt);
    this.postMove();
    this.setPose();
  }

  private updateMove(dt: number, ax: number, ay: number, jumpReleased: boolean): void {
    const s = this.s, P = this.P;

    // ---------- horizontal ----------
    const maxRun = PHYS.maxRun * (s.inWater ? 0.72 : 1);
    if (ax !== 0) {
      s.facing = ax > 0 ? 1 : -1;
      const turning = sign(s.vx) !== 0 && sign(s.vx) !== sign(ax);
      let acc = s.grounded ? PHYS.accelGround : PHYS.accelAir;
      if (turning) acc *= PHYS.turnBoost;
      if (s.inWater) acc *= 0.6;
      s.vx = approach(s.vx, maxRun * ax, acc * dt);
    } else {
      const fr = s.grounded ? PHYS.frictionGround : PHYS.frictionAir;
      s.vx = approach(s.vx, 0, fr * dt * (s.inWater ? 1.8 : 1));
    }

    // ---------- wall detection ----------
    const touchL = this.edge(s.x - 1.2, s.y, 0, -1);
    const touchR = this.edge(s.x + 1.2, s.y, 0, 1);
    let wall: -1 | 0 | 1 = 0;
    if (!s.grounded && s.vy > -40) {
      if (touchL && ax <= 0) wall = -1;
      else if (touchR && ax >= 0) wall = 1;
      else if (touchL && s.onWall === -1) wall = -1;
      else if (touchR && s.onWall === 1) wall = 1;
    }
    if (wall !== 0) {
      s.onWall = wall;
      this.wallStickT = PHYS.wallStick;
      s.facing = wall > 0 ? -1 : 1;
    } else if (this.wallStickT > 0) {
      this.wallStickT -= dt;
      if (this.wallStickT <= 0) s.onWall = 0;
    } else {
      s.onWall = 0;
    }

    const sliding = s.onWall !== 0 && s.vy > 0;
    if (sliding && !this.wasSliding) this.host.emit({ type: 'wallSlide', x: this.cx, y: this.cy, dir: s.onWall as -1 | 1 });
    this.wasSliding = sliding;

    // ---------- gravity / updraft ----------
    const lifted = !s.inWater && this.host.inUpdraft(this.cx, this.cy);
    if (lifted) {
      // the column owns the vertical axis: kill the fall, then push up to the cap
      if (s.vy > UPDRAFT_ENTRY_VY) s.vy = UPDRAFT_ENTRY_VY;
      s.vy = Math.max(UPDRAFT_CAP, s.vy - UPDRAFT_ACCEL * dt);
      s.stomping = false;
    } else {
      let g: number;
      if (s.inWater) g = P.waterGrav;
      else if (s.vy < 0) g = this.jumpHeld ? P.gravity : (P.gravity / P.jumpCut) * 0.55;
      else g = P.gravityFall;
      if (Math.abs(s.vy) < P.apexWindow && !s.inWater) g = P.gravityApex;
      if (s.stomping) g = P.gravityFall * 2.2;
      s.vy += g * dt;

      const maxFall = s.inWater ? PHYS.terminalWater : sliding ? PHYS.wallSlide : s.stomping ? PHYS.stompVel : PHYS.maxFall;
      if (s.vy > maxFall) s.vy = approach(s.vy, maxFall, 2600 * dt);
    }

    // ---------- variable jump cut ----------
    if (jumpReleased && s.vy < 0 && !s.inWater && !lifted) s.vy *= PHYS.jumpCut;

    // ---------- coyote ----------
    if (s.grounded) this.coyote = PHYS.coyote;
    else if (this.coyote > 0) this.coyote -= dt;

    // ---------- jump ----------
    if (this.jumpBuf > 0) {
      if (s.onWall !== 0) this.wallJump();
      else if (s.grounded || this.coyote > 0) this.jump(1);
      else if (s.inWater) { s.vy = PHYS.waterJump; this.jumpBuf = -1; this.host.emit({ type: 'jump', x: this.cx, y: this.feet, air: true }); }
      else if (s.jumps < P.maxJumps) this.jump(2);
    }

    // ---------- stomp ---------- (never into an updraft: the column cancels it)
    if (!s.grounded && !s.inWater && !lifted && ay > 0.6 && s.vy > -30 && !s.stomping) {
      s.stomping = true;
      s.vy = Math.max(s.vy, 120);
      this.host.emit({ type: 'stomp', x: this.cx, y: this.feet });
    }
    if (s.stomping && (s.grounded || ay < 0.4)) s.stomping = false;
  }

  private jump(kind: 1 | 2): void {
    const s = this.s;
    s.vy = kind === 1 ? PHYS.jumpVel : PHYS.jumpVel2;
    s.jumps = kind === 1 ? 1 : s.jumps + 1;
    s.grounded = false;
    this.coyote = 0;
    this.jumpBuf = -1;
    s.stomping = false;
    this.host.stats.jumps++;
    this.host.emit({ type: 'jump', x: this.cx, y: this.feet, air: kind === 2 });
  }

  private wallJump(): void {
    const s = this.s;
    const dir = (s.onWall > 0 ? -1 : 1) as -1 | 1;   // kick away from the wall
    s.vx = PHYS.wallJumpX * dir;
    s.vy = PHYS.wallJumpY;
    s.facing = dir;
    s.jumps = 1;
    this.jumpBuf = -1;
    this.wallLock = PHYS.wallJumpLock;
    this.wallStickT = 0;
    this.host.stats.wallJumps++;
    this.host.emit({ type: 'wallJump', x: s.x + (s.onWall > 0 ? s.w : 0), y: s.y + s.h * 0.6, dir });
    s.onWall = 0;
    this.wasSliding = false;
  }

  private startDash(ax: number, ay: number): void {
    const s = this.s;
    let dx = ax, dy = ay;
    if (dx === 0 && dy === 0) { dx = s.facing; dy = 0; }
    // ax / ay are -1, 0 or 1, so normalising already snaps to 8 directions
    const m = dlen(dx, dy) || 1;
    dx /= m; dy /= m;
    s.dashDirX = dx; s.dashDirY = dy;
    s.dashT = PHYS.dashTime;
    s.dashReady = false;
    this.dashBuf = -1;
    s.dashCd = this.P.dashCooldown;
    s.stomping = false;
    if (dx !== 0) s.facing = dx > 0 ? 1 : -1;
    this.host.stats.dashes++;
    this.host.emit({ type: 'dash', x: this.cx, y: this.cy, dx, dy });
  }

  private updateDash(dt: number): void {
    const s = this.s;
    s.dashT -= dt;
    s.vx = s.dashDirX * PHYS.dashSpeed;
    s.vy = s.dashDirY * PHYS.dashSpeed;
    if (s.dashT <= 0) {
      s.vx = s.dashDirX * PHYS.dashEndSpeed;
      s.vy = s.dashDirY * (s.dashDirY < 0 ? PHYS.dashEndSpeed * 0.72 : PHYS.dashEndSpeed * 0.4);
      s.dashT = 0;
      this.host.emit({ type: 'dashEnd', x: this.cx, y: this.cy });
    }
  }

  // ------------------------------------------------------------------ movement
  private integrate(dt: number): void {
    const s = this.s;
    const stepMax = 3.5;
    const mx = s.vx * dt, my = s.vy * dt;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(mx), Math.abs(my)) / stepMax));
    const sx = mx / steps, sy = my / steps;
    for (let i = 0; i < steps; i++) {
      if (sx !== 0) this.moveX(sx);
      if (sy !== 0) this.moveY(sy);
    }
  }

  private moveX(d: number): void {
    const s = this.s;
    const nx = s.x + d;
    const dir: -1 | 1 = d > 0 ? 1 : -1;
    if (this.edge(nx, s.y, 0, dir)) {
      // corner correction: a small lip should not stop a dash or a run
      for (const lift of [1, 2, 3]) {
        if (!this.edge(nx, s.y - lift, 0, dir) && !this.edge(nx, s.y - lift, 1, -1)) {
          s.y -= lift;
          s.x = nx;
          return;
        }
      }
      s.x = d > 0
        ? Math.floor((s.x + s.w + d) / TILE) * TILE - s.w - 0.01
        : Math.floor((s.x + d) / TILE) * TILE + TILE + 0.01;
      if (s.dashT > 0 && s.dashDirY === 0) {
        s.dashT = 0;
        this.host.emit({ type: 'dashEnd', x: s.x + (d > 0 ? s.w : 0), y: this.cy });
      }
      s.vx = 0;
      return;
    }
    s.x = nx;
  }

  private moveY(d: number): void {
    const s = this.s;
    const L = this.host.level;
    const ny = s.y + d;
    if (d > 0) {
      // one-way platforms only block when crossing their top edge
      let hitOneWay = false;
      for (const px of this.footXs()) {
        const ty = Math.floor((ny + s.h) / TILE);
        if (L.oneWay(Math.floor(px / TILE), ty) && s.y + s.h <= ty * TILE + 1.0) { hitOneWay = true; break; }
      }
      if (hitOneWay || this.edge(s.x, ny, 1, 1)) {
        s.y = Math.floor((s.y + s.h + d) / TILE) * TILE - s.h - 0.01;
        this.land();
        return;
      }
    } else if (this.edge(s.x, ny, 1, -1)) {
      // ceiling corner correction — nudge sideways past a lip
      for (const nudge of [1, 2, 3, -1, -2, -3]) {
        if (!this.edge(s.x + nudge, ny, 1, -1)) {
          s.x += nudge;
          s.y = ny;
          return;
        }
      }
      s.y = Math.floor((s.y + d) / TILE) * TILE + TILE + 0.01;
      s.vy = Math.max(0, s.vy);
      if (s.dashT > 0) { s.dashT = 0; this.host.emit({ type: 'dashEnd', x: this.cx, y: s.y }); }
      return;
    }
    s.y = ny;
  }

  private land(): void {
    const s = this.s;
    const impact = clamp01(s.vy / 380);
    const wasStomp = s.stomping;
    s.vy = 0;
    if (!s.grounded) {
      const cx = this.cx, cy = this.feet;
      this.host.emit({ type: 'land', x: cx, y: cy, impact: impact + (wasStomp ? 0.4 : 0) });
      if (wasStomp) {
        this.host.emit({ type: 'stompLand', x: cx, y: cy });
        this.host.stompShock(cx, cy);
      }
    }
    s.grounded = true;
    s.stomping = false;
    s.jumps = 0;
    s.dashReady = true;

    // crumbling tiles under the feet start their countdown
    const L = this.host.level;
    const fy = Math.floor((s.y + s.h + 1) / TILE);
    for (const px of this.footXs()) L.touchCrumble(Math.floor(px / TILE), fy);
  }

  private postMove(): void {
    const s = this.s;
    const probe = s.dashT > 0 && s.dashDirY < 0 ? false : this.checkGround();
    // Touched down without a collision hit (platform deck, one-way lip, or the
    // probe reading the floor a hair early): land() runs while still airborne so
    // the landing event is never lost.
    if (probe && !s.grounded && s.vy > 60) this.land();
    else s.grounded = probe;
    if (s.grounded && s.vy >= 0) {
      s.jumps = 0;
      if (!s.dashReady && s.dashT <= 0) s.dashReady = true;
    }

    // ride moving platforms
    const plat = this.host.platformUnder(s);
    if (plat && s.vy >= 0) {
      s.x += plat.dx;
      s.y += plat.dy;
      s.grounded = true;
    }

    if (!this.host.interactive) return;

    // out of bounds / hazards
    const L = this.host.level;
    const cx = this.cx;
    if (s.y > L.pxH + 40) { this.kill('pit'); return; }
    if (!this.host.invincible && s.invuln <= 0) {
      if (L.hazardPx(cx, s.y + s.h - 2) || L.hazardPx(cx, s.y + 2) ||
          L.hazardPx(s.x + 1, s.y + s.h / 2) || L.hazardPx(s.x + s.w - 1, s.y + s.h / 2)) {
        this.hurt(0, 'spike');
      }
    }

    // water transitions
    const nowWater = L.waterPx(cx, s.y + s.h * 0.4);
    if (nowWater !== this.wasWater) {
      this.host.emit({ type: 'splash', x: cx, y: s.y + s.h * 0.4, enter: nowWater });
      this.wasWater = nowWater;
    }
  }

  private setPose(): void {
    const s = this.s;
    let pose: PlayerPose;
    if (s.dead) pose = 'dead';
    else if (this.spawnT > 0) pose = 'spawn';
    else if (s.dashT > 0) pose = 'dash';
    else if (s.invuln > this.P.hurtInvuln - 0.35) pose = 'hurt';
    else if (s.inWater) pose = 'swim';
    else if (s.stomping) pose = 'stomp';
    else if (s.onWall !== 0 && !s.grounded) pose = 'wall';
    else if (!s.grounded) pose = s.vy < 0 ? 'jump' : 'fall';
    else pose = Math.abs(s.vx) > 14 ? 'run' : 'idle';
    s.pose = pose;
  }

  // ------------------------------------------------------------------ damage
  /**
   * Hazard contact (spikes, saws, bolts, foes, a switch block closing on the
   * player). Outside assist mode every hit is a death on the same tick — hp is
   * never touched and no 'hurt' event fires (SIM_VERSION 3: the free-failure
   * loop makes a death cheaper than a hurt-and-blink). Assist mode keeps the
   * three hearts: lose one hp with knockback away from `fromX` (0 = away from
   * facing) and a spell of invulnerability.
   */
  hurt(fromX: number, cause = 'hit'): void {
    const s = this.s;
    if (s.dead || s.invuln > 0 || this.host.invincible) return;
    if (!this.host.assist) { this.kill(cause); return; }
    s.hp--;
    this.host.emit({ type: 'hurt', x: this.cx, y: this.cy, hp: s.hp });
    if (s.hp <= 0) { this.kill(cause); return; }
    s.invuln = this.P.hurtInvuln;
    const dir = fromX === 0 ? -s.facing : sign(this.cx - fromX) || 1;
    s.vx = PHYS.hurtKnockX * dir;
    s.vy = PHYS.hurtKnockY;
    s.grounded = false;
    s.dashT = 0;
    s.stomping = false;
  }

  kill(cause = 'hit'): void {
    const s = this.s;
    if (s.dead) return;
    s.dead = true;
    s.deadT = 0;
    s.dashT = 0;
    s.stomping = false;
    s.onWall = 0;
    s.vx = -s.facing * 40;
    s.vy = -190;
    s.pose = 'dead';
    this.host.onDeath(cause);
  }

  private updateDead(dt: number): void {
    const s = this.s;
    s.deadT += dt;
    if (s.deadT > 2.5) return;
    s.vy += 900 * dt;
    s.x += s.vx * dt;
    s.y += s.vy * dt;
  }

  /** Bounce off a stomped foe. */
  bounce(strong: boolean): void {
    const s = this.s;
    s.vy = PHYS.stompBounce * (strong ? 1.15 : 1);
    s.jumps = 0;
    s.stomping = false;
    s.dashReady = true;
    s.grounded = false;
  }

  /** Spring launch. */
  launch(topY: number): void {
    const s = this.s;
    s.vy = PHYS.springVel;
    s.y = topY - 10 - s.h;
    s.grounded = false;
    s.jumps = 0;
    s.stomping = false;
    s.dashReady = true;
  }
}
