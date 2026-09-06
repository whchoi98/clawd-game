/**
 * Authored tower chunks (roadmap P2-9).
 *
 * Every chunk in levels/chunks must pass the geometry rules of validateChunk(),
 * build a solo room the DSL validator accepts, and carry a golden replay in
 * levels/chunks/solutions/<id>.json that a fresh Sim replays to a death-free
 * clear of that room — the proof the generator may splice it into a daily.
 * src/sim/chunks.generated.ts must be exactly what levels/build.ts renders.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CHUNKS_PATH, chunkProblems, renderChunks } from '../../levels/build.js';
import { CHUNK_SOLUTIONS_DIR, CHUNK_SOURCES, readChunkSolution } from '../../levels/chunks/index.js';
import { readPendingFile, staleReason } from '../../levels/solutions.js';
import { census, validate } from '../../levels/dsl.js';
import { CHUNKS } from '../../src/sim/chunks.generated.js';
import {
  CHUNK_MAX_H, CHUNK_MIN_H, CHUNK_ROOM_PAR, CHUNK_TAGS, CHUNK_W, CHUNK_X0, LEDGE_MAX_W, LEDGE_MIN_W, chunkRoom, chunkRoomSeed, validateChunk,
} from '../../src/sim/gen/chunks.js';
import type { ChunkDef } from '../../src/sim/gen/chunks.js';
import { Level } from '../../src/sim/level.js';
import { Sim } from '../../src/sim/sim.js';
import { decodeMasks, encodeMasks, verifyReplay } from '../../src/sim/replay.js';
import { IN, SIM_VERSION } from '../../src/sim/types.js';
import type { RunClaim } from '../../src/sim/types.js';
import { join } from 'node:path';

const HANGUL = /[가-힣]/;
const pending = readPendingFile(join(CHUNK_SOLUTIONS_DIR, 'PENDING.json'));

describe('levels/chunks — the registry', () => {
  it('holds at least twelve chunks with unique file-safe ids, Korean names and known tags, sorted by id', () => {
    expect(CHUNK_SOURCES.length).toBeGreaterThanOrEqual(12);
    const ids = CHUNK_SOURCES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort());
    for (const c of CHUNK_SOURCES) {
      expect(c.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(c.name).toMatch(HANGUL);
      expect(c.tags.length).toBeGreaterThan(0);
      for (const t of c.tags) expect(CHUNK_TAGS).toContain(t);
    }
  });

  it('covers every tag (dash / wall / crystal / switch) at least twice', () => {
    for (const tag of CHUNK_TAGS) {
      expect(CHUNK_SOURCES.filter((c) => c.tags.includes(tag)).length, tag).toBeGreaterThanOrEqual(2);
    }
  });

  it('is 40 wide and 8–14 tall with 4–9 wide entry / exit ledges, and passes every chunk rule', () => {
    expect(chunkProblems(CHUNK_SOURCES)).toEqual([]);
    for (const c of CHUNK_SOURCES) {
      expect(validateChunk(c)).toEqual([]);
      expect(c.rows.length).toBeGreaterThanOrEqual(CHUNK_MIN_H);
      expect(c.rows.length).toBeLessThanOrEqual(CHUNK_MAX_H);
      for (const r of c.rows) expect(r).toHaveLength(CHUNK_W);
      for (const s of [c.entry, c.exit]) {
        expect(s.x1 - s.x0 + 1).toBeGreaterThanOrEqual(LEDGE_MIN_W);
        expect(s.x1 - s.x0 + 1).toBeLessThanOrEqual(LEDGE_MAX_W);
      }
      // the ledges are surfaces on the bottom / top row
      for (let x = c.entry.x0; x <= c.entry.x1; x++) expect('#=').toContain(c.rows[c.rows.length - 1][x]);
      for (let x = c.exit.x0; x <= c.exit.x1; x++) expect('#=').toContain(c.rows[0][x]);
    }
  });

  it('src/sim/chunks.generated.ts is rendered from the sources and equals CHUNKS', () => {
    const src = renderChunks(CHUNK_SOURCES);
    expect(readFileSync(CHUNKS_PATH, 'utf8')).toBe(src);
    expect(renderChunks(CHUNK_SOURCES)).toBe(src);
    expect(src.startsWith('/**\n * GENERATED — do not edit')).toBe(true);
    expect(CHUNKS.map((c) => c.id)).toEqual(CHUNK_SOURCES.map((c) => c.id));
    for (const c of CHUNK_SOURCES) expect(CHUNKS.find((g) => g.id === c.id)).toEqual(c);
  });
});

describe('validateChunk — the rules a chunk must keep for the generator', () => {
  const base = CHUNK_SOURCES[0];
  const edit = (patch: Partial<ChunkDef>, cells: [number, number, string][] = []): ChunkDef => {
    const rows = base.rows.map((r) => r.split(''));
    for (const [x, y, ch] of cells) rows[y][x] = ch;
    return { ...base, ...patch, rows: rows.map((r) => r.join('')) };
  };

  it('accepts the shipped chunks and refuses a bad id, tag or height', () => {
    expect(validateChunk(base)).toEqual([]);
    expect(validateChunk(edit({ id: 'Bad Id' }))[0]).toMatch(/id must match/);
    expect(validateChunk(edit({ tags: ['dash', 'fly' as never] }))[0]).toMatch(/unknown tag 'fly'/);
    expect(validateChunk({ ...base, rows: base.rows.slice(0, 5) })[0]).toMatch(/height 5/);
  });

  it('refuses start / goal / checkpoint markers and unknown characters', () => {
    expect(validateChunk(edit({}, [[20, 2, 'P']])).join('\n')).toMatch(/'P' at \(20,2\)/);
    expect(validateChunk(edit({}, [[20, 2, 'G']])).join('\n')).toMatch(/'G' at \(20,2\)/);
    expect(validateChunk(edit({}, [[20, 2, 'C']])).join('\n')).toMatch(/'C' at \(20,2\)/);
    expect(validateChunk(edit({}, [[20, 2, '?']])).join('\n')).toMatch(/unknown char '\?'/);
  });

  it('requires the entry and exit ledges to be surfaces of a standard width on the bottom / top row', () => {
    const h = base.rows.length;
    expect(validateChunk(edit({}, [[base.entry.x0, h - 1, '.']])).join('\n')).toMatch(/entry cell/);
    expect(validateChunk(edit({}, [[base.exit.x0, 0, '.']])).join('\n')).toMatch(/exit cell/);
    expect(validateChunk(edit({ entry: { x0: base.entry.x0, x1: base.entry.x0 + 1 } })).join('\n')).toMatch(/entry is 2 wide/);
    expect(validateChunk(edit({ exit: { x0: -1, x1: 5 } })).join('\n')).toMatch(/exit span/);
  });

  it('keeps the landing yard above the entry free of rock, switch blocks and spikes', () => {
    const h = base.rows.length;
    const x = Math.min(CHUNK_W - 1, base.entry.x1 + 3);
    expect(validateChunk(edit({}, [[x, h - 2, '#']])).join('\n')).toMatch(/blocks the landing yard/);
    expect(validateChunk(edit({}, [[x, h - 3, '%']])).join('\n')).toMatch(/blocks the landing yard/);
    expect(validateChunk(edit({}, [[x, h - 2, '^']])).join('\n')).toMatch(/spikes at .* in the landing yard/);
    expect(validateChunk(edit({}, [[x, h - 1, '^']])).join('\n')).toMatch(/beside the entry ledge/);
    // beyond the yard's reach the same rock is fine (when the chunk is wide enough to have such a column)
    const far = base.entry.x1 + 7;
    if (far < CHUNK_W) expect(validateChunk(edit({}, [[far, h - 2, '#']]))).toEqual([]);
  });
});

describe('chunkRoom — the solo room each chunk is proven in', () => {
  for (const c of CHUNK_SOURCES) {
    it(`${c.id}: tower walls, floor under the entry, deck over the exit, exact chunk cells, valid level`, () => {
      const def = chunkRoom(c);
      expect(def.id).toBe(c.id);
      expect(def.seed).toBe(chunkRoomSeed(c.id));
      expect(def.par).toBe(CHUNK_ROOM_PAR);
      expect(def.tide).toBeUndefined();
      expect(validate(def)).toEqual([]);
      const cs = census(def);
      expect(cs.w).toBe(CHUNK_W + 2 * CHUNK_X0);
      expect(cs.h).toBe(c.rows.length + 9);
      // the chunk sits verbatim in the room: P stands on the floor three rows under the entry ledge (the bottom row)
      const lv = new Level(def);
      const P = lv.spawns.find((s) => s.ch === 'P')!, G = lv.spawns.find((s) => s.ch === 'G')!;
      const top = P.ty - 1 - c.rows.length;
      expect(top).toBe(5);                            // two open rows, the deck, two open rows
      for (let y = 0; y < c.rows.length; y++) expect(def.rows[top + y].slice(CHUNK_X0, CHUNK_X0 + CHUNK_W)).toBe(c.rows[y]);
      expect(P.tx).toBeGreaterThanOrEqual(CHUNK_X0 + c.entry.x0);
      expect(P.tx).toBeLessThanOrEqual(CHUNK_X0 + c.entry.x1);
      expect(G.ty).toBe(top - 4);
      expect(lv.solid(P.tx, P.ty + 1)).toBe(true);
      expect(lv.solid(G.tx, G.ty + 1)).toBe(true);
      for (let y = 0; y < lv.h; y++) for (const x of [0, 1, lv.w - 2, lv.w - 1]) expect(lv.solid(x, y)).toBe(true);
    });
  }
});

describe('levels/chunks/solutions — every chunk is clearable (golden replay of its solo room)', () => {
  for (const c of CHUNK_SOURCES) {
    it(`${c.id} (${c.name}): a verified death-free clear inside par × 1.2`, () => {
      const def = chunkRoom(c);
      const sol = readChunkSolution(c.id);
      expect(sol, `${c.id} has no golden replay — run \`npx tsx tools/solve.ts --chunks ${c.id}\`${pending[c.id] ? ` (PENDING: ${pending[c.id].reason})` : ''}`).not.toBeNull();
      if (!sol) return;
      expect(pending[c.id], `${c.id} has a solution and is also listed in PENDING.json`).toBeUndefined();
      expect(staleReason(def, sol)).toBeNull();
      expect(sol.sim).toBe(SIM_VERSION);
      expect(sol.seed).toBe(def.seed);
      expect(sol.deaths).toBe(0);

      const masks = decodeMasks(sol.masks);
      expect(masks.some((m) => (m & IN.RETRY) !== 0)).toBe(false);
      const sim = new Sim(def, { seed: def.seed });
      for (let i = 0; i < masks.length && !sim.finished; i++) sim.step(masks[i]);
      const s = sim.summary();
      const claim: RunClaim = { ticks: s.ticks, shards: s.shards, deaths: s.deaths, cleared: s.cleared, height: s.height };
      const v = verifyReplay(def, { v: SIM_VERSION, levelId: def.id, seed: def.seed, assist: false, masks }, claim);
      expect(v.ok, `verifyReplay: ${v.reason}`).toBe(true);
      expect(v.summary.cleared).toBe(true);
      expect(v.summary.deaths).toBe(0);
      expect(v.summary.time).toBeLessThanOrEqual(def.par * 1.2);
      expect(v.summary.ticks).toBe(sol.ticks);
      expect(encodeMasks(masks)).toBe(sol.masks);
    });
  }

  it('the primary tag names a mechanic the golden clear actually uses (switch chunks flip a toggle, wall chunks wall-jump or dash up the shaft, …)', () => {
    // The fast solver chains dashes wherever it can, so a secondary tag is a design note, not a proof;
    // the first tag is the mechanic the chunk is built around and the clear must show it (or the dash
    // that stands in for it — a shaft can be dashed up as well as wall-jumped).
    for (const c of CHUNK_SOURCES) {
      const sol = readChunkSolution(c.id);
      if (!sol) continue;
      const def = chunkRoom(c);
      const masks = decodeMasks(sol.masks);
      const sim = new Sim(def, { seed: def.seed });
      let crystals = 0, toggles = 0;
      for (let i = 0; i < masks.length && !sim.finished; i++) {
        sim.step(masks[i]);
        for (const e of sim.drainEvents()) {
          if (e.type === 'crystal') crystals++;
          if (e.type === 'toggle') toggles++;
        }
      }
      const st = sim.state.stats;
      switch (c.tags[0]) {
        case 'switch': expect(toggles, `${c.id} toggles`).toBeGreaterThan(0); break;
        case 'dash': expect(st.dashes, `${c.id} dashes`).toBeGreaterThan(0); break;
        case 'wall': expect(st.wallJumps + st.dashes, `${c.id} wall jumps or dashes`).toBeGreaterThan(0); break;
        case 'crystal': expect(crystals + st.dashes, `${c.id} crystals or dashes`).toBeGreaterThan(0); break;
      }
    }
  });

  it('PENDING.json names only real chunks', () => {
    const ids = new Set(CHUNK_SOURCES.map((c) => c.id));
    for (const [id, entry] of Object.entries(pending)) {
      expect(ids.has(id), `PENDING.json lists unknown chunk '${id}'`).toBe(true);
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });
});
