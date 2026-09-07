/**
 * v4 — 별빛 우물 / STARLIGHT WELL (voidreef). The tier's vertical zone (P2-10):
 * a 44-wide tower climbed on three updraft columns, then a crystal chain that
 * climbs the left wall to an apex ledge, drops onto a gallery floor spanning
 * the well and climbs again to the summit deck on the right.
 *
 * Each updraft rises from a shelf to the row of the next shelf, three tiles to
 * the side (the v2 pattern): ride to the top, drift onto the shelf. A missed
 * exit falls back onto the shelf below — every landing yard is bare rock. The
 * chain: four crystals up the wall (spikes on its face) to the apex, two down
 * onto the gallery, two more up to the deck and the goal. The gallery hangs
 * fourteen rows over the last shelf and reaches the right wall, so the chain is
 * the only way past it — and the only way the goal's potential runs, which is
 * what keeps the paced solver honest.
 *
 * Shards are side routes only: a dash-up perch over the base, the wall side of
 * every column top (drift the wrong way, fall back, ride again), and the relic
 * perch over the apex. Checkpoints stand at most 32 tiles apart along the
 * climb: one at the foot of every column, one on the last shelf, one on the
 * chain's rest ledge, two on the gallery.
 */
import { room } from '../dsl.js';

const m = room(44, 72).tower();       // walls x 0..1 and 42..43, base rows 68..71
const B = 68;                          // base floor top row; the player stands on row 67

// --- base yard: a dash-up perch, the first column at the right end
m.ent('P', 12, B - 1);
m.plat(30, 31, B - 6);
m.shards([[30, B - 7], [31, B - 7]]);
m.ent('z', 38, B - 1);                 // column rows 55..67 (twelve tiles up from the marker)
m.shards([[40, 57], [41, 57]]);        // wall side of the column top: drift right instead of left

// --- shelf 1 (rows 55..57) spans the tower; its left end carries the second column
m.ground(2, 34, 55, 3);
m.ent('C', 25, 54);
m.ent('f', 28, 51);
m.ent('z', 5, 54);                     // column rows 42..54
m.shards([[2, 44], [3, 44]]);
m.ent('C', 8, 54);

// --- shelf 2 (rows 42..44): checkpoint at the exit, a flyer over the run, the third column at its right end
m.ground(9, 27, 42, 3);
m.ent('C', 12, 41);
m.ent('f', 17, 38);
m.ent('C', 20, 41);
m.ent('z', 24, 41);                    // column rows 29..41
m.shards([[26, 31], [27, 31]]);        // right of the column top: the exit is to the left

// --- shelf 3 (rows 29..31), left of the column; the crystal chain climbs the left wall from its end.
//     Everything above is out of reach without the chain: the gallery floor hangs fourteen rows up.
m.ground(12, 20, 29, 3);
m.ent('C', 16, 28);
m.ent('D', 8, 25);
m.ent('D', 5, 21);
m.plat(8, 9, 19);                      // rest ledge halfway up the chain, with its checkpoint: a breath before the last two crystals
m.ent('C', 9, 18);
m.ent('D', 8, 17);
m.ent('D', 5, 13);
m.spikesV(2, 12, 26, 'right');        // the wall face beside the chain bites anyone who hugs it

// --- apex ledge (rows 10..11) against the left wall; relic perch five above it
m.ground(2, 9, 10, 2);
m.plat(6, 7, 5);
m.ent('R', 6, 4);
m.shards([[7, 4]]);

// --- the gallery (rows 15..17): a floor across the well to the right wall. Two crystals drop onto it from
//     the apex; a turret at its far end covers the last climb.
m.ent('D', 12, 12);
m.ent('D', 16, 13);
m.ground(14, 41, 15, 3);
m.ent('C', 18, 14);
m.ent('C', 34, 14);
m.ent('t', 38, 14);

// --- the last climb: two crystals up to the summit deck (rows 6..9) over the gallery, and the goal
m.ent('D', 28, 12);
m.ent('D', 28, 9);
m.ground(30, 41, 6, 4);
m.ent('G', 38, 5);

export const v4 = m.def({
  id: 'v4', name: '별빛 우물', en: 'STARLIGHT WELL', biome: 'voidreef', par: 120, seed: 197,
  hint: '상승기류는 꼭대기에서 옆으로 빠져나온다 · 크리스탈은 {dash} 대시와 점프를 되돌려 준다',
});
