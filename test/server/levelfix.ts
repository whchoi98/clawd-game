/**
 * Fixture levels for the server tests. This module must stay a leaf (types
 * only, no app imports): the vi.mock factories import it while the app module
 * graph is still being evaluated, and importing anything from that graph here
 * would deadlock the import.
 */
import type { LevelDef } from '../../src/sim/types.js';
import type { Mode } from '../../src/shared/protocol.js';

export const FIX_T1: LevelDef = {
  id: 't1', name: '조수 웅덩이 I', en: 'Tide Pools I', biome: 'tidepool', par: 45, seed: 1001,
  hint: '점프로 시작하세요',
  rows: [
    '..........',
    'P........G',
    '##########',
  ],
};

export function fixDaily(seed: number): LevelDef {
  return {
    id: 'daily', name: '데일리 타워', en: 'Daily Tower', biome: 'tidepool', par: 120, seed, tide: true, baseY: 2,
    rows: ['....G.....', '..........', 'P.........', '##########'],
  };
}

export function fakeResolveLevel(mode: Mode, levelId: string, seed: number): LevelDef | null {
  if (mode === 'daily') return levelId === 'daily' ? fixDaily(seed) : null;
  return levelId === 't1' ? FIX_T1 : null;
}
