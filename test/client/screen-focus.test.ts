// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { Navigator, ScreenStack, isVisible } from '../../src/client/ui/screens.js';

const get = (id: string) => document.getElementById(id)!;
let screens: ScreenStack;

beforeEach(() => {
  document.body.innerHTML = `
    <section class="screen is-active" id="scr-title">
      <button class="menu__item" id="open-settings">Settings</button>
      <button class="menu__item" id="title-other">Credits</button>
    </section>
    <section class="screen screen--modal" id="scr-settings" aria-label="Settings">
      <input type="range" id="music">
      <button id="open-name">Name</button>
      <button class="menu__item" id="close-settings">Close</button>
    </section>
    <section class="screen screen--modal" id="scr-name" aria-label="Name">
      <input id="name-field" type="text">
      <button class="menu__item" id="close-name">Close</button>
    </section>
    <section class="screen screen--modal" id="scr-credits" aria-label="Credits">
      <button class="menu__item" id="close-credits">Close</button>
    </section>
    <section class="screen" id="scr-play"><button id="pause">Pause</button></section>
    <section class="screen" id="scr-replay">
      <button id="replay-toggle" data-default>Play / pause</button>
      <button id="replay-next">Next checkpoint</button>
      <button id="replay-close">Close replay</button>
    </section>
    <section class="screen" id="scr-select">
      <div id="cards">
        <button class="card" id="zone-one" data-default>Zone one</button>
        <button class="card" id="zone-two">Zone two</button>
      </div>
    </section>
    <section class="screen" id="scr-ending">
      <button class="menu__item" id="ending-replay">Replay</button>
      <button class="menu__item" id="ending-credits">Credits</button>
    </section>`;
  screens = new ScreenStack(document);
});

function tab(shiftKey = false): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', shiftKey, bubbles: true, cancelable: true });
  document.activeElement!.dispatchEvent(e);
  return e;
}

describe('screen focus ownership', () => {
  it('makes only the top regular screen interactive and gives its initial action keyboard focus', () => {
    get('open-settings').focus();
    screens.show('settings');
    expect(get('scr-title').hasAttribute('inert')).toBe(true);
    expect(get('scr-title').getAttribute('aria-hidden')).toBe('true');
    expect(get('scr-settings').hasAttribute('inert')).toBe(false);
    expect(get('scr-settings').getAttribute('role')).toBe('dialog');
    expect(get('scr-settings').getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(get('close-settings'));
  });

  it('wraps Tab and Shift+Tab inside a modal, including native form controls', () => {
    screens.show('settings');
    get('close-settings').focus();
    expect(tab().defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(get('music'));
    expect(tab(true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(get('close-settings'));
  });

  it('restores each opener through nested modal closes and keeps the navigator on the restored action', () => {
    get('open-settings').focus();
    screens.show('settings');
    get('open-name').focus();
    screens.show('name');
    get('name-field').focus();
    screens.pop();
    expect(document.activeElement).toBe(get('open-name'));
    expect(get('scr-name').hasAttribute('inert')).toBe(true);
    const nav = new Navigator(document, { onConfirm() {}, onCancel() {} });
    nav.refresh(screens.el('settings'));
    expect(nav.current).toBe(get('open-name'));
    screens.pop();
    expect(document.activeElement).toBe(get('open-settings'));
    expect(get('scr-title').hasAttribute('inert')).toBe(false);
    expect(get('scr-settings').hasAttribute('inert')).toBe(true);
  });

  it('restores the lower modal when show() removes the screens above it', () => {
    screens.show('settings');
    get('open-name').focus();
    screens.show('name');
    screens.show('settings');
    expect(document.activeElement).toBe(get('open-name'));
    expect(get('scr-name').hasAttribute('inert')).toBe(true);
  });

  it('removes leaving controls from keyboard access immediately and focuses the gameplay surface', () => {
    screens.show('settings');
    screens.show('play');
    expect(get('scr-settings').classList.contains('is-leaving')).toBe(true);
    expect(get('scr-settings').hasAttribute('inert')).toBe(true);
    expect(document.activeElement).toBe(get('scr-play'));
    // Gameplay must not put native Enter/Space focus on its pause button.
    expect(document.activeElement).not.toBe(get('pause'));
  });

  it('returns focus to the gameplay surface even when a HUD button opened the modal', () => {
    screens.show('play');
    get('pause').focus();
    screens.show('settings');
    screens.show('play');
    expect(document.activeElement).toBe(get('scr-play'));
  });

  it('chooses a live fallback when the opener was removed while its modal was open', () => {
    get('open-settings').focus();
    screens.show('settings');
    get('open-settings').remove();
    screens.pop();
    expect(document.activeElement).toBe(get('title-other'));
  });

  it('treats replay as a base screen and restores its transport focus after a modal', () => {
    screens.show('play');
    screens.show('replay');
    expect(screens.base).toBe('replay');
    expect(screens.modals).toEqual([]);
    expect(get('scr-play').hasAttribute('inert')).toBe(true);
    expect(get('scr-replay').hasAttribute('inert')).toBe(false);
    expect(get('scr-replay').hasAttribute('aria-modal')).toBe(false);
    expect(document.activeElement).toBe(get('replay-toggle'));
    get('replay-close').focus();
    // A base screen may let Tab leave the application.
    expect(tab().defaultPrevented).toBe(false);
    screens.show('credits');
    screens.pop();
    expect(document.activeElement).toBe(get('replay-close'));
  });

  it('keeps keyboard focus in sync with menu moves without moving focus on pointer hover', () => {
    screens.show('title');
    const nav = new Navigator(document, { onConfirm() {}, onCancel() {} });
    nav.refresh(screens.el('title'));
    nav.move('down');
    expect(document.activeElement).toBe(get('title-other'));
    expect(nav.current).toBe(document.activeElement);
    nav.hover(get('open-settings'));
    expect(document.activeElement).toBe(get('title-other'));
  });

  it('focuses Play when the focused replay Next control becomes disabled and the browser drops focus', () => {
    screens.show('replay');
    const nav = new Navigator(document, { onConfirm() {}, onCancel() {} });
    nav.refresh(screens.el('replay'));
    const next = get('replay-next') as HTMLButtonElement;
    next.focus();
    nav.hover(next);
    next.disabled = true;
    next.blur(); // happy-dom does not reproduce the browser's automatic blur on disable.
    expect(document.activeElement).toBe(document.body);
    nav.refresh(screens.el('replay'), true);
    expect(nav.current).toBe(get('replay-toggle'));
    expect(document.activeElement).toBe(get('replay-toggle'));
  });

  it('focuses the newly selected campaign card when rebuilding removes the focused card', () => {
    screens.show('select');
    const nav = new Navigator(document, { onConfirm() {}, onCancel() {} });
    nav.refresh(screens.el('select'));
    get('zone-two').focus();
    nav.hover(get('zone-two'));
    // The campaign owner preserves the selected ID and marks the replacement default.
    get('cards').innerHTML = `<button class="card" id="zone-one">Zone one</button>
      <button class="card" id="zone-two" data-default>Zone two</button>`;
    expect(document.activeElement).toBe(document.body);
    nav.refresh(screens.el('select'));
    expect(nav.current).toBe(get('zone-two'));
    expect(document.activeElement).toBe(get('zone-two'));
  });

  it.each([
    '<input id="editor" type="text">',
    '<textarea id="editor"></textarea>',
    '<div id="editor" contenteditable="true" tabindex="0"></div>',
    '<input id="editor" type="range">',
    '<button id="editor">Another active control</button>',
    '<a id="editor" href="#help">Help</a>',
  ])('does not steal valid focus during a cursor refresh: %s', (markup) => {
    screens.show('settings');
    const root = screens.el('settings')!;
    const nav = new Navigator(document, { onConfirm() {}, onCancel() {} });
    nav.refresh(root);
    root.insertAdjacentHTML('beforeend', markup);
    get('editor').focus();
    nav.refresh(root, true);
    expect(document.activeElement).toBe(get('editor'));
  });

  it('accepts a manually managed surface and restores its focus after a regular modal', () => {
    screens.show('play');
    get('scr-ending').classList.add('is-active');
    screens.setFocusRoot(get('scr-ending'));
    get('ending-credits').focus();
    screens.show('credits');
    expect(get('scr-ending').hasAttribute('inert')).toBe(true);
    expect(document.activeElement).toBe(get('close-credits'));
    screens.pop();
    // The UI's afterShow hook selects the ending again after credits close.
    screens.setFocusRoot(get('scr-ending'));
    expect(get('scr-play').hasAttribute('inert')).toBe(true);
    expect(document.activeElement).toBe(get('ending-credits'));
    expect(tab().defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(get('ending-replay'));
    get('scr-ending').classList.remove('is-active');
    screens.setFocusRoot(null);
    expect(get('scr-ending').hasAttribute('inert')).toBe(true);
    expect(document.activeElement).toBe(get('scr-play'));
  });

  it('does not navigate hidden/inert roots or elements outside the requested root', () => {
    const root = get('scr-settings');
    expect(isVisible(get('close-settings'), root)).toBe(false);
    expect(isVisible(get('title-other'), root)).toBe(false);
    screens.show('settings');
    expect(isVisible(get('close-settings'), root)).toBe(true);
    root.hidden = true;
    expect(isVisible(get('close-settings'), root)).toBe(false);
  });
});
