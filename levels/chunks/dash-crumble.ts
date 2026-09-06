/**
 * dash-crumble — 무너지는 다리 / run the crumble, dash the gap. [dash]
 *
 * A twelve-tile crumbling bridge breaks 0.42 s behind your feet; at its end
 * a six-tile gap two rows up wants the dash, and the exit is a four-row
 * double jump above the far ledge.
 */
import { room } from '../dsl.js';

const m = room(40, 10);
m.plat(0, 7, 9);                       // entry
m.crumble(10, 21, 6);                  // bridge
m.plat(28, 33, 4);                     // far ledge, gap 22..27 (6)
m.plat(32, 39, 0);                     // exit
m.shards([[12, 5], [15, 5], [18, 5], [24, 3], [26, 3], [30, 3]]);

export const dashCrumble = m.chunk({ id: 'dash-crumble', name: '무너지는 다리', tags: ['dash'], entry: [0, 7], exit: [32, 39] });
