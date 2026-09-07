/**
 * P5-5 (SIM_VERSION 4) — the bubble foe ('b').
 *
 * A bubble floats over its spawn tile and bobs vertically. Stomped from above
 * it pops and launches the player at PHYS.bubbleBounce (no kill, no combo),
 * re-forming PHYS.bubbleRespawn seconds later; while popped it collides with
 * nothing. Side or underside contact is a death (cause 'bubble') outside
 * assist mode and a hurt inside it. Everything here runs on the real Sim with
 * tiny rooms, and the whole thing must be bit-identical run twice.
 */
import { describe, expect, it } from 'vitest';
import { Sim } from '../../src/sim/sim.js';
import { PHYS } from '../../src/sim/config.js';
import { BUBBLE_RESPAWN_TICKS } from '../../src/sim/foes.js';
import { IN, TICK_HZ } from '../../src/sim/types.js';
import type { FoeState, LevelDef, SimEvent } from '../../src/sim/types.js';
import { Room } from '../fixtures/levels.js';
import { D, DN, J, R, TILE, collect, playing, run, stepUntil } from './helpers.js';

/** Floor on rows 18-19, P standing at column 2, one bubble four rows over the floor at column 8 (awake, out of reach of a plain jump). */
function bobRoom(): LevelDef {
  const r = new Room(40, 20);
  r.rect(0, 18, 39, 19);
  r.set(2, 17, 'P');
  r.set(8, 13, 'b');
  return r.def('bob');
}

/** The same floor; P floats seven rows straight above the bubble, so the spawn drop lands on it from above. */
function dropRoom(): LevelDef {
  const r = new Room(40, 20);
  r.rect(0, 18, 39, 19);
  r.set(8, 6, 'P');
  r.set(8, 13, 'b');
  return r.def('drop');
}

/** Floor on rows 12-13; a bubble hangs in the standing row six tiles right of P: walking right meets its side. */
function sideRoom(): LevelDef {
  const r = new Room(40, 14);
  r.rect(0, 12, 39, 13);
  r.set(2, 11, 'P');
  r.set(8, 11, 'b');
  return r.def('side');
}

/** P floats over the floor; a bubble one row over the floor two tiles right of the landing point (inside the stomp shockwave, beside the player). */
function shockRoom(): LevelDef {
  const r = new Room(40, 20);
  r.rect(0, 18, 39, 19);
  r.set(8, 10, 'P');
  r.set(10, 17, 'b');
  return r.def('shock');
}

/** The bob room plus a second bubble far to the right, out of FOE_WAKE_GAP. */
function farRoom(): LevelDef {
  const r = new Room(60, 20);
  r.rect(0, 18, 59, 19);
  r.set(2, 17, 'P');
  r.set(8, 13, 'b');
  r.set(40, 8, 'b');
  return r.def('far');
}

/**
 * The drop room with a one-tile-thick ledge on row 15 from the bubble's column rightward: the player who pops the
 * bubble falls back onto the ledge and stands with their box (y 225..240) inside the bubble's home envelope
 * (y 198..234), blocking the re-form until they walk off to the right.
 */
function perchRoom(): LevelDef {
  const r = new Room(40, 20);
  r.rect(0, 18, 39, 19);
  r.hline(8, 14, 15);
  r.set(8, 6, 'P');
  r.set(8, 13, 'b');
  return r.def('perch');
}

const bubbleOf = (sim: Sim): FoeState => sim.state.foes.find((f) => f.kind === 'bubble')!;
const types = (ev: SimEvent[]) => ev.map((e) => e.type);
/** Home of the bubble every room above places at tile (8, 13). */
const HOME = { x: 8 * TILE + TILE / 2, y: 13 * TILE + TILE / 2 };
/** The popped bubble's home box grown by the bob amplitude and the re-form margin of 2: what must be clear of the player before it re-forms. */
const HOME_ENVELOPE = (() => {
  const m = 2, amp = PHYS.bubbleBobAmp;
  return { x: HOME.x - 6 - m, y: HOME.y - 6 - amp - m, w: 12 + 2 * m, h: 12 + 2 * amp + 2 * m };
})();
const inEnvelope = (sim: Sim): boolean => {
  const p = sim.state.player, e = HOME_ENVELOPE;
  return p.x + p.w > e.x && p.x < e.x + e.w && p.y + p.h > e.y && p.y < e.y + e.h;
};

describe('bubble — spawn and bob', () => {
  it('spawns from the legend char b as a 12x12 bubble foe centred on its tile, alive, with hp irrelevant', () => {
    const sim = new Sim(bobRoom());
    const b = bubbleOf(sim);
    expect(b).toBeDefined();
    expect(b.kind).toBe('bubble');
    expect([b.w, b.h]).toEqual([12, 12]);
    expect([b.x, b.y]).toEqual([8 * TILE + TILE / 2, 13 * TILE + TILE / 2]);
    expect(b.dead).toBe(false);
    expect(b.dying).toBe(0);
    expect(b.state).toBe(0);
    expect(sim.state.foes).toHaveLength(1);
  });

  it('bobs vertically within PHYS.bubbleBobAmp of home, never sideways, with the period of PHYS.bubbleBobPeriod', () => {
    const sim = playing(bobRoom());
    const home = { x: 8 * TILE + TILE / 2, y: 13 * TILE + TILE / 2 };
    const ys: number[] = [];
    for (let i = 0; i < 4 * TICK_HZ; i++) {
      sim.step(0);
      const b = bubbleOf(sim);
      expect(b.x).toBe(home.x);
      expect(Math.abs(b.y - home.y)).toBeLessThanOrEqual(PHYS.bubbleBobAmp + 1e-9);
      ys.push(b.y);
    }
    // it moves, and it reaches (nearly) both extremes
    expect(Math.max(...ys) - home.y).toBeGreaterThan(PHYS.bubbleBobAmp * 0.95);
    expect(home.y - Math.min(...ys)).toBeGreaterThan(PHYS.bubbleBobAmp * 0.95);
    // one full period later the bubble is back where it was (to the dsin approximation)
    const period = Math.round(PHYS.bubbleBobPeriod * TICK_HZ);
    for (let i = period; i < ys.length; i++) expect(Math.abs(ys[i] - ys[i - period])).toBeLessThan(0.05);
    expect(sim.state.player.dead).toBe(false);
  });

  it('is deterministic: two sims stepping the same masks report the same bubble y every tick', () => {
    const a = playing(bobRoom()), b = playing(bobRoom());
    for (let i = 0; i < 600; i++) {
      a.step(0); b.step(0);
      expect(bubbleOf(a).y).toBe(bubbleOf(b).y);
    }
  });

  it('sleeps like every foe: a bubble far from the player does not bob until the player comes near', () => {
    const sim = playing(farRoom());
    const farOf = (s: Sim) => s.state.foes.find((f) => f.kind === 'bubble' && f.x > 30 * TILE)!;
    const nearOf = (s: Sim) => s.state.foes.find((f) => f.kind === 'bubble' && f.x < 30 * TILE)!;
    expect(farOf(sim).y).toBe(8 * TILE + TILE / 2);
    run(sim, 240);
    expect(farOf(sim).y).toBe(8 * TILE + TILE / 2);
    // the near one moved
    expect(nearOf(sim).y).not.toBe(13 * TILE + TILE / 2);
  });
});

describe('bubble — pop on a stomp', () => {
  /** Step the drop room until the pop tick; returns the events of that tick and the tick index. */
  function dropOnto(sim: Sim, mask = 0): { ev: SimEvent[]; tick: number } {
    for (let i = 0; i < 600; i++) {
      sim.step(mask);
      const ev = sim.drainEvents();
      if (ev.some((e) => e.type === 'bubblePop')) return { ev, tick: sim.state.tick };
    }
    throw new Error('the drop never popped the bubble');
  }

  it('falling onto it from above pops it: bubblePop (no foeKilled), vy = PHYS.bubbleBounce, jumps and dash refilled, no kill, no combo', () => {
    const sim = playing(dropRoom());
    const { ev } = dropOnto(sim);
    const pops = ev.filter((e) => e.type === 'bubblePop');
    expect(pops).toHaveLength(1);
    expect(pops[0]).toMatchObject({ type: 'bubblePop', x: 8 * TILE + TILE / 2 });
    expect(types(ev)).not.toContain('foeKilled');
    expect(types(ev)).not.toContain('foeHit');
    expect(types(ev)).not.toContain('death');
    const p = sim.state.player;
    expect(p.vy).toBe(PHYS.bubbleBounce);
    expect(PHYS.bubbleBounce).toBeLessThan(PHYS.stompBounce);   // stronger than a stomp bounce …
    expect(PHYS.bubbleBounce).toBeGreaterThan(PHYS.springVel);  // … weaker than a spring
    expect(p.jumps).toBe(0);
    expect(p.dashReady).toBe(true);
    expect(p.stomping).toBe(false);
    expect(p.grounded).toBe(false);
    expect(p.dead).toBe(false);
    expect(sim.state.stats.foes).toBe(0);
    expect(sim.state.stats.combo).toBe(0);
    expect(sim.state.stats.bestCombo).toBe(0);
    // the bubble is popped, still listed, counting down, and snapped back to its home y (no bob phase lingers on a dead bubble)
    const b = bubbleOf(sim);
    expect(b.dead).toBe(true);
    expect(b.dying).toBe(0);
    expect(b.state).toBeCloseTo(PHYS.bubbleRespawn, 9);
    expect(b.y).toBe(HOME.y);
    expect(sim.state.foes).toHaveLength(1);
  });

  it('the launch carries the player higher than a stomp bounce would and clear of the popped spot', () => {
    const sim = playing(dropRoom());
    dropOnto(sim);
    const y0 = sim.state.player.y;
    let top = y0;
    for (let i = 0; i < 120; i++) { sim.step(0); top = Math.min(top, sim.state.player.y); }
    const rise = y0 - top;
    // v² / 2g with JUMP released (the jump-cut gravity): -352 → ~55 units; a stomp bounce (-300) would be ~40.
    // Holding JUMP through the launch (the held-jump gravity) lifts it to ~72.
    expect(rise).toBeGreaterThan(50);
    expect(rise).toBeLessThan(80);
    // JUMP held from before the pop (no press edge, so no air jump replaces the launch): the held-jump gravity applies
    const held = playing(dropRoom());
    dropOnto(held, J);
    const hy0 = held.state.player.y;
    let htop = hy0;
    for (let i = 0; i < 120; i++) { held.step(J); htop = Math.min(htop, held.state.player.y); }
    expect(hy0 - htop).toBeGreaterThan(rise + 10);
    expect(hy0 - htop).toBeLessThan(80);
    // a JUMP press right after the pop is an air jump (the bounce refilled both), which replaces the launch velocity
    const tapped = playing(dropRoom());
    dropOnto(tapped);
    tapped.step(J);
    expect(tapped.state.player.vy).toBe(PHYS.jumpVel2);
    expect(tapped.state.player.jumps).toBe(1);
  });

  it('a popped bubble has no collision: falling straight back through its spot lands on the floor alive', () => {
    const sim = playing(dropRoom());
    dropOnto(sim);
    const n = stepUntil(sim, (s) => s.state.player.grounded, 400, 0);
    expect(n).toBeGreaterThan(0);
    const p = sim.state.player;
    expect(p.dead).toBe(false);
    expect(p.y + p.h).toBeCloseTo(18 * TILE, 0);
    expect(sim.state.stats.deaths).toBe(0);
    expect(bubbleOf(sim).dead).toBe(true);
  });

  it(`re-forms at home exactly ${'BUBBLE_RESPAWN_TICKS'} (= PHYS.bubbleRespawn · 120) ticks after the pop with a bubbleBack event, then bobs and collides again`, () => {
    expect(BUBBLE_RESPAWN_TICKS).toBe(Math.round(PHYS.bubbleRespawn * TICK_HZ));
    const sim = playing(dropRoom());
    const { tick: popTick } = dropOnto(sim);
    let backTick = -1;
    let back: SimEvent | undefined;
    for (let i = 0; i < BUBBLE_RESPAWN_TICKS + 60 && backTick < 0; i++) {
      sim.step(0);
      const ev = sim.drainEvents();
      back = ev.find((e) => e.type === 'bubbleBack');
      if (back) backTick = sim.state.tick;
      else {
        // dead the whole way, parked at its home y
        expect(bubbleOf(sim).dead).toBe(true);
        expect(bubbleOf(sim).y).toBe(HOME.y);
      }
    }
    expect(backTick - popTick).toBe(BUBBLE_RESPAWN_TICKS);
    expect(back).toMatchObject({ type: 'bubbleBack', x: 8 * TILE + TILE / 2 });
    const b = bubbleOf(sim);
    expect(b.dead).toBe(false);
    expect(b.state).toBe(0);
    expect(Math.abs(b.y - (13 * TILE + TILE / 2))).toBeLessThanOrEqual(PHYS.bubbleBobAmp + 1e-9);
    // the state countdown ran in seconds from bubbleRespawn down to 0
    expect(sim.state.foes).toHaveLength(1);
  });

  it('the countdown is visible on the state: `state` falls from bubbleRespawn toward 0 in 1/120 s steps', () => {
    const sim = playing(dropRoom());
    dropOnto(sim);
    const s0 = bubbleOf(sim).state;
    sim.step(0);
    expect(s0 - bubbleOf(sim).state).toBeCloseTo(1 / TICK_HZ, 9);
    run(sim, 119);
    expect(bubbleOf(sim).state).toBeCloseTo(PHYS.bubbleRespawn - 120 / TICK_HZ, 9);
  });

  it('a player standing in its home envelope when the countdown ends holds the re-form: dead, state 1/120, no bubbleBack — until the first tick they are clear', () => {
    const sim = playing(perchRoom());
    const { tick: popTick } = dropOnto(sim);
    // the launch, then the fall back onto the ledge: the player ends up standing inside the envelope
    const landed = stepUntil(sim, (s) => s.state.player.grounded, 400, 0);
    expect(landed).toBeGreaterThan(0);
    expect(sim.state.player.dead).toBe(false);
    expect(sim.state.player.y + sim.state.player.h).toBeCloseTo(15 * TILE, 0);
    expect(inEnvelope(sim)).toBe(true);
    // stand still through the end of the countdown and 30 ticks past it
    const dueTick = popTick + BUBBLE_RESPAWN_TICKS;
    while (sim.state.tick < dueTick + 30) {
      sim.step(0);
      const ev = sim.drainEvents();
      expect(types(ev)).not.toContain('bubbleBack');
      const b = bubbleOf(sim);
      expect(b.dead).toBe(true);
      expect(b.y).toBe(HOME.y);
      if (sim.state.tick >= dueTick) {
        // held: the smallest positive countdown, never 0 (the renderer reads "about to return" from 0 < state < 0.5)
        expect(b.state).toBeCloseTo(1 / TICK_HZ, 12);
        expect(b.state).toBeGreaterThan(0);
      }
    }
    expect(inEnvelope(sim)).toBe(true);
    // walk off to the right: the bubble is back on the first tick the player's box is clear of the envelope, not before
    let backTick = -1, clearTick = -1;
    for (let i = 0; i < 120 && backTick < 0; i++) {
      sim.step(R);
      const ev = sim.drainEvents();
      if (clearTick < 0 && !inEnvelope(sim)) clearTick = sim.state.tick;
      const backs = ev.filter((e) => e.type === 'bubbleBack');
      if (backs.length) {
        backTick = sim.state.tick;
        expect(backs).toHaveLength(1);
        expect(backs[0]).toMatchObject({ type: 'bubbleBack', x: HOME.x });
      } else {
        expect(inEnvelope(sim)).toBe(true);
        expect(bubbleOf(sim).dead).toBe(true);
      }
    }
    expect(clearTick).toBeGreaterThan(0);
    expect(backTick).toBe(clearTick);
    const b = bubbleOf(sim);
    expect(b.dead).toBe(false);
    expect(b.state).toBe(0);
    expect(Math.abs(b.y - HOME.y)).toBeLessThanOrEqual(PHYS.bubbleBobAmp + 1e-9);
    expect(sim.state.player.dead).toBe(false);
    expect(sim.state.stats.deaths).toBe(0);
  });

  it('holding DOWN (a stomp) pops it even when the feet meet it beside its top', () => {
    // fall from a shallow height with DOWN held: the stomp flag makes every contact a pop
    const sim = playing(dropRoom());
    sim.state.player.y = 11 * TILE;   // three rows over the bubble
    const ev = collect(sim, 60, DN);
    expect(ev.some((e) => e.type === 'stomp')).toBe(true);
    expect(ev.filter((e) => e.type === 'bubblePop')).toHaveLength(1);
    expect(sim.state.player.dead).toBe(false);
    expect(sim.state.stats.foes).toBe(0);
  });

  it('a stomp landing next to a bubble does not burst it (only a stomp onto it does)', () => {
    const sim = playing(shockRoom());
    const ev = collect(sim, 150, DN);
    expect(ev.some((e) => e.type === 'stompLand')).toBe(true);
    expect(ev.some((e) => e.type === 'bubblePop')).toBe(false);
    expect(bubbleOf(sim).dead).toBe(false);
    expect(sim.state.player.dead).toBe(false);
    expect(sim.state.player.grounded).toBe(true);
  });

  it('a player respawn puts a popped bubble straight back (foe reset), without a bubbleBack event', () => {
    const sim = playing(dropRoom());
    dropOnto(sim);
    expect(bubbleOf(sim).dead).toBe(true);
    sim.step(IN.RETRY);
    const ev = collect(sim, 90, 0);
    expect(ev.some((e) => e.type === 'respawn')).toBe(true);
    expect(ev.some((e) => e.type === 'bubbleBack')).toBe(false);
    expect(bubbleOf(sim).dead).toBe(false);
    expect(bubbleOf(sim).state).toBe(0);
  });
});

describe('bubble — side contact and dashes', () => {
  it('normal mode: walking into its side is a death on the same tick with cause "bubble", no hurt event, hp untouched', () => {
    const sim = playing(sideRoom());
    let hit: SimEvent[] | null = null;
    for (let i = 0; i < 600 && !hit; i++) {
      sim.step(R);
      const ev = sim.drainEvents();
      if (ev.some((e) => e.type === 'hurt' || e.type === 'death')) hit = ev;
    }
    expect(hit).not.toBeNull();
    const death = hit!.find((e) => e.type === 'death');
    expect(death).toMatchObject({ type: 'death', cause: 'bubble', deaths: 1 });
    expect(types(hit!)).not.toContain('hurt');
    expect(types(hit!)).not.toContain('bubblePop');
    expect(sim.state.player.dead).toBe(true);
    expect(sim.state.player.hp).toBe(PHYS.maxHp);
    expect(bubbleOf(sim).dead).toBe(false);   // the bubble survives the contact
  });

  it('assist mode: the same contact is a hurt with knockback and invulnerability; the third one kills with cause "bubble"', () => {
    const sim = playing(sideRoom(), { assist: true });
    let hit: SimEvent[] | null = null;
    for (let i = 0; i < 600 && !hit; i++) {
      sim.step(R);
      const ev = sim.drainEvents();
      if (ev.some((e) => e.type === 'hurt' || e.type === 'death')) hit = ev;
    }
    expect(hit).not.toBeNull();
    expect(hit!.find((e) => e.type === 'hurt')).toMatchObject({ type: 'hurt', hp: 2 });
    expect(types(hit!)).not.toContain('death');
    const p = sim.state.player;
    expect(p.dead).toBe(false);
    expect(p.hp).toBe(2);
    expect(p.invuln).toBeGreaterThan(0);
    expect(p.vx).toBeLessThan(0);   // knocked back, away from the bubble
    // the bubble is still there; walk into it twice more from the start (after the invulnerability): a hurt, then the death
    let deaths = 0, hurts = 0, cause = '';
    for (let round = 0; round < 2 && !deaths; round++) {
      sim.state.player.x = 2 * TILE; sim.state.player.vx = 0;
      const calm = stepUntil(sim, (s) => s.state.player.invuln <= 0 && s.state.player.grounded, 600, 0);
      expect(calm).toBeGreaterThanOrEqual(0);
      for (let i = 0; i < 600 && !deaths; i++) {
        sim.step(R);
        const ev = sim.drainEvents();
        const death = ev.find((e) => e.type === 'death');
        if (death && death.type === 'death') { deaths++; cause = death.cause; break; }   // (the fatal hurt carries hp 0 alongside)
        if (ev.some((e) => e.type === 'hurt')) { hurts++; break; }
      }
    }
    expect(hurts).toBe(1);
    expect(deaths).toBe(1);
    expect(cause).toBe('bubble');
    expect(sim.state.player.hp).toBe(0);
    expect(bubbleOf(sim).dead).toBe(false);
  });

  it('dashing through it pops it without the launch: bubblePop, the player alive, no kill counted', () => {
    const sim = playing(sideRoom());
    // walk up, then dash into it
    const n = stepUntil(sim, (s) => s.state.player.x > 6 * TILE, 300, R);
    expect(n).toBeGreaterThan(0);
    sim.step(D | R);
    const ev = collect(sim, 30, R);
    expect(ev.filter((e) => e.type === 'bubblePop')).toHaveLength(1);
    expect(types(ev)).not.toContain('death');
    expect(types(ev)).not.toContain('foeKilled');
    expect(sim.state.player.dead).toBe(false);
    expect(sim.state.player.vy).toBeGreaterThanOrEqual(0);   // no bubbleBounce
    expect(sim.state.stats.foes).toBe(0);
    expect(bubbleOf(sim).dead).toBe(true);
  });

  it('a jump into its underside is a death, not a pop', () => {
    const sim = playing(bobRoom());
    // stand under the bubble, then jump straight up into it (the double jump reaches four rows)
    const n = stepUntil(sim, (s) => s.state.player.x + s.state.player.w / 2 > 8 * TILE + 6, 300, R);
    expect(n).toBeGreaterThan(0);
    run(sim, 20, 0);
    sim.step(J);
    run(sim, 12, J);
    run(sim, 6, 0);
    sim.step(J);
    const ev = collect(sim, 60, J);
    const death = ev.find((e) => e.type === 'death');
    expect(death).toMatchObject({ type: 'death', cause: 'bubble' });
    expect(types(ev)).not.toContain('bubblePop');
  });
});

describe('bubble — determinism', () => {
  it('two sims over 2000 ticks with a scripted stomp and respawn are bit-identical', () => {
    const script = (i: number): number => {
      if (i < 200) return DN;                       // drop onto the bubble with DOWN held: a pop and a launch
      if (i < 320) return R;                        // drift right
      if (i < 330) return R | J;                    // hop
      if (i === 700) return IN.RETRY;               // die on purpose, respawn over the (re-formed) bubble
      if (i > 760 && i < 900) return DN;            // pop it again
      if (i % 300 < 20) return L_OR_R(i);
      return 0;
    };
    const L_OR_R = (i: number) => (Math.floor(i / 300) % 2 ? IN.LEFT : IN.RIGHT);
    const a = new Sim(dropRoom()), b = new Sim(dropRoom());
    const pops: number[] = [], backs: number[] = [];
    for (let i = 0; i < 2000; i++) {
      const m = script(i);
      a.step(m); b.step(m);
      for (const e of a.drainEvents()) {
        if (e.type === 'bubblePop') pops.push(i);
        if (e.type === 'bubbleBack') backs.push(i);
      }
      b.drainEvents();
    }
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
    expect(pops.length).toBeGreaterThanOrEqual(2);
    expect(backs.length).toBeGreaterThanOrEqual(1);
    expect(a.state.stats.deaths).toBe(1);
    expect(a.state.stats.foes).toBe(0);
    // the same script on a fresh sim reproduces the same digest
    const digest = (s: Sim) => JSON.stringify(s.snapshot());
    const c = new Sim(dropRoom());
    for (let i = 0; i < 2000; i++) c.step(script(i));
    expect(digest(c)).toBe(digest(a));
  });
});
