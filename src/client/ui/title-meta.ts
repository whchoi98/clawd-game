/**
 * Title-screen metadata that is not part of the scene machine: the version
 * badge at the bottom of the title (package.json version + build id, so a
 * screenshot or a bug report says which build it came from) and the tower
 * summary under 탑 오르기 (tiers · zones, counted from the level list instead
 * of a hand-written number that goes stale when a tier is added).
 */
import type { LevelDef } from '../../sim/types.js';

export const VERSION_ID = 'title-version';
export const TOWER_NOTE_ID = 'tower-note';

/** Characters of the build id shown next to the version. */
export const BUILD_CHARS = 8;

export interface TitleMeta {
  /** Semantic version from package.json ('dev' when not inlined). */
  version: string;
  /** Build id (content hash) from tools/build.mjs ('dev' when not inlined). */
  build: string;
  levels: readonly Pick<LevelDef, 'id' | 'biome'>[];
}

/** 'v0.3.0 · 빌드 5a9af50a' — a dev tree (no inlined version) reads 'dev'. */
export function formatVersion(version: string, build: string): string {
  const v = version && version !== 'dev' ? `v${version}` : 'dev';
  const b = build && build !== 'dev' ? build.slice(0, BUILD_CHARS) : '';
  return b ? `${v} · 빌드 ${b}` : v;
}

/** '스토리 · 3개 층 · 12개 구역' from the ordered level list (tiers = distinct biomes). */
export function towerSummary(levels: readonly Pick<LevelDef, 'biome'>[]): string {
  const tiers = new Set(levels.map((l) => l.biome)).size;
  return `스토리 · ${tiers}개 층 · ${levels.length}개 구역`;
}

/** Writes both strings into the title DOM; missing elements are ignored (tests, stripped templates). */
export function applyTitleMeta(doc: Pick<Document, 'getElementById'>, meta: TitleMeta): void {
  const ver = doc.getElementById(VERSION_ID);
  if (ver) ver.textContent = formatVersion(meta.version, meta.build);
  const note = doc.getElementById(TOWER_NOTE_ID);
  if (note) note.textContent = towerSummary(meta.levels);
}
