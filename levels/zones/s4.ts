/**
 * s4 — 천둥 승강기 / THUNDER LIFT (stormspire). The tier's vertical zone
 * (P2-10): a 44-wide tower in three acts.
 *
 * Act 1 crumble stairs — rock landings every four rows (a double jump reaches
 * them on their own) with a crumbling half-step between each pair, so the
 * stairs are the easy way up and a fall onto the base costs a climb, not a
 * life · Act 2 two vertical platforms ('M', each riding six rows down to its
 * boarding ledge and back) under a turret on a perch · Act 3 the switch-block
 * lift: dash through a toggle on a rock rest ledge and the '&' steps appear,
 * climb them to the next rest ledge, dash through the toggle there and the '%'
 * steps take over — the rest ledges are rock, so a flip never drops you.
 * Summit: a floor saw between two stubs before the goal.
 *
 * Shards are side routes: a dash-up perch over the base, the air beside the
 * first lift's top, the relic perch off the second boarding ledge, a '&' ledge
 * beside the second staircase (there only before the toggle flips it away) and
 * a dash-up perch over the summit. Checkpoints stand at most 32 tiles apart
 * along the climb.
 */
import { room } from '../dsl.js';

const m = room(44, 72).tower();       // walls x 0..1 and 42..43, base rows 68..71
const B = 68;                          // base floor top row; the player stands on row 67

// --- base yard: a dash-up perch over the right half
m.ent('P', 21, B - 1);
m.plat(36, 37, B - 5);
m.shards([[36, B - 6], [37, B - 6]]);

// --- act 1: crumble stairs zig-zagging up the left side; landings 4 rows apart, half-steps between
m.ground(4, 8, B - 4, 2);             // L1
m.crumble(9, 10, B - 2);
m.ground(12, 16, B - 8, 2);           // L2
m.crumble(9, 10, B - 6);
m.ent('C', 16, B - 9);
m.ground(4, 8, B - 12, 2);            // L3
m.crumble(9, 10, B - 10);
m.ground(12, 24, B - 16, 2);          // L4: the shelf that boards the first lift (rock under its column stops the ride)
m.crumble(9, 10, B - 14);
m.ent('C', 14, B - 17);

// --- act 2: lift 1 rides x 22..24 between rows 45 and 51; jump off its top onto the ledge at row 43
m.ent('M', 22, 45);
m.shards([[19, 46], [19, 44]]);        // in the air left of the ride's top: hop off, fall back to the shelf, ride again
m.ground(26, 37, 43, 2);
m.ent('C', 29, 42);
//     lift 2 rides x 35..37 between rows 36 and 42; its exit ledge is to the left at row 34
m.ent('M', 35, 36);
m.ground(26, 33, 34, 2);
//     relic perch four above the boarding ledge, beside the second lift's column
m.plat(38, 41, 39);
m.ent('R', 39, 38);
m.shards([[38, 38], [41, 38]]);
//     a turret on a perch by the wall covers the top of the second ride and the rest ledge above it
m.plat(39, 41, 27);
m.ent('t', 40, 26);

// --- act 3: the switch-block lift. Rest ledge R0 is lift 2's exit ledge; toggle k1 at its right end.
m.ent('C', 27, 33);
m.ent('k', 32, 33);
//     '&' staircase (solid once k1 is flipped): single-jump steps up to rest ledge R1
m.switchB(35, 37, 32);
m.switchB(30, 32, 30);
m.switchB(35, 37, 28);
m.switchB(30, 32, 26);
m.switchB(35, 37, 24);
m.ground(26, 33, 22, 2);              // R1
m.ent('C', 26, 21);
m.ent('k', 30, 21);
m.switchB(38, 40, 19);                // side ledge, there only in the '&' polarity: shards before flipping k2
m.shards([[39, 18], [40, 18]]);
//     '%' staircase (solid again once k2 flips the polarity back)
m.switchA(35, 37, 20);
m.switchA(30, 32, 18);
m.switchA(35, 37, 16);
m.switchA(30, 32, 14);
m.switchA(35, 37, 12);
m.ground(26, 33, 10, 2);              // R2
m.ent('C', 30, 9);
m.plat(30, 31, 4);                    // dash-up perch over R2
m.shards([[30, 3], [31, 3]]);

// --- summit deck to the left: a floor saw between two stubs, then the goal
m.ground(2, 22, 8, 3);
m.block(14, 14, 6, 7);
m.ent('s', 16, 7);
m.block(19, 19, 6, 7);
m.ent('G', 8, 7);

export const s4 = m.def({
  id: 's4', name: '천둥 승강기', en: 'THUNDER LIFT', biome: 'stormspire', par: 110, seed: 89,
  hint: '승강 발판은 내려올 때까지 기다려 탄다 · 토글을 {dash} 대시로 켜면 번개 발판이 나타난다',
});
