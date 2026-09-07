/**
 * Two golden replay corpora.
 *
 * The FAST corpus (levels/solutions/<id>.json) is the regression net for every
 * physics and level change: each story zone must either carry a solution that
 * a fresh Sim replays to a death-free clear inside par × 1.2, or be listed in
 * levels/solutions/PENDING.json with a reason. A zone in neither — or in
 * both — fails.
 *
 * The PACED corpus (levels/solutions/par/<id>.json) feeds GOAL_ECHOES: a
 * human-looking death-free clear whose time sits at 0.95–1.10 × par. A zone
 * may instead be listed in par/PENDING.json with the ratio it reached; the
 * closest verified clear may still be on disk and then only has to clear.
 * src/sim/echoes.generated.ts must be rendered from the paced corpus with the
 * fast corpus as the fallback.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ECHOES_PATH, ZONES, renderEchoes, solutionProblem } from '../../levels/build.js';
import { PACE_WINDOW, inPaceWindow, readPending, readSolution, readSolutions, staleReason } from '../../levels/solutions.js';
import { LEVELS } from '../../src/sim/levels.generated.js';
import { GOAL_ECHOES } from '../../src/sim/echoes.generated.js';
import { Sim } from '../../src/sim/sim.js';
import { decodeMasks, encodeMasks, verifyReplay } from '../../src/sim/replay.js';
import { IN, SIM_VERSION } from '../../src/sim/types.js';
import type { RunClaim } from '../../src/sim/types.js';

const pending = readPending();

describe('levels/solutions — golden replays', () => {
  for (const def of LEVELS) {
    it(`${def.id} (${def.name}): a verified death-free clear inside par × 1.2, or a PENDING entry`, () => {
      const sol = readSolution(def.id);
      if (!sol) {
        expect(pending[def.id], `${def.id} has neither a solution file nor a PENDING.json entry`).toBeDefined();
        expect(pending[def.id].reason.length).toBeGreaterThan(0);
        return;
      }
      expect(pending[def.id], `${def.id} has a solution and is also listed in PENDING.json`).toBeUndefined();
      expect(staleReason(def, sol)).toBeNull();
      expect(sol.levelId).toBe(def.id);
      expect(sol.sim).toBe(SIM_VERSION);
      expect(sol.rev).toBe(def.rev ?? 0);
      expect(sol.seed).toBe(def.seed);
      expect(sol.deaths).toBe(0);
      expect(Date.parse(sol.recordedAt)).not.toBeNaN();

      const masks = decodeMasks(sol.masks);
      expect(masks.some((m) => (m & IN.RETRY) !== 0)).toBe(false);   // no checkpoint retries hidden in the log

      // the claim comes from a fresh run of the masks, exactly as a client would compute it
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
      expect(v.summary.shards).toBe(sol.shards);
      expect(Math.abs(v.summary.time - sol.time)).toBeLessThan(0.002);
      // the stored masks are the canonical encoding of the decoded log
      expect(encodeMasks(masks)).toBe(sol.masks);
    });
  }

  it('PENDING.json names only real zones, each with a reason', () => {
    const ids = new Set(LEVELS.map((l) => l.id));
    for (const [id, entry] of Object.entries(pending)) {
      expect(ids.has(id), `PENDING.json lists unknown zone '${id}'`).toBe(true);
      expect(typeof entry.reason).toBe('string');
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });

  it('renderEchoes skips a solution whose sim / rev no longer match, with a warning, and never emits it', () => {
    const t1 = ZONES[0];
    const sol = readSolution(t1.id);
    if (!sol) return;   // nothing to check while t1 is pending
    const stale = { ...sol, sim: sol.sim + 1 };
    const out = renderEchoes([t1], { [t1.id]: stale });
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatch(new RegExp(`t1: solution skipped — recorded on sim v${SIM_VERSION + 1}, this build is v${SIM_VERSION}`));
    expect(out.src).not.toContain('t1:');
    expect(out.sources).toEqual({});
    const rev = renderEchoes([t1], { [t1.id]: { ...sol, rev: 7 } });
    expect(rev.warnings[0]).toMatch(new RegExp(`recorded at rev 7, the zone is at rev ${t1.rev ?? 0}`));
    expect(solutionProblem(t1, { ...sol, masks: encodeMasks(new Uint8Array(200)) })).toMatch(/does not verify|does not clear/);
    expect(solutionProblem(t1, sol)).toBeNull();
  });
});

// ---------------------------------------------------------------- paced corpus
const parPending = readPending('par');

/** Replay a solution from scratch; the summary is what the tests judge. */
function replaySolution(def: (typeof LEVELS)[number], sol: NonNullable<ReturnType<typeof readSolution>>) {
  const masks = decodeMasks(sol.masks);
  expect(masks.some((m) => (m & IN.RETRY) !== 0)).toBe(false);
  const v = verifyReplay(def, { v: SIM_VERSION, levelId: def.id, seed: def.seed, assist: false, masks });
  expect(v.ok, `verifyReplay: ${v.reason}`).toBe(true);
  expect(v.summary.cleared).toBe(true);
  expect(v.summary.deaths).toBe(0);
  expect(v.summary.ticks).toBe(sol.ticks);
  expect(v.summary.shards).toBe(sol.shards);
  expect(Math.abs(v.summary.time - sol.time)).toBeLessThan(0.002);
  expect(encodeMasks(masks)).toBe(sol.masks);
  return v.summary;
}

describe('levels/solutions/par — paced golden replays (the 목표 echo and the 개발자 seed)', () => {
  it('PACE_WINDOW is the roadmap window: 95–110 % of par', () => {
    expect(PACE_WINDOW).toEqual({ lo: 0.95, hi: 1.10 });
    expect(inPaceWindow(0.95)).toBe(true);
    expect(inPaceWindow(1.1)).toBe(true);
    expect(inPaceWindow(0.949)).toBe(false);
    expect(inPaceWindow(1.101)).toBe(false);
  });

  for (const def of LEVELS) {
    it(`${def.id} (${def.name}): a death-free clear at 0.95–1.10 × par, or a par/PENDING.json entry (whose clear only has to clear)`, () => {
      const sol = readSolution(def.id, 'par');
      const pend = parPending[def.id];
      if (!sol) {
        expect(pend, `${def.id} has neither a paced solution nor a par/PENDING.json entry`).toBeDefined();
        expect(pend.reason.length).toBeGreaterThan(0);
        return;
      }
      expect(staleReason(def, sol)).toBeNull();
      expect(sol.deaths).toBe(0);
      expect(Date.parse(sol.recordedAt)).not.toBeNaN();
      const s = replaySolution(def, sol);
      const ratio = s.time / def.par;
      if (sol.ratio !== undefined) expect(Math.abs(sol.ratio - ratio)).toBeLessThan(0.002);
      if (pend) {
        // the closest verified clear the solver found, honestly labelled with the ratio it reached
        expect(typeof pend.ratio).toBe('number');
        expect(Math.abs((pend.ratio as number) - ratio)).toBeLessThan(0.01);
        expect(inPaceWindow(ratio), `${def.id} is listed in par/PENDING.json but its clear is inside the window`).toBe(false);
        return;
      }
      expect(ratio, `${def.id}: ${s.time.toFixed(2)}s is ${(ratio * 100).toFixed(0)}% of par ${def.par}`).toBeGreaterThanOrEqual(PACE_WINDOW.lo);
      expect(ratio).toBeLessThanOrEqual(PACE_WINDOW.hi);
    });
  }

  it('a paced clear looks like a person, not a speedrun: fewer dashes than the fast clear and real pauses', () => {
    for (const def of LEVELS) {
      const paced = readSolution(def.id, 'par');
      const fast = readSolution(def.id, 'fast');
      if (!paced || !fast || parPending[def.id]) continue;
      const count = (sol: typeof paced) => {
        const masks = decodeMasks(sol.masks);
        const sim = new Sim(def, { seed: def.seed });
        let idle = 0;
        for (let i = 0; i < masks.length && !sim.finished; i++) { if (masks[i] === 0 && sim.state.phase === 'play') idle++; sim.step(masks[i]); }
        return { dashes: sim.state.stats.dashes, idleSec: idle / 120 };
      };
      const p = count(paced), f = count(fast);
      expect(p.dashes, `${def.id}: paced run dashes ${p.dashes} vs fast ${f.dashes}`).toBeLessThan(f.dashes);
      // pauses are only one of the ways the slack is spent (swimming, careful jumps and shard detours are others): a floor, not a share
      expect(p.idleSec, `${def.id}: paced run stands still for ${p.idleSec.toFixed(1)}s`).toBeGreaterThan(def.par * 0.05);
    }
  });

  it('par/PENDING.json names only real zones, each with a reason (and the ratio when a clear exists)', () => {
    const ids = new Set(LEVELS.map((l) => l.id));
    for (const [id, entry] of Object.entries(parPending)) {
      expect(ids.has(id), `par/PENDING.json lists unknown zone '${id}'`).toBe(true);
      expect(typeof entry.reason).toBe('string');
      expect(entry.reason.length).toBeGreaterThan(0);
      if (readSolution(id, 'par')) expect(typeof entry.ratio).toBe('number');
    }
  });

  it('src/sim/echoes.generated.ts is rendered from the paced corpus, falling back to the fast corpus per zone with a warning', () => {
    const ids = ZONES.map((z) => z.id);
    const paced = readSolutions(ids, 'par');
    const fast = readSolutions(ids, 'fast');
    const { src, warnings, sources } = renderEchoes(ZONES, paced, fast);
    expect(readFileSync(ECHOES_PATH, 'utf8')).toBe(src);
    expect(Object.keys(GOAL_ECHOES).sort()).toEqual(Object.keys(sources).sort());
    for (const [id, echo] of Object.entries(GOAL_ECHOES)) {
      const sol = sources[id] === 'paced' ? paced[id] : fast[id];
      expect(sources[id], `${id}: a zone with a verified paced solution must not fall back`).toBe(paced[id] && !solutionProblem(ZONES.find((z) => z.id === id)!, paced[id]) ? 'paced' : 'fast');
      expect(echo).toEqual({ sim: sol.sim, rev: sol.rev, seed: sol.seed, masks: sol.masks, ticks: sol.ticks });
    }
    // every warning is either a fallback (zone without a paced solution) or a skip (zone without any)
    for (const w of warnings) expect(w).toMatch(/falls back to the fast corpus|solution skipped/);
    expect(warnings.filter((w) => w.includes('falls back')).length).toBe(Object.values(sources).filter((s) => s === 'fast').length);
  });

  it('renderEchoes falls back to the fast solution when the paced one is missing or stale, and says so', () => {
    const t1 = ZONES[0];
    const fast = readSolution(t1.id, 'fast');
    const paced = readSolution(t1.id, 'par');
    if (!fast) return;
    const missing = renderEchoes([t1], {}, { [t1.id]: fast });
    expect(missing.sources).toEqual({ t1: 'fast' });
    expect(missing.warnings).toHaveLength(1);
    expect(missing.warnings[0]).toMatch(/t1: no paced solution — goal echo falls back to the fast corpus/);
    expect(missing.src).toContain(`masks: '${fast.masks}'`);
    if (paced) {
      const stale = renderEchoes([t1], { [t1.id]: { ...paced, sim: paced.sim + 1 } }, { [t1.id]: fast });
      expect(stale.sources).toEqual({ t1: 'fast' });
      expect(stale.warnings[0]).toMatch(new RegExp(`recorded on sim v${SIM_VERSION + 1}, this build is v${SIM_VERSION} — goal echo falls back`));
      const good = renderEchoes([t1], { [t1.id]: paced }, { [t1.id]: fast });
      expect(good.sources).toEqual({ t1: 'paced' });
      expect(good.warnings).toEqual([]);
      expect(good.src).toContain(`masks: '${paced.masks}'`);
    }
    const none = renderEchoes([t1], {}, {});
    expect(none.sources).toEqual({});
    expect(none.warnings[0]).toMatch(/t1: solution skipped — no paced solution; no fast solution either/);
  });
});
