/**
 * crystal-gap — 크리스탈 도약 / one crystal, fourteen tiles. [crystal, dash]
 *
 * Ledges A and B are fourteen tiles apart; the crystal halfway is the only
 * mid-air reset — dash to it, dash again.
 */
import { room } from '../dsl.js';

const m = room(40, 10);
m.plat(0, 7, 9);                       // entry
m.plat(8, 13, 6);                      // A
m.ent('D', 20, 4);                     // halfway over the gap 14..27
m.plat(28, 33, 6);                     // B
m.plat(34, 37, 3);                     // step
m.plat(30, 37, 0);                     // exit
m.shards([[10, 5], [12, 5], [17, 4], [23, 4], [30, 5], [32, 5], [35, 2]]);

export const crystalGap = m.chunk({ id: 'crystal-gap', name: '크리스탈 도약', tags: ['crystal', 'dash'], entry: [0, 7], exit: [30, 37] });
