// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { campaignInfo, nextObjective, terrainPreview, unlockHint } from '../../src/client/ui/campaign.js';
import { defaultLevelRecord, defaultProgress } from '../../src/client/save.js';
import type { LevelDef } from '../../src/sim/types.js';

const room = (id: string, name: string, biome: LevelDef['biome'] = 'tidepool'): LevelDef => ({
  id, name, en: id, biome, par: 45, seed: 1,
  rows: ['............', '.P.oC.o.R.G.', '####..######'],
});
const zones = [room('a', '물가'), room('b', '바람길'), room('c', '첨탑'), room('d', '폭풍', 'stormspire')];

describe('campaign guidance', () => {
  it('points at the first unfinished accessible zone and explains the tier boundary', () => {
    const p = defaultProgress('test');
    expect(nextObjective(zones, p)?.id).toBe('a');
    expect(unlockHint(zones[1], zones, p)).toBe('물가 클리어 후 해금');
    p.levels.a = { ...defaultLevelRecord(), done: true };
    expect(nextObjective(zones, p)?.id).toBe('b');
    expect(unlockHint(zones[2], zones, p)).toBeNull();
    expect(unlockHint(zones[3], zones, p)).toBe('첨탑 클리어 후 해금');
    p.levels.b = { ...defaultLevelRecord(), done: true };
    p.levels.c = { ...defaultLevelRecord(), done: true };
    p.levels.d = { ...defaultLevelRecord(), done: true };
    expect(nextObjective(zones, p)).toBeNull();
  });

  it('derives collectibles and learning techniques from real terrain, without inventing a record', () => {
    const def = { ...zones[0], rows: ['PDoCoRkz.bG', '###########'] };
    const info = campaignInfo(def);
    expect(info.shards).toBe(2);
    expect(info.relics).toBe(1);
    expect(info.checkpoints).toBe(1);
    expect(info.techniques).toEqual(['대시 연결', '스위치 전환', '상승기류', '거품 발판']);
    expect(info.direction).toBe('가로 횡단');
    expect(info.width).toBe(11);
    expect(info.height).toBe(2);
  });

  it('renders the authored map and its start/checkpoint/goal markers as accessible SVG', () => {
    const def = zones[0];
    const before = JSON.stringify(def);
    const svg = terrainPreview(document, def, '#7FE3D6');
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toContain('물가');
    expect(svg.getAttribute('viewBox')).toBe('-1 -1 14 5');
    expect(svg.querySelectorAll('[data-marker="start"]')).toHaveLength(1);
    expect(svg.querySelectorAll('[data-marker="checkpoint"]')).toHaveLength(1);
    expect(svg.querySelectorAll('[data-marker="goal"]')).toHaveLength(1);
    expect(svg.querySelector('[data-terrain="solid"]')?.getAttribute('d')).toContain('M0 2h4v1h-4z');
    expect(JSON.stringify(def)).toBe(before);
  });
});
