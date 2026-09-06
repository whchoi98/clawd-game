/**
 * s1 — 비 내리는 발판 / RAINFALL LEDGES (stormspire). Teaches crumbling
 * ledges and moving platforms under the rain.
 *
 * Crumble tiles break PHYS.crumbleDelay after the first footfall, so every
 * crumble run here is something you cross, never something you stand on.
 * The moving platforms are slow (a ten-second ping-pong); the lesson is to
 * wait for them, not to chase them.
 */
import { room } from '../dsl.js';

const m = room(116, 22);
const F = 18;

// --- start yard
m.ground(0, 10, F);
m.ent('P', 3, F - 1);
m.shards([[6, F - 1], [8, F - 1]]);

// --- crumble bridge 1 over a bottomless gap: keep running
m.crumble(11, 17, F);
m.arc(11, F - 1, 17, F - 1, 4, 'o', 2.5);

// --- bank, then a slow horizontal platform over a spike bed
m.ground(18, 28, F);
m.ent('w', 23, F - 1);
m.ground(29, 40, F + 3);
m.spikes(29, 40, F + 2);
m.ent('m', 30, F - 2);                       // rides x 30..38, three tiles wide
m.shards([[32, F - 4], [35, F - 4], [38, F - 4]]);

// --- bank with checkpoint
m.ground(41, 52, F);
m.ent('C', 43, F - 1);
m.ent('h', 49, F - 1);

// --- crumble stair: two rising crumble ledges, then a solid one — no standing still
m.crumble(54, 58, F - 3);
m.shards([[55, F - 4], [57, F - 4]]);
m.crumble(60, 64, F - 6);
m.shards([[61, F - 7], [63, F - 7]]);
m.plat(66, 70, F - 6);

// --- vertical platform lifts you to the cliff top
m.ent('M', 72, F - 10);                      // starts at row 8, travels down to row 16
m.ground(76, 90, F - 10);
m.ent('C', 78, F - 11);
m.ent('h', 84, F - 11);
m.shards([[79, F - 12], [81, F - 12], [83, F - 12], [85, F - 12]]);

// --- relic perch above the cliff: a four-tile double jump
m.plat(80, 82, F - 14);
m.ent('R', 81, F - 15);
m.shards([[80, F - 16], [82, F - 16]]);

// --- climax: a stepping descent over crumble ledges to the goal
m.crumble(93, 96, F - 5);
m.shards([[94, F - 6], [95, F - 6]]);
m.crumble(98, 101, F - 2);
m.shards([[99, F - 3], [100, F - 3]]);
m.ground(103, 115, F);
m.ent('w', 108, F - 1);
m.ent('G', 112, F - 1);

export const s1 = m.def({
  id: 's1', name: '비 내리는 발판', en: 'RAINFALL LEDGES', biome: 'stormspire', par: 60, seed: 41,
  hint: '무너지는 발판은 밟은 순간부터 0.4초 — 멈추지 말 것 · 움직이는 발판은 기다리는 편이 빠르다',
});
