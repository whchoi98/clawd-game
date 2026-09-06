/**
 * wall-zig — 굴뚝 지그재그 / a chimney in the middle. [wall]
 *
 * Two facing walls four tiles apart rise from the entry ledge; the right
 * wall carries on to the top row and its crown is the exit. Wall-jump the
 * chimney, pop out above it and land on the crown.
 */
import { room } from '../dsl.js';

const m = room(40, 12);
m.plat(16, 23, 11);                    // entry, under the chimney mouth (rows 9..10 open)
m.wall(17, 2, 8);                      // left wall
m.wall(22, 0, 8);                      // right wall, up to the top row
m.plat(23, 30, 0);                     // exit ledge off the right wall's crown (exit span 22..30)
m.shards([[19, 3], [20, 6], [18, 1]]);

export const wallZig = m.chunk({ id: 'wall-zig', name: '굴뚝 지그재그', tags: ['wall'], entry: [16, 23], exit: [22, 30] });
