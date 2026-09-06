/**
 * Application entry (the esbuild client bundle). Composes the concrete
 * subsystems — Renderer, AudioEngine, UI, Input, Api, Save — behind the ports
 * in contracts.ts, hands them to `Scenes`, and runs the frame loop:
 *
 *   requestAnimationFrame → dt → scenes.frame(dt)
 *     → input.poll() · held / takeLatched()
 *     → N fixed 1/120 s ticks (tick 0 carries the latched press edges),
 *       scaled by hitstop / slow-mo, every mask recorded
 *     → one render
 *
 * `?shot=` switches to the synchronous capture harness (shot.ts) instead of
 * starting the loop. Boots on DOMContentLoaded, or immediately when the
 * document is already parsed.
 */
import { LEVELS } from '../sim/index.js';
import { Renderer } from './render/index.js';
import { createAudio } from './audio/index.js';
import { installAudioUnlock } from './audio/unlock.js';
import { UI } from './ui/index.js';
import { DEFAULT_BINDS, Input } from './input/index.js';
import { Api } from './net/api.js';
import { SubmitQueue } from './net/queue.js';
import { Save } from './save.js';
import { Scenes } from './scenes.js';
import { parseShotQuery, runShot } from './shot.js';
import { loadFonts } from './fonts.js';
import { installPrompt, isIosSafariNotStandalone, registerServiceWorker } from './pwa.js';

declare const __BUILD__: string | undefined;

/** Build id inlined by tools/build.mjs; 'dev' under vitest / plain tsc. */
const BUILD: string = typeof __BUILD__ === 'string' ? __BUILD__ : 'dev';

declare global {
  interface Window {
    /** Set while the `?shot=` capture harness is active (read by the QA smoke). */
    __shot?: boolean;
    /** The scene machine, for poking at from the console. */
    __clawd?: Scenes;
  }
}

let booted = false;
let uiRef: UI | null = null;

/**
 * Surface failures without trapping the player: before boot the message goes on
 * the loading screen; afterwards a toast, throttled so a per-frame throw
 * cannot spam it.
 */
let lastFatal = 0;
function fatal(msg: string): void {
  const text = String(msg).slice(0, 400);
  if (!booted) {
    const hint = document.getElementById('boot-hint');
    if (hint) { hint.textContent = text; hint.classList.add('is-error'); }
    return;
  }
  const now = Date.now();
  if (now - lastFatal < 4000) return;
  lastFatal = now;
  try { uiRef?.toast(text); } catch { /* the UI itself is broken */ }
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/**
 * Yield a frame, but never block boot on it: a backgrounded or headless tab can
 * throttle requestAnimationFrame indefinitely.
 */
const raf2 = (): Promise<void> => Promise.race([
  new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  wait(120),
]);

function reducedMotion(): boolean {
  try { return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

async function start(): Promise<void> {
  // First thing: kick off the webfont fetch without letting it block anything,
  // and start listening for the browser's install offer (it can fire early).
  loadFonts(document);
  const install = installPrompt();
  const canvas = document.getElementById('world') as HTMLCanvasElement | null;
  if (!canvas) throw new Error('canvas#world is missing');

  const save = new Save({ defaultBinds: DEFAULT_BINDS, reducedMotion: reducedMotion() });
  const renderer = new Renderer(canvas);
  const audio = createAudio();
  const input = new Input({ binds: save.settings.binds });
  const ui = new UI({
    input, audio, skins: renderer.skins, defaultBinds: DEFAULT_BINDS, build: BUILD,
    onInstall: () => { void install.prompt(); },
  });
  uiRef = ui;
  input.attachTouch(ui.touch);
  const api = new Api({ base: '' });
  const queue = new SubmitQueue();
  const scenes = new Scenes({ renderer, audio, ui, input, api, save, queue, levels: LEVELS, build: BUILD });
  window.__clawd = scenes;

  // WebAudio may only start inside a user activation, and a touch pointerdown
  // is not one: listen on every activation event until the context runs, and
  // re-arm after an app switch (iOS will not resume outside a gesture).
  const unlock = installAudioUnlock(window, audio, { onFirstInit: () => audio.applySettings(save.settings) });
  addEventListener('visibilitychange', () => { if (!document.hidden && !audio.running) unlock.arm(); });

  const onResize = (): void => renderer.resize();
  addEventListener('resize', onResize);
  window.visualViewport?.addEventListener('resize', onResize);
  addEventListener('pagehide', () => save.flush());
  addEventListener('visibilitychange', () => { if (document.hidden) save.flush(); });

  // Deterministic capture mode for automated visual checks — never without the flag.
  const spec = parseShotQuery(new URLSearchParams(location.search));
  if (spec) {
    window.__shot = true;
    scenes.bootSync();
    booted = true;
    runShot(spec, { scenes, renderer, ui, doc: document, audio, levels: LEVELS, build: BUILD });
    return;
  }

  // PWA: install offer → title menu; iOS share-sheet hint; update bar when a new
  // worker waits; connectivity badge; queued runs go out when the network returns.
  ui.setInstallable(install.canInstall());
  install.onChange((on) => ui.setInstallable(on));
  ui.setIosHint(isIosSafariNotStandalone());
  void registerServiceWorker({ onUpdateReady: (apply) => ui.showUpdate(apply) });
  const syncOnline = (): void => ui.setOffline(typeof navigator.onLine === 'boolean' && !navigator.onLine);
  syncOnline();
  addEventListener('online', () => { syncOnline(); void scenes.flushQueue(); });
  addEventListener('offline', syncOnline);

  const fonts = (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts?.ready;
  await scenes.boot({ raf: raf2, wait, fonts });
  booted = true;

  let last = performance.now();
  const frame = (now: number): void => {
    requestAnimationFrame(frame);
    let dt = (now - last) / 1000;
    last = now;
    if (!(dt > 0)) dt = 1 / 120;
    scenes.frame(Math.min(dt, 0.25));
  };
  requestAnimationFrame((now) => { last = now; frame(now); });
}

addEventListener('error', (e) => fatal(`오류: ${e.message} @ ${e.filename?.split('/').pop() ?? ''}:${e.lineno}`));
addEventListener('unhandledrejection', (e) => {
  const r = (e as PromiseRejectionEvent).reason as { message?: string } | undefined;
  fatal(`오류: ${r?.message ?? String(r)}`);
});

function boot(): void {
  start().catch((e: unknown) => fatal(`부팅 실패: ${e instanceof Error ? e.stack ?? e.message : String(e)}`));
}

if (document.readyState === 'loading') addEventListener('DOMContentLoaded', boot, { once: true });
else boot();
