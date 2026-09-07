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
 * five rows up; a miss drops you back onto the yard. Two more hang up the
 * spiked side of the second column's well — widened from three spike columns
 * to four (32..35) to make room for them — the bubble ladder between the
 * updrafts: (33,15) and (35,12), two columns and three rows apart, so the
 * launch off the lower one rises past the upper one's side with a clear tile
 * between before the rider drifts over onto it. The column lifts anyone who
 * jumps off shelf 1 into the well: come down onto the lower bubble from that
 * lift (or ride the column and step off onto it) and keep {jump} held through
 * the launch — held it rises ≈ 72 units and clears the upper bubble with room,
 * released ≈ 55 and barely. The launch off the upper bubble alone stops short
 * of shelf 2 (feet ≈ 114..132 against the floor top at 112): the bounce refills
 * the air jump, so {jump} again near the apex (feet ≈ 82, the head three units
 * under the lintel) or a dash-up carries you onto the shelf at column 36.
 * Straight down is still the spikes; a tile left is the column; nothing hangs
 * over either bubble, so a launch straight up meets only air and falls back
 * onto the spikes. No bubble hangs over shelf 1 (a launch plus two air jumps
 * and a dash-up from there would), every bubble stays a tile clear of the
 * column (a rider's box never touches one) and out of the phone spawn frame.
 * Probed on the sim (Phase 5 C, task 1-B): the ride up the column exits onto
 * shelf 2 without touching a bubble, the ladder chains with {jump} held and an
 * air jump off the upper launch, and a full-speed jump off shelf 1 into the
 * well ends on the spikes, not a bubble — only a {jump} tap of four ticks or
 * less (≤ 33 ms) from a tile before the edge arcs low enough to meet the upper
 * bubble's underside.
 *
 * The well of the second column is capped by a rock lintel and the roof runs
 * over the whole shelf, so no dash-up climb gets above the corridor. Shards are
 * side routes: the dash-up perch at the start, the bubble perch beside it, two
 * over the yard off the first column's top, two over shelf 1 off the second's,
 * the '&' ledge, beside the relic. Seven checkpoints, every neighbour pair
 * within 32 columns.
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

// --- act 1b: updraft 2 in a four-column well between the shelves (column rows 6..18 at 31, spikes 32..35), a lintel over
//     the well; shards off its top over shelf 1
m.ground(31, 35, 19);
m.spikes(32, 35, 18);
m.ent('z', 31, 18);
m.block(31, 35, 0, 3);
m.shards([[30, 4], [29, 3]]);
//     the well ladder (P5-5): two bubbles up the spiked side of the well, (33,15) and (35,12) — three rows apart and TWO
//     columns apart, so the launch off the lower one rises past the upper one's side with a clear tile between and the
//     rider drifts over onto it; both a tile clear of the column at 31. The column lifts a jump off shelf 1 — come down
//     onto the lower bubble from that lift, or ride the column and step off onto it. The launch off the upper bubble
//     stops just short of shelf 2: the refilled air jump (or a dash-up) near the apex steps onto it. A miss falls onto
//     the spikes or drifts left into the column; nothing hangs over either bubble, and the lintel caps the well.
m.ent('b', 33, 15);
m.ent('b', 35, 12);

// --- act 2: shelf 2 and the switch corridor under one roof (rows 1..6 open): k → '%' gate → '&' ledge → k → '&' gate → turret
m.ground(36, 80, 7);
m.plat(36, 80, 0);
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
  id: 'm3', name: '바람의 첨탑', en: 'WIND SPIRE', biome: 'summit', par: 110, seed: 251, rev: 1,
  hint: '상승기류는 꼭대기에서 옆으로 빠져나온다 · 토글을 {dash} 대시로 켜면 관문이 뒤바뀐다 · 유물을 지키는 추격자는 {dash} 대시로 뚫는다',
});
