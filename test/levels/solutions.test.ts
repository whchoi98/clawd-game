/**
 * The golden replay corpus is the regression net for every physics and level
 * change: each story zone must either carry a solution that a fresh Sim
 * replays to a death-free clear inside par × 1.2, or be listed in
 * levels/solutions/PENDING.json with a reason. A zone in neither — or in
 * both — fails. src/sim/echoes.generated.ts must match the corpus on disk.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ECHOES_PATH, ZONES, renderEchoes, solutionProblem } from '../../levels/build.js';
import { readPending, readSolution, readSolutions, staleReason } from '../../levels/solutions.js';
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

  it('src/sim/echoes.generated.ts is up to date with the solutions on disk and carries only verified entries', () => {
    const solutions = readSolutions(ZONES.map((z) => z.id));
    const { src, warnings } = renderEchoes(ZONES, solutions);
    expect(warnings, warnings.join('\n')).toEqual([]);
    expect(readFileSync(ECHOES_PATH, 'utf8')).toBe(src);
    expect(Object.keys(GOAL_ECHOES).sort()).toEqual(Object.keys(solutions).sort());
    for (const [id, echo] of Object.entries(GOAL_ECHOES)) {
      const sol = solutions[id];
      expect(echo).toEqual({ sim: sol.sim, rev: sol.rev, seed: sol.seed, masks: sol.masks, ticks: sol.ticks });
    }
  });

  it('renderEchoes skips a solution whose sim / rev no longer match, with a warning, and never emits it', () => {
    const t1 = ZONES[0];
    const sol = readSolution(t1.id);
    if (!sol) return;   // nothing to check while t1 is pending
    const stale = { ...sol, sim: sol.sim + 1 };
    const out = renderEchoes([t1], { [t1.id]: stale });
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatch(/t1: solution skipped — recorded on sim v3, this build is v2/);
    expect(out.src).not.toContain('t1:');
    const rev = renderEchoes([t1], { [t1.id]: { ...sol, rev: 7 } });
    expect(rev.warnings[0]).toMatch(/recorded at rev 7, the zone is at rev 0/);
    expect(solutionProblem(t1, { ...sol, masks: encodeMasks(new Uint8Array(200)) })).toMatch(/does not verify|does not clear/);
    expect(solutionProblem(t1, sol)).toBeNull();
  });
});
