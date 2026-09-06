/**
 * s2 — 번개 회로 / LIGHTNING CIRCUIT (stormspire). Teaches switch blocks.
 *
 * '%' is solid at the start, '&' is not; dashing through a toggle ('k') swaps
 * them. Lesson order: one toggle opens one gate → the swapped '&' row is now a
 * bridge → the relic sits on a '&' ledge that only exists in that polarity →
 * two gates of opposite kinds with a toggle between them → a hallway of four
 * alternating gates with a toggle before each: dash, dash, dash, dash.
 */
import { room } from '../dsl.js';

const m = room(112, 24);
const F = 20;

// --- start yard: the first toggle is on the ground, right in the way
m.ground(0, 12, F);
m.ent('P', 3, F - 1);
m.shards([[6, F - 1], [8, F - 1]]);
m.ent('k', 10, F - 1);

// --- gate 1: a '%' wall six tall — jump can't clear it, the toggle can
m.ground(13, 30, F);
m.switchA(14, 15, F - 6, F - 1);
m.shards([[17, F - 1], [19, F - 1]]);
m.ent('w', 24, F - 1);
m.shards([[26, F - 3], [28, F - 3]]);

// --- '&' bridge over a spike bed: solid now that the switch is flipped
m.ground(31, 39, F + 3);
m.spikes(31, 39, F + 2);
m.switchB(31, 39, F);
m.shards([[33, F - 2], [35, F - 2], [37, F - 2]]);

// --- bank with checkpoint; relic on a '&' ledge reached from a solid step
m.ground(40, 54, F);
m.ent('C', 42, F - 1);
m.plat(50, 52, F - 3);
m.shards([[51, F - 4]]);
m.switchB(45, 47, F - 6);
m.ent('R', 46, F - 7);
m.shards([[45, F - 7], [47, F - 7]]);

// --- gate 2 ('%', open in the flipped state) → toggle → gate 3 ('&', open again in the start state)
m.ground(55, 75, F);
m.switchA(56, 57, F - 6, F - 1);
m.shards([[59, F - 1]]);
m.ent('k', 62, F - 1);
m.shards([[64, F - 3]]);
m.switchB(66, 67, F - 6, F - 1);
m.shards([[70, F - 1]]);
m.ent('h', 72, F - 1);

// --- climax: the switch hallway — a rock ceiling, four alternating gates, a toggle before each
m.ground(76, 101, F);
m.plat(76, 101, F - 7);
m.ent('k', 78, F - 1);
m.switchA(80, 81, F - 6, F - 1);
m.shards([[82, F - 2]]);
m.ent('k', 84, F - 1);
m.switchB(86, 87, F - 6, F - 1);
m.shards([[88, F - 2]]);
m.ent('k', 90, F - 1);
m.switchA(92, 93, F - 6, F - 1);
m.shards([[94, F - 2]]);
m.ent('k', 96, F - 1);
m.switchB(98, 99, F - 6, F - 1);
m.shards([[100, F - 2]]);

// --- goal yard
m.ground(102, 111, F);
m.shards([[104, F - 2], [105, F - 2]]);
m.ent('G', 107, F - 1);

export const s2 = m.def({
  id: 's2', name: '번개 회로', en: 'LIGHTNING CIRCUIT', biome: 'stormspire', par: 75, seed: 59,
  hint: '빛나는 스위치를 {dash} 대시로 통과하면 주황 블록과 파란 블록이 뒤바뀐다',
});
