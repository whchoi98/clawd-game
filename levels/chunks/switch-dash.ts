/**
 * switch-dash — 대시 스위치 / the toggle hangs over a dash gap. [switch, dash]
 *
 * Ledges A and B are nine tiles apart with the toggle in the flight path:
 * the dash that crosses also flips it, and the '&' step it reveals is the
 * only way up to the exit.
 */
import { room } from '../dsl.js';

const m = room(40, 10);
m.plat(0, 7, 9);                       // entry
m.plat(10, 15, 6);                     // A
m.ent('k', 24, 5);                     // in the dash line, gap 16..24
m.plat(25, 30, 6);                     // B
m.switchB(32, 35, 3);                  // step, solid after the flip
m.plat(28, 35, 0);                     // exit
m.shards([[12, 5], [14, 5], [19, 4], [27, 5], [29, 5], [33, 2]]);

export const switchDash = m.chunk({ id: 'switch-dash', name: '대시 스위치', tags: ['switch', 'dash'], entry: [0, 7], exit: [28, 35] });
