/**
 * Pure routing rules for the service worker — no DOM, no worker globals — so
 * they can be unit-tested in Node. `sw.ts` maps each class to a caching
 * strategy:
 *
 *   bypass  never handled: cross-origin, /api/*, /healthz, /sw.js
 *   asset   /assets/* (content-hashed, immutable)   → cache-first
 *   page    navigations, "/" and "/index.html"      → network-first, cache fallback
 *   swr     every other same-origin GET (manifest,   → stale-while-revalidate
 *           icons, favicon)
 */
export type FetchClass = 'bypass' | 'asset' | 'page' | 'swr';

/**
 * Classify a GET request by its URL path. `sameOrigin` is decided by the
 * caller (the worker compares against its own origin); `isNavigate` is
 * `request.mode === 'navigate'`.
 */
export function classify(urlPath: string, sameOrigin: boolean, isNavigate: boolean): FetchClass {
  if (!sameOrigin) return 'bypass';
  if (urlPath === '/sw.js' || urlPath === '/healthz') return 'bypass';
  if (urlPath === '/api' || urlPath.startsWith('/api/')) return 'bypass';
  if (urlPath.startsWith('/assets/')) return 'asset';
  if (isNavigate || urlPath === '/' || urlPath === '/index.html') return 'page';
  return 'swr';
}

/**
 * The precache list: `assetPaths` followed by `extra`, each path given a
 * leading slash, empty entries dropped, duplicates removed (first occurrence
 * wins, so order is preserved).
 */
export function buildPrecacheList(assetPaths: string[], extra: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...assetPaths, ...extra]) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const path = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}
