/**
 * Goal echoes — the developer's verified clear of a zone (levels/solutions →
 * src/sim/echoes.generated.ts), run as a translucent '목표' ghost when the world
 * echo cannot be shown: the board is still empty, the player is offline, or
 * the API failed. Like every echo it is a second Sim fed the recorded masks,
 * so it needs no assets and never counts.
 *
 * A recording only applies to the sim version, geometry revision and seed it
 * was made on; `goalEchoFor` refuses anything else so a stale solution stays
 * away rather than lie (see README: 골든 리플레이 재녹화).
 */
import { SIM_VERSION } from '../../sim/types.js';
import type { LevelDef } from '../../sim/types.js';
import { decodeMasks } from '../../sim/replay.js';
import { GOAL_ECHOES } from '../../sim/echoes.generated.js';
import { Echo } from './echo.js';

export const GOAL_LABEL = '목표';
/** Pale gold: apart from the teal self echo, the magenta world echo and the peach guide. */
export const GOAL_COLOR = '#FFE08A';

/** The decoded goal masks for `def` when a current recording exists, else null. */
export function goalMasksFor(def: Pick<LevelDef, 'id' | 'seed' | 'rev'>, seed = def.seed): Uint8Array | null {
  const g = GOAL_ECHOES[def.id];
  if (!g || g.sim !== SIM_VERSION || g.rev !== (def.rev ?? 0) || g.seed !== (seed >>> 0)) return null;
  try {
    return decodeMasks(g.masks);
  } catch {
    return null;
  }
}

/** An Echo of the zone's goal run, or null when no current recording exists. */
export function goalEchoFor(def: LevelDef, color = GOAL_COLOR, label = GOAL_LABEL, seed = def.seed): Echo | null {
  const masks = goalMasksFor(def, seed);
  if (!masks) return null;
  return new Echo(def, masks, seed >>> 0, false, color, label);
}
