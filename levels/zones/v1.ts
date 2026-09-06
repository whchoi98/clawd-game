/**
 * v1 — 공허의 수정 / VOID CRYSTALS (voidreef). Teaches dash crystals: touching
 * one in the air refills the dash and both air jumps, so a chain of crystals
 * is a bridge made of nothing.
 *
 * Every crystal field hangs over a spike bed rather than a bottomless pit:
 * the fields are wider than any jump, which is the point.
 */
import { room } from '../dsl.js';

const m = room(118, 22);
const F = 18;

// --- start yard
m.ground(0, 12, F);
m.ent('P', 3, F - 1);
m.shards([[6, F - 1], [9, F - 1]]);

// --- field 1 (10 wide): one crystal in the middle — jump, dash, touch, dash again
m.ground(13, 22, F + 2);
m.spikes(13, 22, F + 1);
m.ent('D', 18, F - 3);
m.shards([[15, F - 3], [21, F - 3]]);

// --- bank
m.ground(23, 32, F);
m.ent('C', 25, F - 1);
m.shards([[28, F - 3], [30, F - 3]]);

// --- field 2 (20 wide): three crystals in a rhythm
m.ground(33, 52, F + 2);
m.spikes(33, 52, F + 1);
m.ent('D', 37, F - 4);
m.ent('D', 43, F - 5);
m.ent('D', 49, F - 4);
m.shards([[35, F - 3], [40, F - 5], [46, F - 5], [51, F - 3]]);

// --- bank, then a crystal climb up a seven-tile cliff
m.ground(53, 69, F);
m.ent('C', 55, F - 1);
m.shards([[58, F - 3], [60, F - 3]]);
m.ent('D', 67, F - 5);
m.shards([[66, F - 3], [68, F - 7]]);

// --- cliff top with a flyer; the relic needs one more crystal straight up
m.ground(70, 84, F - 8);
m.ent('f', 76, F - 11);
m.shards([[73, F - 9], [76, F - 9], [79, F - 9]]);
m.ent('D', 78, F - 12);
m.plat(80, 82, F - 14);
m.ent('R', 81, F - 15);

// --- climax: field 3 (20 wide) entered from height — three crystals down to the goal
m.ground(85, 104, F + 2);
m.spikes(85, 104, F + 1);
m.ent('D', 89, F - 6);
m.ent('D', 95, F - 5);
m.ent('D', 101, F - 6);
m.shards([[87, F - 4], [92, F - 6], [98, F - 6], [103, F - 4]]);
m.ground(105, 117, F);
m.ent('G', 113, F - 1);

export const v1 = m.def({
  id: 'v1', name: '공허의 수정', en: 'VOID CRYSTALS', biome: 'voidreef', par: 70, seed: 101,
  hint: '공중에서 수정에 닿으면 대시와 2단 점프가 되돌아온다 — 수정에서 수정으로',
});
