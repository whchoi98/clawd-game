/**
 * `?go=` deep links (P3-4) — what the manifest's shortcuts open:
 *
 *   /?go=daily      the daily screen (오늘의 탑 · 세계 순위)
 *   /?go=endless    a fresh endless climb
 *
 * main.ts reads the query before boot, removes it from the address bar right
 * after boot (history.replaceState, so a reload does not repeat the jump) and
 * hands the target to `Scenes.go`. Anything else in the parameter is ignored:
 * a shortcut never starts a story zone or a raced run. Pure helpers, no DOM.
 */

export const GO_PARAM = 'go';
export type GoTarget = 'daily' | 'endless';

/** `?go=daily|endless` → the target, or null for a missing / unknown value. */
export function parseGoQuery(search: string | URLSearchParams): GoTarget | null {
  const q = typeof search === 'string' ? new URLSearchParams(search.startsWith('?') ? search.slice(1) : search) : search;
  const v = q.get(GO_PARAM);
  return v === 'daily' || v === 'endless' ? v : null;
}

/** `href` without the `go` parameter (what the address bar shows after boot). */
export function stripGoQuery(href: string): string {
  try {
    const u = new URL(href);
    u.searchParams.delete(GO_PARAM);
    return u.toString();
  } catch {
    return href;
  }
}
