/**
 * crystal-ladder — 크리스탈 사다리 / nothing to stand on. [crystal]
 *
 * Four dash crystals zigzag up thirteen rows of open air; each one resets
 * the jumps and the dash, so the climb is jump → crystal → jump → crystal.
 */
import { room } from '../dsl.js';

const m = room(40, 14);
m.plat(15, 22, 13);                    // entry
m.ent('D', 16, 10);
m.ent('D', 22, 7);
m.ent('D', 16, 4);
m.ent('D', 22, 1);
m.plat(24, 31, 0);                     // exit
m.shards([[19, 11], [19, 8], [19, 5], [19, 2]]);

export const crystalLadder = m.chunk({ id: 'crystal-ladder', name: '크리스탈 사다리', tags: ['crystal'], entry: [15, 22], exit: [24, 31] });
