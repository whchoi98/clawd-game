/**
 * Grid legend. Terrain characters stay in the grid; spawn characters are
 * extracted into `Level.spawns` at load time and replaced with '.'.
 *
 *   grid:  . empty   # solid   = one-way   X crumble   ~ water surface   W water body
 *          ^ V { }  spikes pointing up / down / right / left
 *          %  switch block A (solid while switchA)   &  switch block B (solid while !switchA)
 *   spawn: P player  G goal  C checkpoint  o shard  R relic  S spring  D dash crystal
 *          k switch toggle
 *          w walker  h hopper  f flyer  t turret  c chaser
 *          m platform (horizontal)  M platform (vertical)  s saw  z updraft
 */
export const SOLID_CH = '#X';
export const SWITCH_A = '%';
export const SWITCH_B = '&';
export const ONE_WAY = '=';
export const CRUMBLE = 'X';
export const WATER_SURFACE = '~';
export const WATER_BODY = 'W';
export const SPIKES = '^V{}';
export const SPAWN_CH = 'PGCoRSDkwhftcmMsz';

export const FOE_CH: Record<string, import('./types.js').FoeKind> = {
  w: 'walker', h: 'hopper', f: 'flyer', t: 'turret', c: 'chaser',
};

export const ENTITY_CH: Record<string, import('./types.js').EntityKind> = {
  o: 'shard', R: 'relic', C: 'checkpoint', G: 'goal', S: 'spring', D: 'crystal', k: 'toggle',
  m: 'platH', M: 'platV', s: 'saw', z: 'updraft',
};

/** Maximum bottomless pit a double jump clears, in tiles (level builder rule). */
export const MAX_PIT_TILES = 7;
/** Wall-jump shafts must be exactly this wide, in tiles. */
export const SHAFT_WIDTH_TILES = 4;
