/**
 * Board seeding. A story board that nobody has cleared yet looks dead, so at
 * boot every empty story board (the current SIM_VERSION and geometry revision,
 * see boards.ts) receives the developer's goal run from GOAL_ECHOES — the same
 * replay the client shows as the '목표' echo. The run is replayed here before
 * it is written: a solution the shipped sim does not reproduce is skipped.
 *
 * Idempotent and race-safe through `Repo.putIfBoardEmpty`; a repo without it
 * (or SEED_BOARDS=0 in the environment) seeds nothing. Zones without a goal
 * echo are skipped.
 */
import { LEVELS } from '../sim/levels.generated.js';
import { GOAL_ECHOES } from '../sim/echoes.generated.js';
import type { GoalEcho } from '../sim/echoes.generated.js';
import { decodeMasks, verifyReplay } from '../sim/replay.js';
import { boardScore } from '../sim/config.js';
import { SIM_VERSION } from '../sim/types.js';
import type { LevelDef } from '../sim/types.js';
import { storyBoardSuffix } from './boards.js';
import type { Repo, StoredRun } from './repo/types.js';

/** The seeded entries' author. The id matches PlayerRef and never belongs to a real browser. */
export const SEED_PLAYER = { id: 'developer-goal-echo-0001', name: '개발자' } as const;

export interface SeedOptions {
  /** Zones to consider (default: every story zone). */
  levels?: readonly LevelDef[];
  /** Solutions keyed by zone id (default: the bundled GOAL_ECHOES). */
  echoes?: Readonly<Record<string, GoalEcho>>;
  now?: () => Date;
  /** One line per seeded board (and per skipped solution). */
  log?: (line: string) => void;
}

export interface SeedReport {
  /** Zone ids whose board received the goal run. */
  seeded: string[];
  /** Zone ids that had a goal echo but whose board already had entries (or lost the race). */
  occupied: string[];
  /** Zone ids without a usable goal echo, with the reason. */
  skipped: { id: string; reason: string }[];
}

/** Deterministic run id: the same across tasks, so a lost race never leaves a second RUN item. */
export function seedRunId(levelId: string): string {
  return `goal-${levelId}-${storyBoardSuffix(levelId)}`;
}

/** The StoredRun for a zone's goal echo, or the reason there is none. */
export function seedRunFor(def: LevelDef, echo: GoalEcho | undefined, now: Date): { run: StoredRun } | { reason: string } {
  if (!echo) return { reason: 'no goal echo' };
  if (echo.sim !== SIM_VERSION) return { reason: `goal echo is for sim v${echo.sim}, this build is v${SIM_VERSION}` };
  if (echo.rev !== (def.rev ?? 0)) return { reason: `goal echo is for rev ${echo.rev}, the zone is at rev ${def.rev ?? 0}` };
  if (echo.seed !== def.seed) return { reason: `goal echo seed ${echo.seed} differs from the zone seed ${def.seed}` };
  let masks: Uint8Array;
  try {
    masks = decodeMasks(echo.masks);
  } catch (e) {
    return { reason: `goal echo masks do not decode (${e instanceof Error ? e.message : String(e)})` };
  }
  const v = verifyReplay(def, { v: SIM_VERSION, levelId: def.id, seed: def.seed, assist: false, masks });
  if (!v.ok) return { reason: `goal echo does not verify (${v.reason})` };
  if (!v.summary.cleared || v.summary.deaths !== 0) return { reason: 'goal echo is not a death-free clear' };
  const s = v.summary;
  return {
    run: {
      runId: seedRunId(def.id),
      mode: 'story',
      board: def.id,
      levelId: def.id,
      seed: def.seed,
      assist: false,
      masks: echo.masks,
      playerId: SEED_PLAYER.id,
      name: SEED_PLAYER.name,
      score: boardScore(s),
      ticks: s.ticks,
      shards: s.shards,
      deaths: s.deaths,
      cleared: s.cleared,
      height: s.height,
      createdAt: now.toISOString(),
    },
  };
}

/** Seed every empty story board the repo can seed. Never throws for a single zone's bad solution. */
export async function seedBoards(repo: Repo, opts: SeedOptions = {}): Promise<SeedReport> {
  const report: SeedReport = { seeded: [], occupied: [], skipped: [] };
  const put = repo.putIfBoardEmpty;
  if (!put) return report;
  const levels = opts.levels ?? LEVELS;
  const echoes = opts.echoes ?? GOAL_ECHOES;
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});
  for (const def of levels) {
    const made = seedRunFor(def, echoes[def.id], now());
    if ('reason' in made) {
      report.skipped.push({ id: def.id, reason: made.reason });
      if (made.reason !== 'no goal echo') log(`seed: ${def.id} skipped — ${made.reason}`);
      continue;
    }
    const written = await put.call(repo, made.run);
    if (written) {
      report.seeded.push(def.id);
      log(`seed: ${def.id}#${storyBoardSuffix(def.id)} ← ${SEED_PLAYER.name} ${made.run.ticks} ticks (${(made.run.ticks / 120).toFixed(2)} s), ${made.run.shards} shards`);
    } else {
      report.occupied.push(def.id);
    }
  }
  return report;
}

/** SEED_BOARDS=0 turns boot seeding off; anything else (or unset) leaves it on. */
export function seedingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SEED_BOARDS !== '0';
}
