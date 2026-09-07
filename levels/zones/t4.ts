/**
 * t4 — 소금 굴뚝 / SALT CHIMNEY (tidepool). The tier's vertical zone (P2-10):
 * a 44-wide tower climbed bottom to top through three 4-wide wall-jump shafts,
 * each against a tower wall with a single pillar for the other side, with a
 * tide pool on every shelf between the climbs as the safety net.
 *
 * Every shaft reads the same way, so the lesson of t3 carries: walk in through
 * the doorway, the spring lifts you to the first one-way rest ledge, wall jumps
 * take you to the second (its checkpoint) and over the pillar top onto the
 * shelf. Left, right, left: the shelves alternate, so a missed exit drops you
 * into the pool below, never further than the last checkpoint.
 *
 * Shards are the side routes only: the wall side of each shaft above its exit
 * (one more kick off the tower wall), a dash perch over each pool and the relic
 * tower on the summit deck. Checkpoints stand at most 32 tiles apart along the
 * climb (vertical-zone rule: Manhattan distance, bottom to top).
 */
import { room } from '../dsl.js';

const m = room(44, 66).tower();       // walls x 0..1 and 42..43, base rows 62..65
const B = 62;                          // base floor top row; the player stands on row 61

// --- base yard
m.ent('P', 21, B - 1);

// --- shaft A (left): interior x 2..5 against the tower wall, pillar x 6..7; floor is the base
//     spring → rest ledge 8 up → wall jumps → second rest ledge (checkpoint) → over the pillar top at row 44
m.shaft(2, 44, B, { leftTop: 0, rightTop: 44, floorDepth: 4 });
m.ent('S', 3, B - 1);
m.owp(2, 5, B - 8);
m.owp(2, 5, B - 13);
m.ent('C', 4, B - 14);
m.shards([[2, 41], [3, 41]]);          // wall side, three above the exit: one more kick off the tower wall

// --- shelf A and pool 1: the shelf is one slab (rows 44..49) with the pool carved into it
m.ground(6, 14, 44, 6);
m.water(15, 26, 45, 47);
m.ground(15, 26, 48, 2);
m.ground(27, 41, 44, 6);
m.ent('C', 29, 43);
m.plat(20, 21, 40);                    // dash perch over the pool: a double jump off the left bank
m.shards([[20, 39], [21, 39]]);
m.ent('f', 23, 41);

// --- shaft B (right): interior x 38..41 against the tower wall, pillar x 36..37; floor is the right bank
m.shaft(38, 26, 44, { leftTop: 26, rightTop: 0, floorDepth: 6 });
m.ent('S', 40, 43);
m.owp(38, 41, 36);
m.owp(38, 41, 31);
m.ent('C', 39, 30);
m.shards([[40, 23], [41, 23]]);

// --- shelf B and pool 2, running left
m.ground(29, 37, 26, 6);
m.water(17, 28, 27, 29);
m.ground(17, 28, 30, 2);
m.ground(2, 16, 26, 6);
m.ent('C', 31, 25);
m.ent('C', 10, 25);
m.plat(22, 23, 22);
m.shards([[22, 21], [23, 21]]);
m.ent('f', 20, 23);

// --- shaft C (left again): interior x 2..5, pillar x 6..7; floor is the left bank
m.shaft(2, 8, 26, { leftTop: 0, rightTop: 8, floorDepth: 6 });
m.ent('S', 3, 25);
m.owp(2, 5, 18);
m.owp(2, 5, 13);
m.ent('C', 2, 12);                     // on the wall side: shaft A's checkpoint owns column 4 (tools/novice.ts reads checkpoints by column)
m.shards([[2, 5], [3, 5]]);

// --- summit deck: the pillar top continues right; a walker patrols it; the relic tower stands four up
m.ground(6, 30, 8, 4);
m.ent('w', 14, 7);
m.ent('G', 20, 7);
m.plat(26, 28, 4);
m.ent('R', 27, 3);
m.shards([[26, 3], [28, 3]]);

export const t4 = m.def({
  id: 't4', name: '소금 굴뚝', en: 'SALT CHIMNEY', biome: 'tidepool', par: 90, seed: 37,
  hint: '탑을 오른다 — 통로에서는 벽에 붙은 순간 {jump}, 떨어지면 물웅덩이가 받아 준다',
});
