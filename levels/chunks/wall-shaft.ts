/**
 * wall-shaft — 벽차기 통로 / a four-wide shaft against the tower wall. [wall]
 *
 * The only way up is the shaft between the tower's own side wall and a
 * ten-row pillar: wall-jump to the top, then step right onto the pillar's
 * crown, which is the exit ledge. Inside a chunk wall jumps may be required.
 */
import { room } from '../dsl.js';

const m = room(40, 14);
m.plat(0, 7, 13);                      // entry, under the shaft mouth (rows 10..12 open)
m.wall(4, 0, 9);                       // pillar; shaft interior x 0..3 faces the tower wall
m.plat(5, 12, 0);                      // exit ledge continues the pillar crown (exit span 4..12)
m.shards([[1, 2], [2, 5], [1, 8]]);

export const wallShaft = m.chunk({ id: 'wall-shaft', name: '벽차기 통로', tags: ['wall'], entry: [0, 7], exit: [4, 12] });
