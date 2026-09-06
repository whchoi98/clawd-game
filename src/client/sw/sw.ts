/**
 * Service worker for CLAWD JUMP: ECHO TOWER. Built by tools/build.mjs into
 * dist/public/sw.js (unhashed, served no-cache) with two defines:
 *
 *   __PRECACHE__  same-origin paths to precache ("/", "/index.html", every
 *                 /assets/* file, favicon, manifest, icons)
 *   __BUILD__     the build id; the cache is named "cet-<build>"
 *
 * Lifecycle: install precaches the whole list atomically (one 404 fails the
 * install and the previous worker keeps serving); activate deletes every other
 * "cet-*" cache, claims open clients and broadcasts { type: "sw-activated",
 * build }. The page asks a waiting worker to take over with
 * { type: "skip-waiting" }.
 *
 * Fetch: only same-origin GETs are handled. /api/*, /healthz and /sw.js are
 * never touched, and cross-origin requests (Google Fonts) are never intercepted
 * — the worker's own CSP is connect-src 'self'. /assets/* is cache-first,
 * navigations and the shell are network-first with a cache fallback, and every
 * other same-origin GET is stale-while-revalidate.
 *
 * tsconfig carries lib DOM (for the app), not WebWorker — the two cannot be
 * loaded together — so the worker-only surface is typed locally below.
 */
import { buildPrecacheList, classify, type FetchClass } from './strategy.js';

declare const __PRECACHE__: string[];
declare const __BUILD__: string;

interface ExtendableEventLike extends Event {
  waitUntil(promise: Promise<unknown>): void;
}
interface FetchEventLike extends ExtendableEventLike {
  readonly request: Request;
  respondWith(response: Response | Promise<Response>): void;
}
interface MessageEventLike extends ExtendableEventLike {
  readonly data: unknown;
}
interface ClientLike {
  postMessage(message: unknown): void;
}
interface ClientsLike {
  claim(): Promise<void>;
  matchAll(options?: { includeUncontrolled?: boolean; type?: 'window' | 'worker' | 'sharedworker' | 'all' }): Promise<ClientLike[]>;
}
interface WorkerScope {
  addEventListener(type: 'install' | 'activate', listener: (event: ExtendableEventLike) => void): void;
  addEventListener(type: 'fetch', listener: (event: FetchEventLike) => void): void;
  addEventListener(type: 'message', listener: (event: MessageEventLike) => void): void;
  skipWaiting(): Promise<void>;
  readonly clients: ClientsLike;
  readonly caches: CacheStorage;
  readonly location: { readonly origin: string };
  fetch(input: Request | string): Promise<Response>;
}

const sw = self as unknown as WorkerScope;

export const CACHE_PREFIX = 'cet-';
export const SKIP_WAITING = 'skip-waiting';
export const ACTIVATED = 'sw-activated';
const SHELL = '/index.html';

const BUILD: string = __BUILD__;
const CACHE_NAME = CACHE_PREFIX + BUILD;
/** The shell is always precached even if the build list somehow lacks it. */
const PRECACHE: string[] = buildPrecacheList(__PRECACHE__, ['/', SHELL]);

type KeepAlive = (work: Promise<unknown>) => void;
const swallow = (): undefined => undefined;

// ---------------------------------------------------------------- install
sw.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await sw.caches.open(CACHE_NAME);
    // addAll is atomic: a single failed request rejects and nothing is stored,
    // so a half-precached build can never activate.
    await cache.addAll(PRECACHE);
  })());
});

// ---------------------------------------------------------------- activate
sw.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await sw.caches.keys();
    await Promise.all(
      names
        .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
        .map((name) => sw.caches.delete(name)),
    );
    await sw.clients.claim();
    const clients = await sw.clients.matchAll({ includeUncontrolled: true, type: 'window' });
    for (const client of clients) client.postMessage({ type: ACTIVATED, build: BUILD });
  })());
});

// ---------------------------------------------------------------- message
sw.addEventListener('message', (event) => {
  const data = event.data;
  if (typeof data !== 'object' || data === null) return;
  if ((data as { type?: unknown }).type === SKIP_WAITING) void sw.skipWaiting();
});

// ---------------------------------------------------------------- fetch
sw.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  const kind = classify(url.pathname, url.origin === sw.location.origin, request.mode === 'navigate');
  if (kind === 'bypass') return;
  const keepAlive: KeepAlive = (work) => event.waitUntil(work.catch(swallow));
  event.respondWith(respond(kind, request, url, keepAlive));
});

async function respond(kind: Exclude<FetchClass, 'bypass'>, request: Request, url: URL, keepAlive: KeepAlive): Promise<Response> {
  const cache = await sw.caches.open(CACHE_NAME);
  switch (kind) {
    case 'asset':
      return cacheFirst(cache, request, keepAlive);
    case 'page':
      return networkFirst(cache, request, url, keepAlive);
    case 'swr':
      return staleWhileRevalidate(cache, request, keepAlive);
  }
}

/** Only complete 200 responses are cacheable (206 partials make cache.put throw). */
function cacheable(response: Response): boolean {
  return response.status === 200;
}

async function cacheFirst(cache: Cache, request: Request, keepAlive: KeepAlive): Promise<Response> {
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await sw.fetch(request);
  if (cacheable(response)) keepAlive(cache.put(request, response.clone()));
  return response;
}

async function networkFirst(cache: Cache, request: Request, url: URL, keepAlive: KeepAlive): Promise<Response> {
  const shellPath = url.pathname === '/' || url.pathname === SHELL;
  let response: Response | null = null;
  try {
    response = await sw.fetch(request);
  } catch {
    response = null;
  }
  if (response && response.status < 500) {
    // The shell is stored under its bare path so `/?shot=…` refreshes "/" too.
    if (shellPath && cacheable(response)) keepAlive(cache.put(url.pathname, response.clone()));
    return response;
  }
  const cached = (await cache.match(request, { ignoreSearch: true }))
    ?? (await cache.match(SHELL))
    ?? (await cache.match('/'));
  if (cached) return cached;
  if (response) return response;
  return new Response('offline', { status: 503, statusText: 'Service Unavailable', headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

async function staleWhileRevalidate(cache: Cache, request: Request, keepAlive: KeepAlive): Promise<Response> {
  const hit = await cache.match(request, { ignoreSearch: true });
  const refresh = sw.fetch(request).then(async (response) => {
    if (cacheable(response)) await cache.put(request, response.clone());
    return response;
  });
  if (hit) {
    keepAlive(refresh);
    return hit;
  }
  return refresh;
}
