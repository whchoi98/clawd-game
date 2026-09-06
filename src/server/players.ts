/**
 * Public player identity. The player id is the player's only credential, so
 * it never leaves the server; boards show `playerTag` instead — an HMAC of the
 * id under the daily secret, stable per player and useless for impersonation.
 */
import { createHmac } from 'node:crypto';

export const PLAYER_TAG_HEX = 12;

/** First 12 hex chars of HMAC-SHA256(key = secret, message = playerId). */
export function playerTag(playerId: string, secret: string): string {
  return createHmac('sha256', secret).update(playerId).digest('hex').slice(0, PLAYER_TAG_HEX);
}
