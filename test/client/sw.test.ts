/**
 * Service worker tests. The pure routing helpers are checked directly; the
 * worker itself (src/client/sw/sw.ts) is loaded against a fake
 * ServiceWorkerGlobalScope — captured `self.addEventListener` handlers, a fake
 * `caches` API, a scripted `fetch` — so install / activate / fetch / message
 * behaviour is proven in Node without a browser.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildPrecacheList, classify } from '../../src/client/sw/strategy.js';

const ORIGIN = 'https://tower.test';
const BUILD = 'abc12345';
const PRECACHE = ['/', '/index.html', '/assets/app.AAAA1111.js', '/assets/styles.deadbeef.css', '/favicon.svg', '/manifest.webmanifest', '/icons/icon-192.png'];

// ---------------------------------------------------------------- pure helpers

describe('sw/strategy classify', () => {
  it('never handles cross-origin requests, whatever the path', () => {
    expect(classify('/css2', false, false)).toBe('bypass');
    expect(classify('/assets/app.js', false, false)).toBe('bypass');
    expect(classify('/', false, true)).toBe('bypass');
  });

  it('leaves the API, the health probe and the worker script to the network', () => {
    expect(classify('/api/daily', true, false)).toBe('bypass');
    expect(classify('/api/runs', true, true)).toBe('bypass');
    expect(classify('/api', true, false)).toBe('bypass');
    expect(classify('/healthz', true, false)).toBe('bypass');
    expect(classify('/sw.js', true, false)).toBe('bypass');
    // A sibling path that merely starts with the same letters is not the API.
    expect(classify('/apiary.txt', true, false)).toBe('swr');
  });

  it('routes hashed assets to cache-first', () => {
    expect(classify('/assets/app.AAAA1111.js', true, false)).toBe('asset');
    expect(classify('/assets/styles.deadbeef.css', true, false)).toBe('asset');
  });

  it('routes navigations and the shell to network-first', () => {
    expect(classify('/', true, true)).toBe('page');
    expect(classify('/', true, false)).toBe('page');
    expect(classify('/index.html', true, false)).toBe('page');
    expect(classify('/anything', true, true)).toBe('page');
  });

  it('routes other same-origin GETs to stale-while-revalidate', () => {
    expect(classify('/manifest.webmanifest', true, false)).toBe('swr');
    expect(classify('/icons/icon-192.png', true, false)).toBe('swr');
    expect(classify('/favicon.svg', true, false)).toBe('swr');
  });
});

describe('sw/strategy buildPrecacheList', () => {
  it('concatenates in order, adds the leading slash and drops duplicates and blanks', () => {
    expect(buildPrecacheList(['/assets/a.js', 'assets/b.css', '', '/assets/a.js'], ['/', '/index.html', ' ', '/'])).toEqual([
      '/assets/a.js', '/assets/b.css', '/', '/index.html',
    ]);
  });

  it('returns an empty list for empty input', () => {
    expect(buildPrecacheList([], [])).toEqual([]);
  });
});

// ---------------------------------------------------------------- fake worker scope

interface RequestLike { url: string; method: string; mode: string }
type Listener = (event: unknown) => void;

function abs(url: string): string {
  return new URL(url, ORIGIN).href;
}
function keyOf(req: RequestLike | string): string {
  return typeof req === 'string' ? abs(req) : req.url;
}
function stripSearch(url: string): string {
  const u = new URL(url);
  u.search = '';
  return u.href;
}

class FakeCache {
  readonly store = new Map<string, Response>();
  constructor(private readonly scope: FakeScope) {}

  async addAll(urls: string[]): Promise<void> {
    const fetched = await Promise.all(urls.map(async (u) => [abs(u), await this.scope.fetch(u)] as const));
    for (const [url, res] of fetched) {
      if (!res.ok) throw new TypeError(`addAll: ${url} → ${res.status}`);
    }
    for (const [url, res] of fetched) this.store.set(url, res);
  }
  async match(req: RequestLike | string, opts?: { ignoreSearch?: boolean }): Promise<Response | undefined> {
    const key = keyOf(req);
    const hit = this.store.get(key);
    if (hit || !opts?.ignoreSearch) return hit;
    const bare = stripSearch(key);
    for (const [k, v] of this.store) if (stripSearch(k) === bare) return v;
    return undefined;
  }
  async put(req: RequestLike | string, res: Response): Promise<void> {
    this.store.set(keyOf(req), res);
  }
  urls(): string[] {
    return [...this.store.keys()].map((u) => u.slice(ORIGIN.length));
  }
}

class FakeCacheStorage {
  readonly caches = new Map<string, FakeCache>();
  constructor(private readonly scope: FakeScope) {}
  async open(name: string): Promise<FakeCache> {
    let c = this.caches.get(name);
    if (!c) {
      c = new FakeCache(this.scope);
      this.caches.set(name, c);
    }
    return c;
  }
  async keys(): Promise<string[]> {
    return [...this.caches.keys()];
  }
  async delete(name: string): Promise<boolean> {
    return this.caches.delete(name);
  }
  async has(name: string): Promise<boolean> {
    return this.caches.has(name);
  }
}

interface FakeClient { messages: unknown[]; postMessage(m: unknown): void }

function client(): FakeClient {
  const c: FakeClient = { messages: [], postMessage(m) { c.messages.push(m); } };
  return c;
}

class FakeScope {
  readonly listeners = new Map<string, Listener[]>();
  readonly caches = new FakeCacheStorage(this);
  readonly location = { origin: ORIGIN };
  readonly skipWaiting = vi.fn(async () => undefined);
  readonly windows: FakeClient[] = [];
  readonly clients = {
    claim: vi.fn(async () => undefined),
    matchAll: vi.fn(async () => this.windows),
  };
  /** Scripted network: path → response factory. Anything else is a 404. */
  readonly network = new Map<string, () => Response>();
  offline = false;
  readonly fetched: string[] = [];
  readonly fetch = vi.fn(async (input: RequestLike | string): Promise<Response> => {
    const url = keyOf(input);
    this.fetched.push(url.slice(ORIGIN.length));
    if (this.offline) throw new TypeError('Failed to fetch');
    const make = this.network.get(new URL(url).pathname);
    return make ? make() : new Response('not found', { status: 404 });
  });

  addEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  dispatch(type: string, event: unknown): void {
    const list = this.listeners.get(type) ?? [];
    expect(list.length, `no ${type} listener registered`).toBeGreaterThan(0);
    for (const fn of list) fn(event);
  }
  serve(path: string, body = `body of ${path}`, status = 200): void {
    this.network.set(path, () => new Response(body, { status, headers: { 'content-type': 'text/plain' } }));
  }
  serveAll(paths: string[]): void {
    for (const p of paths) this.serve(p);
  }
}

function extendable() {
  const waits: Promise<unknown>[] = [];
  return {
    waitUntil: (p: Promise<unknown>) => { waits.push(p); },
    /** Settles when every waitUntil promise has; rejects if any did. */
    done: () => Promise.all(waits),
  };
}

function fetchEvent(url: string, opts: { method?: string; mode?: string } = {}) {
  const ev = extendable();
  let response: Promise<Response> | null = null;
  const respondWith = vi.fn((r: Response | Promise<Response>) => { response = Promise.resolve(r); });
  return {
    ...ev,
    request: { url: abs(url), method: opts.method ?? 'GET', mode: opts.mode ?? 'no-cors' } as RequestLike,
    respondWith,
    handled: () => respondWith.mock.calls.length > 0,
    response: () => {
      if (!response) throw new Error('respondWith was not called');
      return response;
    },
  };
}

const GLOBAL_KEYS = ['self', '__PRECACHE__', '__BUILD__'] as const;

/** Load a fresh copy of the worker module against a fresh fake scope. */
async function boot(precache: string[] = PRECACHE, build = BUILD): Promise<FakeScope> {
  const scope = new FakeScope();
  const g = globalThis as Record<string, unknown>;
  g.self = scope;
  g.__PRECACHE__ = precache;
  g.__BUILD__ = build;
  vi.resetModules();
  await import('../../src/client/sw/sw.js');
  return scope;
}

/** Boot, serve the precache list, and run install + activate to a controlling state. */
async function bootActivated(precache: string[] = PRECACHE): Promise<FakeScope> {
  const scope = await boot(precache);
  scope.serveAll(precache);
  const install = extendable();
  scope.dispatch('install', install);
  await install.done();
  const activate = extendable();
  scope.dispatch('activate', activate);
  await activate.done();
  scope.fetched.length = 0;
  scope.fetch.mockClear();
  return scope;
}

async function text(p: Promise<Response>): Promise<string> {
  return (await p).text();
}

afterEach(() => {
  const g = globalThis as Record<string, unknown>;
  for (const k of GLOBAL_KEYS) delete g[k];
});

// ---------------------------------------------------------------- lifecycle

describe('sw install', () => {
  it('registers every lifecycle handler on self', async () => {
    const scope = await boot();
    for (const type of ['install', 'activate', 'fetch', 'message']) {
      expect(scope.listeners.get(type)?.length, type).toBe(1);
    }
  });

  it('precaches the whole __PRECACHE__ list into cet-<build>', async () => {
    const scope = await boot();
    scope.serveAll(PRECACHE);
    const ev = extendable();
    scope.dispatch('install', ev);
    await ev.done();
    const cache = await scope.caches.open(`cet-${BUILD}`);
    expect(cache.urls().sort()).toEqual([...PRECACHE].sort());
    expect(await scope.caches.keys()).toEqual([`cet-${BUILD}`]);
    for (const p of PRECACHE) expect(scope.fetched).toContain(p);
  });

  it('always includes the shell even when the build list lacks it', async () => {
    const list = ['/assets/app.AAAA1111.js'];
    const scope = await boot(list);
    scope.serveAll([...list, '/', '/index.html']);
    const ev = extendable();
    scope.dispatch('install', ev);
    await ev.done();
    const cache = await scope.caches.open(`cet-${BUILD}`);
    expect(cache.urls().sort()).toEqual(['/', '/assets/app.AAAA1111.js', '/index.html']);
  });

  it('fails atomically when a single precache request 404s', async () => {
    const scope = await boot();
    scope.serveAll(PRECACHE.filter((p) => p !== '/icons/icon-192.png'));
    const ev = extendable();
    scope.dispatch('install', ev);
    await expect(ev.done()).rejects.toThrow(/404/);
    const cache = await scope.caches.open(`cet-${BUILD}`);
    expect(cache.urls()).toEqual([]);
  });
});

describe('sw activate', () => {
  it('deletes other cet-* caches, keeps its own and foreign caches, claims clients', async () => {
    const scope = await boot();
    scope.serveAll(PRECACHE);
    await scope.caches.open('cet-old00000');
    await scope.caches.open('cet-older000');
    await scope.caches.open('someone-elses-cache');
    const install = extendable();
    scope.dispatch('install', install);
    await install.done();

    const activate = extendable();
    scope.dispatch('activate', activate);
    await activate.done();

    expect((await scope.caches.keys()).sort()).toEqual([`cet-${BUILD}`, 'someone-elses-cache']);
    expect(scope.clients.claim).toHaveBeenCalledTimes(1);
  });

  it('broadcasts { type: "sw-activated", build } to every window client', async () => {
    const scope = await boot();
    scope.serveAll(PRECACHE);
    const a = client();
    const b = client();
    scope.windows.push(a, b);
    const activate = extendable();
    scope.dispatch('activate', activate);
    await activate.done();
    expect(scope.clients.matchAll).toHaveBeenCalledWith({ includeUncontrolled: true, type: 'window' });
    expect(a.messages).toEqual([{ type: 'sw-activated', build: BUILD }]);
    expect(b.messages).toEqual([{ type: 'sw-activated', build: BUILD }]);
  });
});

describe('sw message', () => {
  it('calls skipWaiting on { type: "skip-waiting" } and ignores everything else', async () => {
    const scope = await boot();
    scope.dispatch('message', { ...extendable(), data: { type: 'ping' } });
    scope.dispatch('message', { ...extendable(), data: 'skip-waiting' });
    scope.dispatch('message', { ...extendable(), data: null });
    expect(scope.skipWaiting).not.toHaveBeenCalled();
    scope.dispatch('message', { ...extendable(), data: { type: 'skip-waiting' } });
    expect(scope.skipWaiting).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------- fetch

describe('sw fetch', () => {
  it('serves /assets/* from the cache without touching the network', async () => {
    const scope = await bootActivated();
    const ev = fetchEvent('/assets/app.AAAA1111.js');
    scope.dispatch('fetch', ev);
    expect(ev.handled()).toBe(true);
    expect(await text(ev.response())).toBe('body of /assets/app.AAAA1111.js');
    await ev.done();
    expect(scope.fetch).not.toHaveBeenCalled();
  });

  it('fetches an uncached asset from the network and stores the fresh copy', async () => {
    const scope = await bootActivated();
    scope.serve('/assets/chunk.BBBB2222.js', 'fresh chunk');
    const ev = fetchEvent('/assets/chunk.BBBB2222.js');
    scope.dispatch('fetch', ev);
    expect(await text(ev.response())).toBe('fresh chunk');
    await ev.done();
    const cache = await scope.caches.open(`cet-${BUILD}`);
    expect(await text(Promise.resolve((await cache.match('/assets/chunk.BBBB2222.js'))!))).toBe('fresh chunk');
  });

  it('does not cache non-200 asset responses', async () => {
    const scope = await bootActivated();
    const ev = fetchEvent('/assets/missing.CCCC3333.js');
    scope.dispatch('fetch', ev);
    expect((await ev.response()).status).toBe(404);
    await ev.done();
    const cache = await scope.caches.open(`cet-${BUILD}`);
    expect(await cache.match('/assets/missing.CCCC3333.js')).toBeUndefined();
  });

  it('never handles /api/*, /healthz, /sw.js, non-GET or cross-origin requests', async () => {
    const scope = await bootActivated();
    const cases = [
      fetchEvent('/api/daily'),
      fetchEvent('/api/runs', { method: 'POST' }),
      fetchEvent('/healthz'),
      fetchEvent('/sw.js'),
      fetchEvent('/assets/app.AAAA1111.js', { method: 'POST' }),
      fetchEvent('/index.html', { method: 'HEAD' }),
      { ...fetchEvent('/'), request: { url: 'https://fonts.googleapis.com/css2?family=X', method: 'GET', mode: 'no-cors' } },
      { ...fetchEvent('/'), request: { url: 'https://fonts.gstatic.com/s/x.woff2', method: 'GET', mode: 'cors' } },
      { ...fetchEvent('/'), request: { url: 'https://other.test/assets/app.AAAA1111.js', method: 'GET', mode: 'navigate' } },
    ];
    for (const ev of cases) {
      scope.dispatch('fetch', ev);
      expect(ev.respondWith, ev.request.url).not.toHaveBeenCalled();
    }
    expect(scope.fetch).not.toHaveBeenCalled();
  });

  it('navigations are network-first online and refresh the cached shell', async () => {
    const scope = await bootActivated();
    scope.serve('/', 'new shell');
    const ev = fetchEvent('/?shot=t1', { mode: 'navigate' });
    scope.dispatch('fetch', ev);
    expect(await text(ev.response())).toBe('new shell');
    await ev.done();
    expect(scope.fetched).toEqual(['/?shot=t1']);
    const cache = await scope.caches.open(`cet-${BUILD}`);
    expect(await text(Promise.resolve((await cache.match('/'))!))).toBe('new shell');
    // No stray entry keyed by the query.
    expect(cache.urls()).not.toContain('/?shot=t1');
  });

  it('navigations fall back to the cached shell when offline', async () => {
    const scope = await bootActivated();
    scope.offline = true;
    const root = fetchEvent('/', { mode: 'navigate' });
    scope.dispatch('fetch', root);
    expect(await text(root.response())).toBe('body of /');
    const deep = fetchEvent('/somewhere?x=1', { mode: 'navigate' });
    scope.dispatch('fetch', deep);
    expect(await text(deep.response())).toBe('body of /index.html');
    await Promise.all([root.done(), deep.done()]);
  });

  it('navigations fall back to the cached shell on a 5xx too', async () => {
    const scope = await bootActivated();
    scope.serve('/index.html', 'bad gateway', 502);
    const ev = fetchEvent('/index.html', { mode: 'navigate' });
    scope.dispatch('fetch', ev);
    expect(await text(ev.response())).toBe('body of /index.html');
    await ev.done();
  });

  it('answers 503 for an offline navigation when nothing is cached', async () => {
    const scope = await boot();
    scope.offline = true;
    const ev = fetchEvent('/', { mode: 'navigate' });
    scope.dispatch('fetch', ev);
    expect((await ev.response()).status).toBe(503);
    await ev.done();
  });

  it('other same-origin GETs are stale-while-revalidate', async () => {
    const scope = await bootActivated();
    scope.serve('/manifest.webmanifest', 'v2 manifest');
    const ev = fetchEvent('/manifest.webmanifest');
    scope.dispatch('fetch', ev);
    // Stale copy now…
    expect(await text(ev.response())).toBe('body of /manifest.webmanifest');
    await ev.done();
    // …revalidated in the background.
    expect(scope.fetched).toEqual(['/manifest.webmanifest']);
    const cache = await scope.caches.open(`cet-${BUILD}`);
    expect(await text(Promise.resolve((await cache.match('/manifest.webmanifest'))!))).toBe('v2 manifest');
  });

  it('stale-while-revalidate goes to the network for an unknown path and caches it', async () => {
    const scope = await bootActivated();
    scope.serve('/robots.txt', 'User-agent: *');
    const ev = fetchEvent('/robots.txt');
    scope.dispatch('fetch', ev);
    expect(await text(ev.response())).toBe('User-agent: *');
    await ev.done();
    const cache = await scope.caches.open(`cet-${BUILD}`);
    expect(cache.urls()).toContain('/robots.txt');
  });

  it('stale-while-revalidate surfaces the network failure when offline and uncached', async () => {
    const scope = await bootActivated();
    scope.offline = true;
    const ev = fetchEvent('/nothing-here.txt');
    scope.dispatch('fetch', ev);
    await expect(ev.response()).rejects.toThrow(/Failed to fetch/);
    await ev.done();
  });
});
