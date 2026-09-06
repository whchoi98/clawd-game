/**
 * Leaderboard tables. One renderer serves the Daily Tower screen (full width)
 * and the result / game-over modals (compact). Names come from other players,
 * so they are always written as text nodes, never markup.
 */
import type { LeaderboardEntry, LeaderboardResponse } from '../../shared/protocol.js';
import { el } from './screens.js';
import { fmtTicks } from './hud.js';

export type LbStatus = 'loading' | 'ok' | 'error';

export interface LeaderboardRenderOptions {
  status?: LbStatus;
  /** Highlights this player's row when the response carries no `yours`. */
  playerId?: string;
  /** Show at most this many entries (yours is appended when it falls outside). */
  limit?: number;
}

/** The record cell: cleared runs show time, tide-drowned runs show the height they reached. */
export function recordText(e: Pick<LeaderboardEntry, 'cleared' | 'ticks' | 'height'>): string {
  return e.cleared ? fmtTicks(e.ticks) : `높이 ${Math.max(0, Math.floor(e.height))}`;
}

function entryRow(doc: Document, e: LeaderboardEntry, you: boolean): HTMLTableRowElement {
  const tr = el(doc, 'tr', { class: you ? 'lb__row is-you' : 'lb__row' });
  tr.append(
    el(doc, 'td', { class: 'lb__rank' }, String(e.rank)),
    el(doc, 'td', { class: 'lb__name', title: e.name }, e.name),
    el(doc, 'td', { class: e.cleared ? 'lb__time' : 'lb__time lb__tide' }, recordText(e)),
    el(doc, 'td', { class: 'lb__shards' }, String(e.shards)),
  );
  return tr;
}

function note(doc: Document, text: string, err = false): HTMLElement {
  return el(doc, 'p', { class: err ? 'lb__note lb__note--err' : 'lb__note' }, text);
}

export function renderLeaderboard(host: HTMLElement, lb: LeaderboardResponse | null, opts: LeaderboardRenderOptions = {}): void {
  const doc = host.ownerDocument;
  const status = opts.status ?? 'ok';
  host.replaceChildren();

  if (!lb) {
    if (status === 'loading') host.appendChild(note(doc, '순위표를 불러오는 중…'));
    else if (status === 'error') host.appendChild(note(doc, '순위표를 불러올 수 없다 · 오프라인', true));
    else host.appendChild(note(doc, '아직 기록이 없다'));
    return;
  }

  const entries = opts.limit ? lb.entries.slice(0, opts.limit) : lb.entries;
  const yours = lb.yours;
  const yoursId = yours?.playerId ?? opts.playerId;

  if (!entries.length && !yours) {
    host.appendChild(note(doc, '아직 기록이 없다 · 첫 메아리를 남겨 보자'));
    return;
  }

  const total = Math.max(lb.total, lb.entries.length);
  const head = el(doc, 'p', { class: 'lb__you' });
  if (yours) {
    head.append(el(doc, 'span', {}, '내 순위 ', el(doc, 'b', {}, `${yours.rank}위`)), el(doc, 'span', {}, `${total.toLocaleString('ko-KR')}명 참가`));
  } else {
    head.append(el(doc, 'span', {}, '내 순위 —'), el(doc, 'span', {}, `${total.toLocaleString('ko-KR')}명 참가`));
  }
  host.appendChild(head);

  const table = el(doc, 'table', { class: 'lb__table' });
  const thead = el(doc, 'thead', {}, el(doc, 'tr', {},
    el(doc, 'th', { scope: 'col' }, '순위'),
    el(doc, 'th', { scope: 'col' }, '이름'),
    el(doc, 'th', { scope: 'col', class: 'lb__time' }, '기록'),
    el(doc, 'th', { scope: 'col', class: 'lb__shards' }, '파편'),
  ));
  const tbody = el(doc, 'tbody');
  let yoursShown = false;
  for (const e of entries) {
    const you = yoursId !== undefined && e.playerId === yoursId;
    yoursShown ||= you;
    tbody.appendChild(entryRow(doc, e, you));
  }
  if (yours && !yoursShown) {
    tbody.appendChild(el(doc, 'tr', { class: 'lb__gap', 'aria-hidden': 'true' }, el(doc, 'td', { colspan: 4 }, '···')));
    tbody.appendChild(entryRow(doc, yours, true));
  }
  table.append(thead, tbody);
  host.appendChild(table);
}
