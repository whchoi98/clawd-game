/**
 * t1 — 새벽 물가 / DAWN SHALLOWS (tidepool). Teaches run, jump, double jump.
 *
 * Reading order: a flat run with shards on the sand → a gap whose floor is two
 * tiles down (a mistake costs time, not a life) → two-tile ledges for single
 * jumps → the first lethal pit with a high shard arc that reads "double jump"
 * → a three-tile step you can only double-jump onto → the widest pit the
 * rules allow → an optional two-step relic tower → a stepping stone over the
 * last pit as the climax.
 */
import { room } from '../dsl.js';

const m = room(100, 20);
const F = 16;               // floor top row; the player stands on row F-1

// --- start yard: walking collects the first shards
m.ground(0, 14, F);
m.ent('P', 3, F - 1);
m.shards([[7, F - 1], [9, F - 1], [11, F - 1]]);

// --- forgiving gap: floor two tiles down, a low arc invites the hop
m.ground(15, 17, F + 2);
m.arc(14, F - 1, 18, F - 1, 3, 'o', 2.5);

// --- ledges for single jumps (2 up), then a second tier (2 up again)
m.ground(18, 40, F);
m.plat(24, 28, F - 2);
m.shards([[25, F - 3], [27, F - 3]]);
m.ent('w', 33, F - 1);
m.plat(33, 37, F - 4);
m.shards([[34, F - 5], [36, F - 5]]);

// --- first lethal pit (6 wide): a high arc says "press jump again"
m.ground(47, 62, F);
m.arc(40, F - 1, 47, F - 1, 4, 'o', 4.5);
m.ent('C', 49, F - 1);

// --- a 3-tile step: single jump falls short, double jump lands it
m.plat(53, 57, F - 3);
m.shards([[54, F - 4], [56, F - 4]]);

// --- the widest pit the rules allow (7)
m.ground(70, 84, F);
m.arc(62, F - 1, 70, F - 1, 4, 'o', 4.5);
m.ent('w', 76, F - 1);

// --- optional relic tower: two double jumps off the main line
m.plat(72, 75, F - 3);
m.plat(78, 81, F - 6);
m.ent('R', 79, F - 7);

// --- climax: a stepping stone over the last pit, or one clean double jump
m.plat(87, 88, F - 3);
m.ground(91, 99, F);
m.ent('G', 96, F - 1);

export const t1 = m.def({
  id: 't1', name: '새벽 물가', en: 'DAWN SHALLOWS', biome: 'tidepool', par: 45, seed: 5,
  hint: '← → 이동 · 점프 · 공중에서 한 번 더 누르면 2단 점프',
});
