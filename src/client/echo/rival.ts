/**
 * Rival echo (P2-4) — pure helpers behind the 세계 메아리 choice and the live
 * checkpoint splits.
 *
 * The world echo used to be the board's leader only. A leader who is thirty
 * seconds faster teaches nothing, so the default now races the entry ranked
 * just above the player's own ('rival'): beatable, and a rank up when beaten.
 * Without a row of our own the median entry stands in; the leader remains one
 * setting away. Empty boards are the shell's business (the bundled 목표 echo).
 *
 * Splits are whole sim ticks: the live tick at which the player passed a
 * checkpoint minus the tick at which the echo passed the same pillar, so a
 * positive split means the player is behind. Formatting keeps two decimals and
 * an explicit sign ('+0.84s' / '−1.20s' / '±0.00s'); '—' says the echo has not
 * reached that checkpoint yet.
 */
import { TICK_HZ } from '../../sim/types.js';
import type { LeaderboardEntry, LeaderboardResponse } from '../../shared/protocol.js';
import type { EchoWorldMode } from '../save.js';

export type WorldEchoKind = 'top' | 'rival';

export interface WorldEchoPick {
  entry: LeaderboardEntry;
  kind: WorldEchoKind;
}

/** Seconds the split chip stays on the HUD. */
export const SPLIT_SECONDS = 1.5;
/** The chip's text when the echo has not passed the checkpoint the player just reached. */
export const SPLIT_NONE = '—';
export const RIVAL_LABEL = '라이벌';
export const TOP_LABEL = '1위';

export type SplitSign = -1 | 0 | 1;

export interface SplitText {
  text: string;
  /** −1 = the player is ahead · 0 = even (or unknown) · 1 = behind. */
  sign: SplitSign;
}

/** Our own row: the response's `yours`, else the entry the server flagged `you`. */
function ownRow(lb: LeaderboardResponse): LeaderboardEntry | null {
  return lb.yours ?? lb.entries.find((e) => e.you) ?? null;
}

/**
 * Which board entry to run as the world echo, or null when only our own row
 * qualifies (the self echo already runs it). The caller handles the empty board.
 *
 * 'top': the leader. 'rival': the entry ranked just above ours (the closest
 * entry with a strictly better rank); when we lead, the closest chaser; without
 * a row of our own, the median of the others (the upper median: a newcomer
 * gets the friendlier half).
 */
export function pickWorldEcho(lb: LeaderboardResponse, mode: EchoWorldMode): WorldEchoPick | null {
  const sorted = [...lb.entries].sort((a, b) => a.rank - b.rank);
  if (sorted.length === 0) return null;
  const mine = ownRow(lb);
  if (mode === 'top') {
    const top = sorted[0];
    return top.you || (mine !== null && top.runId === mine.runId) ? null : { entry: top, kind: 'top' };
  }
  const others = sorted.filter((e) => !e.you && (mine === null || e.runId !== mine.runId));
  if (others.length === 0) return null;
  if (mine) {
    let above: LeaderboardEntry | null = null;
    for (const e of others) {
      if (e.rank < mine.rank) above = e;
      else break;
    }
    if (above) return { entry: above, kind: 'rival' };
    const below = others.find((e) => e.rank > mine.rank);
    return below ? { entry: below, kind: 'rival' } : null;
  }
  return { entry: others[Math.floor(others.length / 2)], kind: 'rival' };
}

/** "라이벌 · 이름" / "1위 · 이름" — the tag drawn above the echo. */
export function worldEchoLabel(kind: WorldEchoKind, name: string): string {
  return `${kind === 'top' ? TOP_LABEL : RIVAL_LABEL} · ${name}`;
}

/** Split of `dTicks` (player tick − echo tick) as '+0.84s' / '−1.20s' / '±0.00s'. */
export function fmtSplit(dTicks: number): SplitText {
  const secs = Math.round((dTicks / TICK_HZ) * 100) / 100;
  if (!Number.isFinite(secs) || secs === 0) return { text: '±0.00s', sign: 0 };
  const sign: SplitSign = secs > 0 ? 1 : -1;
  return { text: `${sign > 0 ? '+' : '−'}${Math.abs(secs).toFixed(2)}s`, sign };
}

/**
 * The result screen's row: "라이벌보다 0.62s 빠름" / "1위보다 1.20s 느림" /
 * "라이벌과 같은 기록". `deltaTicks` = our ticks − theirs (negative = faster).
 */
export function fmtVersus(label: string, deltaTicks: number): { text: string; secs: string; sign: SplitSign } {
  const secs = Math.round((deltaTicks / TICK_HZ) * 100) / 100;
  if (!Number.isFinite(secs) || secs === 0) return { text: `${label}과 같은 기록`, secs: '0.00s', sign: 0 };
  const abs = `${Math.abs(secs).toFixed(2)}s`;
  return secs < 0
    ? { text: `${label}보다 ${abs} 빠름`, secs: abs, sign: -1 }
    : { text: `${label}보다 ${abs} 느림`, secs: abs, sign: 1 };
}
