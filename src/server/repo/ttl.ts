/**
 * Retention of RUN items. Daily runs carry a 30-day ttl from the moment they
 * are written (runs.ts). Story runs live as long as they are somebody's best;
 * once a better run replaces one, the old RUN item (the replay nobody can
 * reach from a board any more) gets 90 days before DynamoDB TTL removes it.
 */
export const REPLACED_RUN_TTL_SECONDS = 90 * 86_400;

/** Unix-seconds ttl for a run replaced at `replacedAtIso` (the new best's createdAt). */
export function replacedRunTtl(replacedAtIso: string): number {
  const ms = Date.parse(replacedAtIso);
  const base = Number.isFinite(ms) ? ms : Date.now();
  return Math.floor(base / 1000) + REPLACED_RUN_TTL_SECONDS;
}
