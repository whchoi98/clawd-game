/**
 * crystal-chain — 크리스탈 사슬 / a twelve-tile chasm. [crystal]
 *
 * Entry bottom-left → ledge A → two dash crystals strung across a chasm no
 * jump clears: dash, reset, dash → ledge B → C → exit top-right.
 */
import { room } from '../dsl.js';

const m = room(40, 12);
m.plat(0, 6, 11);                      // entry
m.plat(4, 9, 8);                       // A
m.ent('D', 13, 6);
m.ent('D', 18, 6);
m.plat(22, 27, 6);                     // B, chasm 10..21 (12)
m.plat(31, 36, 3);                     // C
m.plat(26, 33, 0);                     // exit
m.shards([[6, 7], [8, 7], [15, 5], [24, 5], [26, 5], [33, 2], [35, 2]]);

export const crystalChain = m.chunk({ id: 'crystal-chain', name: '크리스탈 사슬', tags: ['crystal'], entry: [0, 6], exit: [26, 33] });
