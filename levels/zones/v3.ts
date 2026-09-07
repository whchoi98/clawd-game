/**
 * v3 — 메아리의 정점 / ECHO SUMMIT (voidreef). The finale: every mechanic in
 * one climb.
 *
 * Act 1 crumble bridge and a turret · Act 2 a switch gate, a '&' bridge and a
 * floor saw · Act 3 the wall-jump shaft with a spring and a rescue crystal ·
 * Act 4 a chaser, then an updraft to the summit shelf (relic off to the left)
 * · Act 5 a crystal chain down onto the goal.
 *
 * P2-8 (rev 1): seven checkpoints, one before every act and every hot spot
 * of the novice heat map (crumble bridge, gate, saw lane, shaft, shelf,
 * updraft pit, crystal chain); the shelf's armoured walker moved away from
 * the shaft exit; ten shards off the line — dash-up perches at the start and
 * over the saw, the shaft's taller wall top, beside the relic, up from the
 * first crystal of the chain.
 */
import { room } from '../dsl.js';

const m = room(120, 30);
const F = 26;

// --- Act 1: start (a perch six up), checkpoint, crumble bridge over the void, a turret behind cover
m.ground(0, 10, F);
m.ent('P', 3, F - 1);
m.plat(6, 7, F - 7);
m.shards([[6, F - 8], [7, F - 8]]);
m.ent('C', 10, F - 1);
m.crumble(11, 16, F);
m.ground(17, 30, F);
m.block(21, 21, F - 3, F - 1);
m.ent('t', 25, F - 1);

// --- Act 2: toggle → checkpoint → '%' gate → '&' bridge over spikes → checkpoint → floor saw with a perch above
m.ent('k', 29, F - 1);
m.ground(31, 33, F);
m.ent('C', 31, F - 1);
m.switchA(32, 33, F - 6, F - 1);
m.ground(34, 40, F + 3);
m.spikes(34, 40, F + 2);
m.switchB(34, 40, F);
m.ground(41, 55, F);
m.ent('C', 43, F - 1);
m.block(46, 46, F - 2, F - 1);
m.ent('s', 48, F - 1);
m.block(52, 52, F - 2, F - 1);
m.plat(48, 50, F - 8);
m.shards([[48, F - 9], [50, F - 9]]);
m.ent('h', 54, F - 1);

// --- Act 3: checkpoint at the doorway, then the shaft — interior x 60..63, doorway rows 24..25,
//     exit right onto the shelf at row 11; the left wall goes on to row 8 with two shards on top
m.ground(56, 57, F);
m.ent('C', 56, F - 1);
m.shaft(60, 11, F, { leftTop: 8 });
m.ent('S', 61, F - 1);
m.owp(60, 63, F - 8);
m.ent('D', 62, F - 12);
m.shards([[58, 7], [59, 7]]);

// --- Act 4: summit shelf with a checkpoint and a chaser; checkpoint again before the updraft pit.
// The column stands flush with the shelf edge so stepping off drops into it; spikes only beyond.
m.ground(66, 82, F - 15);
m.ent('C', 68, F - 16);
m.ent('c', 74, F - 18);
m.ent('C', 82, F - 16);
m.ground(83, 86, F - 13);
m.spikes(84, 86, F - 14);
m.ent('z', 83, F - 14);
m.plat(78, 79, 3);                            // relic perch: drift left off the top of the updraft
m.ent('R', 78, 2);
m.shards([[77, 2], [80, 2]]);
m.block(87, 95, 6, 29);
m.ent('C', 89, 5);
m.ent('f', 92, 2);

// --- Act 5: climax — a crystal chain down over the last spike field onto the goal;
//     two shards up and right of the first crystal, the fall meets the second
m.ground(96, 107, 16);
m.spikes(96, 107, 15);
m.ent('D', 99, 9);
m.ent('D', 104, 11);
m.shards([[100, 5], [102, 3]]);
m.ground(108, 119, 13);
m.ent('G', 115, 12);

export const v3 = m.def({
  id: 'v3', name: '메아리의 정점', en: 'ECHO SUMMIT', biome: 'voidreef', par: 120, seed: 181,
  hint: '마지막 층이다 — 지금까지 배운 모든 것을 한 번에',
  spikers: [[19, F - 1], [78, F - 16]],
  rev: 1,
});
