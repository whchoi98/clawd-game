/**
 * v2 — 심해 상승기류 / DEEP UPDRAFT (voidreef). Updrafts, flyers and a
 * one-way maze.
 *
 * An updraft column rises from its spawn tile to the first rock above (up to
 * twelve tiles). One-way ledges are passable from below only, so the maze
 * is climbed, never fallen back through; two updrafts offer shortcuts.
 */
import { room } from '../dsl.js';

const m = room(96, 28);
const F = 24;

// --- start yard
m.ground(0, 16, F);
m.ent('P', 3, F - 1);
m.shards([[7, F - 1], [10, F - 1]]);

// --- updraft 1: a spike pit whose column lifts you ten tiles onto the cliff.
// The column is flush with the bank edge, so stepping off the yard drops you
// straight into it; the spikes wait beyond it for anyone who overshoots.
m.ground(17, 20, F + 2);
m.spikes(18, 20, F + 1);
m.ent('z', 17, F + 1);
m.shards([[17, F - 4], [17, F - 7], [17, F - 10]]);

// --- cliff top: checkpoint, a flyer, and the drop into the maze
m.ground(21, 34, F - 10);
m.ent('C', 23, F - 11);
m.ent('f', 28, F - 14);
m.shards([[26, F - 12], [30, F - 12]]);

// --- the one-way maze: six alternating ledges climbing a walled room
m.ground(35, 66, F);
m.block(62, 66, F - 19, F - 1);               // right wall; its top (row 5) is the exit
const ledges: [number, number, number][] = [
  [37, 42, F - 3], [46, 52, F - 5], [38, 44, F - 8], [48, 54, F - 11], [38, 44, F - 14], [47, 53, F - 17],
];
for (const [x0, x1, y] of ledges) {
  m.owp(x0, x1, y);
  m.shards([[x0 + 1, y - 1], [x1 - 1, y - 1]]);
}
m.owp(57, 60, F - 18);                        // rest ledge between the top ledge and the exit wall top
m.ent('f', 45, F - 10);
m.ent('f', 50, F - 15);
m.ent('z', 58, F - 1);                        // shortcut column up the right side of the maze
m.ent('z', 36, F - 1);                        // and one up the left side

// --- relic: a ledge left of the maze, five above the cliff — only reachable from the maze
m.plat(31, 33, F - 15);
m.ent('R', 32, F - 16);

// --- climax: descend over a spike floor on three ledges past two flyers
m.ground(67, 89, F);
m.spikes(67, 89, F - 1);
m.plat(70, 74, F - 15);
m.shards([[72, F - 16]]);
m.ent('f', 76, F - 18);
m.plat(78, 82, F - 10);
m.shards([[80, F - 11]]);
m.ent('f', 84, F - 13);
m.plat(86, 90, F - 5);
m.shards([[88, F - 6]]);
m.ground(90, 95, F);
m.ent('G', 93, F - 1);

export const v2 = m.def({
  id: 'v2', name: '심해 상승기류', en: 'DEEP UPDRAFT', biome: 'voidreef', par: 85, seed: 137,
  hint: '상승기류를 타고 오른다 · 얇은 발판은 아래에서 위로 통과할 수 있다',
});
