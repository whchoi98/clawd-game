/**
 * PWA glue for the page side: service-worker registration with an update
 * prompt, the deferred `beforeinstallprompt` install flow, and the display-mode
 * probes the UI uses to decide what to show (install button, iOS hint).
 *
 * Contract with src/client/sw/sw.ts:
 *   - the worker lives at /sw.js (unhashed, scope /)
 *   - page → worker  { type: 'skip-waiting' }   the waiting worker activates now
 *   - worker → page  { type: 'sw-activated', build }
 *   - the page prompts when `registration.waiting` exists, or when an
 *     installing worker reaches 'installed' while the page already has a
 *     controller (a first install never prompts); `apply()` posts skip-waiting
 *     and the page reloads once on `controllerchange`.
 *
 * Every function is a no-op when the browser lacks the API or the page runs the
 * `?shot=` capture harness, and every environment handle is injectable so the
 * flows run under happy-dom.
 */

// ---------------------------------------------------------------- minimal environment types
export interface ServiceWorkerLike {
  state: string;
  postMessage(message: unknown): void;
  addEventListener(type: string, listener: (ev: Event) => void): void;
}

export interface RegistrationLike {
  installing: ServiceWorkerLike | null;
  waiting: ServiceWorkerLike | null;
  active: ServiceWorkerLike | null;
  addEventListener(type: string, listener: (ev: Event) => void): void;
  update?(): Promise<unknown>;
}

export interface ServiceWorkerContainerLike {
  controller: ServiceWorkerLike | null;
  register(url: string, options?: { scope?: string }): Promise<RegistrationLike>;
  addEventListener(type: string, listener: (ev: Event) => void): void;
}

export interface PwaNavigator {
  serviceWorker?: ServiceWorkerContainerLike;
  /** iOS Safari: true when launched from the home screen. */
  standalone?: boolean;
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
}

export interface PwaWindow {
  location: { search: string; reload(): void };
  document: { readyState: string; hidden?: boolean; addEventListener(type: string, listener: (ev: Event) => void): void };
  addEventListener(type: string, listener: (ev: Event) => void): void;
  matchMedia?(query: string): { matches: boolean };
  /** Set by main.ts while the `?shot=` capture harness runs. */
  __shot?: boolean;
}

export interface BeforeInstallPromptEventLike extends Event {
  prompt(): Promise<unknown>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export const SW_URL = '/sw.js';
/** How often, at most, a visible page asks the browser to look for a new worker. */
export const UPDATE_CHECK_MS = 60 * 60 * 1000;

const defaultWindow = (): PwaWindow | null => (typeof window === 'undefined' ? null : (window as unknown as PwaWindow));
const defaultNavigator = (): PwaNavigator | null => (typeof navigator === 'undefined' ? null : (navigator as unknown as PwaNavigator));

/** The deterministic capture harness (`?shot=`) never registers workers or prompts. */
export function isShotHarness(win: PwaWindow | null | undefined): boolean {
  if (!win) return false;
  if (win.__shot) return true;
  try { return new URLSearchParams(win.location.search).has('shot'); } catch { return false; }
}

// ---------------------------------------------------------------- display mode
/** Installed and launched as an app (display-mode standalone / fullscreen, or iOS `navigator.standalone`). */
export function isStandalone(win: PwaWindow | null = defaultWindow(), nav: PwaNavigator | null = defaultNavigator()): boolean {
  if (nav?.standalone === true) return true;
  if (!win || typeof win.matchMedia !== 'function') return false;
  try {
    return win.matchMedia('(display-mode: standalone)').matches || win.matchMedia('(display-mode: fullscreen)').matches;
  } catch {
    return false;
  }
}

/** An iPhone / iPad / iPod (including iPadOS's desktop UA) running a browser tab, not the installed app. */
export function isIosSafariNotStandalone(nav: PwaNavigator | null = defaultNavigator(), win: PwaWindow | null = defaultWindow()): boolean {
  if (!nav) return false;
  const ua = nav.userAgent ?? '';
  const iDevice = /iPad|iPhone|iPod/.test(ua);
  const iPadDesktopUa = nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1;
  if (!iDevice && !iPadDesktopUa) return false;
  // Other iOS browsers cannot add to the home screen from their own share sheet the same way.
  if (/CriOS|FxiOS|EdgiOS|OPiOS|OPT\//.test(ua)) return false;
  if (!/Safari/.test(ua)) return false;
  return !isStandalone(win, nav);
}

// ---------------------------------------------------------------- service worker
export interface RegisterOptions {
  /** A new worker is installed and waiting; call `apply()` to switch to it (the page reloads). */
  onUpdateReady(apply: () => void): void;
  /** The worker announced `{ type: 'sw-activated', build }`. */
  onActivated?(build: string): void;
  url?: string;
  win?: PwaWindow | null;
  nav?: PwaNavigator | null;
  /** Milliseconds between update checks when the tab becomes visible (0 disables). */
  updateCheckMs?: number;
  now?: () => number;
}

/**
 * Register the service worker after `load` and wire the update prompt.
 * Resolves with the registration, or null when nothing was registered (no API,
 * capture harness, registration failure).
 */
export function registerServiceWorker(opts: RegisterOptions): Promise<RegistrationLike | null> {
  const win = opts.win === undefined ? defaultWindow() : opts.win;
  const nav = opts.nav === undefined ? defaultNavigator() : opts.nav;
  const container = nav?.serviceWorker;
  if (!win || !container || typeof container.register !== 'function' || isShotHarness(win)) return Promise.resolve(null);

  const url = opts.url ?? SW_URL;
  const now = opts.now ?? (() => Date.now());
  const checkMs = opts.updateCheckMs ?? UPDATE_CHECK_MS;
  const hadController = !!container.controller;
  let applied = false;
  let reloaded = false;
  let prompted: ServiceWorkerLike | null = null;

  // Reload exactly once, and only when this page asked for the switch or was
  // already controlled: a first install's clients.claim() must not reload.
  container.addEventListener('controllerchange', () => {
    if (reloaded || !(applied || hadController)) return;
    reloaded = true;
    try { win.location.reload(); } catch { /* unloading */ }
  });
  if (opts.onActivated) {
    container.addEventListener('message', (ev) => {
      const data = (ev as MessageEvent).data as { type?: string; build?: string } | null;
      if (data && data.type === 'sw-activated') opts.onActivated!(String(data.build ?? ''));
    });
  }

  const prompt = (worker: ServiceWorkerLike, reg: RegistrationLike): void => {
    if (prompted === worker) return;
    prompted = worker;
    opts.onUpdateReady(() => {
      applied = true;
      const target = reg.waiting ?? worker;
      try { target.postMessage({ type: 'skip-waiting' }); } catch { /* the worker is gone; the next load picks it up */ }
    });
  };

  const watch = (reg: RegistrationLike): void => {
    if (reg.waiting) prompt(reg.waiting, reg);
    const track = (worker: ServiceWorkerLike | null): void => {
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && container.controller) prompt(worker, reg);
      });
    };
    track(reg.installing);
    reg.addEventListener('updatefound', () => track(reg.installing));
    if (checkMs > 0 && typeof reg.update === 'function') {
      let last = now();
      win.document.addEventListener('visibilitychange', () => {
        if (win.document.hidden || now() - last < checkMs) return;
        last = now();
        reg.update!().catch(() => { /* offline: nothing to check */ });
      });
    }
  };

  const register = (): Promise<RegistrationLike | null> =>
    container.register(url, { scope: '/' }).then((reg) => { watch(reg); return reg; }, () => null);

  if (win.document.readyState === 'complete') return register();
  return new Promise((resolve) => {
    win.addEventListener('load', () => { register().then(resolve); });
  });
}

// ---------------------------------------------------------------- install prompt
export interface InstallPrompt {
  /** A deferred `beforeinstallprompt` is stashed and can be shown. */
  canInstall(): boolean;
  /** Show the browser's install dialog; 'unavailable' when there is nothing to show. */
  prompt(): Promise<'accepted' | 'dismissed' | 'unavailable'>;
  /** Called whenever `canInstall()` flips. */
  onChange(cb: (can: boolean) => void): void;
}

/** Capture `beforeinstallprompt` as early as possible and expose it as an explicit action. */
export function installPrompt(win: PwaWindow | null = defaultWindow()): InstallPrompt {
  let deferred: BeforeInstallPromptEventLike | null = null;
  const listeners: ((can: boolean) => void)[] = [];
  const notify = (can: boolean): void => { for (const cb of listeners) { try { cb(can); } catch { /* listener */ } } };
  const set = (ev: BeforeInstallPromptEventLike | null): void => {
    const before = deferred !== null;
    deferred = ev;
    if (before !== (ev !== null)) notify(ev !== null);
  };

  if (win && !isShotHarness(win)) {
    win.addEventListener('beforeinstallprompt', (ev) => {
      ev.preventDefault();
      set(ev as BeforeInstallPromptEventLike);
    });
    win.addEventListener('appinstalled', () => set(null));
  }

  return {
    canInstall: () => deferred !== null,
    async prompt() {
      const ev = deferred;
      if (!ev) return 'unavailable';
      set(null);
      try {
        await ev.prompt();
        const choice = await ev.userChoice;
        return choice.outcome === 'accepted' ? 'accepted' : 'dismissed';
      } catch {
        return 'unavailable';
      }
    },
    onChange(cb) { listeners.push(cb); },
  };
}
