/**
 * t1 — 새벽 물가 / DAWN SHALLOWS (tidepool). Teaches run, jump, double jump.
 *
 * Reading order: a flat run → a gap whose floor is two tiles down (a mistake
 * costs time, not a life) → two-tile ledges for single jumps → the first
 * lethal pit (five tiles) → a three-tile step you can only double-jump onto →
 * another five-tile pit → an optional two-step relic tower → a stepping stone
 * over the last pit as the climax.
 *
 * P2-8 (rev 1): three checkpoints, one right before each pit the novice bot
 * fell into (levels/heatmap/t1.json), both lethal pits cut to five tiles (the
 * wide one was seven), and the shards moved off the sand onto perches that take a double
 * jump off the main line — eleven of them, so the second star is earned.
 */
import { room } from '../dsl.js';

const m = room(100, 20);
const F = 16;               // floor top row; the player stands on row F-1

// --- start yard: nothing to collect on the sand — the eye goes to the perches ahead
m.ground(0, 14, F);
m.ent('P', 3, F - 1);

// --- forgiving gap: floor two tiles down
m.ground(15, 17, F + 2);

// --- ledges for single jumps (2 up), then a second tier (2 up again)
m.ground(18, 40, F);
m.plat(24, 28, F - 2);
// the walker patrols the whole 18..40 floor; it spawns under the first ledge so
// the spawn frame never draws it under a phone's DASH / JUMP thumb (qa:mobile)
m.ent('w', 24, F - 1);
// perch A: four tiles above the first ledge — a double jump off it
m.plat(26, 27, F - 6);
m.shards([[26, F - 7], [27, F - 7]]);
m.plat(33, 37, F - 4);
// three above the second tier: a double jump from the ledge collects them at the apex
m.shards([[34, F - 7], [36, F - 7]]);
// checkpoint 1: right before the first lethal pit (the bot's second hot spot)
m.ent('C', 32, F - 1);

// --- first lethal pit (5 wide — no pit in t1 is wider): one shard at the apex says "press jump again"
m.ground(46, 62, F);
m.shards([[43, F - 5]]);
m.ent('C', 49, F - 1);

// --- a 3-tile step: single jump falls short, double jump lands it; a perch four above it
m.plat(53, 57, F - 3);
m.plat(55, 56, F - 7);
m.shards([[55, F - 8], [56, F - 8]]);

// --- the wide pit, five tiles (was seven: the bot's top hot spot); checkpoint on landing
m.ground(68, 84, F);
m.ent('C', 70, F - 1);
m.ent('w', 76, F - 1);

// --- optional relic tower: two double jumps off the main line, a perch beyond the top
m.plat(72, 75, F - 3);
m.plat(78, 81, F - 6);
m.ent('R', 79, F - 7);
m.plat(83, 84, F - 9);
m.shards([[83, F - 10], [84, F - 10]]);

// --- climax: a stepping stone over the last pit (shards three above it), or one clean double jump
m.plat(87, 88, F - 3);
m.shards([[87, F - 6], [88, F - 6]]);
m.ground(91, 99, F);
m.ent('G', 96, F - 1);

export const t1 = m.def({
  id: 't1', name: '새벽 물가', en: 'DAWN SHALLOWS', biome: 'tidepool', par: 45, seed: 5,
  hint: '{move} 이동 · {jump} 점프 · 공중에서 {jump} 한 번 더 — 2단 점프',
  // rev 1 = P2-8 (SIM_VERSION 3): checkpoints 32 / 49 / 70, pits cut to five (41..45, 63..67), shards on perches.
  // Bump `rev` (and re-record src/client/echo/guide.ts) for any further cell change.
  rev: 1,
});
