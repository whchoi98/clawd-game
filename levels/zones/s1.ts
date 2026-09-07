/**
 * s1 — 비 내리는 발판 / RAINFALL LEDGES (stormspire). Teaches crumbling
 * ledges and moving platforms under the rain.
 *
 * Crumble tiles break PHYS.crumbleDelay after the first footfall, so every
 * crumble run here is something you cross, never something you stand on.
 * The moving platforms are slow (a ten-second ping-pong); the lesson is to
 * wait for them, not to chase them.
 *
 * P2-8 (rev 1): five checkpoints — before the spike bed the platform crosses
 * (69 % of novice deaths), on the bank, on the solid ledge after the crumble
 * stair, on the cliff, and before the crumble descent — and ten shards on
 * side ledges that take a dash or a dash-up: over the spike bed, above the
 * breaking stair, above the lift's top, beside the relic, off the cliff edge.
 */
import { room } from '../dsl.js';

const m = room(116, 22);
const F = 18;

// --- start yard
m.ground(0, 10, F);
m.ent('P', 3, F - 1);

// --- crumble bridge 1 over a bottomless gap: keep running
m.crumble(11, 17, F);

// --- bank, checkpoint, then a slow horizontal platform over a spike bed; a dash ledge five up over the bed
m.ground(18, 28, F);
m.ent('w', 23, F - 1);
m.ent('C', 27, F - 1);
m.ground(29, 40, F + 3);
m.spikes(29, 40, F + 2);
m.ent('m', 30, F - 2);                       // rides x 30..38, three tiles wide
m.plat(33, 35, F - 5);
m.shards([[33, F - 6], [35, F - 6]]);

// --- bank with checkpoint
m.ground(41, 52, F);
m.ent('C', 43, F - 1);
m.ent('h', 49, F - 1);

// --- crumble stair: two rising crumble ledges, then a solid one with a checkpoint — no standing still before it
m.crumble(54, 58, F - 3);
m.crumble(60, 64, F - 6);
m.plat(60, 61, F - 10);                      // perch four above the breaking ledge: double-jump off it as it goes
m.shards([[60, F - 11], [61, F - 11]]);
m.plat(66, 70, F - 6);
m.ent('C', 68, F - 7);

// --- vertical platform lifts you to the cliff top; a perch six above its highest point (dash-up)
m.ent('M', 72, F - 10);                      // starts at row 8, travels down to row 16
m.plat(72, 73, F - 16);
m.shards([[72, F - 17], [73, F - 17]]);
m.ground(76, 90, F - 10);
m.ent('C', 78, F - 11);
m.ent('h', 84, F - 11);

// --- relic perch above the cliff: a four-tile double jump
m.plat(80, 82, F - 14);
m.ent('R', 81, F - 15);
m.shards([[80, F - 16], [82, F - 16]]);
m.ent('C', 89, F - 11);

// --- a dash ledge six tiles off the cliff edge, then the stepping descent over crumble ledges to the goal
m.plat(96, 97, F - 11);
m.shards([[96, F - 12], [97, F - 12]]);
m.crumble(93, 96, F - 5);
m.crumble(98, 101, F - 2);
m.ground(103, 115, F);
m.ent('w', 108, F - 1);
m.ent('G', 112, F - 1);

export const s1 = m.def({
  id: 's1', name: '비 내리는 발판', en: 'RAINFALL LEDGES', biome: 'stormspire', par: 60, seed: 41,
  hint: '무너지는 발판은 밟은 순간부터 0.4초 — 멈추지 말 것 · 움직이는 발판은 기다리는 편이 빠르다',
  rev: 1,
});
