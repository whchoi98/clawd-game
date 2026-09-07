/**
 * m2 — 오로라 다리 / AURORA BRIDGE (summit). Crumbling bridges over the void
 * with rock piers, moving platforms over an ice-shard bed, and a turret gallery.
 *
 * Act 1 the long bridge: four crumble spans with a two-tile rock pier between
 * each — keep running, and a pier is a breath · Act 2 the turret gallery: two
 * turrets on ledges four rows up cover the run below (stomp them, or run under)
 * · Act 3 a horizontal platform rides eight tiles over a spike bed, then a
 * vertical lift climbs ten rows to the summit cliff · Act 4 the last crumble
 * span under a turret perch, and the goal.
 *
 * Shards are side routes: the dash-up perch at the start, a perch nine rows
 * over the turret gallery, a dash-up perch over the platform's bed, beside the
 * relic (a double jump off the lift's top), and a dash-up perch over the last
 * span. Checkpoints: first pier, the bank, the gallery door, before the bed,
 * the lift's bank, the cliff top — every neighbour pair within 32 columns.
 */
import { room } from '../dsl.js';

const m = room(118, 24);
const F = 20;

// --- start yard: a dash-up perch
m.ground(0, 12, F);
m.ent('P', 3, F - 1);
m.plat(7, 8, F - 7);
m.shards([[7, F - 8], [8, F - 8]]);

// --- act 1: the bridge — crumble spans of five with rock piers of two, the first pier a checkpoint
m.crumble(13, 17, F);
m.ground(18, 19, F);
m.ent('C', 18, F - 1);
m.crumble(20, 24, F);
m.ground(25, 26, F);
m.crumble(27, 31, F);
m.ground(32, 33, F);
m.crumble(34, 38, F);
m.ground(39, 50, F);
m.ent('C', 40, F - 1);
m.ent('h', 45, F - 1);

// --- act 2: the turret gallery — two turrets on ledges four up; a perch nine up between them
m.ground(51, 72, F);
m.ent('C', 52, F - 1);
m.plat(55, 57, F - 4);
m.ent('t', 56, F - 5);
m.plat(63, 65, F - 4);
m.ent('t', 64, F - 5);
m.plat(59, 60, F - 9);
m.shards([[59, F - 10], [60, F - 10]]);
m.ent('C', 70, F - 1);                        // two tiles before the edge: a runner walks through it instead of jumping over it

// --- act 3a: a horizontal platform rides x 74..84 over an ice-shard bed; a dash-up perch above the ride
m.ground(73, 88, F + 3);
m.spikes(73, 88, F + 2);
m.ent('m', 74, F - 2);
m.plat(80, 81, F - 7);
m.shards([[80, F - 8], [81, F - 8]]);

// --- act 3b: the lift's bank; the vertical platform rides rows 11..19 up to the cliff; relic perch beside its top
m.ground(89, 100, F);
m.ent('C', 90, F - 1);
m.ent('M', 95, F - 9);
m.plat(97, 99, F - 13);
m.ent('R', 98, F - 14);
m.shards([[97, F - 14], [99, F - 14]]);

// --- act 4: the summit cliff — a last crumble span under a turret perch, a dash-up perch over the span, the goal
m.ground(101, 106, F - 10);
m.ent('C', 102, F - 11);
m.crumble(107, 110, F - 10);
m.ground(111, 117, F - 10);
m.ent('G', 115, F - 11);
m.plat(112, 113, F - 14);
m.ent('t', 112, F - 15);
m.plat(108, 109, F - 16);
m.shards([[108, F - 17], [109, F - 17]]);

export const m2 = m.def({
  id: 'm2', name: '오로라 다리', en: 'AURORA BRIDGE', biome: 'summit', par: 95, seed: 229,
  hint: '무너지는 다리 위에서는 멈추지 않는다 — 바위 기둥이 숨 쉴 자리다 · 승강 발판은 기다려 탄다 · 포탑은 {stomp} 스톰프로 부순다',
});
