// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Settings } from '../../src/client/contracts.js';
import { DEFAULT_BINDS, Input } from '../../src/client/input/index.js';
import { SettingsPanel } from '../../src/client/ui/settings.js';

let input: Input;
let panel: SettingsPanel;
let settings: Settings;
let callbacks: ((code: string | null) => void)[];

beforeEach(() => {
  document.body.innerHTML = `<section id="scr-settings">
    <div id="pane-av"></div><div id="pane-ctrl"></div>
    <div id="pane-a11y"></div><div id="pane-data"></div>
  </section>`;
  input = new Input({ getGamepads: () => [] });
  callbacks = [];
  settings = {
    v: 1, master: 0.8, music: 0.6, sfx: 0.8, shake: 1, bloom: true, grain: true, quality: 'auto',
    flashes: true, showTimer: true, skin: 'clawd', assist: false, invincible: false, echoSelf: true, echoWorld: true,
    binds: structuredClone(DEFAULT_BINDS),
  };
  panel = new SettingsPanel({
    doc: document, settings: () => settings, skins: () => ({}), keyLabel: (code) => input.keyLabel(code),
    capture: (cb) => { callbacks.push(cb); input.capture(cb); return true; },
    // Integration through the existing InputPort: no contract extension is needed.
    cancelCapture: () => input.reset(),
    defaultBinds: () => DEFAULT_BINDS,
    onChange() {}, onRebind: (binds) => input.setBinds(binds), onRebuilt() {}, sound() {}, portrait: () => null,
  });
  panel.build();
});

afterEach(() => {
  input.dispose();
  document.body.replaceChildren();
});

const bind = () => document.querySelector<HTMLButtonElement>('[data-bind="dash"][data-slot="0"]')!;
const key = (code: string) => window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));

describe('settings capture lifecycle', () => {
  it('cancels the panel and input together without changing the bind or swallowing the next key', () => {
    const button = bind();
    const before = structuredClone(settings.binds);
    button.click();
    expect(panel.capturing).toBe(true);
    panel.cancelCapture();
    panel.cancelCapture();
    expect(panel.capturing).toBe(false);
    expect(input.capturing).toBe(false);
    expect(button.classList.contains('listening')).toBe(false);
    expect(button.textContent).toBe('L Shift');
    expect(settings.binds).toEqual(before);
    key('ArrowDown');
    input.poll();
    expect(input.takeMenu()).toEqual(['down']);
  });

  it('ignores a callback from an abandoned capture even after the same button starts listening again', () => {
    const button = bind();
    button.click();
    const abandoned = callbacks[0];
    panel.cancelCapture();
    button.click();
    abandoned('KeyM');
    expect(settings.binds.dash[0]).toBe('ShiftLeft');
    expect(panel.capturing).toBe(true);
    key('KeyQ');
    expect(settings.binds.dash[0]).toBe('KeyQ');
    expect(panel.capturing).toBe(false);
  });

  it('rebuilding settings cancels the old capture and restores ordinary menu input', () => {
    bind().click();
    panel.build();
    expect(panel.capturing).toBe(false);
    expect(input.capturing).toBe(false);
    key('Enter');
    input.poll();
    expect(input.takeMenu()).toEqual(['confirm']);
    expect(settings.binds.dash[0]).toBe('ShiftLeft');
  });

  it('clears the listening widget when the input lifecycle cancels on blur', () => {
    const button = bind();
    button.click();
    window.dispatchEvent(new Event('blur'));
    expect(input.capturing).toBe(false);
    expect(panel.capturing).toBe(false);
    expect(button.textContent).toBe('L Shift');
    key('Enter');
    input.poll();
    expect(input.takeMenu()).toEqual(['confirm']);
  });
});
