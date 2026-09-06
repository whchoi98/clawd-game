import { describe, expect, it } from 'vitest';
import { MAX_PIT_TILES, SHAFT_WIDTH_TILES } from '../../src/sim/legend.js';
import { assertValid, census, room, validate, type ZoneMeta } from '../../levels/dsl.js';
import type { LevelDef } from '../../src/sim/types.js';

const META: ZoneMeta = { id: 'test', name: '테스트', en: 'TEST', biome: 'tidepool', par: 10, seed: 1, hint: '힌트' };

/** A sound 40x14 room: flat floor, P left, G right, a shard in between. */
function flatRoom() {
  return room(40, 14).ground(0, 39, 10).ent('P', 2, 9).ent('G', 36, 9).ent('o', 20, 8);
}

/** A hollow rock box at x 20..26, y 4..8 (interior 21..25 x 5..7) floating above the floor. */
function hollowBox(m: ReturnType<typeof flatRoom>) {
  return m.block(20, 26, 4, 8).fill(21, 25, 5, 7, '.');
}

describe('Room primitives', () => {
  it('builds a rectangular grid of the requested size', () => {
    const rows = room(12, 5).rows();
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(r).toHaveLength(12);
    expect(rows.join('')).toBe('.'.repeat(60));
  });

  it('ground fills from the row to the bottom, or to a depth', () => {
    const m = room(6, 6).ground(1, 2, 3).ground(4, 4, 1, 2);
    expect(m.rows()).toEqual([
      '......',
      '....#.',
      '....#.',
      '.##...',
      '.##...',
      '.##...',
    ]);
  });

  it('plat / owp / crumble / spikes / water / wall emit the legend characters', () => {
    const m = room(10, 6)
      .plat(0, 2, 0).owp(3, 5, 0).crumble(6, 8, 0)
      .spikes(0, 1, 1).spikes(2, 3, 1, 'down').spikes(4, 4, 1, 'right').spikes(5, 5, 1, 'left')
      .water(0, 3, 3, 5)
      .wall(9, 1, 5)
      .switchA(6, 7, 3).switchB(6, 7, 4);
    expect(m.rows()).toEqual([
      '###===XXX.',
      '^^VV{}...#',
      '.........#',
      '~~~~..%%.#',
      'WWWW..&&.#',
      'WWWW.....#',
    ]);
  });

  it('shaft is exactly SHAFT_WIDTH_TILES wide with a two-tile doorway above the floor', () => {
    const m = room(14, 14).shaft(5, 2, 12);
    const rows = m.rows();
    // walls at x 3..4 and 9..10 from y=2 to y=9; rows 10 and 11 open; floor from 12
    for (let y = 2; y <= 9; y++) {
      expect(rows[y].slice(3, 11)).toBe('##....##');
    }
    expect(rows[10].slice(3, 11)).toBe('........');
    expect(rows[11].slice(3, 11)).toBe('........');
    expect(rows[12].slice(3, 11)).toBe('########');
    expect(rows[13].slice(3, 11)).toBe('########');
    expect(rows[5].slice(5, 9)).toHaveLength(SHAFT_WIDTH_TILES);
  });

  it('shaft honours asymmetric wall tops so one side is the exit', () => {
    const rows = room(14, 16).shaft(5, 3, 14, { leftTop: 5 }).rows();
    expect(rows[3].slice(3, 11)).toBe('......##');
    expect(rows[4].slice(3, 11)).toBe('......##');
    expect(rows[5].slice(3, 11)).toBe('##....##');
    expect(rows[11].slice(3, 11)).toBe('##....##');
    expect(rows[12].slice(3, 11)).toBe('........');
  });

  it('shaft refuses walls shorter than the wall-jump minimum', () => {
    expect(() => room(14, 14).shaft(5, 6, 12)).toThrow(/walls too short/);
  });

  it('arc lays a lobbed shard trail whose apex is above both ends', () => {
    const m = room(20, 12).arc(2, 10, 10, 10, 6);
    const rows = m.rows();
    const ys: number[] = [];
    for (let y = 0; y < 12; y++) for (let x = 0; x < 20; x++) if (rows[y][x] === 'o') ys.push(y);
    expect(m.count('o')).toBe(6);
    expect(Math.min(...ys)).toBeLessThan(10);
    expect(rows[10][2]).toBe('o');
    expect(rows[10][10]).toBe('o');
  });

  it('rejects unknown characters and non-spawn entities', () => {
    expect(() => room(4, 4).set(0, 0, 'Q')).toThrow(/unknown char/);
    expect(() => room(4, 4).ent('#', 0, 0)).toThrow(/not a spawn/);
  });

  it('def() attaches metadata and the rows', () => {
    const d = flatRoom().def({ ...META, spikers: [[5, 9]] });
    expect(d.id).toBe('test');
    expect(d.rows).toHaveLength(14);
    expect(d.spikers).toEqual([[5, 9]]);
    expect(d.tide).toBeUndefined();
    expect(census(d)).toMatchObject({ w: 40, h: 14, shards: 1, relics: 0, checkpoints: 0 });
  });
});

describe('validate', () => {
  it('accepts a sound room', () => {
    expect(validate(flatRoom().def(META))).toEqual([]);
    expect(() => assertValid(flatRoom().def(META))).not.toThrow();
  });

  it('rejects non-rectangular rows', () => {
    const d = flatRoom().def(META);
    d.rows[3] = d.rows[3] + '.';
    expect(validate(d).join('\n')).toMatch(/width/);
  });

  it('rejects unknown characters', () => {
    const d = flatRoom().def(META);
    d.rows[0] = 'Q' + d.rows[0].slice(1);
    expect(validate(d).join('\n')).toMatch(/unknown char 'Q'/);
  });

  it('rejects a missing P or G, and duplicates', () => {
    const noP = room(40, 14).ground(0, 39, 10).ent('G', 36, 9).def(META);
    expect(validate(noP).join('\n')).toMatch(/exactly one P/);
    const noG = room(40, 14).ground(0, 39, 10).ent('P', 2, 9).def(META);
    expect(validate(noG).join('\n')).toMatch(/exactly one G/);
    const twoG = flatRoom().ent('G', 30, 9).def(META);
    expect(validate(twoG).join('\n')).toMatch(/exactly one G, found 2/);
  });

  it('rejects P or G floating in the air', () => {
    const d = room(40, 14).ground(0, 39, 10).ent('P', 2, 7).ent('G', 36, 9).def(META);
    expect(validate(d).join('\n')).toMatch(/P at \(2,7\) is not standing on rock/);
  });

  it('rejects a deliberately sealed chamber holding a shard', () => {
    // a hollow rock box at x 20..26, y 4..8 with a shard inside and no opening
    const d = hollowBox(flatRoom()).set(23, 6, 'o').def(META);
    const errs = validate(d);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/o at \(23,6\) is not reachable/);
    // the same chamber with a doorway is fine
    expect(validate(hollowBox(flatRoom()).set(20, 6, '.').set(23, 6, 'o').def(META))).toEqual([]);
  });

  it('rejects a goal sealed behind a wall to the ceiling', () => {
    const d = flatRoom().wall(30, 0, 9).def(META);
    expect(validate(d).join('\n')).toMatch(/G at \(36,9\) is not reachable/);
  });

  it('treats crumble, one-way, water and spikes as passable for reachability', () => {
    // a shard boxed by X = ~ ^ walls only
    const d = flatRoom()
      .crumble(20, 26, 4).owp(20, 26, 8).fill(20, 20, 5, 7, 'X').fill(26, 26, 5, 7, '^')
      .set(23, 6, 'o').def(META);
    expect(validate(d)).toEqual([]);
  });

  it('accepts a shard reachable in only one switch polarity, rejects one sealed in both', () => {
    // shard behind a '&' door (open at start) — reachable in polarity A
    const behindB = hollowBox(flatRoom()).switchB(20, 20, 6).set(23, 6, 'o').def(META);
    expect(validate(behindB)).toEqual([]);
    // shard behind a '%' door (closed at start, opens after a toggle) — reachable in polarity B
    const behindA = hollowBox(flatRoom()).switchA(20, 20, 6).set(23, 6, 'o').def(META);
    expect(validate(behindA)).toEqual([]);
    // shard behind '%' AND '&' in series — never reachable
    const both = hollowBox(flatRoom()).wall(19, 4, 8).switchA(19, 19, 6).switchB(20, 20, 6).set(23, 6, 'o').def(META);
    expect(validate(both).join('\n')).toMatch(/o at \(23,6\) is not reachable/);
  });

  it('lets the polarity flip at a toggle: alternating % and & gates with k between them are passable', () => {
    // % gate, then a toggle, then a & gate — needs polarity B for the first and A for the second
    const gated = room(40, 14).ground(0, 39, 10).ent('P', 2, 9).ent('G', 36, 9)
      .switchA(12, 12, 0, 9).ent('k', 18, 9).switchB(24, 24, 0, 9).def(META);
    expect(validate(gated)).toEqual([]);
    // the same gates with no toggle between them: sealed in both polarities
    const sealed = room(40, 14).ground(0, 39, 10).ent('P', 2, 9).ent('G', 36, 9)
      .switchA(12, 12, 0, 9).switchB(24, 24, 0, 9).def(META);
    expect(validate(sealed).join('\n')).toMatch(/G at \(36,9\) is not reachable/);
  });

  it(`rejects a bottomless pit wider than ${MAX_PIT_TILES} tiles and accepts one at the limit`, () => {
    const ok = room(60, 14).ground(0, 19, 10).ground(20 + MAX_PIT_TILES, 59, 10).ent('P', 2, 9).ent('G', 56, 9).def(META);
    expect(validate(ok)).toEqual([]);
    const bad = room(60, 14).ground(0, 19, 10).ground(21 + MAX_PIT_TILES, 59, 10).ent('P', 2, 9).ent('G', 56, 9).def(META);
    expect(validate(bad).join('\n')).toMatch(new RegExp(`bottomless pit ${MAX_PIT_TILES + 1} wide at x=20`));
  });

  it('a pit floored by water or spikes is not bottomless', () => {
    const d = room(60, 14).ground(0, 19, 10).ground(32, 59, 10).water(20, 31, 12, 13).ent('P', 2, 9).ent('G', 56, 9).def(META);
    expect(validate(d)).toEqual([]);
  });

  it('accepts a 4-wide shaft and rejects 2-wide and 6-wide ones', () => {
    const good = room(40, 16).ground(0, 39, 14).shaft(10, 2, 14).ent('P', 2, 13).ent('G', 36, 13).def(META);
    expect(validate(good)).toEqual([]);

    const narrow = room(40, 16).ground(0, 39, 14).wall(10, 4, 11, 2).wall(14, 4, 11, 2).ent('P', 2, 13).ent('G', 36, 13).def(META);
    expect(validate(narrow).join('\n')).toMatch(/shaft 2 wide between x=11 and x=14/);

    const wide = room(40, 16).ground(0, 39, 14).wall(10, 4, 11, 2).wall(18, 4, 11, 2).ent('P', 2, 13).ent('G', 36, 13).def(META);
    expect(validate(wide).join('\n')).toMatch(/shaft 6 wide between x=11 and x=18/);
  });

  it('short facing walls are steps, not shafts', () => {
    const d = room(40, 16).ground(0, 39, 14).wall(10, 10, 13, 2).wall(14, 10, 13, 2).ent('P', 2, 13).ent('G', 36, 13).def(META);
    expect(validate(d)).toEqual([]);
  });

  it('the map edge counts as a wall for the shaft rule', () => {
    const d = room(40, 16).ground(0, 39, 14).wall(2, 2, 11, 2).ent('P', 10, 13).ent('G', 36, 13).def(META);
    expect(validate(d).join('\n')).toMatch(/shaft 2 wide between x=-1 and x=2/);
  });

  it('assertValid throws with every problem listed', () => {
    const d: LevelDef = { ...flatRoom().def(META), rows: hollowBox(flatRoom()).set(23, 6, 'o').set(24, 6, 'R').rows() };
    expect(() => assertValid(d)).toThrow(/o at \(23,6\)[\s\S]*R at \(24,6\)/);
  });

  it('a 7- or 8-wide space between tall walls is a yard, not a shaft', () => {
    const d = room(40, 16).ground(0, 39, 14).wall(10, 4, 11, 2).wall(19, 4, 11, 2).ent('P', 2, 13).ent('G', 36, 13).def(META);
    expect(validate(d)).toEqual([]);
  });

  it('rejects hints that name raw keys and accepts token templates', () => {
    for (const bad of ['← → 이동 · 점프', 'SHIFT 대시', 'Shift 대시', 'Space 점프', 'A/D 이동', 'R 재시작', '↓ 스톰프']) {
      const errs = validate(flatRoom().def({ ...META, hint: bad }));
      expect(errs, bad).toHaveLength(1);
      expect(errs[0]).toMatch(/hint names a raw key/);
      expect(errs[0]).toMatch(/\{move\} \{jump\} \{dash\} \{stomp\} \{down\}/);
    }
    for (const ok of ['{move} 이동 · {jump} 점프 · 공중에서 {jump} 한 번 더', '{dash} 대시', 'DASH 버튼과 JUMP 버튼', '무너지는 발판은 0.4초']) {
      expect(validate(flatRoom().def({ ...META, hint: ok })), ok).toEqual([]);
    }
    // a hint problem is reported alongside geometry problems, and assertValid refuses it
    const noG = room(40, 14).ground(0, 39, 10).ent('P', 2, 9).def({ ...META, hint: 'Space 점프' });
    expect(validate(noG).join('\n')).toMatch(/exactly one G[\s\S]*hint names a raw key|hint names a raw key[\s\S]*exactly one G/);
    expect(() => assertValid(flatRoom().def({ ...META, hint: '← →' }))).toThrow(/hint names a raw key/);
  });
});
