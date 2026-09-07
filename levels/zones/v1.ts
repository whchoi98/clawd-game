/**
 * v1 — 공허의 수정 / VOID CRYSTALS (voidreef). Teaches dash crystals: touching
 * one in the air refills the dash and both air jumps, so a chain of crystals
 * is a bridge made of nothing.
 *
 * Every crystal field hangs over a spike bed rather than a bottomless pit:
 * the fields are wider than any jump, which is the point.
 *
 * P2-8 (rev 1): five checkpoints — right before each field (the novice bot
 * never got past the first one) and on the cliff either side of the relic —
 * and ten shards that all need a crystal detour: up and away from a crystal
 * so the fall lands on a bank, beside the relic, on a dash-up perch at the start.
 */
import { room } from '../dsl.js';

const m = room(118, 22);
const F = 18;

// --- start yard: a perch six up (dash-up), checkpoint before the first field
m.ground(0, 12, F);
m.ent('P', 3, F - 1);
m.plat(8, 9, F - 7);
m.shards([[8, F - 8], [9, F - 8]]);
m.ent('C', 11, F - 1);

// --- field 1 (10 wide): one crystal in the middle — jump, dash, touch, dash again;
//     two shards up and to the right of it: dash up from the crystal and the fall lands on the bank
m.ground(13, 22, F + 2);
m.spikes(13, 22, F + 1);
m.ent('D', 18, F - 3);
m.shards([[19, F - 6], [21, F - 8]]);

// --- bank with the checkpoint for field 2
m.ground(23, 32, F);
m.ent('C', 31, F - 1);

// --- field 2 (20 wide): three crystals in a rhythm
m.ground(33, 52, F + 2);
m.spikes(33, 52, F + 1);
m.ent('D', 37, F - 4);
m.ent('D', 43, F - 5);
m.ent('D', 49, F - 4);

// --- bank, then a crystal climb up a seven-tile cliff; shards straight up from the climb crystal (safe ground below)
m.ground(53, 69, F);
m.ent('C', 55, F - 1);
m.ent('D', 67, F - 5);
m.shards([[67, F - 9], [67, F - 11]]);

// --- cliff top with a flyer; the relic needs one more crystal straight up; checkpoints either side
m.ground(70, 84, F - 8);
m.ent('C', 72, F - 9);
m.ent('f', 76, F - 11);
m.ent('D', 78, F - 12);
m.plat(80, 82, F - 14);
m.ent('R', 81, F - 15);
m.shards([[80, F - 16], [82, F - 16]]);
m.ent('C', 84, F - 9);

// --- climax: field 3 (20 wide) entered from height — three crystals down to the goal;
//     two shards up and right of the last crystal, the fall lands on the goal bank
m.ground(85, 104, F + 2);
m.spikes(85, 104, F + 1);
m.ent('D', 89, F - 6);
m.ent('D', 95, F - 5);
m.ent('D', 101, F - 6);
m.shards([[102, F - 9], [104, F - 11]]);
m.ground(105, 117, F);
m.ent('G', 113, F - 1);

export const v1 = m.def({
  id: 'v1', name: '공허의 수정', en: 'VOID CRYSTALS', biome: 'voidreef', par: 70, seed: 101,
  hint: '공중에서 수정에 닿으면 {dash} 대시와 2단 점프가 되돌아온다 — 수정에서 수정으로',
  rev: 1,
});
