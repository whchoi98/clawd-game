/**
 * Arm WebAudio on the first user activation and keep trying until the context
 * actually runs.
 *
 * Why not `pointerdown` once: per the HTML spec, a touch `pointerdown` is not
 * an activation-triggering event (only `keydown`, `mousedown`, mouse
 * `pointerdown`, non-mouse `pointerup` and `touchend` are), so on phones a
 * context resumed from it stays suspended — and a `{ once: true }` listener
 * never gets a second chance. This helper listens on every activation event
 * (capture phase, so pad handlers that stop propagation cannot hide the tap),
 * calls `audio.unlock()` inside the gesture and uninstalls itself only once
 * `audio.running` is true. Re-arm it when the page becomes visible again: iOS
 * will not resume a context outside a gesture after an app switch.
 */

export interface UnlockableAudio {
  unlock(): void;
  readonly ready: boolean;
  readonly running: boolean;
}

export interface UnlockTarget {
  addEventListener(type: string, cb: () => void, opts?: AddEventListenerOptions): void;
  removeEventListener(type: string, cb: () => void, opts?: EventListenerOptions): void;
}

/** Activation-triggering input events (plus mouse pointerdown for low latency on desktop). */
export const UNLOCK_EVENTS: readonly string[] = ['pointerdown', 'pointerup', 'touchend', 'mousedown', 'click', 'keydown'];

export interface UnlockOptions {
  /** Called once, right after the context is first created (apply volume settings here). */
  onFirstInit?: () => void;
  /** Called once when the context reaches the running state. */
  onRunning?: () => void;
  /** Delay before checking `running` after a gesture (resume() is asynchronous). */
  settleMs?: number;
  setTimeout?: (cb: () => void, ms: number) => unknown;
}

export interface UnlockController {
  /** Listen again (after a visibility change, when the context is no longer running). */
  arm(): void;
  /** Stop listening. */
  disarm(): void;
  readonly armed: boolean;
}

export function installAudioUnlock(target: UnlockTarget, audio: UnlockableAudio, opts: UnlockOptions = {}): UnlockController {
  const settleMs = opts.settleMs ?? 60;
  const later = opts.setTimeout ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
  let armed = false;
  let announcedInit = false;
  let announcedRunning = false;

  const finish = (): void => {
    if (!announcedRunning) { announcedRunning = true; opts.onRunning?.(); }
    disarm();
  };

  const onGesture = (): void => {
    const hadContext = audio.ready;
    audio.unlock();
    if (!hadContext && audio.ready && !announcedInit) { announcedInit = true; opts.onFirstInit?.(); }
    if (audio.running) { finish(); return; }
    // resume() resolves asynchronously; look again shortly, keep listening otherwise.
    later(() => { if (armed && audio.running) finish(); }, settleMs);
  };

  const arm = (): void => {
    if (armed) return;
    armed = true;
    announcedRunning = false;
    for (const t of UNLOCK_EVENTS) target.addEventListener(t, onGesture, { capture: true, passive: true });
  };
  const disarm = (): void => {
    if (!armed) return;
    armed = false;
    for (const t of UNLOCK_EVENTS) target.removeEventListener(t, onGesture, { capture: true });
  };

  arm();
  return { arm, disarm, get armed() { return armed; } };
}
