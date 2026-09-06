import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EDGE_CACHE, EDGE_CACHED_FILES, IMMUTABLE, NO_CACHE, cacheControlFor } from '../../src/server/static.js';
import { makeApp } from './fixtures.js';

vi.mock('../../src/server/levels.js', async () => ({ resolveLevel: (await import('./levelfix.js')).fakeResolveLevel }));

const SCRATCH = '/tmp/claude-1000/-home-ec2-user-my-project-clawd-game/f8aa643c-bc48-400a-8c09-d71da38a73d7/scratchpad';

describe('static serving', () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  let dir: string;
  beforeAll(async () => {
    mkdirSync(SCRATCH, { recursive: true });
    dir = mkdtempSync(join(SCRATCH, 'static-'));
    mkdirSync(join(dir, 'assets'));
    mkdirSync(join(dir, 'icons'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>클로드 점프</title>');
    writeFileSync(join(dir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    writeFileSync(join(dir, 'sw.js'), 'self.addEventListener("fetch", () => {})');
    writeFileSync(join(dir, 'manifest.webmanifest'), '{"name":"클로드 점프"}');
    writeFileSync(join(dir, 'icons', 'icon-192.png'), 'png');
    writeFileSync(join(dir, 'assets', 'app.abc123.js'), 'console.log(1)');
    writeFileSync(join(dir, 'assets', 'styles.def456.css'), 'body{}');
    ctx = await makeApp({ staticDir: dir });
  });
  afterAll(async () => { await ctx.app.close(); });

  it('serves hashed assets as immutable for a year', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/assets/app.abc123.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.body).toBe('console.log(1)');
    const css = await ctx.app.inject({ method: 'GET', url: '/assets/styles.def456.css' });
    expect(css.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(css.headers['content-type']).toMatch(/text\/css/);
  });

  it('serves index.html at / and /index.html with the edge policy (s-maxage=60, browser revalidates)', async () => {
    expect(EDGE_CACHE).toBe('public, max-age=0, s-maxage=60, stale-while-revalidate=300');
    const root = await ctx.app.inject({ method: 'GET', url: '/' });
    expect(root.statusCode).toBe(200);
    expect(root.headers['cache-control']).toBe(EDGE_CACHE);
    expect(root.headers['cache-control']).toContain('s-maxage=60');
    expect(root.headers['content-type']).toMatch(/text\/html/);
    expect(root.body).toContain('클로드 점프');
    const idx = await ctx.app.inject({ method: 'GET', url: '/index.html' });
    expect(idx.statusCode).toBe(200);
    expect(idx.headers['cache-control']).toBe(EDGE_CACHE);
  });

  it('serves sw.js and manifest.webmanifest with the same edge policy — the paths release.mjs invalidates', async () => {
    expect([...EDGE_CACHED_FILES].sort()).toEqual(['index.html', 'manifest.webmanifest', 'sw.js']);
    const sw = await ctx.app.inject({ method: 'GET', url: '/sw.js' });
    expect(sw.statusCode).toBe(200);
    expect(sw.headers['cache-control']).toBe(EDGE_CACHE);
    expect(sw.headers['content-type']).toMatch(/javascript/);
    const manifest = await ctx.app.inject({ method: 'GET', url: '/manifest.webmanifest' });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.headers['cache-control']).toBe(EDGE_CACHE);
  });

  it('keeps every other root file (favicon, icons) on no-cache', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/favicon.svg' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
    const icon = await ctx.app.inject({ method: 'GET', url: '/icons/icon-192.png' });
    expect(icon.statusCode).toBe(200);
    expect(icon.headers['cache-control']).toBe('no-cache');
  });

  it('answers 404 for unknown paths instead of rewriting to the SPA', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/some/deep/route' });
    expect(res.statusCode).toBe(404);
    const missingAsset = await ctx.app.inject({ method: 'GET', url: '/assets/nope.js' });
    expect(missingAsset.statusCode).toBe(404);
  });

  it('keeps the API reachable alongside static files, still no-store', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('cacheControlFor classifies by path: assets → immutable, the four entry files → edge, the rest → no-cache', () => {
    expect(cacheControlFor('/srv/public', '/srv/public/assets/app.1.js')).toBe(IMMUTABLE);
    expect(cacheControlFor('/srv/public', '/srv/public/index.html')).toBe(EDGE_CACHE);
    expect(cacheControlFor('/srv/public', '/srv/public/sw.js')).toBe(EDGE_CACHE);
    expect(cacheControlFor('/srv/public', '/srv/public/manifest.webmanifest')).toBe(EDGE_CACHE);
    expect(cacheControlFor('/srv/public', '/srv/public/favicon.svg')).toBe(NO_CACHE);
    expect(cacheControlFor('/srv/public', '/srv/public/icons/sw.js')).toBe(NO_CACHE);
    expect(cacheControlFor('/srv/public', '/srv/public/assets')).toBe(NO_CACHE);
    expect(cacheControlFor('/srv/public/', '/srv/public/assets/x/y.css')).toBe(IMMUTABLE);
  });
});

describe('without staticDir', () => {
  it('root answers 404', async () => {
    const ctx = await makeApp();
    try {
      const res = await ctx.app.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(404);
    } finally {
      await ctx.app.close();
    }
  });
});
