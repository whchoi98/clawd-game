import { describe, it, expect } from 'vitest';
import { Sim } from '../../src/sim/sim.js';
import { busyRoom, crystalRoom, platformRoom, stompRoom, switchRoom } from '../fixtures/levels.js';
import { D, DN, J, R, TILE, collect, playing, run, stepUntil } from './helpers.js';

describe('entities and foes', () => {
  it('stomping a walker kills it', () => {
    const sim = playing(stompRoom());
    const walker = sim.state.foes.find((f) => f.kind === 'walker');
    expect(walker).toBeDefined();
    // step off the ledge into the trench, then hold DOWN to stomp
    const n = stepUntil(sim, (s) => !s.state.player.grounded, 120, R);
    expect(n).toBeGreaterThan(0);
    const ev = collect(sim, 240, DN);
    expect(ev.some((e) => e.type === 'stomp')).toBe(true);
    expect(ev.some((e) => e.type === 'foeKilled' && e.kind === 'walker')).toBe(true);
    expect(sim.state.stats.foes).toBe(1);
    expect(sim.state.player.dead).toBe(false);
    expect(sim.state.player.hp).toBe(3);
    run(sim, 60);
    expect(sim.state.foes.some((f) => f.kind === 'walker' && !f.dead)).toBe(false);
  });

  it('a dash crystal restores the dash mid-air and respawns later', () => {
    const sim = playing(crystalRoom());
    sim.step(J | R);
    run(sim, 9, R);
    sim.step(D | R);
    expect(sim.state.player.dashReady).toBe(false);
    expect(sim.state.player.grounded).toBe(false);
    let got = false;
    for (let i = 0; i < 60 && !got; i++) {
      for (const e of collect(sim, 1, R)) if (e.type === 'crystal') got = true;
    }
    expect(got).toBe(true);
    expect(sim.state.player.dashReady).toBe(true);
    expect(sim.state.player.grounded).toBe(false);
    const c = sim.state.entities.find((e) => e.kind === 'crystal')!;
    expect(c.state).toBeGreaterThan(0);
    expect(c.alive).toBe(true);
    run(sim, 260);
    expect(sim.state.entities.find((e) => e.kind === 'crystal')!.state).toBe(0);
  });

  it('dashing through a toggle flips switchA and the %/& solidity', () => {
    const def = switchRoom();
    const sim = playing(def);
    expect(sim.state.switchA).toBe(true);
    expect(sim.level.solid(14, 10)).toBe(true);
    expect(sim.level.solid(20, 10)).toBe(false);
    // walk toward the toggle and dash through it
    const n = stepUntil(sim, (s) => s.state.player.x > 7 * TILE, 600, R);
    expect(n).toBeGreaterThan(0);
    sim.step(D | R);
    const ev = collect(sim, 30, R);
    const tog = ev.find((e) => e.type === 'toggle');
    expect(tog && tog.type === 'toggle' && tog.switchA).toBe(false);
    expect(sim.state.switchA).toBe(false);
    expect(sim.level.switchA).toBe(false);
    expect(sim.level.solid(14, 10)).toBe(false);
    expect(sim.level.solid(20, 10)).toBe(true);
    expect(sim.state.entities.find((e) => e.kind === 'toggle')!.state).toBe(0);
    // the toggle has a cooldown: the same dash does not flip it back
    expect(ev.filter((e) => e.type === 'toggle').length).toBe(1);
  });

  it('spawns every legend entity and foe from the busy room', () => {
    const sim = new Sim(busyRoom());
    const kinds = new Set(sim.state.entities.map((e) => e.kind));
    for (const k of ['shard', 'relic', 'checkpoint', 'goal', 'spring', 'crystal', 'toggle', 'platH', 'platV', 'saw']) {
      expect(kinds.has(k as never)).toBe(true);
    }
    const foes = new Set(sim.state.foes.map((f) => f.kind));
    for (const k of ['walker', 'hopper', 'flyer', 'turret', 'chaser', 'spiker']) expect(foes.has(k as never)).toBe(true);
    expect(sim.level.totalShards).toBe(4);
    expect(sim.level.totalRelics).toBe(1);
    const ids = sim.state.entities.map((e) => e.id).concat(sim.state.foes.map((f) => f.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('moving platforms travel along their span and carry the player', () => {
    for (const vertical of [false, true]) {
      const sim = playing(platformRoom(vertical));
      const kind = vertical ? 'platV' : 'platH';
      const pl0 = { ...sim.state.entities.find((e) => e.kind === kind)! };
      expect(pl0.span).toBeGreaterThanOrEqual(2 * TILE);
      // the player drops onto the deck during the first ticks of play
      const n = stepUntil(sim, (s) => s.state.player.grounded, 60, 0);
      expect(n).toBeGreaterThanOrEqual(0);
      run(sim, 5); // settle onto the deck
      const p0 = { x: sim.state.player.x, y: sim.state.player.y };
      const plAtLanding = { ...sim.state.entities.find((e) => e.kind === kind)! };
      run(sim, 180);
      const p = sim.state.player;
      const pl = sim.state.entities.find((e) => e.kind === kind)!;
      expect(p.grounded).toBe(true);
      expect(Math.abs(p.y + p.h - (pl.y - 3))).toBeLessThan(0.5);
      if (vertical) {
        expect(pl.y).not.toBe(pl0.y);
        expect(Math.abs(p.y - p0.y)).toBeGreaterThan(4);
      } else {
        expect(pl.x).not.toBe(pl0.x);
        expect(Math.abs(p.x - p0.x)).toBeGreaterThan(4);
        // carried by the deck's displacement (one tick of lag at most)
        expect(Math.abs((p.x - p0.x) - (pl.x - plAtLanding.x))).toBeLessThan(0.3);
      }
    }
  });

  it('shards are collected with a combo and marked not alive', () => {
    const sim = playing(busyRoom());
    const ev = collect(sim, 130, R);
    const shards = ev.filter((e) => e.type === 'shard');
    expect(shards.length).toBeGreaterThanOrEqual(1);
    expect(shards[0].type === 'shard' && shards[0].total).toBe(4);
    expect(sim.state.stats.shards).toBe(shards.length);
    const taken = sim.state.entities.filter((e) => e.kind === 'shard' && !e.alive).length;
    expect(taken).toBe(shards.length);
  });

  it('turrets fire bolts and bolts hurt the player', () => {
    const sim = playing(busyRoom(), { invincible: false });
    sim.state.player.x = 24 * TILE; // teleport next to the turret at column 26
    sim.state.player.y = 17 * TILE;
    const ev = collect(sim, 400, 0);
    expect(ev.some((e) => e.type === 'bolt')).toBe(true);
    expect(ev.some((e) => e.type === 'hurt' || e.type === 'death')).toBe(true);
  });

  it('foes far from the player stay asleep', () => {
    const sim = playing(busyRoom());
    const chaser = sim.state.foes.find((f) => f.kind === 'chaser')!;
    const flyer = sim.state.foes.find((f) => f.kind === 'flyer')!;
    const cx = chaser.x, cy = chaser.y, fx = flyer.x;
    run(sim, 120);
    expect(sim.state.foes.find((f) => f.kind === 'chaser')!.x).toBe(cx);
    expect(sim.state.foes.find((f) => f.kind === 'chaser')!.y).toBe(cy);
    expect(sim.state.foes.find((f) => f.kind === 'flyer')!.x).toBe(fx);
  });
});
