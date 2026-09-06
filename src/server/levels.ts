/**
 * Maps a (mode, levelId, seed) triple to the LevelDef the server must replay.
 * Story zones come from the generated level table; the daily tower is
 * regenerated from the seed with the same generator the client used.
 */
import type { LevelDef } from '../sim/types.js';
import type { Mode } from '../shared/protocol.js';
import { LEVEL_BY_ID } from '../sim/levels.generated.js';
import { makeDailyLevel } from '../sim/gen/daily.js';

export function resolveLevel(mode: Mode, levelId: string, seed: number): LevelDef | null {
  if (mode === 'daily') {
    return levelId === 'daily' ? makeDailyLevel(seed) : null;
  }
  if (!Object.prototype.hasOwnProperty.call(LEVEL_BY_ID, levelId)) return null;
  return LEVEL_BY_ID[levelId] ?? null;
}
