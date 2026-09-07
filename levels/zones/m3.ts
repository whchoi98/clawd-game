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
 * Rev 1 (P5-5): three bubbles ('b'). One hangs over the start yard a tile right
 * of the dash-up perch, five rows over the floor — walk off the perch onto it
 * (or double-jump beside it and hold {stomp}) and the launch passes a shard
 * five rows up; a miss drops you back onto the yard. The other two are a shard
 * stair up the left wall of the chaser room, (81,23) and (83,20): the first
 * rung hangs three rows over the standing row against the wall, right under the
 * corridor exit, so whoever steps off the exit and falls straight down lands on
 * it from above — a pop and a bounce, never a side hit, the drop being nineteen
 * rows; the second rung is two columns right and three rows up. Have {jump}
 * held BEFORE the landing (held, the launch rises ≈ 72 units, released ≈ 55;
 * the second rung's top is 48 above the first's, up to 68 over the bobs — a
 * press after the pop spends the refilled air jump and cuts the launch) and
 * drift over onto the second; its launch passes a shard five rows up, in reach
 * of the held launch only. From the floor the stair starts with a double jump
 * beside the first rung and {stomp} held over it. A walker on the floor never
 * touches a rung (the lower one's bob envelope ends nine units over a standing
 * head), a runner who jumps off the exit passes far over both, and the whole
 * stair — rungs, rider and the launch apex — keeps more than 140 units of
 * horizontal gap to the chaser's box at (93,13): it wakes only within 140 units
 * on both axes, so the room floor is out of its vertical range and the stair
 * out of its horizontal one (a rider centred on the upper rung has 147; the
 * wind-up needs 130 units centre to centre, i.e. an overshoot past column 85).
 * Probed on the sim (Phase 5 C, fix round 1): the drop entry and the floor
 * entry both chain to the shard with the chaser idle throughout, a
 * right-holding walker crossing the room floor meets no bubble, and the ride
 * up updraft 2 is the rev 0 well, untouched. The well itself carries no bubble:
 * every rung position inside it met the arc of a plain jump off shelf 1 lifted
 * by the column (202 novice deaths in one cell before this fix).
 *
 * The well of the second column is capped by a rock lintel and the roof runs
 * over the whole shelf, so no dash-up climb gets above the corridor. Shards are
 * side routes: the dash-up perch at the start, the bubble perch beside it, two
 * over the yard off the first column's top, two over shelf 1 off the second's,
 * the '&' ledge, beside the relic, over the shard stair in the chaser room.
 * Seven checkpoints, every neighbour pair within 32 columns.
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
//     the bubble perch (P5-5): five rows over the yard floor, a tile right of the dash-up perch (walk off it onto the
//     bubble), a shard five rows over the bubble inside the launch's reach; left of the column, clear of the checkpoint
m.ent('b', 10, F - 6);
m.ent('o', 10, F - 11);

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
//     the shard stair (P5-5): two bubbles up the room's left wall, (81,23) and (83,20) — two columns and three rows apart,
//     so the held launch off the lower one (≈ 72 units) clears the upper one's top and the rider drifts over onto it; the
//     lower rung hangs under the corridor exit, where a straight drop lands on it from above (pop and bounce) and a
//     walker's head passes nine units under its bob; the shard five rows over the upper rung, inside its launch's reach.
//     Everything stays left of column 84, more than 140 units from the chaser's box: it never wakes for the stair.
m.ent('b', 81, F - 3);
m.ent('b', 83, F - 6);
m.ent('o', 83, F - 11);

// --- act 4: updraft 3 flush with the room's floor edge (column rows 15..27) up to the goal shelf
m.ground(99, 102, F + 2);
m.spikes(100, 102, F + 1);
m.ent('z', 99, F + 1);
m.ground(103, 115, F - 9);
m.ent('C', 104, F - 10);
m.ent('G', 112, F - 10);

export const m3 = m.def({
  id: 'm3', name: '바람의 첨탑', en: 'WIND SPIRE', biome: 'summit', par: 110, seed: 251, rev: 1,
  hint: '상승기류는 꼭대기에서 옆으로 빠져나온다 · 토글을 {dash} 대시로 켜면 관문이 뒤바뀐다 · 유물을 지키는 추격자는 {dash} 대시로 뚫는다',
});
