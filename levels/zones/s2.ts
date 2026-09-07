/**
 * s2 — 번개 회로 / LIGHTNING CIRCUIT (stormspire). Teaches switch blocks.
 *
 * '%' is solid at the start, '&' is not; dashing through a toggle ('k') swaps
 * them. Lesson order: one toggle opens one gate → the swapped '&' row is now a
 * bridge → the relic sits on a '&' ledge that only exists in that polarity →
 * two gates of opposite kinds with a toggle between them → a hallway of four
 * alternating gates with a toggle before each: dash, dash, dash, dash.
 *
 * P2-8 (rev 1): four checkpoints (before the bridge — every novice death in
 * the heat map — on the bank, between the paired gates, at the hallway door);
 * respawns keep the switch polarity (SIM_VERSION 3), so a checkpoint behind a
 * toggle no longer strands anyone. The first gate is sealed to the ceiling so
 * it cannot be wall-jumped past with the bridge still open air. Shards: a
 * dash-up perch at the start, the relic ledge, the top of gate 2 (solid only in
 * the start polarity) and the hallway roof — a dash-up climb above the lesson.
 */
import { room } from '../dsl.js';

const m = room(112, 24);
const F = 20;

// --- start yard: a perch six up (jump, air jump, dash up), the first toggle on the ground, right in the way
m.ground(0, 12, F);
m.ent('P', 3, F - 1);
m.plat(6, 7, F - 7);
m.shards([[6, F - 8], [7, F - 8]]);
m.ent('k', 10, F - 1);

// --- gate 1: a '%' door in a wall that meets a rock roof over the start yard — only the toggle opens it
//     (the map has no top edge: without the roof a wall jump climbs past row 0 and over the wall)
m.ground(13, 30, F);
m.switchA(14, 15, F - 6, F - 1);
m.block(14, 15, 0, F - 7);
m.block(0, 17, 0, 1);
m.ent('w', 24, F - 1);
m.ent('C', 28, F - 1);

// --- '&' bridge over a spike bed: solid now that the switch is flipped
m.ground(31, 39, F + 3);
m.spikes(31, 39, F + 2);
m.switchB(31, 39, F);

// --- bank with checkpoint; relic on a '&' ledge reached from a solid step
m.ground(40, 54, F);
m.ent('C', 42, F - 1);
m.plat(50, 52, F - 3);
m.switchB(45, 47, F - 6);
m.ent('R', 46, F - 7);
m.shards([[45, F - 7], [47, F - 7]]);

// --- gate 2 ('%', open in the flipped state) → checkpoint → toggle → gate 3 ('&', open again in the start state)
//     two shards stand on gate 2's top: it is only a floor in the start polarity — come back for them, or dash up
m.ground(55, 75, F);
m.switchA(56, 57, F - 6, F - 1);
m.shards([[56, F - 7], [57, F - 7]]);
m.ent('C', 60, F - 1);
m.ent('k', 62, F - 1);
m.switchB(66, 67, F - 6, F - 1);
m.ent('w', 72, F - 1);        // a walker, not a hopper: a hopper here camped the hallway door and the checkpoint at 77

// --- climax: the switch hallway — a rock roof, four alternating gates, a toggle before each; shards on the roof
m.ground(76, 101, F);
m.plat(76, 101, F - 7);
m.ent('C', 77, F - 1);
m.ent('k', 78, F - 1);
m.switchA(80, 81, F - 6, F - 1);
m.ent('k', 84, F - 1);
m.switchB(86, 87, F - 6, F - 1);
m.ent('k', 90, F - 1);
m.switchA(92, 93, F - 6, F - 1);
m.ent('k', 96, F - 1);
m.switchB(98, 99, F - 6, F - 1);
m.shards([[79, F - 8], [85, F - 8], [91, F - 8], [97, F - 8]]);

// --- goal yard
m.ground(102, 111, F);
m.ent('G', 107, F - 1);

export const s2 = m.def({
  id: 's2', name: '번개 회로', en: 'LIGHTNING CIRCUIT', biome: 'stormspire', par: 75, seed: 59,
  hint: '빛나는 스위치를 {dash} 대시로 통과하면 주황 블록과 파란 블록이 뒤바뀐다',
  rev: 1,
});
