/**
 * PWA glue against fake window / navigator / service-worker objects: the update
 * prompt fires only for a genuine update (never on first install), `apply()`
 * posts skip-waiting and reloads once on controllerchange, the install prompt
 * is captured and exposed, and every entry point is inert in the capture
 * harness or without the APIs.
 */
import { describe, expect, it } from 'vitest';
import {
  installPrompt, isIosSafariNotStandalone, isShotHarness, isStandalone, registerServiceWorker,
  type BeforeInstallPromptEventLike, type PwaNavigator, type PwaWindow, type RegistrationLike, type ServiceWorkerLike,
} from '../../src/client/pwa.js';

// ------------------------------------------------------------------ fakes
class FakeWorker extends EventTarget implements ServiceWorkerLike {
  state = 'installing';
  messages: unknown[] = [];
  postMessage(m: unknown): void { this.messages.push(m); }
  setState(s: string): void { this.state = s; this.dispatchEvent(new Event('statechange')); }
}

class FakeRegistration extends EventTarget implements RegistrationLike {
  installing: FakeWorker | null = null;
  waiting: FakeWorker | null = null;
  active: FakeWorker | null = null;
  updates = 0;
  async update(): Promise<void> { this.updates++; }
  /** A new worker shows up and installs. */
  found(): FakeWorker {
    const w = new FakeWorker();
    this.installing = w;
    this.dispatchEvent(new Event('updatefound'));
    return w;
  }
}

class FakeContainer extends EventTarget {
  controller: FakeWorker | null = null;
  registered: string[] = [];
  reg = new FakeRegistration();
  fail = false;
  async register(url: string): Promise<RegistrationLike> {
    this.registered.push(url);
    if (this.fail) throw new TypeError('bad script');
    return this.reg;
  }
}

class FakeDocument extends EventTarget {
  readyState = 'complete';
  hidden = false;
}

class FakeWindow extends EventTarget implements PwaWindow {
  location = { search: '', reloads: 0, reload(): void { this.reloads++; } };
  document = new FakeDocument();
  media = new Set<string>();
  __shot?: boolean;
  matchMedia(q: string): { matches: boolean } { return { matches: this.media.has(q) }; }
}

function env(opts: { controlled?: boolean; search?: string } = {}) {
  const win = new FakeWindow();
  win.location.search = opts.search ?? '';
  const sw = new FakeContainer();
  if (opts.controlled) { sw.controller = new FakeWorker(); sw.controller.state = 'activated'; sw.reg.active = sw.controller; }
  const nav: PwaNavigator = { serviceWorker: sw };
  return { win, sw, nav };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// ------------------------------------------------------------------ tests
describe('registerServiceWorker', () => {
  it('registers /sw.js with scope / once the document is complete', async () => {
    const { win, sw, nav } = env();
    const reg = await registerServiceWorker({ win, nav, onUpdateReady: () => {} });
    expect(reg).toBe(sw.reg);
    expect(sw.registered).toEqual(['/sw.js']);
  });

  it('waits for the load event while the document is still loading', async () => {
    const { win, sw, nav } = env();
    win.document.readyState = 'loading';
    const p = registerServiceWorker({ win, nav, onUpdateReady: () => {} });
    await tick();
    expect(sw.registered).toEqual([]);
    win.dispatchEvent(new Event('load'));
    expect(await p).toBe(sw.reg);
    expect(sw.registered).toEqual(['/sw.js']);
  });

  it('a first install never prompts and never reloads on the claim', async () => {
    const { win, sw, nav } = env();
    let prompts = 0;
    await registerServiceWorker({ win, nav, onUpdateReady: () => { prompts++; } });
    const w = sw.reg.found();
    w.setState('installed');
    w.setState('activating');
    w.setState('activated');
    sw.controller = w;
    sw.dispatchEvent(new Event('controllerchange'));
    expect(prompts).toBe(0);
    expect(win.location.reloads).toBe(0);
  });

  it('prompts when an installing worker reaches installed under an existing controller; apply posts skip-waiting and reloads once', async () => {
    const { win, sw, nav } = env({ controlled: true });
    let apply: (() => void) | null = null;
    let prompts = 0;
    await registerServiceWorker({ win, nav, onUpdateReady: (a) => { prompts++; apply = a; } });
    const w = sw.reg.found();
    expect(prompts).toBe(0);
    w.setState('installed');
    sw.reg.installing = null;
    sw.reg.waiting = w;
    expect(prompts).toBe(1);
    // a repeated statechange for the same worker does not prompt twice
    w.setState('installed');
    expect(prompts).toBe(1);

    apply!();
    expect(w.messages).toEqual([{ type: 'skip-waiting' }]);
    sw.dispatchEvent(new Event('controllerchange'));
    sw.dispatchEvent(new Event('controllerchange'));
    expect(win.location.reloads).toBe(1);
  });

  it('prompts immediately when a worker is already waiting', async () => {
    const { win, sw, nav } = env({ controlled: true });
    const waiting = new FakeWorker();
    waiting.state = 'installed';
    sw.reg.waiting = waiting;
    let apply: (() => void) | null = null;
    await registerServiceWorker({ win, nav, onUpdateReady: (a) => { apply = a; } });
    expect(apply).not.toBeNull();
    apply!();
    expect(waiting.messages).toEqual([{ type: 'skip-waiting' }]);
  });

  it('a controllerchange this tab did not request re-offers the update instead of reloading; its apply reloads once', async () => {
    const { win, sw, nav } = env({ controlled: true });
    const applies: (() => void)[] = [];
    await registerServiceWorker({ win, nav, onUpdateReady: (a) => { applies.push(a); } });
    // another tab (or the browser) switched the worker under this page
    sw.dispatchEvent(new Event('controllerchange'));
    expect(win.location.reloads).toBe(0);
    expect(applies.length).toBe(1);
    sw.dispatchEvent(new Event('controllerchange'));
    expect(applies.length).toBe(1); // offered once
    applies[0]();
    applies[0]();
    expect(win.location.reloads).toBe(1);
  });

  it('defers the reload while isBusy() (a run in play) and performs it once when onRunEnd fires', async () => {
    const { win, sw, nav } = env({ controlled: true });
    let busy = true;
    const runEnd: (() => void)[] = [];
    let apply: (() => void) | null = null;
    await registerServiceWorker({
      win, nav, onUpdateReady: (a) => { apply = a; }, isBusy: () => busy, onRunEnd: (cb) => { runEnd.push(cb); },
    });
    const w = sw.reg.found();
    w.setState('installed');
    apply!();
    expect(w.messages).toEqual([{ type: 'skip-waiting' }]);
    sw.dispatchEvent(new Event('controllerchange'));
    expect(win.location.reloads).toBe(0); // the run is still going
    sw.dispatchEvent(new Event('controllerchange'));
    expect(win.location.reloads).toBe(0);
    busy = false;
    for (const cb of runEnd) cb();
    expect(win.location.reloads).toBe(1);
    for (const cb of runEnd) cb();
    sw.dispatchEvent(new Event('controllerchange'));
    expect(win.location.reloads).toBe(1);
  });

  it('a run end without a pending reload does nothing, and an idle page still reloads immediately on its own apply', async () => {
    const { win, sw, nav } = env({ controlled: true });
    const runEnd: (() => void)[] = [];
    let apply: (() => void) | null = null;
    await registerServiceWorker({ win, nav, onUpdateReady: (a) => { apply = a; }, isBusy: () => false, onRunEnd: (cb) => { runEnd.push(cb); } });
    for (const cb of runEnd) cb();
    expect(win.location.reloads).toBe(0);
    const w = sw.reg.found();
    w.setState('installed');
    apply!();
    sw.dispatchEvent(new Event('controllerchange'));
    expect(win.location.reloads).toBe(1);
  });

  it('relays sw-activated messages and checks for updates when the tab becomes visible, throttled', async () => {
    const { win, sw, nav } = env({ controlled: true });
    let t = 0;
    const builds: string[] = [];
    await registerServiceWorker({ win, nav, onUpdateReady: () => {}, onActivated: (b) => builds.push(b), updateCheckMs: 1000, now: () => t });
    sw.dispatchEvent(new MessageEvent('message', { data: { type: 'sw-activated', build: 'abc123' } }));
    sw.dispatchEvent(new MessageEvent('message', { data: { type: 'other' } }));
    expect(builds).toEqual(['abc123']);

    win.document.dispatchEvent(new Event('visibilitychange'));
    expect(sw.reg.updates).toBe(0); // too soon
    t = 1500;
    win.document.hidden = true;
    win.document.dispatchEvent(new Event('visibilitychange'));
    expect(sw.reg.updates).toBe(0); // hidden
    win.document.hidden = false;
    win.document.dispatchEvent(new Event('visibilitychange'));
    expect(sw.reg.updates).toBe(1);
    win.document.dispatchEvent(new Event('visibilitychange'));
    expect(sw.reg.updates).toBe(1); // throttled
  });

  it('is a no-op without the API, in the capture harness, or when registration fails', async () => {
    const { win, nav } = env({ search: '?shot=t1' });
    expect(await registerServiceWorker({ win, nav, onUpdateReady: () => {} })).toBeNull();
    const flagged = env();
    flagged.win.__shot = true;
    expect(await registerServiceWorker({ win: flagged.win, nav: flagged.nav, onUpdateReady: () => {} })).toBeNull();
    expect(flagged.sw.registered).toEqual([]);
    expect(await registerServiceWorker({ win: new FakeWindow(), nav: {}, onUpdateReady: () => {} })).toBeNull();
    expect(await registerServiceWorker({ win: null, nav: null, onUpdateReady: () => {} })).toBeNull();
    const failing = env();
    failing.sw.fail = true;
    expect(await registerServiceWorker({ win: failing.win, nav: failing.nav, onUpdateReady: () => {} })).toBeNull();
  });
});

describe('installPrompt', () => {
  function fireBip(win: FakeWindow, outcome: 'accepted' | 'dismissed'): BeforeInstallPromptEventLike & { prevented: boolean; prompted: number } {
    const ev = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
      prevented: boolean; prompted: number; prompt(): Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
    };
    ev.prevented = false;
    ev.prompted = 0;
    ev.prompt = async () => { ev.prompted++; };
    ev.userChoice = Promise.resolve({ outcome });
    win.dispatchEvent(ev);
    ev.prevented = ev.defaultPrevented;
    return ev;
  }

  it('captures beforeinstallprompt, reports the change and shows it on demand', async () => {
    const win = new FakeWindow();
    const p = installPrompt(win);
    const changes: boolean[] = [];
    p.onChange((c) => changes.push(c));
    expect(p.canInstall()).toBe(false);
    expect(await p.prompt()).toBe('unavailable');
    const ev = fireBip(win, 'accepted');
    expect(ev.prevented).toBe(true);
    expect(p.canInstall()).toBe(true);
    expect(changes).toEqual([true]);
    expect(await p.prompt()).toBe('accepted');
    expect(ev.prompted).toBe(1);
    expect(p.canInstall()).toBe(false);
    expect(changes).toEqual([true, false]);
    // a dismissed prompt is consumed as well (the browser re-fires later when it wants to)
    fireBip(win, 'dismissed');
    expect(await p.prompt()).toBe('dismissed');
    expect(p.canInstall()).toBe(false);
  });

  it('appinstalled clears the stashed event', () => {
    const win = new FakeWindow();
    const p = installPrompt(win);
    fireBip(win, 'accepted');
    expect(p.canInstall()).toBe(true);
    win.dispatchEvent(new Event('appinstalled'));
    expect(p.canInstall()).toBe(false);
  });

  it('is inert in the capture harness and without a window', async () => {
    const win = new FakeWindow();
    win.location.search = '?shot=title';
    const p = installPrompt(win);
    fireBip(win, 'accepted');
    expect(p.canInstall()).toBe(false);
    expect(await p.prompt()).toBe('unavailable');
    expect(installPrompt(null).canInstall()).toBe(false);
  });
});

describe('display-mode probes', () => {
  it('isShotHarness reads the flag or the query', () => {
    const win = new FakeWindow();
    expect(isShotHarness(win)).toBe(false);
    win.location.search = '?shot=t1&frames=10';
    expect(isShotHarness(win)).toBe(true);
    const flagged = new FakeWindow();
    flagged.__shot = true;
    expect(isShotHarness(flagged)).toBe(true);
    expect(isShotHarness(null)).toBe(false);
  });

  it('isStandalone honours display-mode and navigator.standalone', () => {
    const win = new FakeWindow();
    expect(isStandalone(win, {})).toBe(false);
    win.media.add('(display-mode: standalone)');
    expect(isStandalone(win, {})).toBe(true);
    const fs = new FakeWindow();
    fs.media.add('(display-mode: fullscreen)');
    expect(isStandalone(fs, {})).toBe(true);
    expect(isStandalone(new FakeWindow(), { standalone: true })).toBe(true);
    expect(isStandalone(null, {})).toBe(false);
  });

  it('isIosSafariNotStandalone spots iPhone / iPad Safari tabs only', () => {
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
    const chromeIos = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/118.0 Mobile/15E148 Safari/604.1';
    const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';
    const ipadDesktop = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
    const win = new FakeWindow();
    expect(isIosSafariNotStandalone({ userAgent: iphone }, win)).toBe(true);
    expect(isIosSafariNotStandalone({ userAgent: iphone, standalone: true }, win)).toBe(false);
    expect(isIosSafariNotStandalone({ userAgent: chromeIos }, win)).toBe(false);
    expect(isIosSafariNotStandalone({ userAgent: android }, win)).toBe(false);
    expect(isIosSafariNotStandalone({ userAgent: ipadDesktop, platform: 'MacIntel', maxTouchPoints: 5 }, win)).toBe(true);
    expect(isIosSafariNotStandalone({ userAgent: ipadDesktop, platform: 'MacIntel', maxTouchPoints: 0 }, win)).toBe(false);
    const standaloneWin = new FakeWindow();
    standaloneWin.media.add('(display-mode: standalone)');
    expect(isIosSafariNotStandalone({ userAgent: iphone }, standaloneWin)).toBe(false);
    expect(isIosSafariNotStandalone(null, win)).toBe(false);
  });
});
