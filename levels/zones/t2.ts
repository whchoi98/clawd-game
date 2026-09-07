/**
 * t2 — 조류의 도약 / TIDAL LEAP (tidepool). Teaches dash, springs and water.
 *
 * Water is the safety net: every aerial section hangs over a pool whose banks
 * are one tile above the surface, so a missed dash costs a swim, not a life.
 * Spikes appear only once, in the climax, after the dash has been learned.
 *
 * P2-8 (rev 1): four checkpoints (each bank, plus one right before the spike
 * bed — 85 % of the novice bot's deaths), and the shards moved off the banks
 * onto ledges over the pools that a jump alone does not reach: dash, or swim.
 */
import { room } from '../dsl.js';

const m = room(110, 24);
const F = 18;                 // floor top row
const WS = F + 1, WB = 21;    // water surface / bottom rows

/** A pool with a rock bed: the map bottom is never open under water. */
function pool(x0: number, x1: number): void {
  m.water(x0, x1, WS, WB);
  m.ground(x0, x1, WB + 1);
}

// --- start yard
m.ground(0, 12, F);
m.ent('P', 3, F - 1);

// --- pool 1 (9 wide): a ledge seven tiles out and five up — jump, then dash; a miss is a swim
pool(13, 21);
m.plat(19, 20, F - 5);
m.shards([[19, F - 6], [20, F - 6]]);

// --- bank 1: checkpoint, the first spring, a side ledge the spring lands you on
m.ground(22, 34, F);
m.ent('C', 23, F - 1);
m.ent('w', 25, F - 1);
m.ent('S', 28, F - 1);
m.plat(31, 34, F - 6);
m.shards([[32, F - 7], [33, F - 7]]);

// --- pool 2 (11 wide): a mid-pool ledge past double-jump range from the side ledge — dash
pool(35, 45);
m.plat(41, 42, F - 4);
m.shards([[41, F - 5], [42, F - 5]]);

// --- bank 2: checkpoint, a hopper, and a spring that launches onto the aerial line
m.ground(46, 58, F);
m.ent('C', 48, F - 1);
m.ent('h', 53, F - 1);
m.ent('S', 57, F - 1);

// --- aerial line over the long pool: ledge → dash gap (5) with the shards in it → ledge → drop to the bank
pool(59, 76);
m.plat(60, 64, F - 6);
m.shards([[66, F - 7], [68, F - 7]]);
m.plat(70, 74, F - 6);

// --- bank 3: checkpoint, spring up to the relic climb, checkpoint again before the spikes
m.ground(77, 92, F);
m.ent('C', 78, F - 1);
m.ent('S', 80, F - 1);
m.plat(83, 86, F - 6);          // a spring lifts ~6.7 tiles: six up is the ceiling for a spring-only reach
m.plat(88, 90, F - 9);          // three more: a double jump off the ledge
m.ent('R', 89, F - 10);
m.shards([[88, F - 11], [90, F - 11]]);
m.ent('w', 88, F - 1);
m.ent('C', 91, F - 1);

// --- climax: a seven-wide spike bed — jump, then dash; one shard at the apex
m.ground(93, 99, F);
m.spikes(93, 99, F - 1);
m.shards([[96, F - 5]]);
m.ground(100, 109, F);
m.ent('G', 106, F - 1);

export const t2 = m.def({
  id: 't2', name: '조류의 도약', en: 'TIDAL LEAP', biome: 'tidepool', par: 55, seed: 13,
  hint: '{dash} 대시 · 용수철은 대시를 되돌려준다 · 물에 빠지면 헤엄쳐 나오면 된다',
  rev: 1,
});
