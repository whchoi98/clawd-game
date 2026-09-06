import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cacheControlFor, IMMUTABLE, NO_CACHE } from '../../src/server/static.js';
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
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>클로드 점프</title>');
    writeFileSync(join(dir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
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

  it('serves index.html at / and /index.html with no-cache', async () => {
    const root = await ctx.app.inject({ method: 'GET', url: '/' });
    expect(root.statusCode).toBe(200);
    expect(root.headers['cache-control']).toBe('no-cache');
    expect(root.headers['content-type']).toMatch(/text\/html/);
    expect(root.body).toContain('클로드 점프');
    const idx = await ctx.app.inject({ method: 'GET', url: '/index.html' });
    expect(idx.statusCode).toBe(200);
    expect(idx.headers['cache-control']).toBe('no-cache');
  });

  it('serves other root files (favicon) with no-cache', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/favicon.svg' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('answers 404 for unknown paths instead of rewriting to the SPA', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/some/deep/route' });
    expect(res.statusCode).toBe(404);
    const missingAsset = await ctx.app.inject({ method: 'GET', url: '/assets/nope.js' });
    expect(missingAsset.statusCode).toBe(404);
  });

  it('keeps the API reachable alongside static files', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it('cacheControlFor classifies by the assets prefix', () => {
    expect(cacheControlFor('/srv/public', '/srv/public/assets/app.1.js')).toBe(IMMUTABLE);
    expect(cacheControlFor('/srv/public', '/srv/public/index.html')).toBe(NO_CACHE);
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
