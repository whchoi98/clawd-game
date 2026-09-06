/**
 * s3 — 폭풍의 눈 / EYE OF THE STORM (stormspire). Turrets, saws and a chaser.
 *
 * Saws patrol between rock: a floor saw sweeps the standing row between two
 * short pillars (jump over it), a saw pinned between two floating anchors
 * runs vertically (time the pass). Turrets are stompable (two hits); the
 * chaser is not — dash into it or dodge its charge.
 */
import { room } from '../dsl.js';

const m = room(118, 24);
const F = 20;

// --- start yard
m.ground(0, 14, F);
m.ent('P', 3, F - 1);
m.shards([[7, F - 1], [10, F - 1]]);

// --- turret intro: one turret behind a short cover pillar, an armoured walker on patrol
m.ground(15, 30, F);
m.block(17, 17, F - 3, F - 1);
m.ent('t', 21, F - 1);
m.shards([[19, F - 3], [23, F - 3]]);

// --- floor saws between pillars: two lanes, jump each on its return
m.ground(31, 54, F);
m.block(31, 31, F - 2, F - 1);
m.block(40, 40, F - 2, F - 1);
m.ent('s', 35, F - 1);
m.ent('s', 45, F - 1);
m.shards([[33, F - 4], [37, F - 4], [43, F - 4], [47, F - 4]]);

// --- chaser room with a vertical saw gate at its door
m.ground(55, 80, F);
m.ent('C', 56, F - 1);
m.block(59, 59, F - 7, F - 7);
m.block(61, 61, F - 7, F - 7);
m.ent('s', 60, F - 7);                       // anchored left and right → runs vertically to the floor
m.shards([[59, F - 10], [61, F - 10]]);
m.ent('c', 70, F - 3);
m.shards([[66, F - 3], [68, F - 3], [72, F - 3], [74, F - 3], [76, F - 3], [78, F - 3]]);

// --- turret nest: two turrets on rising ledges — stomp them on the way up
m.ground(81, 100, F);
m.plat(84, 88, F - 4);
m.ent('t', 86, F - 5);
m.shards([[84, F - 5], [88, F - 5]]);
m.plat(92, 96, F - 8);
m.ent('t', 94, F - 9);
m.shards([[92, F - 9], [96, F - 9]]);

// --- relic perch above the nest, a flyer drifting near it
m.plat(97, 99, F - 13);
m.ent('R', 98, F - 14);
m.ent('f', 96, F - 12);

// --- climax: a bounded floor saw and a chaser standing guard at the goal
m.ground(101, 117, F);
m.block(102, 102, F - 2, F - 1);
m.ent('s', 104, F - 1);
m.block(110, 110, F - 2, F - 1);
m.shards([[105, F - 4], [107, F - 4], [109, F - 4]]);
m.ent('c', 113, F - 3);
m.ent('G', 116, F - 1);

export const s3 = m.def({
  id: 's3', name: '폭풍의 눈', en: 'EYE OF THE STORM', biome: 'stormspire', par: 90, seed: 79,
  hint: '포탑은 공중에서 {stomp} 스톰프로 부수고 · 톱날은 리듬을 읽고 · 돌진하는 적은 {down} 웅크려 피한다',
  // the spiker patrols the 15..30 floor; it starts at 24 so a phone's spawn frame
  // never hides it under the DASH thumb (moved before SIM_VERSION 2 shipped: rev stays 0)
  spikers: [[24, F - 1]],
});
