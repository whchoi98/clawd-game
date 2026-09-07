/**
 * Tuning constants. Ported from the reference PHYS table — these are the
 * product of playtesting and are not to be retuned blind.
 * Units: world units and seconds. TILE = 16; the player is 11 x 15.
 */
import type { Rank } from './types.js';

export const PLAYER_W = 11;
export const PLAYER_H = 15;

export const PHYS = {
  // horizontal
  maxRun: 132,
  accelGround: 1150,
  accelAir: 820,
  frictionGround: 1500,
  frictionAir: 260,
  turnBoost: 1.9,

  // vertical
  gravity: 860,
  gravityFall: 1120,
  gravityApex: 620,
  apexWindow: 42,
  maxFall: 340,
  jumpVel: -272,      // ≈ 2.7 tiles
  jumpVel2: -238,
  jumpCut: 0.42,
  coyote: 0.095,
  jumpBuffer: 0.13,
  maxJumps: 2,

  // dash
  dashSpeed: 300,
  dashTime: 0.145,
  dashEndSpeed: 168,
  dashCooldown: 0.22,
  dashGrace: 0.06,

  // wall
  wallSlide: 62,
  wallStick: 0.1,
  wallJumpX: 168,
  wallJumpY: -258,
  wallJumpLock: 0.13,

  // misc
  stompVel: 400,
  stompBounce: -300,
  springVel: -430,
  hurtInvuln: 1.35,
  hurtKnockX: 130,
  hurtKnockY: -170,
  maxHp: 3,
  terminalWater: 90,
  waterGrav: 300,
  waterJump: -190,

  // new in Echo Tower
  crystalRespawn: 2.0,   // seconds before a dash crystal returns
  crumbleDelay: 0.42,
  tideSpeed0: 11,        // tide base speed (units/s)
  tideAccel: 0.42,       // + per second of play
  tideHeightGain: 0.05,  // + per tile of max height
  tideLeash: 26,         // the tide never falls more than this many tiles behind
} as const;

/**
 * Assist mode multiplies / overrides without touching level design. Hearts are
 * an assist feature since SIM_VERSION 3: outside assist every hazard contact is
 * a death, so `maxHp` only ever shows in assist mode (PHYS.maxHp stays the
 * stored value on the player state in both modes).
 */
export const ASSIST = {
  gravity: 0.82,
  gravityFall: 0.8,
  maxJumps: 3,
  maxHp: 3,
  hurtInvuln: 2.2,
  dashCooldown: 0.12,
} as const;

/** Star 1 = clear, star 2 = all shards, star 3 = under par. Ported verbatim. */
export function rankFor(timeSec: number, par: number, shards: number, totalShards: number, deaths: number): Rank {
  const t = timeSec / Math.max(0.001, par);
  let score = 0;
  if (t <= 0.8) score += 3; else if (t <= 1.0) score += 2; else if (t <= 1.35) score += 1;
  if (totalShards > 0 && shards >= totalShards) score += 2;
  else if (totalShards > 0 && shards / totalShards >= 0.6) score += 1;
  if (deaths === 0) score += 2;
  else if (deaths <= 2) score += 1;
  return (['C', 'C', 'B', 'B', 'A', 'A', 'S', 'S'] as Rank[])[Math.min(7, score)];
}

/**
 * Leaderboard score — lower is better. Cleared runs sort by ticks; runs that
 * ended in the tide sort after every clear, by height descended.
 */
export function boardScore(s: { cleared: boolean; ticks: number; height: number }): number {
  if (s.cleared) return s.ticks;
  return 1_000_000_000 + Math.max(0, 100_000 - Math.floor(s.height * 10));
}
