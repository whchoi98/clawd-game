/**
 * Serves the built client (dist/public). Hashed files under /assets/ are
 * immutable for a year. The four unhashed entry files — index.html (also
 * served at /), sw.js and manifest.webmanifest — are edge-cached: CloudFront
 * keeps them 60 s (`s-maxage`) and serves stale for five minutes while it
 * revalidates, while the browser itself always revalidates (`max-age=0`);
 * tools/release.mjs invalidates exactly these paths after a deploy. Every
 * other root file (favicon, icons) stays `no-cache`. Unknown paths are a plain
 * 404 — the app has a single entry route, so there is no SPA rewrite.
 */
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { relative, resolve, sep } from 'node:path';

export const IMMUTABLE = 'public, max-age=31536000, immutable';
export const NO_CACHE = 'no-cache';
export const EDGE_CACHE = 'public, max-age=0, s-maxage=60, stale-while-revalidate=300';
/** Root files the edge may hold for 60 s (the release script invalidates them). */
export const EDGE_CACHED_FILES: ReadonlySet<string> = new Set(['index.html', 'sw.js', 'manifest.webmanifest']);

/** Cache policy for an absolute file path served from `root`. */
export function cacheControlFor(root: string, filePath: string): string {
  const rel = relative(resolve(root), resolve(filePath)).split(sep).join('/');
  if (rel.startsWith('assets/')) return IMMUTABLE;
  if (EDGE_CACHED_FILES.has(rel)) return EDGE_CACHE;
  return NO_CACHE;
}

export async function registerStatic(app: FastifyInstance, root: string): Promise<void> {
  const absRoot = resolve(root);
  await app.register(fastifyStatic, {
    root: absRoot,
    prefix: '/',
    index: 'index.html',
    wildcard: true,
    // We set Cache-Control ourselves per path; keep validators on.
    cacheControl: false,
    etag: true,
    lastModified: true,
    dotfiles: 'ignore',
    setHeaders(res, filePath) {
      res.setHeader('Cache-Control', cacheControlFor(absRoot, filePath));
    },
  });
}
