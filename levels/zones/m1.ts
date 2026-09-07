/**
 * m1 — 얼음 회랑 / FROST GALLERY (summit). The fourth tier opens above the
 * clouds with the ice-shelf lesson: one-way ledges ('=') read as frozen
 * shelves you pass through from below, and a stack of dash crystals against a
 * cliff face is a ladder — jump, touch, dash up, touch, dash up.
 *
 * Act 1 the frost hall: a low hall roofed with ice shelves; the floor dead-ends
 * at a three-tile step, so the way on is up through the ceiling (a double jump)
 * onto the shelves, which are the upper floor · Act 2 the crystal ladder: two
 * crystals up a nine-tile cliff, a hopper on the bank below · Act 3 the cliff
 * gallery with a flyer · Act 4 the ice descent: three one-way shelves stepping
 * down over a spike bed (a shelf you dropped past can be climbed back through),
 * the relic on a perch over the first shelf · Act 5 a walker behind a stub and
 * one last ice stone over the goal pit.
 *
 * Rev 1 (P5-5): two bubbles ('b') hang over the spike bed, one under each gap
 * between the shelves, each a shard perch — stomp the bubble (fall onto it, or
 * hold {stomp}) and the launch carries you through a shard six rows up, then
 * drift onto the next shelf; the popped bubble is gone for 2.5 s, so falling
 * straight back is the spikes. The tower's first bubbles, on a side route only.
 *
 * Shards are side routes only: the dash-up perch at the start, the far left end
 * of the upper hall floor (walk back once you are up), a perch a dash left of
 * the ladder top, beside the relic, the two bubble perches over the spike bed,
 * and three tiles over the last ice stone.
 * Checkpoints: hall floor, first bank, cliff top, second bank — every neighbour
 * pair within 32 columns; foes start at column 54 so a phone's spawn frame never
 * hides one under a thumb (tools/qa/mobile.ts).
 */
import { room } from '../dsl.js';

const m = room(114, 26);
const F = 22;               // floor top row; the player stands on row F-1

// --- start yard: a dash-up perch
m.ground(0, 12, F);
m.ent('P', 3, F - 1);
m.plat(8, 9, F - 7);
m.shards([[8, F - 8], [9, F - 8]]);

// --- act 1: the frost hall — a one-way ceiling three rows up, a three-tile step at the end;
//     the ceiling is the upper floor, so the step top joins it and the bank continues at that height
m.ground(13, 44, F);
m.ent('C', 16, F - 1);
m.owp(17, 42, F - 3);
m.block(43, 44, F - 3, F - 1);
m.shards([[17, F - 4], [18, F - 4]]);           // far left end of the upper floor: walk back once you are up

// --- bank 1 with the checkpoint for the ladder; a one-tile stub pens the walker to the ladder side
m.ground(45, 58, F - 3);
m.ent('C', 47, F - 4);
m.block(50, 50, F - 4, F - 4);
m.ent('w', 55, F - 4);

// --- act 2: the crystal ladder up the cliff face — jump and air jump to the first crystal,
//     dash up to the second, dash up onto the cliff; a perch a dash to the left of the top
m.ground(59, 72, F - 14);
m.ent('D', 58, F - 8);
m.ent('D', 58, F - 13);
m.plat(53, 54, F - 14);
m.shards([[53, F - 15], [54, F - 15]]);

// --- act 3: cliff gallery — checkpoint, then a floor saw sweeping between two stubs (jump it on its return)
m.ent('C', 61, F - 15);
m.block(64, 64, F - 16, F - 15);
m.ent('s', 67, F - 15);
m.block(71, 71, F - 16, F - 15);

// --- act 4: the ice descent — three one-way shelves stepping down over a spike bed; the relic perch
//     hangs level with the cliff top, a running double jump out from its edge
m.ground(73, 88, F);
m.spikes(73, 88, F - 1);
m.owp(75, 77, F - 10);
m.owp(80, 82, F - 7);
m.owp(85, 87, F - 4);
m.plat(78, 80, F - 15);
m.ent('R', 79, F - 16);
m.shards([[78, F - 16], [80, F - 16]]);
m.ent('f', 84, F - 19);                          // a flyer drifting over the descent
//     bubble perches (P5-5): one bubble in each shelf gap, one tile left of the next shelf and high enough that the
//     launch (55 units with JUMP released) clears that shelf's top with room to spare; a shard six rows over each,
//     inside the launch's reach. Straight back down is the spikes — drift right onto the ice instead.
m.ent('b', 79, F - 5);
m.ent('o', 80, F - 11);
m.ent('b', 84, F - 3);
m.ent('o', 84, F - 9);

// --- bank 2: checkpoint behind a one-tile stub that pens the walker to the right half
m.ground(89, 100, F - 2);
m.ent('C', 90, F - 3);
m.block(92, 92, F - 3, F - 3);
m.ent('w', 96, F - 3);

// --- act 5: the goal pit with one ice stone in it, shards three above the stone
m.owp(103, 104, F - 4);
m.shards([[103, F - 8], [104, F - 8]]);
m.ground(108, 113, F - 2);
m.ent('G', 111, F - 3);

export const m1 = m.def({
  id: 'm1', name: '얼음 회랑', en: 'FROST GALLERY', biome: 'summit', par: 80, seed: 211, rev: 1,
  hint: '얼음 선반은 아래에서 위로 통과한다 — 천장을 향해 공중에서 {jump} 한 번 더 · 절벽의 수정은 {dash} 위로 대시하며 잇는다 · 거품은 {stomp} 위에서만 밟는다',
});
