import { describe, expect, it } from 'vitest';
import { installAudioUnlock, UNLOCK_EVENTS } from '../../src/client/audio/unlock.js';

class FakeTarget {
  listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, cb: () => void) { (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)!).add(cb); }
  removeEventListener(type: string, cb: () => void) { this.listeners.get(type)?.delete(cb); }
  fire(type: string) { for (const cb of [...(this.listeners.get(type) ?? [])]) cb(); }
  count() { let n = 0; for (const s of this.listeners.values()) n += s.size; return n; }
}

/** A context that only runs once unlocked from an "activation" event. */
class FakeAudio {
  ready = false;
  running = false;
  unlocks = 0;
  /** Set by the test to simulate whether the current gesture carries user activation. */
  activationNow = false;
  unlock() { this.unlocks++; this.ready = true; if (this.activationNow) this.running = true; }
}

const timers: (() => void)[] = [];
const later = (cb: () => void) => { timers.push(cb); return 0; };
const flush = () => { for (const t of timers.splice(0)) t(); };

describe('installAudioUnlock', () => {
  it('listens on every activation-triggering event, in capture phase', () => {
    const t = new FakeTarget();
    installAudioUnlock(t, new FakeAudio(), { setTimeout: later });
    for (const ev of ['pointerup', 'touchend', 'click', 'keydown', 'mousedown', 'pointerdown']) expect(t.listeners.get(ev)?.size).toBe(1);
    expect(UNLOCK_EVENTS).toContain('touchend');
  });

  it('a touch pointerdown without activation does not disarm; the following pointerup unlocks and disarms', () => {
    const t = new FakeTarget();
    const a = new FakeAudio();
    let firstInit = 0, running = 0;
    installAudioUnlock(t, a, { setTimeout: later, onFirstInit: () => firstInit++, onRunning: () => running++ });
    a.activationNow = false;
    t.fire('pointerdown');            // touch: creates the context but cannot start it
    flush();
    expect(a.ready).toBe(true);
    expect(a.running).toBe(false);
    expect(firstInit).toBe(1);
    expect(t.count()).toBe(UNLOCK_EVENTS.length); // still armed — the old once-listener bug
    a.activationNow = true;
    t.fire('pointerup');              // the same tap's activation event
    expect(a.running).toBe(true);
    expect(running).toBe(1);
    expect(t.count()).toBe(0);        // disarmed
    expect(a.unlocks).toBe(2);
  });

  it('checks again after the settle delay because resume() is asynchronous', () => {
    const t = new FakeTarget();
    const a = new FakeAudio();
    installAudioUnlock(t, a, { setTimeout: later });
    a.activationNow = false;
    t.fire('click');
    a.running = true;                 // resume() promise resolved a moment later
    expect(t.count()).toBe(UNLOCK_EVENTS.length);
    flush();
    expect(t.count()).toBe(0);
  });

  it('can be re-armed after the page comes back (iOS will not resume outside a gesture)', () => {
    const t = new FakeTarget();
    const a = new FakeAudio();
    const ctl = installAudioUnlock(t, a, { setTimeout: later });
    a.activationNow = true;
    t.fire('keydown');
    expect(ctl.armed).toBe(false);
    a.running = false;                // app switch suspended the context
    ctl.arm();
    expect(ctl.armed).toBe(true);
    expect(t.count()).toBe(UNLOCK_EVENTS.length);
    t.fire('touchend');
    expect(a.running).toBe(true);
    expect(ctl.armed).toBe(false);
  });
});
