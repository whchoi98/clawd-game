/**
 * Public player identity. The player id is the player's only credential, so
 * it never leaves the server; boards show `playerTag` instead — an HMAC of the
 * id, stable per player and useless for impersonation.
 *
 * The HMAC key is TAG_SECRET when the deployment provides one (index.ts calls
 * `configureTagSecret`); otherwise the daily secret, as before. `AppDeps` is
 * a frozen contract, so the override lives here rather than on deps and the
 * routes ask `tagSecretFor(deps.dailySecret)`.
 */
import { createHmac } from 'node:crypto';

export const PLAYER_TAG_HEX = 12;

let tagSecretOverride: string | undefined;

/** Install (or with undefined / '' clear) the dedicated tag secret. */
export function configureTagSecret(secret: string | undefined): void {
  tagSecretOverride = secret ? secret : undefined;
}

/** The key playerTag and the transfer-code check character use: TAG_SECRET when configured, else the daily secret. */
export function tagSecretFor(dailySecret: string): string {
  return tagSecretOverride ?? dailySecret;
}

/** First 12 hex chars of HMAC-SHA256(key = secret, message = playerId). */
export function playerTag(playerId: string, secret: string): string {
  return createHmac('sha256', secret).update(playerId).digest('hex').slice(0, PLAYER_TAG_HEX);
}
