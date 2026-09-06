/**
 * Daily Tower — a finite procedural tower (~150 rows of climb) whose seed the
 * server issues once per UTC day, identical for every player. It uses the same
 * reachability contract as Endless, adds dash crystals, and ends at a summit
 * goal so a run can be cleared and ranked by ticks.
 *
 * The visual band rotates every DAILY_BAND_ROWS rows; `def.biome` is the
 * biome of the bottom band and `bandBiome(def, ty)` gives the band for any row.
 *
 * Since GEN_VERSION 2 every band also carries one or two authored chunks
 * (src/sim/chunks.generated.ts, spliced by buildTower) — the skill ceiling of
 * the daily board. The server regenerates the tower from the seed with this
 * very function before verifying a run, so the chunk list and the splice code
 * are part of the generator's contract: change either, bump GEN_VERSION.
 */
import type { BiomeId, LevelDef } from '../types.js';
import { makeRng } from '../rng.js';
import { buildTower } from './endless.js';
import { CHUNKS } from '../chunks.generated.js';

export const DAILY_ROWS = 160;
export const DAILY_BAND_ROWS = 50;
export const ENDLESS_BAND_ROWS = 90;

/** Tower tier order, bottom band first (kept local so the sim stays free of shared/). */
const BAND_ORDER: BiomeId[] = ['tidepool', 'stormspire', 'voidreef'];

export function makeDailyLevel(seed: number): LevelDef {
  const def = buildTower(seed, {
    id: 'daily',
    name: '오늘의 탑',
    en: 'DAILY TOWER',
    hint: '매일 바뀌는 탑. 조류보다 빨리 정상에 올라라.',
    par: 200,
    rows: DAILY_ROWS,
    crystals: true,
    chunks: CHUNKS,
  });
  // the bottom band's biome is drawn from the seed; the other bands follow the tier order
  const pick = makeRng((seed >>> 0) ^ 0x9e3779b9);
  def.biome = BAND_ORDER[pick.int(0, 2)];
  return def;
}

/**
 * Biome of the band containing tile row `ty`. Bands are counted upward from
 * `def.baseY` (the row the height meter measures from); rows at or below the
 * base belong to band 0 = `def.biome`.
 */
export function bandBiome(def: LevelDef, ty: number, bandRows?: number): BiomeId {
  const rows = bandRows ?? (def.id === 'endless' ? ENDLESS_BAND_ROWS : DAILY_BAND_ROWS);
  const base = def.baseY ?? def.rows.length - 4;
  const band = Math.max(0, Math.floor((base - 1 - ty) / rows));
  const start = Math.max(0, BAND_ORDER.indexOf(def.biome));
  return BAND_ORDER[(start + band) % BAND_ORDER.length];
}
