/**
 * dash-twin — 쌍둥이 대시 / two gaps, one crystal. [dash, crystal]
 *
 * Entry bottom-right → ledge A → a ten-tile gap with a dash crystal hanging
 * over it: jump + dash into the crystal, then jump again onto ledge B → exit.
 */
import { room } from '../dsl.js';

const m = room(40, 10);
m.plat(32, 39, 9);                     // entry
m.plat(22, 27, 6);                     // A
m.ent('D', 16, 4);                     // crystal over the gap 12..21
m.plat(6, 11, 3);                      // B
m.plat(14, 21, 0);                     // exit
m.shards([[24, 5], [26, 5], [19, 4], [13, 3], [8, 2], [10, 2]]);

export const dashTwin = m.chunk({ id: 'dash-twin', name: '쌍둥이 대시', tags: ['dash', 'crystal'], entry: [32, 39], exit: [14, 21] });
