/**
 * switch-gate — 스위치 관문 / one toggle opens the stairs. [switch]
 *
 * A '%' wall the full height of the chunk seals the way past ledge A, and a
 * rock ceiling closes the yard above so the wall cannot be vaulted from the
 * open rows over the chunk; the toggle on the entry ledge is dashed through,
 * the wall vanishes and two '&' steps appear beyond it leading to the exit.
 */
import { room } from '../dsl.js';

const m = room(40, 9);
m.plat(0, 5, 8);                       // entry
m.ent('k', 3, 7);                      // toggle at body height on the entry ledge
m.plat(8, 11, 5);                      // A
m.plat(0, 13, 0);                      // ceiling of the sealed yard
m.switchA(14, 14, 1, 8);               // gate: solid until the flip, welded to the ceiling
m.switchB(16, 19, 5);                  // step 1 (solid after the flip)
m.switchB(22, 25, 2);                  // step 2
m.plat(28, 35, 0);                     // exit
m.shards([[9, 4], [11, 4], [17, 4], [19, 4], [23, 1], [25, 1]]);

export const switchGate = m.chunk({ id: 'switch-gate', name: '스위치 관문', tags: ['switch'], entry: [0, 5], exit: [28, 35] });
