/**
 * wall-rest — 쉼터 굴뚝 / a chimney with one-way rests. [wall]
 *
 * A central chimney whose interior carries two one-way ledges: wall-jump or
 * double-jump up through them, then out over the right wall's crown to the exit.
 */
import { room } from '../dsl.js';

const m = room(40, 13);
m.plat(7, 14, 12);                     // entry
m.wall(8, 2, 9);                       // left wall
m.wall(13, 0, 9);                      // right wall, up to the top row
m.owp(9, 12, 6);                       // rest ledges never seal the shaft from below
m.owp(9, 12, 3);
m.plat(14, 21, 0);                     // exit off the right wall's crown (exit span 13..21)
m.shards([[10, 5], [11, 2], [9, 8], [12, 8]]);

export const wallRest = m.chunk({ id: 'wall-rest', name: '쉼터 굴뚝', tags: ['wall'], entry: [7, 14], exit: [13, 21] });
