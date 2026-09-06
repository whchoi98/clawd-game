import { afterEach, describe, expect, it, vi } from 'vitest';
import { clientIp } from '../../src/server/app.js';
import { makeApp } from './fixtures.js';

vi.mock('./sim.js', () => ({ Sim: class {} }));
vi.mock('../../src/server/levels.js', async () => ({ resolveLevel: (await import('./levelfix.js')).fakeResolveLevel }));

describe('per-IP rate limit', () => {
  const apps: Awaited<ReturnType<typeof makeApp>>[] = [];
  afterEach(async () => { while (apps.length) await apps.pop()!.app.close(); });

  it('answers 429 after perIp requests in a minute, keyed by the first X-Forwarded-For hop', async () => {
    const ctx = await makeApp({ rateLimit: { perIp: 3, perPlayer: 100 } });
    apps.push(ctx);
    const hit = (xff: string) => ctx.app.inject({ method: 'GET', url: '/api/daily', headers: { 'x-forwarded-for': xff } });
    for (let i = 0; i < 3; i++) expect((await hit('203.0.113.7, 70.132.1.1')).statusCode).toBe(200);
    const blocked = await hit('203.0.113.7, 70.132.9.9');
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toBe('rate-limited');
    expect(blocked.headers['retry-after']).toBeDefined();
    // a different first hop has its own budget, even behind the same edge address
    expect((await hit('198.51.100.2, 70.132.1.1')).statusCode).toBe(200);
  });

  it('does not limit /healthz or static-style root requests', async () => {
    const ctx = await makeApp({ rateLimit: { perIp: 1, perPlayer: 100 } });
    apps.push(ctx);
    for (let i = 0; i < 5; i++) {
      expect((await ctx.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    }
    expect((await ctx.app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(429);
  });

  it('falls back to the socket address without X-Forwarded-For', async () => {
    const ctx = await makeApp({ rateLimit: { perIp: 2, perPlayer: 100 } });
    apps.push(ctx);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/daily' })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/daily' })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/daily' })).statusCode).toBe(429);
  });
});

describe('clientIp', () => {
  const req = (headers: Record<string, string | string[]>, ip = '10.0.0.1') => ({ headers, ip }) as never;
  it('takes the first X-Forwarded-For hop', () => {
    expect(clientIp(req({ 'x-forwarded-for': '203.0.113.7, 70.132.1.1' }))).toBe('203.0.113.7');
    expect(clientIp(req({ 'x-forwarded-for': ['203.0.113.8', '1.1.1.1'] }))).toBe('203.0.113.8');
  });
  it('prefers CloudFront-Viewer-Address when present (ip:port, IPv6 too)', () => {
    expect(clientIp(req({ 'cloudfront-viewer-address': '203.0.113.9:51234', 'x-forwarded-for': '9.9.9.9' }))).toBe('203.0.113.9');
    expect(clientIp(req({ 'cloudfront-viewer-address': '2001:db8::1:443' }))).toBe('2001:db8::1');
  });
  it('falls back to request.ip', () => {
    expect(clientIp(req({}))).toBe('10.0.0.1');
    expect(clientIp(req({ 'x-forwarded-for': ' , ' }))).toBe('10.0.0.1');
  });
});
