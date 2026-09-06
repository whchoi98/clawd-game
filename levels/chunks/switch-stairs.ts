/**
 * switch-stairs — 스위치 계단 / alternate polarity on every step. [switch]
 *
 * The entry side is a compartment sealed by a rock ceiling and a '%' wall, so
 * the first toggle (over the rock step) is the only way out. Beyond the wall
 * the stairs alternate kinds: the '&' step is solid after that flip, the '%'
 * step above it only after the second toggle flips the polarity back — and
 * the step you left is gone each time.
 */
import { room } from '../dsl.js';

const m = room(40, 12);
m.plat(32, 39, 11);                    // entry
m.plat(25, 39, 0);                     // ceiling of the sealed compartment
m.switchA(25, 25, 1, 11);              // wall: solid until the first flip
m.plat(26, 29, 8);                     // step 1 (rock), under the first toggle
m.ent('k', 28, 6);
m.switchB(20, 23, 5);                  // step 2 (solid after the first flip)
m.ent('k', 18, 3);
m.switchA(14, 17, 2);                  // step 3 (solid again after the second flip)
m.plat(6, 13, 0);                      // exit
m.shards([[27, 7], [29, 7], [21, 4], [23, 4], [15, 1], [17, 1]]);

export const switchStairs = m.chunk({ id: 'switch-stairs', name: '스위치 계단', tags: ['switch'], entry: [32, 39], exit: [6, 13] });
