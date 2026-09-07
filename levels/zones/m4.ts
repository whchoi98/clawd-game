/**
 * m4 — 정점 승강 / SUMMIT ASCENT (summit). The tower's last zone and the
 * tier's vertical zone: a 44-wide tower in four acts, climbed bottom to top.
 *
 * Act 1 a four-wide wall-jump shaft against the right wall (spring, two one-way
 * rest ledges, exit over the pillar top) · Act 2 a vertical platform from
 * shelf 1 up to shelf 2 · Act 3 three updraft stages, each column standing on
 * a shelf and rising to the row of the next shelf a short drift to the side
 * (the v4 pattern: a missed exit falls back onto rock) · Act 4 the apex ledge
 * and a two-crystal chain across the well to the summit deck at the top left,
 * the relic on a spire over the apex.
 *
 * Every landing yard is bare rock: the summit has no spikes at all. Shards are
 * side routes: a dash-up perch over the base, the wall side of the shaft above
 * its exit, the air beside the lift's top, the far side of every column top
 * (drift the wrong way, fall back, ride again). Seven checkpoints stand at most
 * 32 tiles apart along the climb, none sharing a column.
 */
import { room } from '../dsl.js';

const m = room(44, 80).tower();       // walls x 0..1 and 42..43, base rows 76..79
const B = 76;                          // base floor top row; the player stands on row 75

// --- base yard: a dash-up perch over the left half
m.ent('P', 26, B - 1);
m.plat(10, 11, B - 6);
m.shards([[10, B - 7], [11, B - 7]]);

// --- act 1: shaft A (right): interior x 38..41 against the tower wall, pillar x 36..37; floor is the base
//     spring → rest ledge 8 up → wall jumps → second rest ledge (checkpoint) → over the pillar top at row 60
m.shaft(38, 60, B, { leftTop: 60, rightTop: 0, floorDepth: 4 });
m.ent('S', 39, B - 1);
m.owp(38, 41, 68);
m.owp(38, 41, 63);
m.ent('C', 40, 62);
m.shards([[40, 57], [41, 57]]);        // wall side, three above the exit: one more kick off the tower wall

// --- shelf 1 (rows 60..62) spans the tower to the pillar; checkpoints at the exit and the lift, a flyer between
m.ground(2, 35, 60, 3);
m.ent('C', 30, 59);
m.ent('C', 18, 59);
m.ent('f', 26, 55);

// --- act 2: the lift rides x 20..22 between rows 50 and 58; jump off its top onto shelf 2 to the left
m.ent('M', 20, 50);
m.shards([[23, 49], [23, 47]]);        // in the air right of the ride's top: hop off, fall back to shelf 1, ride again

// --- shelf 2 (rows 48..50): checkpoint; updraft 1 stands at its right end (column rows 35..47)
m.ground(2, 17, 48, 3);
m.ent('C', 8, 47);
m.ent('z', 17, 47);
m.shards([[15, 37], [16, 37]]);        // left of the column top: the exit is to the right

// --- shelf 3 (rows 35..37): checkpoint, a flyer; updraft 2 at its right end (column rows 22..34)
m.ground(18, 30, 35, 3);
m.ent('C', 22, 34);
m.ent('f', 25, 30);
m.ent('z', 30, 34);
m.shards([[30, 19], [30, 17]]);        // straight up from the column top: jump, fall back into the column

// --- shelf 4 (rows 22..24) against the right wall: checkpoint, a turret at the far end; updraft 3 at its left end (column rows 9..21)
m.ground(31, 41, 22, 3);
m.ent('C', 34, 21);
m.ent('t', 40, 21);
m.ent('z', 31, 21);
m.shards([[31, 7], [31, 5]]);

// --- apex ledge (rows 9..11) left of the last column; the relic spire five above it (a dash-up)
m.ground(20, 30, 9, 3);
m.ent('C', 26, 8);
m.plat(27, 28, 3);
m.ent('R', 27, 2);

// --- act 4: the crystal chain across the well to the summit deck (rows 3..6) and the goal
m.ent('D', 17, 6);
m.ent('D', 14, 3);
m.ground(2, 11, 3, 4);
m.ent('G', 6, 2);

export const m4 = m.def({
  id: 'm4', name: '정점 승강', en: 'SUMMIT ASCENT', biome: 'summit', par: 130, seed: 271,
  hint: '탑의 끝이다 — 통로는 벽에 붙은 순간 {jump}, 상승기류는 꼭대기에서 옆으로, 마지막 수정 다리는 {dash} 대시로 건넌다',
});
