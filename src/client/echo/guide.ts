/**
 * Guide echoes — bundled input logs that show a first-time player the way.
 *
 * On the first play of a zone with a guide, the shell adds a translucent
 * '길잡이' echo GUIDE_DELAY seconds in: it runs the recorded masks through a
 * second Sim exactly like a leaderboard ghost, so it needs no assets, never
 * submits and never counts. It disappears at the player's first checkpoint.
 *
 * GUIDE_T1 was recorded by a small reactive bot against the real Sim on t1
 * (seed 5, rev 0): hold right, hop the forgiving gap, the two-tile step and the
 * walker, double-jump the first lethal pit (tiles 41–46), reach the checkpoint
 * at tile 49 and stand still. 1114 ticks (~9.3 s), 0 deaths, 0 hits.
 * Re-record when SIM_VERSION or the t1 geometry (rev) changes; `guideFor`
 * refuses a stale recording, so the guide silently stays away rather than lie.
 */
import { SIM_VERSION } from '../../sim/types.js';
import type { LevelDef } from '../../sim/types.js';
import { decodeMasks } from '../../sim/replay.js';

export const GUIDE_LABEL = '길잡이';
/** Warm dawn tint: distinct from the teal self echo and the magenta world echo. */
export const GUIDE_COLOR = '#FFC7A8';
/** Seconds of play before the guide sets off. */
export const GUIDE_DELAY = 3;

export interface GuideLog {
  /** SIM_VERSION the log was recorded against. */
  v: number;
  levelId: string;
  /** Geometry revision of the zone at recording time (LevelDef.rev, missing = 0). */
  rev: number;
  seed: number;
  /** RLE-base64 masks (src/sim/replay.ts encodeMasks). */
  masks: string;
  /** Decoded length, for the record. */
  ticks: number;
}

export const GUIDE_T1: GuideLog = {
  v: 2,
  levelId: 't1',
  rev: 0,
  seed: 5,
  masks: 'ADYCmRIOAkASDgIpEg4CFRIOAv8CNhIOAhQSDgJrAP8ABg==',
  ticks: 1114,
};

export const GUIDES: Readonly<Record<string, GuideLog>> = { t1: GUIDE_T1 };

/**
 * The decoded guide masks for `def` when a recording exists and still applies
 * (same SIM_VERSION, same geometry revision, same seed); otherwise null.
 */
export function guideFor(def: Pick<LevelDef, 'id' | 'seed' | 'rev'>, seed = def.seed): Uint8Array | null {
  const g = GUIDES[def.id];
  if (!g || g.v !== SIM_VERSION || g.rev !== (def.rev ?? 0) || g.seed !== (seed >>> 0)) return null;
  try {
    return decodeMasks(g.masks);
  } catch {
    return null;
  }
}
