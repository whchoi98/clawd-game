/**
 * Race links (P3-3) — pure helpers behind "메아리 링크 공유" and the `?race=`
 * boot path.
 *
 * A race link is `https://<origin>/?race=<runId>&z=<levelId>`: the run id of an
 * accepted submission (what GET /api/ghost/:runId serves) plus the zone as a
 * hint for the reader. At boot the shell asks the API for the ghost; the
 * response — not the link — decides mode, board, level, seed and assist, so a
 * tampered `z` can never start the wrong zone. The query is removed from the
 * address bar right after boot (history.replaceState) so a reload does not
 * start the race again.
 *
 * Sharing prefers the Web Share API and falls back to the clipboard; the
 * caller toasts the outcome. Nothing here touches the DOM or the network
 * directly: the environment is passed in, so the flows run in Node.
 */
import { MS_PER_DAY } from '../save.js';

/** Query parameter names of a race link. */
export const RACE_PARAM = 'race';
export const RACE_ZONE_PARAM = 'z';
/** Run ids as the server mints them (also what the URL is allowed to carry). */
export const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Level ids follow the protocol's LevelId rule. */
const LEVEL_ID_RE = /^[a-z][a-z0-9]{0,15}$/;

/** Lilac: apart from the teal self echo, the magenta world echo, the peach guide and the gold goal. */
export const RACE_COLOR = '#C9A6FF';
export const RACE_LABEL_PREFIX = '경주';

/** "경주 · 이름" — the tag drawn above the friend's echo. */
export function raceLabel(name: string): string {
  return `${RACE_LABEL_PREFIX} · ${name}`;
}

/** The banner when a race starts. */
export function raceBanner(name: string): string {
  return `${name}의 메아리와 경주한다`;
}

/** Korean copy the shell toasts (tests assert on these). */
export const RACE_KR = {
  shared: '메아리 링크를 공유했다',
  copied: '메아리 링크를 복사했다',
  shareFailed: '링크를 공유하지 못했다',
  notShareable: '검증된 기록만 공유할 수 있다',
  notFound: '그 메아리를 찾지 못했다',
  offline: '서버에 닿지 않아 경주를 시작하지 못했다',
  badZone: '이 버전에 없는 구역이다',
  staleDaily: '이 탑은 닫혔다 · 기록은 이 기기에만 남는다',
} as const;

export interface RaceQuery { runId: string; levelId: string | null }

/** `?race=<runId>&z=<levelId>` → the parts, or null when the query carries no valid race. */
export function parseRaceQuery(search: string | URLSearchParams): RaceQuery | null {
  const q = typeof search === 'string' ? new URLSearchParams(search.startsWith('?') ? search.slice(1) : search) : search;
  const runId = q.get(RACE_PARAM);
  if (!runId || !RUN_ID_RE.test(runId)) return null;
  const z = q.get(RACE_ZONE_PARAM);
  return { runId, levelId: z && LEVEL_ID_RE.test(z) ? z : null };
}

/** The shareable link for a run: `<origin>/?race=<runId>&z=<levelId>` (origin without a trailing slash). */
export function buildRaceUrl(origin: string, runId: string, levelId: string): string {
  const base = origin.replace(/\/+$/, '');
  return `${base}/?${RACE_PARAM}=${encodeURIComponent(runId)}&${RACE_ZONE_PARAM}=${encodeURIComponent(levelId)}`;
}

/** `href` without the race parameters (what the address bar shows after boot). */
export function stripRaceQuery(href: string): string {
  try {
    const u = new URL(href);
    u.searchParams.delete(RACE_PARAM);
    u.searchParams.delete(RACE_ZONE_PARAM);
    return u.toString();
  } catch {
    return href;
  }
}

/**
 * A daily board the server still accepts: today or yesterday (UTC). Anything
 * older is raced locally without a submission.
 */
export function isFreshDailyDate(date: string, todayStr: string): boolean {
  const d = Date.parse(`${date}T00:00:00.000Z`);
  const t = Date.parse(`${todayStr}T00:00:00.000Z`);
  if (!Number.isFinite(d) || !Number.isFinite(t)) return false;
  const age = Math.round((t - d) / MS_PER_DAY);
  return age === 0 || age === 1;
}

// ---------------------------------------------------------------- sharing
export interface ShareData { url: string; title?: string; text?: string }
/** The platform pieces a share needs; every field optional (Node, old browsers). */
export interface ShareEnv {
  share?: ((data: ShareData) => Promise<void>) | null;
  canShare?: ((data: ShareData) => boolean) | null;
  writeText?: ((text: string) => Promise<void>) | null;
}
export type ShareOutcome = 'shared' | 'copied' | 'failed' | 'cancelled';

/** `navigator.share` / `navigator.clipboard.writeText` bound to the navigator, or empty where the platform has none. */
export function defaultShareEnv(nav: Navigator | undefined = typeof navigator === 'undefined' ? undefined : navigator): ShareEnv {
  if (!nav) return {};
  const env: ShareEnv = {};
  try {
    if (typeof nav.share === 'function') env.share = (d) => nav.share(d);
    if (typeof nav.canShare === 'function') env.canShare = (d) => nav.canShare(d);
    const clip = nav.clipboard;
    if (clip && typeof clip.writeText === 'function') env.writeText = (t) => clip.writeText(t);
  } catch { /* a locked-down navigator */ }
  return env;
}

/**
 * Share a race link: the Web Share API when the platform offers it (and does
 * not refuse the payload), else the clipboard. A share the user dismissed
 * (AbortError) is 'cancelled' — not an error, nothing else is tried.
 */
export async function shareRaceLink(url: string, text: string, env: ShareEnv): Promise<ShareOutcome> {
  const data: ShareData = { url, title: 'CLAWD JUMP: ECHO TOWER', text };
  if (env.share && (!env.canShare || safeCanShare(env.canShare, data))) {
    try {
      await env.share(data);
      return 'shared';
    } catch (err) {
      if ((err as { name?: string } | null)?.name === 'AbortError') return 'cancelled';
      // fall through to the clipboard
    }
  }
  if (env.writeText) {
    try {
      await env.writeText(url);
      return 'copied';
    } catch { /* denied */ }
  }
  return 'failed';
}

function safeCanShare(fn: (d: ShareData) => boolean, data: ShareData): boolean {
  try { return fn(data); } catch { return true; }
}
