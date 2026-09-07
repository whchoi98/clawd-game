/**
 * SIM_VERSION 3 — hazards kill on contact outside assist mode (roadmap P2-8).
 *
 * Normal mode: spikes, saws, bolts, foes and a closing switch block are a
 * death on the tick of contact: no 'hurt' event, hp untouched, the death
 * event carries the same cause string as before, the usual respawn follows.
 * Assist mode keeps the three hearts: the same contact is a 'hurt' with
 * knockback and invulnerability, and only the third one kills.
 */
import { describe, expect, it } from 'vitest';
import { ASSIST, PHYS } from '../../src/sim/config.js';
import { SIM_VERSION } from '../../src/sim/types.js';
import type { LevelDef, SimEvent } from '../../src/sim/types.js';
import type { Sim } from '../../src/sim/sim.js';
import { crushRoom, sawRoom, spikeRoom, turretRoom, walkerRoom } from '../fixtures/levels.js';
import { D, R, TILE, playing, run } from './helpers.js';

/** Events per tick until the first tick that carries a hurt or a death (inclusive), or `max` ticks. */
function untilHit(sim: Sim, mask: (sim: Sim) => number, max: number): { ticks: SimEvent[][]; hitTick: number } {
  const ticks: SimEvent[][] = [];
  for (let i = 0; i < max; i++) {
    sim.step(mask(sim));
    const ev = sim.drainEvents();
    ticks.push(ev);
    if (ev.some((e) => e.type === 'hurt' || e.type === 'death')) return { ticks, hitTick: i };
  }
  return { ticks, hitTick: -1 };
}

interface Hazard {
  name: string;
  cause: string;
  room: () => LevelDef;
  /** Input policy that walks into the hazard. */
  mask: (sim: Sim) => number;
  max: number;
}

/** Dash through the toggle once the player is a few tiles from it; otherwise run right. */
function dashAtToggle(sim: Sim): number {
  const p = sim.state.player;
  return p.x > 7 * TILE && p.dashReady && p.dashT <= 0 ? D | R : R;
}

const HAZARDS: Hazard[] = [
  { name: 'spikes', cause: 'spike', room: spikeRoom, mask: () => R, max: 2400 },
  { name: 'a floor saw', cause: 'saw', room: sawRoom, mask: () => 0, max: 2400 },
  { name: 'a turret bolt', cause: 'bolt', room: turretRoom, mask: () => 0, max: 2400 },
  { name: 'a walker', cause: 'foe', room: walkerRoom, mask: () => 0, max: 2400 },
  { name: 'a switch block closing on the player', cause: 'switch', room: crushRoom, mask: dashAtToggle, max: 2400 },
];

describe('SIM_VERSION 3 — instant death in normal mode', () => {
  it('is sim version 3', () => {
    expect(SIM_VERSION).toBe(3);
  });

  for (const h of HAZARDS) {
    it(`${h.name}: the first contact is a death on the same tick with cause '${h.cause}', no hurt event, hp untouched`, () => {
      const sim = playing(h.room());
      const { ticks, hitTick } = untilHit(sim, h.mask, h.max);
      expect(hitTick, `never touched ${h.name}`).toBeGreaterThanOrEqual(0);
      const all = ticks.flat();
      expect(all.filter((e) => e.type === 'hurt')).toEqual([]);
      const deaths = all.filter((e) => e.type === 'death');
      expect(deaths).toHaveLength(1);
      expect(deaths[0]).toMatchObject({ type: 'death', cause: h.cause, deaths: 1 });
      // the death is on the tick of the contact: the contact tick's own events carry it
      expect(ticks[hitTick].some((e) => e.type === 'death')).toBe(true);
      expect(sim.state.stats.deaths).toBe(1);
      expect(sim.state.player.dead).toBe(true);
      expect(sim.state.player.hp).toBe(PHYS.maxHp);
      expect(sim.state.player.invuln).toBe(0);
      expect(sim.state.phase).toBe('dying');
      // the normal respawn follows: back in play with full hp, deaths stay counted
      run(sim, 200);
      expect(sim.state.phase).toBe('play');
      expect(sim.state.player.dead).toBe(false);
      expect(sim.state.player.hp).toBe(PHYS.maxHp);
      expect(sim.state.stats.deaths).toBe(1);
    });

    it(`${h.name} in assist mode: a hurt (hp ${ASSIST.maxHp} → ${ASSIST.maxHp - 1}) with invulnerability, not a death`, () => {
      const sim = playing(h.room(), { assist: true });
      expect(sim.state.player.hp).toBe(ASSIST.maxHp);
      const { ticks, hitTick } = untilHit(sim, h.mask, h.max);
      expect(hitTick, `never touched ${h.name}`).toBeGreaterThanOrEqual(0);
      const all = ticks.flat();
      expect(all.filter((e) => e.type === 'death')).toEqual([]);
      const hurts = all.filter((e) => e.type === 'hurt');
      expect(hurts).toHaveLength(1);
      expect(hurts[0]).toMatchObject({ type: 'hurt', hp: ASSIST.maxHp - 1 });
      expect(sim.state.player.hp).toBe(ASSIST.maxHp - 1);
      expect(sim.state.player.dead).toBe(false);
      expect(sim.state.player.invuln).toBeGreaterThan(0);
      expect(sim.state.stats.deaths).toBe(0);
      expect(sim.state.phase).toBe('play');
    });
  }

  it('assist mode keeps three hearts: the third spike contact is the death, with a hurt per contact before it', () => {
    expect(ASSIST.maxHp).toBe(3);
    const sim = playing(spikeRoom(), { assist: true });
    const ev: SimEvent[] = [];
    for (let i = 0; i < 4800 && sim.state.phase === 'play'; i++) {
      sim.step(R);
      ev.push(...sim.drainEvents());
    }
    // the existing assist behaviour: every contact is a hurt, the one that empties the hearts also kills
    expect(ev.filter((e) => e.type === 'hurt').map((e) => (e as { hp: number }).hp)).toEqual([2, 1, 0]);
    const death = ev.find((e) => e.type === 'death');
    expect(death).toMatchObject({ type: 'death', cause: 'spike', deaths: 1 });
    expect(sim.state.phase).toBe('dying');
  });

  it('normal mode: a spike bed is a death per contact, never a hurt — deaths add up across respawns', () => {
    const sim = playing(spikeRoom());
    const ev: SimEvent[] = [];
    for (let i = 0; i < 2400; i++) {
      sim.step(R);
      ev.push(...sim.drainEvents());
    }
    expect(ev.filter((e) => e.type === 'hurt')).toEqual([]);
    const deaths = ev.filter((e) => e.type === 'death');
    expect(deaths.length).toBeGreaterThanOrEqual(3);
    for (const d of deaths) expect(d).toMatchObject({ type: 'death', cause: 'spike' });
    expect(sim.state.stats.deaths).toBe(deaths.length);
  });

  it('the invincible debug flag still ignores hazards in normal mode', () => {
    const sim = playing(spikeRoom(), { invincible: true });
    const ev: SimEvent[] = [];
    for (let i = 0; i < 600; i++) {
      sim.step(R);
      ev.push(...sim.drainEvents());
    }
    expect(sim.state.player.x).toBeGreaterThan(12 * TILE);
    expect(ev.some((e) => e.type === 'hurt' || e.type === 'death')).toBe(false);
  });
});
