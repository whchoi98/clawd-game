/** Campaign guidance and small maps, derived from the authored level data. */
import type { BiomeId, LevelDef } from '../../sim/types.js';
import type { Progress } from '../contracts.js';
import { defaultLevelRecord, unlockedZones } from '../save.js';

export const CHAPTER_COPY: Readonly<Record<BiomeId, string>> = {
  tidepool: '물가에서 익힌 작은 도약이, 긴 여정의 시작이 된다.',
  stormspire: '바람을 읽고, 번개가 스친 자리를 넘어선다.',
  voidreef: '사라지는 발판 사이로, 메아리가 길을 잇는다.',
  summit: '모든 도약이 하나로 이어지는 곳. 마지막 빛을 향해.',
};

export function nextObjective(levels: readonly LevelDef[], progress: Progress): LevelDef | null {
  const open = unlockedZones(levels, progress);
  return levels.find((lv) => open.has(lv.id) && !progress.levels[lv.id]?.done) ?? null;
}

/** Explain the actual unlock rule by asking it which earlier clear would open this zone. */
export function unlockHint(def: LevelDef, levels: readonly LevelDef[], progress: Progress): string | null {
  const open = unlockedZones(levels, progress);
  if (open.has(def.id)) return null;
  const i = levels.findIndex((lv) => lv.id === def.id);
  const candidates = levels.slice(Math.max(0, i - 2), i).filter((lv) => {
    const hypothetical = {
      levels: { ...progress.levels, [lv.id]: { ...defaultLevelRecord(), ...progress.levels[lv.id], done: true } },
    };
    return unlockedZones(levels, hypothetical).has(def.id);
  });
  const previous = candidates.find((lv) => open.has(lv.id)) ?? candidates.at(-1);
  return previous ? `${previous.name} 클리어 후 해금` : '앞선 구역을 클리어하면 열린다';
}

export interface CampaignInfo {
  width: number;
  height: number;
  direction: string;
  shards: number;
  relics: number;
  checkpoints: number;
  techniques: string[];
}

export function campaignInfo(def: LevelDef): CampaignInfo {
  const width = def.rows.reduce((n, row) => Math.max(n, row.length), 0);
  const height = def.rows.length;
  const counts = new Map<string, number>();
  for (const row of def.rows) for (const ch of row) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  const techniques: string[] = [];
  for (const [ch, name] of [['D', '대시 연결'], ['k', '스위치 전환'], ['z', '상승기류'], ['b', '거품 발판']] as const) {
    if (counts.has(ch)) techniques.push(name);
  }
  if (!techniques.length) techniques.push(height > width ? '월점프' : '2단 점프', '8방향 대시');
  return {
    width, height, direction: height > width ? '세로 등반' : '가로 횡단',
    shards: counts.get('o') ?? 0, relics: counts.get('R') ?? 0, checkpoints: counts.get('C') ?? 0,
    techniques,
  };
}

const NS = 'http://www.w3.org/2000/svg';
const TERRAIN: Record<string, string> = {
  '#': 'solid', X: 'solid', '=': 'platform',
  '^': 'hazard', V: 'hazard', '{': 'hazard', '}': 'hazard',
  '%': 'switch', '&': 'switch', '~': 'water', W: 'water',
};

/** No fabricated route: the thumbnail draws the level's cells and real markers. */
export function terrainPreview(doc: Document, def: LevelDef, accent: string): SVGSVGElement {
  const { width, height } = campaignInfo(def);
  const svg = doc.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `-1 -1 ${width + 2} ${height + 2}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.setAttribute('class', 'campaign-map');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${def.name} 지형 · 시작, 체크포인트, 도착 지점`);
  const paths = new Map<string, string[]>();
  def.rows.forEach((row, y) => {
    for (let x = 0; x < row.length;) {
      const kind = TERRAIN[row[x]];
      if (!kind) { x++; continue; }
      let end = x + 1;
      while (end < row.length && TERRAIN[row[end]] === kind) end++;
      const list = paths.get(kind) ?? [];
      list.push(`M${x} ${y}h${end - x}v1h-${end - x}z`);
      paths.set(kind, list);
      x = end;
    }
  });
  const colours: Record<string, string> = { solid: '#476574', platform: '#ACCAD0', hazard: '#F28C6A', switch: '#C69CF3', water: '#254C66' };
  for (const [kind, parts] of paths) {
    const path = doc.createElementNS(NS, 'path');
    path.setAttribute('d', parts.join(''));
    path.setAttribute('fill', colours[kind]);
    path.setAttribute('data-terrain', kind);
    svg.appendChild(path);
  }
  const markers: Record<string, { name: string; color: string; radius: number }> = {
    P: { name: 'start', color: '#F3F6F4', radius: 0.85 },
    C: { name: 'checkpoint', color: '#7FE3D6', radius: 0.75 },
    G: { name: 'goal', color: '#F4C95D', radius: 1.05 },
    o: { name: 'shard', color: '#7FE3D6', radius: 0.35 },
    R: { name: 'relic', color: '#F4C95D', radius: 0.6 },
    D: { name: 'crystal', color: '#A7F3E8', radius: 0.45 },
  };
  def.rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const marker = markers[row[x]];
      if (!marker) continue;
      const circle = doc.createElementNS(NS, 'circle');
      circle.setAttribute('cx', String(x + 0.5));
      circle.setAttribute('cy', String(y + 0.5));
      circle.setAttribute('r', String(marker.radius));
      circle.setAttribute('fill', marker.color);
      circle.setAttribute('data-marker', marker.name);
      if (marker.radius > 0.6) { circle.setAttribute('stroke', '#07111C'); circle.setAttribute('stroke-width', '0.3'); }
      svg.appendChild(circle);
    }
  });
  return svg;
}
