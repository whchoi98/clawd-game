/**
 * t3 — 조수 첨탑 / TIDE SPIRE (tidepool). Teaches the wall-jump shaft; hides
 * the relic on the taller wall top.
 *
 * Shaft topology (from the reference, kept as rules the DSL enforces):
 *   - interior exactly 4 tiles wide — a wall jump carries ~3 tiles, so
 *     alternating walls is the obvious answer;
 *   - walls stop 2 tiles above the floor: you walk in through a doorway;
 *   - a spring on the floor lifts you to where the climb starts;
 *   - rest ledges inside are ONE-WAY so the shaft is never sealed from below;
 *   - no cap: you exit by clearing the lower wall top and standing on it.
 */
import { room } from '../dsl.js';

const m = room(72, 30);

// --- entry yard: an arc of shards and a walker on the sand
m.ground(0, 18, 27);
m.ent('P', 3, 26);
m.arc(4, 26, 12, 26, 5, 'o', 2.5);
m.ent('w', 11, 26);

// --- shaft 1: interior x 21..24, floor y 27, doorway rows 25..26
//     left wall (x 19..20) tops out at 12 — the relic perch; right wall (x 25..26) at 15 — the exit
m.shaft(21, 15, 27, { leftTop: 12 });
m.ent('S', 22, 26);
m.owp(21, 24, 19);
m.ent('C', 24, 18);
m.shards([[22, 24], [23, 24], [22, 21], [23, 21], [21, 18], [22, 18], [22, 15], [23, 15], [22, 13], [23, 13]]);
m.ent('R', 20, 11);

// --- mid shelf, level with the right wall top
m.ground(27, 42, 15);
m.ent('h', 34, 14);
m.shards([[30, 13], [33, 13], [36, 13]]);

// --- shaft 2: interior x 45..48, floor y 15, doorway rows 13..14; exit right at 6
m.shaft(45, 6, 15, { leftTop: 3 });
m.ent('S', 46, 14);
m.owp(45, 48, 9);
m.shards([[46, 11], [47, 11], [46, 7], [47, 7]]);

// --- summit run
m.ground(51, 71, 6);
m.ent('f', 60, 2);
m.shards([[56, 4], [59, 4], [62, 4]]);
m.ent('G', 68, 5);

export const t3 = m.def({
  id: 't3', name: '조수 첨탑', en: 'TIDE SPIRE', biome: 'tidepool', par: 70, seed: 29,
  hint: '좁은 통로에서는 좌우 벽을 번갈아 차며 오른다 — 벽에 붙은 순간 점프',
});
