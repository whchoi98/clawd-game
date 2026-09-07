/**
 * m3 — 바람의 첨탑 / WIND SPIRE (summit). Updraft staircases, a roofed
 * switch corridor with two toggles, and a chaser guarding the relic.
 *
 * Act 1 two updraft stages: each column stands flush with the bank edge (the
 * v2 pattern — step off and you are lifted), spikes only beyond it, and the
 * next shelf a short drift to the right of the column top · Act 2 the switch
 * corridor: roofed, so its two gates are the only way through — dash a toggle
 * to open the '%' gate, dash the second to open the '&' gate — with a '&' ledge
 * between the toggles that only exists between the flips, and a turret at the
 * exit · Act 3 the drop into the chaser room: the chaser floats eleven rows
 * over the floor and wakes only for whoever climbs to the relic perch · Act 4 a
 * third updraft to the goal shelf.
 *
 * The well of the second column is capped by a rock lintel and the roof runs
 * over the whole shelf, so no dash-up climb gets above the corridor. Shards are
 * side routes: the dash-up perch at the start, two over the yard off the first
 * column's top, two over shelf 1 off the second's, the '&' ledge, beside the
 * relic. Seven checkpoints, every neighbour pair within 32 columns.
 */
import { room } from '../dsl.js';

const m = room(116, 30);
const F = 26;

// --- start yard: a dash-up perch, checkpoint at the edge
m.ground(0, 12, F);
m.ent('P', 3, F - 1);
m.plat(8, 9, F - 7);
m.shards([[8, F - 8], [9, F - 8]]);
m.ent('C', 11, F - 1);

// --- act 1a: updraft 1 flush with the yard edge (column rows 15..27), spikes beyond; shards off its top over the yard
m.ground(13, 16, F + 2);
m.spikes(14, 16, F + 1);
m.ent('z', 13, F + 1);
m.shards([[12, 12], [11, 12]]);

// --- shelf 1 (top row 16): checkpoint, a flyer high over the run
m.ground(17, 30, 16);
m.ent('C', 19, 15);
m.ent('f', 24, 10);

// --- act 1b: updraft 2 in a well between the shelves (column rows 6..18), a lintel over the well; shards off its top over shelf 1
m.ground(31, 34, 19);
m.spikes(32, 34, 18);
m.ent('z', 31, 18);
m.block(31, 34, 0, 3);
m.shards([[30, 4], [29, 3]]);

// --- act 2: shelf 2 and the switch corridor under one roof (rows 1..6 open): k → '%' gate → '&' ledge → k → '&' gate → turret
m.ground(35, 80, 7);
m.plat(35, 80, 0);
//     each toggle stands four or five tiles before its gate, so a runner dashes it before the gate reads as a wall
m.ent('C', 37, 6);
m.ent('C', 51, 6);
m.ent('k', 53, 6);
m.switchA(57, 58, 1, 6);
m.switchB(59, 60, 3);
m.shards([[59, 2], [60, 2]]);
m.ent('k', 62, 6);
m.switchB(67, 68, 1, 6);
m.ent('C', 70, 6);
m.ent('t', 77, 6);

// --- act 3: the chaser room, nineteen rows down (a runner who jumps off the exit lands past column 90, so the checkpoint
//     waits at 91); a step and the relic perch, the chaser twelve rows over the floor and ten columns from the drop — out of its wake range
m.ground(81, 98, F);
m.ent('C', 91, F - 1);
m.plat(92, 93, F - 4);
m.plat(96, 98, F - 8);
m.ent('R', 97, F - 9);
m.shards([[96, F - 9], [98, F - 9]]);
m.ent('c', 93, F - 13);

// --- act 4: updraft 3 flush with the room's floor edge (column rows 15..27) up to the goal shelf
m.ground(99, 102, F + 2);
m.spikes(100, 102, F + 1);
m.ent('z', 99, F + 1);
m.ground(103, 115, F - 9);
m.ent('C', 104, F - 10);
m.ent('G', 112, F - 10);

export const m3 = m.def({
  id: 'm3', name: '바람의 첨탑', en: 'WIND SPIRE', biome: 'summit', par: 110, seed: 251,
  hint: '상승기류는 꼭대기에서 옆으로 빠져나온다 · 토글을 {dash} 대시로 켜면 관문이 뒤바뀐다 · 유물을 지키는 추격자는 {dash} 대시로 뚫는다',
});
