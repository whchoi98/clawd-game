/**
 * Serves the built client (dist/public). Hashed files under /assets/ are
 * immutable for a year; everything else (index.html, favicon) is `no-cache`
 * so the browser revalidates and picks up a new build's hashed names.
 * Unknown paths are a plain 404 — the app has a single entry route, so there
 * is no SPA rewrite.
 */
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { relative, resolve, sep } from 'node:path';

export const IMMUTABLE = 'public, max-age=31536000, immutable';
export const NO_CACHE = 'no-cache';

/** Cache policy for an absolute file path served from `root`. */
export function cacheControlFor(root: string, filePath: string): string {
  const rel = relative(resolve(root), resolve(filePath)).split(sep).join('/');
  return rel.startsWith('assets/') ? IMMUTABLE : NO_CACHE;
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
