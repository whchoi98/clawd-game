import { describe, expect, it } from 'vitest';
import { MAX_PIT_TILES, SHAFT_WIDTH_TILES } from '../../src/sim/legend.js';
import {
  CHECKPOINT_MAX_GAP, CHECKPOINT_PAR_SEC, SHARD_MAX, SHARD_MIN, ZONE_SHAPES, assertValid, census, checkpointsFor, climbOrder, dumpAt, isVerticalZone,
  room, validate, validateZone, zoneRules, zoneShape, zoneSizeProblem,
  type ZoneMeta,
} from '../../levels/dsl.js';
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

describe('validate error dumps (P2-7)', () => {
  it('an unknown character error carries an ASCII excerpt of the rows around the cell, a column ruler and the (x, y) coordinate', () => {
    const d = flatRoom().def(META);
    d.rows[6] = d.rows[6].slice(0, 23) + 'Q' + d.rows[6].slice(24);
    const errs = validate(d);
    expect(errs).toHaveLength(1);
    const msg = errs[0];
    expect(msg).toMatch(/unknown char 'Q' at \(23,6\)/);
    expect(msg).toContain('(23, 6)');
    // rows y-3..y+3 are listed with their index, and the offending row is among them
    for (let y = 3; y <= 9; y++) expect(msg).toContain(`y=${y} `);
    expect(msg).not.toContain('y=2 ');
    expect(msg).not.toContain('y=10 ');
    expect(msg).toContain(d.rows[6].slice(11, 36));      // ±12 columns around x=23
    // a caret marks the cell under its row, and the ruler shows the tens / units digits of the columns
    const lines = msg.split('\n');
    const rowLine = lines.findIndex((l) => l.startsWith('y=6 '));
    expect(rowLine).toBeGreaterThan(0);
    expect(lines[rowLine + 1]).toMatch(/^\s+\^ \(23, 6\)$/);
    expect(lines[rowLine + 1].indexOf('^')).toBe(lines[rowLine].indexOf('Q'));
    // line 0 is the error, line 1 the excerpt header, then the tens / units ruler rows
    expect(lines[1]).toMatch(/^cell \(23, 6\) — rows 3\.\.9, columns 11\.\.35:$/);
    expect(lines[2]).toMatch(/2 {9}3/);                   // tens row: 2 at column 20, 3 at 30
    expect(lines[3]).toContain('1234567890123456789012345');
  });

  it('every located error (floating spawn, sealed shard, wide pit, narrow shaft, ragged row) ends with a cell dump', () => {
    const floating = room(40, 14).ground(0, 39, 10).ent('P', 2, 7).ent('G', 36, 9).def(META);
    expect(validate(floating)[0]).toMatch(/not standing on rock\ncell \(2, 7\)/);
    const sealed = hollowBox(flatRoom()).set(23, 6, 'o').def(META);
    expect(validate(sealed)[0]).toMatch(/not reachable from P\ncell \(23, 6\)/);
    const pit = room(60, 14).ground(0, 19, 10).ground(21 + MAX_PIT_TILES, 59, 10).ent('P', 2, 9).ent('G', 56, 9).def(META);
    expect(validate(pit)[0]).toMatch(/bottomless pit 8 wide at x=20..27 \(max 7\)\ncell \(20, 13\)/);
    const narrow = room(40, 16).ground(0, 39, 14).wall(10, 4, 11, 2).wall(14, 4, 11, 2).ent('P', 2, 13).ent('G', 36, 13).def(META);
    expect(validate(narrow)[0]).toMatch(/shaft 2 wide between x=11 and x=14[^\n]*\ncell \(12, 4\)/);
    const ragged = flatRoom().def(META);
    ragged.rows[3] = ragged.rows[3] + '.';
    expect(validate(ragged)[0]).toMatch(/row 3 has width 41, expected 40\ncell \(39, 3\)/);
    // the count errors have no cell, so they carry no dump; a duplicate is located at the extra spawn
    const noG = room(40, 14).ground(0, 39, 10).ent('P', 2, 9).def(META);
    expect(validate(noG)[0]).toBe('test: expected exactly one G, found 0');
    expect(validate(flatRoom().ent('G', 30, 9).def(META))[0]).toMatch(/found 2\ncell \(36, 9\)/);   // the second G in scan order
  });

  it('dumpAt clips at the map edges and keeps the caret under the cell', () => {
    const rows = ['abcdef', 'ghijkl', 'mnopqr'];
    const d = dumpAt(rows, 0, 0);
    expect(d).toContain('cell (0, 0) — rows 0..2, columns 0..5:');
    const lines = d.split('\n');
    expect(lines[3]).toMatch(/^y=0 abcdef$/);
    expect(lines[4].indexOf('^')).toBe(lines[3].indexOf('a'));
    expect(lines).toHaveLength(7);   // header, 2 ruler rows, 3 rows, 1 caret
  });
});

describe('Room marks (P2-7)', () => {
  it('mark / at round-trip and return a copy the caller may mutate', () => {
    const m = room(30, 12).mark('ledge', 12, 5).mark('door', 20, 9);
    expect(m.at('ledge')).toEqual({ x: 12, y: 5 });
    const a = m.at('door');
    a.x += 100;
    expect(m.at('door')).toEqual({ x: 20, y: 9 });
    expect(m.marks()).toEqual({ ledge: { x: 12, y: 5 }, door: { x: 20, y: 9 } });
    // a mark can anchor primitives; re-marking moves it
    const { x, y } = m.at('ledge');
    m.plat(x, x + 3, y).ent('o', x + 1, y - 1).mark('ledge', 13, 5);
    expect(m.rows()[5].slice(12, 16)).toBe('####');
    expect(m.rows()[4][13]).toBe('o');
    expect(m.at('ledge')).toEqual({ x: 13, y: 5 });
  });

  it('refuses unknown names and positions outside the room; marks never reach the LevelDef', () => {
    const m = room(30, 12).mark('a', 1, 1);
    expect(() => m.at('b')).toThrow(/no such mark \(known: a\)/);
    expect(() => m.mark('x', 30, 0)).toThrow(/outside the 30x12 room/);
    expect(() => m.mark('x', 1.5, 0)).toThrow(/non-integer/);
    expect(() => m.mark('', 0, 0)).toThrow(/empty name/);
    const d = m.ground(0, 29, 10).ent('P', 2, 9).ent('G', 27, 9).def(META);
    expect(Object.keys(d)).not.toContain('marks');
    expect(validate(d)).toEqual([]);
  });
});

describe('zone pacing rules (P2-8): validateZone = validate + zoneRules', () => {
  /** A 100-wide zone: flat floor, P at 3, G at 96, `shards` shards on the floor, checkpoints at the given columns. */
  function zone(checkpoints: number[], shards = 10, par = 45) {
    const m = room(100, 16).ground(0, 99, 10).ent('P', 3, 9).ent('G', 96, 9);
    for (const x of checkpoints) m.ent('C', x, 9);
    for (let i = 0; i < shards; i++) m.ent('o', 5 + i * 2, 7);
    return m.def({ ...META, par });
  }

  it('checkpointsFor is ceil(par / 20): 45 s → 3, 55 s → 3, 60 s → 3, 70 s → 4, 120 s → 6', () => {
    expect(CHECKPOINT_PAR_SEC).toBe(20);
    expect([45, 55, 60, 70, 75, 85, 90, 120].map(checkpointsFor)).toEqual([3, 3, 3, 4, 4, 5, 5, 6]);
  });

  it('accepts a zone with enough checkpoints, no marker gap over 32 and 8–12 shards', () => {
    const d = zone([30, 55, 80]);
    expect(zoneRules(d)).toEqual([]);
    expect(validateZone(d)).toEqual([]);
    expect(validate(d)).toEqual([]);
  });

  it('refuses too few checkpoints for the par, naming the count it needs', () => {
    const errs = zoneRules(zone([30, 62]));
    expect(errs.join('\n')).toMatch(/2 checkpoint\(s\) for par 45s — needs at least 3/);
    // a shorter par is content with two (spaced so no gap exceeds 32)
    expect(zoneRules(zone([32, 64], 10, 40))).toEqual([]);
  });

  it(`refuses neighbouring P / C / G markers more than ${CHECKPOINT_MAX_GAP} columns apart, with the cell dump at the far marker`, () => {
    expect(CHECKPOINT_MAX_GAP).toBe(32);
    const errs = zoneRules(zone([36, 60, 80]));   // P at 3 → C at 36 is 33 apart
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/P at \(3,9\) and C at \(36,9\) are 33 columns apart \(max 32\)\ncell \(36, 9\)/);
    // the gap is read between neighbours in column order, G included
    const tail = zoneRules(zone([30, 60, 63]));    // C at 63 → G at 96 is 33 apart
    expect(tail.join('\n')).toMatch(/C at \(63,9\) and G at \(96,9\) are 33 columns apart/);
    expect(zoneRules(zone([35, 64, 67]))).toEqual([]);   // 32 is allowed
  });

  it(`refuses fewer than ${SHARD_MIN} or more than ${SHARD_MAX} shards`, () => {
    expect(zoneRules(zone([30, 55, 80], 7)).join('\n')).toMatch(/7 shards — a zone carries 8..12/);
    expect(zoneRules(zone([30, 55, 80], 13)).join('\n')).toMatch(/13 shards — a zone carries 8..12/);
    expect(zoneRules(zone([30, 55, 80], 8))).toEqual([]);
    expect(zoneRules(zone([30, 55, 80], 12))).toEqual([]);
  });

  it('validateZone reports geometry problems first and the pacing rules only for a geometrically sound zone; validate() alone ignores pacing', () => {
    const d = zone([36, 60, 80], 7);
    expect(validate(d)).toEqual([]);                        // the geometry validator does not know about pacing
    const errs = validateZone(d);
    expect(errs).toHaveLength(2);
    expect(errs.join('\n')).toMatch(/33 columns apart/);
    expect(errs.join('\n')).toMatch(/7 shards/);
    const broken = { ...d, rows: d.rows.map((r, y) => (y === 9 ? r.replace('G', '.') : r)) };
    expect(validateZone(broken).join('\n')).toMatch(/exactly one G/);
    expect(validateZone(broken).join('\n')).not.toMatch(/shards/);
    // test rooms and chunk rooms keep using validate(): a one-shard flat room is still sound
    expect(validate(flatRoom().def(META))).toEqual([]);
    expect(zoneRules(flatRoom().def(META)).join('\n')).toMatch(/0 checkpoint\(s\)/);
  });
});

describe('vertical zones (P2-10): shape envelope, climb-order spacing, tower frame', () => {
  /** A 44 x 64 tower: base, P at the bottom, G on a summit deck, ledges carrying the checkpoints given as [x, y] standing cells. */
  function towerZone(checkpoints: [number, number][], shards = 10, par = 90) {
    const m = room(44, 64).tower();
    m.ent('P', 21, 59);
    m.ground(2, 20, 6, 2).ent('G', 6, 5);
    for (const [x, y] of checkpoints) m.plat(x - 1, x + 1, y + 1).ent('C', x, y);
    for (let i = 0; i < shards; i++) m.ent('o', 4 + i * 3, 58);
    return m.def({ ...META, par });
  }

  it('ZONE_SHAPES names the two envelopes and zoneShape reads taller-than-wide as vertical', () => {
    expect(ZONE_SHAPES).toEqual({ horizontal: { cols: [60, 120], rows: [16, 30] }, vertical: { cols: [36, 48], rows: [60, 100] } });
    expect(zoneShape(room(100, 16).def(META))).toBe('horizontal');
    expect(zoneShape(room(44, 64).def(META))).toBe('vertical');
    expect(zoneShape(room(40, 40).def(META))).toBe('horizontal');     // square reads as a room
    expect(isVerticalZone(room(44, 64).def(META))).toBe(true);
    expect(isVerticalZone(flatRoom().def(META))).toBe(false);
  });

  it('zoneSizeProblem accepts both envelopes at their limits and refuses everything between and beyond', () => {
    for (const [w, h] of [[60, 16], [120, 30], [100, 20], [36, 60], [48, 100], [44, 72]]) {
      expect(zoneSizeProblem(room(w, h).def(META)), `${w}x${h}`).toBeNull();
    }
    for (const [w, h] of [[59, 16], [121, 30], [100, 15], [100, 31], [44, 59], [35, 64], [49, 64], [44, 101], [40, 40], [50, 50]]) {
      const err = zoneSizeProblem(room(w, h).def(META));
      expect(err, `${w}x${h}`).toMatch(new RegExp(`test: ${w}x${h} is neither a horizontal zone \\(60–120 x 16–30\\) nor a vertical one \\(36–48 x 60–100\\)`));
    }
    // the size rule is one of the zone rules, so validateZone reports it; validate() alone does not
    const small = flatRoom().def(META);
    expect(validate(small)).toEqual([]);
    expect(zoneRules(small).join('\n')).toMatch(/40x14 is neither/);
  });

  it('climbOrder walks the markers bottom to top, and along a shared row from the nearest to the marker before', () => {
    const P = { ch: 'P', x: 21, y: 59 }, G = { ch: 'G', x: 6, y: 5 };
    const a = { ch: 'C', x: 4, y: 48 }, b = { ch: 'C', x: 29, y: 43 }, c = { ch: 'C', x: 39, y: 30 };
    const dLeft = { ch: 'C', x: 10, y: 25 }, dRight = { ch: 'C', x: 31, y: 25 }, e = { ch: 'C', x: 4, y: 12 };
    const order = climbOrder([G, dLeft, e, P, c, a, dRight, b]);
    // rows 59 → 48 → 43 → 30 → 25 (the right bank first, since the climb arrived at x 39) → 25 → 12 → 5
    expect(order).toEqual([P, a, b, c, dRight, dLeft, e, G]);
    // the same shelf reached from the left is walked left to right
    const fromLeft = climbOrder([dLeft, dRight, { ch: 'C', x: 4, y: 30 }]);
    expect(fromLeft.map((m) => m.x)).toEqual([4, 10, 31]);
    expect(climbOrder([])).toEqual([]);
  });

  it('a vertical zone is judged along the climb: Manhattan distance between neighbours, 32 at most, with the far marker dumped', () => {
    // P (21,59) → C (30,46): 9 + 13 = 22 · → C (10,34): 20 + 12 = 32 · → C (30,20): 20 + 14 = 34 ✗ · → G (6,5): 24 + 15 = 39 ✗
    const errs = zoneRules(towerZone([[30, 46], [10, 34], [30, 20], [8, 10]], 10, 90));
    expect(errs.join('\n')).toMatch(/C at \(10,34\) and C at \(30,20\) are 34 tiles apart along the climb \(max 32\)\ncell \(30, 20\)/);
    expect(errs.join('\n')).not.toMatch(/columns apart/);
    // spaced within 32 along the zig-zag it passes, though two of its checkpoints share a column with P (columns never mattered here)
    const ok = towerZone([[30, 46], [10, 34], [21, 22], [8, 10], [21, 47]], 10, 90);
    expect(zoneRules(ok)).toEqual([]);
    expect(validateZone(ok)).toEqual([]);
    // the checkpoint count rule is unchanged: par 90 wants five
    expect(zoneRules(towerZone([[30, 46], [10, 34], [21, 22], [8, 10]], 10, 90)).join('\n')).toMatch(/4 checkpoint\(s\) for par 90s — needs at least 5/);
  });

  it('a horizontal zone still reads columns left to right and reports them as columns', () => {
    const m = room(100, 16).ground(0, 99, 10).ent('P', 3, 9).ent('G', 96, 9);
    for (const x of [36, 60, 80]) m.ent('C', x, 9);
    for (let i = 0; i < 10; i++) m.ent('o', 5 + i * 2, 7);
    expect(zoneRules(m.def(META)).join('\n')).toMatch(/P at \(3,9\) and C at \(36,9\) are 33 columns apart/);
  });

  it('tower() frames the room like the daily tower: side walls the whole height and a base floor', () => {
    const rows = room(12, 10).tower({ wall: 2, base: 3 }).rows();
    for (let y = 0; y < 7; y++) expect(rows[y]).toBe('##........##');
    for (let y = 7; y < 10; y++) expect(rows[y]).toBe('############');
    const thin = room(8, 6).tower({ wall: 1, base: 1 }).rows();
    expect(thin[0]).toBe('#......#');
    expect(thin[5]).toBe('########');
    expect(room(44, 66).tower().rows()[0]).toBe('##' + '.'.repeat(40) + '##');
    expect(() => room(4, 6).tower()).toThrow(/bad wall thickness/);
    expect(() => room(12, 3).tower()).toThrow(/bad base/);
  });

  it('shaft floorDepth limits the floor to a shelf instead of a column to the bottom of the room', () => {
    const shelf = room(14, 20).shaft(5, 2, 12, { floorDepth: 3 }).rows();
    for (let y = 12; y <= 14; y++) expect(shelf[y].slice(3, 11)).toBe('########');
    for (let y = 15; y < 20; y++) expect(shelf[y]).toBe('..............');
    const deep = room(14, 20).shaft(5, 2, 12).rows();
    for (let y = 12; y < 20; y++) expect(deep[y].slice(3, 11)).toBe('########');
    expect(() => room(14, 20).shaft(5, 2, 12, { floorDepth: 0 })).toThrow(/bad floorDepth/);
    // a wall-side shaft: the room edge is one wall, a single pillar the other
    const side = room(12, 20).tower({ wall: 2, base: 4 }).shaft(2, 4, 16, { leftTop: 0, rightTop: 4, floorDepth: 4 }).rows();
    for (let y = 4; y <= 13; y++) expect(side[y].slice(0, 8)).toBe('##....##');
    expect(side[14].slice(0, 8)).toBe('##......');
    expect(side[15].slice(0, 8)).toBe('##......');
  });
});
