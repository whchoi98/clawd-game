/**
 * spike-alley — 가시 골목 / a dash over a spike bed. [dash]
 *
 * Entry bottom-right → ledge A → an eight-tile gap over spikes (falling short
 * costs a heart, not the run) → ledge B → the exit four rows up on the left.
 */
import { room } from '../dsl.js';

const m = room(40, 9);
m.plat(32, 39, 8);                     // entry
m.plat(22, 29, 5);                     // A
m.plat(8, 21, 7);                      // floor under the gap
m.spikes(10, 19, 6);                   // spike bed
m.plat(8, 13, 4);                      // B, gap 14..21 (8)
m.plat(0, 7, 0);                       // exit
m.shards([[24, 4], [27, 4], [17, 3], [15, 3], [10, 3], [12, 3]]);

export const spikeAlley = m.chunk({ id: 'spike-alley', name: '가시 골목', tags: ['dash'], entry: [32, 39], exit: [0, 7] });
