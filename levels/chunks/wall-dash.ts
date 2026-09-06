/**
 * wall-dash — 벽차기 뒤 대시 / shaft, then a long leap. [wall, dash]
 *
 * A shaft against the right tower wall; at its top the exit ledge waits
 * eight tiles to the left — kick off the tower wall and dash for it.
 */
import { room } from '../dsl.js';

const m = room(40, 12);
m.plat(32, 39, 11);                    // entry
m.wall(35, 0, 8);                      // pillar; shaft interior x 36..39 faces the tower wall
m.plat(19, 26, 0);                     // exit, gap 27..34 (8) from the pillar crown
m.shards([[37, 2], [38, 5], [37, 7], [31, 1], [29, 1]]);

export const wallDash = m.chunk({ id: 'wall-dash', name: '벽차기 뒤 대시', tags: ['wall', 'dash'], entry: [32, 39], exit: [19, 26] });
