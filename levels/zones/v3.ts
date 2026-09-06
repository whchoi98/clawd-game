/**
 * v3 — 메아리의 정점 / ECHO SUMMIT (voidreef). The finale: every mechanic in
 * one climb, two checkpoints.
 *
 * Act 1 crumble bridge and a turret · Act 2 a switch gate, a '&' bridge and a
 * floor saw · Act 3 the wall-jump shaft with a spring and a rescue crystal ·
 * Act 4 a chaser, then an updraft to the summit shelf (relic off to the left)
 * · Act 5 a crystal chain down onto the goal.
 */
import { room } from '../dsl.js';

const m = room(120, 30);
const F = 26;

// --- Act 1: start, crumble bridge over the void, a turret behind cover
m.ground(0, 10, F);
m.ent('P', 3, F - 1);
m.shards([[6, F - 1], [8, F - 1]]);
m.crumble(11, 16, F);
m.arc(11, F - 1, 16, F - 1, 4, 'o', 2.5);
m.ground(17, 30, F);
m.block(21, 21, F - 3, F - 1);
m.ent('t', 25, F - 1);
m.shards([[23, F - 3], [27, F - 3]]);

// --- Act 2: toggle → '%' gate → '&' bridge over spikes → checkpoint → floor saw
m.ent('k', 29, F - 1);
m.switchA(32, 33, F - 6, F - 1);
m.ground(31, 33, F);
m.ground(34, 40, F + 3);
m.spikes(34, 40, F + 2);
m.switchB(34, 40, F);
m.shards([[35, F - 2], [37, F - 2], [39, F - 2]]);
m.ground(41, 55, F);
m.ent('C', 43, F - 1);
m.block(46, 46, F - 2, F - 1);
m.ent('s', 48, F - 1);
m.block(52, 52, F - 2, F - 1);
m.shards([[47, F - 4], [49, F - 4], [51, F - 4]]);
m.ent('h', 54, F - 1);

// --- Act 3: the shaft — interior x 60..63, doorway rows 24..25, exit right onto the shelf at row 11
m.ground(56, 57, F);
m.shaft(60, 11, F, { leftTop: 8 });
m.ent('S', 61, F - 1);
m.owp(60, 63, F - 8);
m.ent('D', 62, F - 12);
m.shards([[61, F - 3], [62, F - 3], [61, F - 6], [62, F - 6], [60, F - 9], [63, F - 9], [61, F - 14], [62, F - 14]]);

// --- Act 4: summit shelf with the second checkpoint and a chaser; updraft pit to the high shelf.
// The column stands flush with the shelf edge so stepping off drops into it; spikes only beyond.
m.ground(66, 82, F - 15);
m.ent('C', 68, F - 16);
m.ent('c', 74, F - 18);
m.shards([[71, F - 17], [77, F - 17]]);
m.ground(83, 86, F - 13);
m.spikes(84, 86, F - 14);
m.ent('z', 83, F - 14);
m.shards([[83, F - 18], [83, F - 22]]);
m.plat(78, 79, 3);                            // relic perch: drift left off the top of the updraft
m.ent('R', 78, 2);
m.block(87, 95, 6, 29);
m.shards([[89, 4], [91, 4], [93, 4]]);
m.ent('f', 92, 2);

// --- Act 5: climax — a crystal chain down over the last spike field onto the goal
m.ground(96, 107, 16);
m.spikes(96, 107, 15);
m.ent('D', 99, 9);
m.ent('D', 104, 11);
m.shards([[97, 10], [101, 9]]);
m.ground(108, 119, 13);
m.ent('G', 115, 12);

export const v3 = m.def({
  id: 'v3', name: '메아리의 정점', en: 'ECHO SUMMIT', biome: 'voidreef', par: 120, seed: 181,
  hint: '마지막 층이다 — 지금까지 배운 모든 것을 한 번에',
  spikers: [[19, F - 1], [70, F - 16]],
});
