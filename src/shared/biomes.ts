/**
 * Art direction for the tower tiers (three shipped biomes + the Phase 5 summit). Pure data — shared by the
 * renderer (palettes) and the UI (names). The sim only knows BiomeId.
 */
import type { BiomeId } from '../sim/types.js';

export interface Biome {
  id: BiomeId;
  name: string;   // English
  kr: string;     // Korean
  /** Sequenced music track key for the audio engine. */
  track: string;
  /** Sky gradient, top → horizon. */
  sky: [string, string, string, string];
  skyLight: string;
  sun: { x: number; y: number; r: number; color: string; glow: string; kind: 'disc' | 'glow' };
  fog: string;
  /** Three parallax ridge colours, far → near. */
  ridge: [string, string, string];
  rock: string; rockHi: string; rockDeep: string;
  crust: string; crustHi: string;
  accent: string;
  weather: 'spray' | 'rain' | 'spores' | 'snow';
  /** Occasional full-sky flash (stormspire). */
  lightning: boolean;
  ambient: number;
  spike: { hi: string; mid: string; lo: string };
  props: [string, string];
}

export const BIOMES: Record<BiomeId, Biome> = {
  tidepool: {
    id: 'tidepool', name: 'TIDE POOLS', kr: '조수 웅덩이', track: 'tidepool',
    sky: ['#101B2E', '#1E4A5F', '#3F8C8C', '#F2B48A'], skyLight: '#FFE0C0',
    sun: { x: 0.7, y: 0.34, r: 40, color: '#FFF6E0', glow: '#FFB07A', kind: 'disc' },
    fog: '#5FA9A0', ridge: ['#12283A', '#1C3E52', '#2B5A66'],
    rock: '#3E5A62', rockHi: '#6A8C92', rockDeep: '#20333A',
    crust: '#F28C6A', crustHi: '#FFC7A8', accent: '#7FE3D6',
    weather: 'spray', lightning: false, ambient: 0.06,
    spike: { hi: '#F5FFFF', mid: '#BFDDE0', lo: '#4C6A70' }, props: ['anemone', 'kelp'],
  },
  stormspire: {
    id: 'stormspire', name: 'STORM SPIRE', kr: '폭풍 첨탑', track: 'stormspire',
    sky: ['#07061A', '#15123F', '#2A1F6E', '#5A3A8C'], skyLight: '#C9B8FF',
    sun: { x: 0.3, y: 0.2, r: 26, color: '#F6F0FF', glow: '#9F8CFF', kind: 'disc' },
    fog: '#3A2C6E', ridge: ['#0B0A26', '#161443', '#241E5E'],
    rock: '#3A3560', rockHi: '#5E5790', rockDeep: '#1C1A36',
    crust: '#8F7CFF', crustHi: '#C9BDFF', accent: '#FFD166',
    weather: 'rain', lightning: true, ambient: 0.2,
    spike: { hi: '#F2ECFF', mid: '#B3A8E0', lo: '#463D70' }, props: ['crystal', 'lantern'],
  },
  voidreef: {
    id: 'voidreef', name: 'VOID REEF', kr: '공허의 초', track: 'voidreef',
    sky: ['#020308', '#05091A', '#0A1430', '#12244A'], skyLight: '#6FE7FF',
    sun: { x: 0.5, y: 0.9, r: 110, color: '#2CF0E0', glow: '#0A6E8A', kind: 'glow' },
    fog: '#08304A', ridge: ['#03060F', '#071020', '#0B1A32'],
    rock: '#132A3C', rockHi: '#245068', rockDeep: '#081520',
    crust: '#22E6D2', crustHi: '#B8FFF6', accent: '#FF5BC8',
    weather: 'spores', lightning: false, ambient: 0.16,
    spike: { hi: '#E0FFFF', mid: '#66B8C8', lo: '#123A48' }, props: ['polyp', 'glowvine'],
  },
  // Phase 5: the fourth tier above the clouds — aurora night, glacier rock, snow. Tuned by the
  // background pass (P5-3) against tools/qa/readability.ts: the icy crust (#5FA3D6, L 0.35) keeps
  // the spike outline above 3:1 with margin, the steel fog (#4F86A8) keeps the haze band from
  // washing the updraft column, and the mint accent sits >48 RGB from every sky/crust/ice colour
  // so the goal beacon and the aurora ribbons (accent ↔ skyLight) never read as terrain.
  summit: {
    id: 'summit', name: 'AURORA SUMMIT', kr: '오로라 정점', track: 'summit',
    sky: ['#03040F', '#0B1B3A', '#1E4A6E', '#7FD8E8'], skyLight: '#E8FBFF',
    sun: { x: 0.22, y: 0.18, r: 30, color: '#FFFFFF', glow: '#A8E8FF', kind: 'disc' },
    fog: '#4F86A8', ridge: ['#0A1630', '#15305A', '#2A5A86'],
    rock: '#3A4E6A', rockHi: '#7C9AB8', rockDeep: '#1A2638',
    crust: '#5FA3D6', crustHi: '#D8F4FF', accent: '#9CF5C8',
    weather: 'snow', lightning: false, ambient: 0.12,
    spike: { hi: '#FFFFFF', mid: '#BFDDF0', lo: '#3F6484' }, props: ['pine', 'shrine'],
  },
};

export const BIOME_ORDER: BiomeId[] = ['tidepool', 'stormspire', 'voidreef', 'summit'];

/** Shared colours (character, pickups, hazards). */
export const C = {
  clawd: '#E8825C', clawdHi: '#FFB088', clawdLo: '#B24A3B', shell: '#F2A07A', ink: '#120B14',
  shard: '#5BD8E0', shardHi: '#CFFBFF',
  relic: '#F4C95D', relicHi: '#FFF0BE',
  crystal: '#8BE86A', crystalHi: '#E4FFD6',
  switchA: '#FF8A5B', switchB: '#5BB8FF',
  danger: '#FF4D63', dangerHi: '#FF9AA6',
  spring: '#8BE86A', checkpoint: '#7DE1FF', goal: '#FFE27A',
  enemy: '#7A5CC7', enemyHi: '#B49BFF',
  water: '#2E7FA8', tide: '#8FE6FF',
  echoSelf: '#7FE3D6', echoWorld: '#FF5BC8',
} as const;
