/**
 * Hand-built test rooms for the simulation tests. Every room is tiny and
 * describes exactly one situation so a failing assertion points at one rule.
 *
 * Coordinates are tile indices; row 0 is the top. The map edge reads solid on
 * the sides and empty above / below (see Level.at), so rooms only need a floor.
 */
import type { LevelDef } from '../../src/sim/types.js';

export class Room {
  readonly g: string[][];
  constructor(readonly w: number, readonly h: number) {
    this.g = [];
    for (let y = 0; y < h; y++) this.g.push(new Array<string>(w).fill('.'));
  }
  set(x: number, y: number, ch: string): this {
    if (x >= 0 && x < this.w && y >= 0 && y < this.h) this.g[y][x] = ch;
    return this;
  }
  hline(x0: number, x1: number, y: number, ch = '#'): this {
    for (let x = x0; x <= x1; x++) this.set(x, y, ch);
    return this;
  }
  vline(x: number, y0: number, y1: number, ch = '#'): this {
    for (let y = y0; y <= y1; y++) this.set(x, y, ch);
    return this;
  }
  rect(x0: number, y0: number, x1: number, y1: number, ch = '#'): this {
    for (let y = y0; y <= y1; y++) this.hline(x0, x1, y, ch);
    return this;
  }
  rows(): string[] { return this.g.map((r) => r.join('')); }
  def(id: string, extra: Partial<LevelDef> = {}): LevelDef {
    return {
      id, name: `테스트 ${id}`, en: `TEST ${id.toUpperCase()}`, biome: 'tidepool', par: 30, seed: 1234,
      rows: this.rows(), ...extra,
    };
  }
}

/** 40 x 14: a flat floor on rows 12-13, P at the left, G at the right. */
export function flatRoom(): LevelDef {
  const r = new Room(40, 14);
  r.rect(0, 12, 39, 13);
  r.set(2, 11, 'P').set(37, 11, 'G');
  return r.def('flat');
}

/** Same floor, no goal: for physics probes that must never finish. */
export function openRoom(): LevelDef {
  const r = new Room(40, 14);
  r.rect(0, 12, 39, 13);
  r.set(2, 11, 'P');
  return r.def('open');
}

/**
 * A 4-wide wall-jump shaft: walls at columns 10 and 15 (interior 11..14),
 * running from row 2 down to two tiles above the floor (doorways). P stands
 * inside the shaft on the floor.
 */
export function shaftRoom(): LevelDef {
  const r = new Room(30, 30);
  r.rect(0, 28, 29, 29);
  r.vline(10, 2, 25).vline(15, 2, 25);
  r.set(12, 27, 'P');
  r.set(12, 3, 'o');
  return r.def('shaft');
}

/** Floor with a 6-tile bottomless pit at columns 15..20. */
export function pitRoom(): LevelDef {
  const r = new Room(40, 14);
  r.rect(0, 12, 39, 13);
  for (let x = 15; x <= 20; x++) { r.set(x, 12, '.'); r.set(x, 13, '.'); }
  r.set(2, 11, 'P').set(37, 11, 'G');
  return r.def('pit');
}

/** Walker in a 2-tile trench; P on a ledge straight above it so a stomp lands on it. */
export function stompRoom(): LevelDef {
  const r = new Room(20, 16);
  r.rect(0, 14, 19, 15);
  // trench walls at columns 4 and 7 (interior 5..6), rising to row 9
  r.vline(4, 9, 13).vline(7, 9, 13);
  r.set(5, 13, 'w');
  // player stands on the left wall top (row 8) and steps right into the trench
  r.set(4, 8, 'P');
  return r.def('stomp');
}

/** A crystal hanging in the dash path 2 tiles above the floor. */
export function crystalRoom(): LevelDef {
  const r = new Room(40, 14);
  r.rect(0, 12, 39, 13);
  r.set(2, 11, 'P');
  r.set(6, 10, 'D');
  return r.def('crystal');
}

/** A moving platform right under the spawn point: the player drops onto it and rides. */
export function platformRoom(vertical: boolean): LevelDef {
  const r = new Room(30, 14);
  r.rect(0, 12, 29, 13);
  // (tx + ty) % 4 === 0 → the deck starts at its home end, right under the spawn
  r.set(10, 6, vertical ? 'M' : 'm');
  r.set(11, 5, 'P');
  return r.def(vertical ? 'platV' : 'platH');
}

/** '%' pillar with a toggle in front of it and '&' blocks beyond. */
export function switchRoom(): LevelDef {
  const r = new Room(40, 14);
  r.rect(0, 12, 39, 13);
  r.set(2, 11, 'P');
  r.set(9, 11, 'k');
  r.vline(14, 8, 11, '%');
  r.vline(20, 8, 11, '&');
  return r.def('switch');
}

/** Tide room: no way up, so the flood always catches the player. */
export function tideRoom(): LevelDef {
  const r = new Room(20, 12);
  r.rect(0, 8, 19, 11);
  r.set(10, 7, 'P');
  return r.def('tide', { tide: true, baseY: 8 });
}

/** Water pool between two banks. */
export function waterRoom(): LevelDef {
  const r = new Room(40, 14);
  r.rect(0, 12, 39, 13);
  r.rect(10, 9, 20, 11, 'W');
  r.hline(10, 20, 9, '~');
  r.rect(0, 9, 9, 13);
  r.rect(21, 9, 39, 13);
  r.set(3, 8, 'P');
  return r.def('water');
}

/**
 * A 1-wide updraft column (x = 9) rising from a spike bed: spikes at columns
 * 8 and 10 on row 20, rock beneath, the 'z' marker in the middle. The column
 * reaches up to row 8; P floats at row 4 so the player falls ~4 tiles before
 * its centre enters the column top.
 */
export function updraftRoom(): LevelDef {
  const r = new Room(20, 24);
  r.rect(0, 20, 19, 23);
  r.set(8, 20, '^').set(10, 20, '^').set(9, 20, 'z');
  r.set(9, 4, 'P');
  return r.def('updraft');
}

/** One-way ledge, a spring and a crumble bridge. */
export function furnitureRoom(): LevelDef {
  const r = new Room(40, 14);
  r.rect(0, 12, 39, 13);
  r.set(2, 11, 'P');
  r.hline(6, 9, 9, '=');
  r.set(14, 11, 'S');
  r.hline(20, 24, 12, 'X');
  return r.def('furniture');
}

/** Busy room used by the determinism test: every foe, moving platforms, a saw, a checkpoint. */
export function busyRoom(): LevelDef {
  const r = new Room(60, 20);
  r.rect(0, 18, 59, 19);
  r.set(2, 17, 'P');
  r.set(12, 17, 'w').set(14, 17, 'h').set(20, 13, 'f').set(26, 17, 't').set(34, 13, 'c');
  r.hline(10, 13, 14).set(11, 13, 'o').set(12, 13, 'o');
  r.set(16, 13, 'm');
  r.set(30, 10, 'M');
  r.set(40, 15, 's');
  r.set(22, 17, 'S');
  r.set(36, 17, 'C');
  r.set(44, 17, 'D');
  r.set(48, 17, 'k');
  r.vline(52, 14, 17, '%').vline(55, 14, 17, '&');
  r.hline(24, 28, 12, 'X');
  r.set(5, 17, 'o').set(6, 17, 'o').set(18, 17, 'R');
  r.set(28, 17, '^');
  r.set(57, 17, 'G');
  return r.def('busy', { spikers: [[42, 17]] });
}

/** Flat floor with a checkpoint pillar at column 10 between P (column 2) and G (column 37). */
export function checkpointRoom(): LevelDef {
  const r = new Room(40, 14);
  r.rect(0, 12, 39, 13);
  r.set(2, 11, 'P').set(10, 11, 'C').set(37, 11, 'G');
  return r.def('checkpoint');
}

/**
 * Flat floor that turns into a spike bed from column 12 to the far wall, no
 * goal: holding RIGHT dies by spikes (one contact outside assist mode, three
 * in it), never by a pit.
 */
export function spikeRoom(): LevelDef {
  const r = new Room(60, 14);
  r.rect(0, 12, 59, 13);
  r.hline(12, 59, 11, '^');
  r.set(2, 11, 'P');
  return r.def('spikes');
}

/**
 * A floor saw sweeping the standing row over the spawn: no rock to its left
 * until the map edge, a pillar at column 9 to its right, so it patrols
 * columns 0..8 and passes through a player who stands still at column 2.
 */
export function sawRoom(): LevelDef {
  const r = new Room(30, 14);
  r.rect(0, 12, 29, 13);
  r.vline(9, 10, 11);
  r.set(2, 11, 'P');
  r.set(6, 11, 's');
  return r.def('saw');
}

/** A turret eight tiles from the spawn (awake: inside FOE_WAKE_GAP, and inside TURRET_RANGE): standing still gets shot. */
export function turretRoom(): LevelDef {
  const r = new Room(30, 14);
  r.rect(0, 12, 29, 13);
  r.set(2, 11, 'P');
  r.set(10, 11, 't');
  return r.def('turret');
}

/** A walker six tiles to the right of the spawn, facing it: it walks into a player who stands still. */
export function walkerRoom(): LevelDef {
  const r = new Room(30, 14);
  r.rect(0, 12, 29, 13);
  r.set(2, 11, 'P');
  r.set(8, 11, 'w');
  return r.def('walker');
}

/**
 * A bubble (P5-5) hanging in the standing row six tiles right of the spawn, no
 * goal: holding RIGHT walks into its side, which kills outside assist mode.
 * Mirrors `sideRoom` of test/sim/bubble.test.ts.
 */
export function bubbleRoom(): LevelDef {
  const r = new Room(40, 14);
  r.rect(0, 12, 39, 13);
  r.set(2, 11, 'P');
  r.set(8, 11, 'b');
  return r.def('bubble');
}

/**
 * A toggle at column 10 with '&' blocks (passable at the start) filling
 * columns 8..9 of the standing row and the two rows above it. Dashing through
 * the toggle flips the switch while the player's body is still inside column
 * 9; the block turns solid, the one-tile nudge cannot free the player, and the
 * switch closes on them (cause 'switch').
 */
export function crushRoom(): LevelDef {
  const r = new Room(40, 14);
  r.rect(0, 12, 39, 13);
  r.set(2, 11, 'P');
  r.set(10, 11, 'k');
  r.rect(8, 9, 9, 11, '&');
  return r.def('crush');
}

/**
 * A toggle at column 6, a checkpoint at column 12 and a 6-tile pit at 16..21
 * on a flat floor, with a '%' and a '&' pillar past the pit to read the
 * polarity from: dash through the toggle, take the checkpoint in the flipped
 * polarity, fall into the pit — the respawn must come back flipped.
 */
export function polarityRoom(): LevelDef {
  const r = new Room(40, 14);
  r.rect(0, 12, 39, 13);
  for (let x = 16; x <= 21; x++) { r.set(x, 12, '.'); r.set(x, 13, '.'); }
  r.set(2, 11, 'P').set(6, 11, 'k').set(12, 11, 'C').set(37, 11, 'G');
  r.vline(30, 8, 11, '%').vline(34, 8, 11, '&');
  return r.def('polarity');
}
