/**
 * dash-gap — 대시 도약 / one dash gap. [dash]
 *
 * Entry bottom-left → a mid ledge (double jump) → a nine-tile gap only a
 * jump + dash crosses → the exit ledge four rows up on the right.
 */
import { room } from '../dsl.js';

const m = room(40, 8);
m.plat(0, 7, 7);                       // entry
m.plat(6, 11, 4);                      // mid ledge
m.plat(21, 27, 4);                     // far ledge, gap 12..20 (9)
m.plat(30, 37, 0);                     // exit
m.shards([[8, 3], [10, 3], [14, 2], [16, 2], [18, 2], [23, 3], [25, 3]]);

export const dashGap = m.chunk({ id: 'dash-gap', name: '대시 도약', tags: ['dash'], entry: [0, 7], exit: [30, 37] });
