/**
 * Sim — one level instance stepping at a fixed 120 Hz, one InputMask per tick.
 *
 * Owns the phase machine (intro → play → dying → respawn | over, play → clear),
 * the player, entities, foes, bolts, the tide and the run statistics. Emits
 * SimEvents for the presentation layer and exposes a plain SimState that is
 * safe to JSON.stringify — the same code verifies replays on the server, so
 * nothing here may touch the DOM, the clock or non-deterministic math.
 */
import { DT, IN, IN_ALL, TICK_HZ, TILE } from './types.js';
import type {
  BoltState, InputMask, LevelDef, PlayerState, RunStats, RunSummary, SimEvent, SimOptions, SimPhase, SimState,
} from './types.js';
import { PHYS, rankFor } from './config.js';
import { Level } from './level.js';
import { makeRng } from './rng.js';
import type { Rng } from './rng.js';
import { Player } from './player.js';
import type { PlatformRide, SimHost } from './player.js';
import { Entity, MovePlat, Toggle, Updraft, resetActorIds, spawnEntity } from './entities.js';
import { Foe, Spiker, spawnFoe } from './foes.js';

/** Seconds of spawn-in before input is live on the first spawn of a run. */
export const INTRO_T = 0.45;
/**
 * Seconds of spawn-in after every respawn. The free-failure loop hands control
 * back DYING_T + RESPAWN_INTRO_T = 0.6 s after a death.
 */
export const RESPAWN_INTRO_T = 0.15;
/** Seconds of death animation before the respawn / game over. */
export const DYING_T = 0.45;
/**
 * The phase machine counts whole ticks, so a transition never depends on how
 * the float accumulation of DT rounds against a threshold. 54 / 18 / 54 ticks.
 */
export const INTRO_TICKS = Math.round(INTRO_T * TICK_HZ);
export const RESPAWN_INTRO_TICKS = Math.round(RESPAWN_INTRO_T * TICK_HZ);
export const DYING_TICKS = Math.round(DYING_T * TICK_HZ);
/** Foes think only while their box is within this gap of the player's box (or while dying). */
export const FOE_WAKE_GAP = 140;
/** Bolts expire after this many seconds of flight. */
const BOLT_LIFE = 3.4;
const COMBO_WINDOW = 2.2;

function emptyStats(): RunStats {
  return { shards: 0, relics: 0, deaths: 0, jumps: 0, dashes: 0, wallJumps: 0, foes: 0, combo: 0, bestCombo: 0 };
}

export class Sim implements SimHost {
  readonly def: LevelDef;
  readonly level: Level;
  readonly state: SimState;
  readonly assist: boolean;
  readonly invincible: boolean;
  readonly seed: number;
  readonly rng: Rng;

  private readonly player: Player;
  private readonly ents: Entity[] = [];
  private readonly plats: MovePlat[] = [];
  private readonly toggles: Toggle[] = [];
  private readonly drafts: Updraft[] = [];
  private readonly foeList: Foe[] = [];
  private events: SimEvent[] = [];
  private prevMask: InputMask = 0;
  /** Ticks stepped in the current phase (the integer twin of state.phaseT). */
  private phaseTicks = 0;
  /** True until the first respawn: the opening intro is longer than a respawn intro. */
  private firstSpawn = true;
  private playTicks = 0;
  private comboT = 0;
  private boltSeq = 1;
  /** World y the tide height is measured from (tide modes). */
  private readonly baseYpx: number;

  constructor(def: LevelDef, opts: SimOptions = {}) {
    this.def = def;
    this.level = new Level(def);
    this.level.resetRunState();
    this.assist = !!opts.assist;
    this.invincible = !!opts.invincible;
    this.seed = (opts.seed ?? def.seed) >>> 0;
    this.rng = makeRng(this.seed);

    const start = this.level.start;
    this.state = {
      tick: 0, time: 0, phase: 'intro', phaseT: 0,
      player: null as unknown as PlayerState,
      entities: [], foes: [], bolts: [],
      respawn: { x: start.x, y: start.y },
      switchA: true,
      stats: emptyStats(),
    };

    resetActorIds();
    this.spawnAll();
    this.state.entities = this.ents.map((e) => e.s);
    this.state.foes = this.foeList.map((f) => f.s);

    this.baseYpx = (def.baseY ?? this.level.h - 4) * TILE;
    if (def.tide) {
      this.state.tide = { y: this.baseYpx + TILE * 6, speed: PHYS.tideSpeed0, height: 0, maxHeight: 0 };
    }

    // The player is created last: its ground probe needs the platforms to exist.
    this.player = new Player(this, start.x, start.y);
    this.state.player = this.player.s;
  }

  // ------------------------------------------------------------------ host
  get stats(): RunStats { return this.state.stats; }
  get interactive(): boolean { return this.state.phase === 'play'; }
  get finished(): boolean { return this.state.phase === 'clear' || this.state.phase === 'over'; }

  emit(ev: SimEvent): void { this.events.push(ev); }

  platformUnder(p: PlayerState): PlatformRide | null {
    for (const pl of this.plats) if (pl.supports(p)) return pl.ride;
    return null;
  }

  inUpdraft(x: number, y: number): boolean {
    for (const d of this.drafts) if (d.contains(x, y)) return true;
    return false;
  }

  stompShock(x: number, y: number): void {
    for (const f of this.foeList) {
      if (f.s.dead || f.s.dying > 0) continue;
      if (Math.abs(f.s.x - x) < 34 && Math.abs(f.s.y - y) < 22) f.damage(this, 1);
    }
  }

  onDeath(cause: string): void {
    const st = this.state;
    st.stats.deaths++;
    st.stats.combo = 0;
    this.comboT = 0;
    this.emit({ type: 'death', x: this.player.cx, y: this.player.cy, cause, deaths: st.stats.deaths });
    this.setPhase('dying');
  }

  spawnBolt(x: number, y: number, vx: number, vy: number): void {
    this.state.bolts.push({ id: this.boltSeq++, x, y, vx, vy, dead: false, t: 0 });
  }

  onShard(x: number, y: number): void {
    const st = this.state.stats;
    st.shards++;
    st.combo++;
    this.comboT = COMBO_WINDOW;
    if (st.combo > st.bestCombo) st.bestCombo = st.combo;
    this.emit({ type: 'shard', x, y, n: st.shards, total: this.level.totalShards, combo: st.combo });
  }

  onRelic(x: number, y: number): void {
    this.state.stats.relics++;
    this.player.s.dashReady = true;
    this.emit({ type: 'relic', x, y, n: this.state.stats.relics, total: this.level.totalRelics });
  }

  onCheckpoint(x: number, y: number): void {
    this.state.respawn = { x, y };
    this.emit({ type: 'checkpoint', x, y });
  }

  onGoal(x: number, y: number): void {
    if (this.finished) return;
    this.setPhase('clear');
    this.emit({ type: 'goal', x, y, summary: this.summary() });
  }

  onCrystal(x: number, y: number): void { this.emit({ type: 'crystal', x, y }); }

  onToggle(x: number, y: number): void {
    const L = this.level;
    L.switchA = !L.switchA;
    this.state.switchA = L.switchA;
    for (const t of this.toggles) t.sync(L.switchA);
    this.emit({ type: 'toggle', x, y, switchA: L.switchA });
    // a player standing inside a block that just became solid is nudged up by at most one tile, else hurt
    const p = this.player.s;
    if (this.player.overlapsSolid()) {
      const y0 = p.y;
      let freed = false;
      for (let lift = 1; lift <= TILE; lift++) {
        p.y = y0 - lift;
        if (!this.player.overlapsSolid()) { freed = true; break; }
      }
      if (!freed) { p.y = y0; this.player.hurt(0, 'switch'); }
    }
  }

  onFoeKilled(): void { this.state.stats.foes++; }

  // ------------------------------------------------------------------ setup
  private spawnAll(): void {
    const L = this.level;
    for (const sp of L.spawns) {
      const e = spawnEntity(sp, L);
      if (e) {
        this.ents.push(e);
        if (e instanceof MovePlat) this.plats.push(e);
        else if (e instanceof Toggle) this.toggles.push(e);
        else if (e instanceof Updraft) this.drafts.push(e);
        continue;
      }
      const f = spawnFoe(sp, sp.ch === 'h' ? this.rng() : 0);
      if (f) this.foeList.push(f);
    }
    for (const [tx, ty] of L.def.spikers ?? []) {
      this.foeList.push(new Spiker({ ch: 'w', tx, ty, x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 }));
    }
  }

  private setPhase(p: SimPhase): void {
    this.state.phase = p;
    this.state.phaseT = 0;
    this.phaseTicks = 0;
    this.emit({ type: 'phase', phase: p });
  }

  // ------------------------------------------------------------------ step
  /**
   * Advance one tick with this tick's input. Inert once the run is over.
   *
   * A RETRY press edge during 'play' is a death like any other (cause 'retry'):
   * it counts, plays the dying beat and respawns at the last checkpoint. Every
   * other phase ignores it, and a hold never repeats — the edge is derived from
   * the previous tick's mask, so a replay reproduces it exactly.
   */
  step(mask: InputMask): void {
    const st = this.state;
    if (st.phase === 'over') return;
    mask &= IN_ALL;
    const prev = this.prevMask;
    this.prevMask = mask;
    st.tick++;
    st.phaseT += DT;
    this.phaseTicks++;

    switch (st.phase) {
      case 'intro':
        if (this.phaseTicks >= (this.firstSpawn ? INTRO_TICKS : RESPAWN_INTRO_TICKS)) {
          // The flip tick is already controllable (the player reads this mask),
          // so it is a play tick for the run timer as well.
          this.setPhase('play');
          st.time += DT;
          this.playTicks++;
        }
        break;
      case 'play':
        st.time += DT;
        this.playTicks++;
        break;
      case 'dying':
        if (this.phaseTicks >= DYING_TICKS) {
          if (this.def.tide) {
            this.setPhase('over');
            this.emit({ type: 'tideOver', summary: this.summary() });
            return;
          }
          this.respawn();
        }
        break;
      case 'clear':
        break;
    }

    if (st.phase === 'play' && (mask & IN.RETRY) !== 0 && (prev & IN.RETRY) === 0) this.player.kill('retry');

    const live = st.phase === 'play';
    if (st.phase !== 'intro') this.player.update(DT, live ? mask : 0, live ? prev : 0);

    for (const e of this.ents) e.update(DT, this, this.player);

    let foeDied = false;
    for (const f of this.foeList) {
      if (f.s.dead) continue;
      if (f.s.dying > 0 || this.awake(f)) {
        f.update(DT, this, this.player);
        if (f.s.dead) foeDied = true;
      }
    }
    if (foeDied) st.foes = this.foeList.filter((f) => !f.s.dead).map((f) => f.s);

    this.updateBolts();
    if (st.tide && st.phase === 'play') this.updateTide();

    const broke = this.level.updateCrumble(DT);
    if (broke) for (const b of broke) this.emit({ type: 'crumble', tx: b.tx, ty: b.ty });

    if (this.comboT > 0) {
      this.comboT -= DT;
      if (this.comboT <= 0) st.stats.combo = 0;
    }
  }

  /** Awake when the gap between the foe's box and the player's box is within FOE_WAKE_GAP on both axes. */
  private awake(f: Foe): boolean {
    const p = this.player.s;
    const [bx, by, bw, bh] = f.box();
    const gx = Math.max(bx - (p.x + p.w), p.x - (bx + bw), 0);
    const gy = Math.max(by - (p.y + p.h), p.y - (by + bh), 0);
    return gx <= FOE_WAKE_GAP && gy <= FOE_WAKE_GAP;
  }

  private updateBolts(): void {
    const st = this.state;
    if (!st.bolts.length) return;
    const L = this.level;
    const p = this.player.s;
    let died = false;
    for (const b of st.bolts) {
      b.t += DT;
      b.x += b.vx * DT; b.y += b.vy * DT;
      // one-way platforms stop the player, so they stop bolts too
      const blocked = L.solidPx(b.x, b.y) || L.oneWay(Math.floor(b.x / TILE), Math.floor(b.y / TILE));
      if (b.t > BOLT_LIFE || blocked) { b.dead = true; died = true; continue; }
      if (!this.interactive || p.dead) continue;
      if (p.x + p.w > b.x - 3 && p.x < b.x + 3 && p.y + p.h > b.y - 3 && p.y < b.y + 3) {
        if (p.dashT <= 0) this.player.hurt(b.x, 'bolt');
        b.dead = true; died = true;
      }
    }
    if (died) st.bolts = st.bolts.filter((b: BoltState) => !b.dead);
  }

  private updateTide(): void {
    const st = this.state;
    const tide = st.tide!;
    const p = this.player.s;
    tide.speed = PHYS.tideSpeed0 + st.time * PHYS.tideAccel + tide.maxHeight * PHYS.tideHeightGain;
    tide.y -= tide.speed * DT;
    const feet = p.y + p.h;
    tide.height = Math.max(0, (this.baseYpx - feet) / TILE);
    if (tide.height > tide.maxHeight) {
      tide.maxHeight = tide.height;
      // the tide never falls further behind than the leash: keeps pressure on
      tide.y = Math.min(tide.y, feet + TILE * PHYS.tideLeash);
    }
    if (feet > tide.y && !p.dead) this.player.kill('tide');
  }

  private respawn(): void {
    const st = this.state;
    this.level.resetRunState();
    st.switchA = true;
    for (const t of this.toggles) t.sync(true);
    for (const f of this.foeList) f.reset();
    st.foes = this.foeList.map((f) => f.s);
    st.bolts = [];
    for (const e of this.ents) e.onRespawn();
    this.player.reset(st.respawn.x, st.respawn.y);
    this.firstSpawn = false;
    this.setPhase('intro');
    this.emit({ type: 'respawn', x: st.respawn.x, y: st.respawn.y });
  }

  // ------------------------------------------------------------------ output
  /** Events since the last drain, oldest first. */
  drainEvents(): SimEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  summary(): RunSummary {
    const st = this.state;
    const L = this.level;
    const time = this.playTicks / TICK_HZ;
    return {
      levelId: L.id,
      cleared: st.phase === 'clear',
      ticks: this.playTicks,
      time,
      shards: st.stats.shards, totalShards: L.totalShards,
      relics: st.stats.relics, totalRelics: L.totalRelics,
      deaths: st.stats.deaths,
      par: this.def.par,
      rank: rankFor(time, this.def.par, st.stats.shards, L.totalShards, st.stats.deaths),
      height: st.tide ? st.tide.maxHeight : 0,
    };
  }

  /** Deep copy of the public state (for echo rendering / tests). */
  snapshot(): SimState {
    return JSON.parse(JSON.stringify(this.state)) as SimState;
  }
}
