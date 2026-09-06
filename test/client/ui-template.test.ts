/**
 * Static assertions on the HTML template. The template is served under a CSP
 * without 'unsafe-inline', so no inline scripts, handlers or style attributes
 * may exist; the build replaces the two markers with hashed asset tags.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Screen } from '../../src/client/contracts.js';
import { FONTS_HREF } from '../../src/client/fonts.js';

const html = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../public/styles.css', import.meta.url), 'utf8');
const svg = readFileSync(new URL('../../public/favicon.svg', import.meta.url), 'utf8');

const SCREENS: Screen[] = ['boot', 'title', 'select', 'daily', 'settings', 'credits', 'play', 'pause', 'result', 'over', 'name'];

describe('public/index.html', () => {
  it('has a section for every Screen id', () => {
    for (const s of SCREENS) {
      expect(html, `#scr-${s}`).toMatch(new RegExp(`id="scr-${s}"`));
    }
  });

  it('carries the build markers in head and before </body>', () => {
    const head = html.slice(0, html.indexOf('</head>'));
    expect(head).toContain('<!--CSS-->');
    const bodyEnd = html.lastIndexOf('</body>');
    const appAt = html.indexOf('<!--APP-->');
    expect(appAt).toBeGreaterThan(0);
    expect(appAt).toBeLessThan(bodyEnd);
    expect(html.indexOf('<!--CSS-->')).toBe(html.lastIndexOf('<!--CSS-->'));
    expect(appAt).toBe(html.lastIndexOf('<!--APP-->'));
  });

  it('has no inline scripts, inline handlers or style attributes (CSP)', () => {
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/javascript:/i);
  });

  it('preconnects to Google Fonts but never render-blocks on an external stylesheet', () => {
    expect(html).toMatch(/<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com">/);
    expect(html).toMatch(/<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossorigin>/);
    // the webfont stylesheet is injected at boot (src/client/fonts.ts), not linked from the template
    expect(html).not.toMatch(/<link[^>]*rel="stylesheet"[^>]*href="https?:/i);
    expect(html).not.toContain('fonts.googleapis.com/css2');
    expect(FONTS_HREF).toMatch(/^https:\/\/fonts\.googleapis\.com\/css2\?.*family=Outfit.*family=Noto\+Sans\+KR/);
    const externals = [...html.matchAll(/(?:href|src)="(https?:)?\/\/([^/"]+)/g)].map((m) => m[2]);
    expect(externals.length).toBeGreaterThan(0);
    for (const host of externals) {
      expect(['fonts.googleapis.com', 'fonts.gstatic.com']).toContain(host);
    }
  });

  it('lets the viewport scale (no user-scalable=no) and keeps viewport-fit=cover', () => {
    const viewport = /<meta name="viewport" content="([^"]*)">/.exec(html)?.[1] ?? '';
    expect(viewport).toContain('viewport-fit=cover');
    expect(viewport).not.toMatch(/user-scalable/);
    expect(viewport).not.toMatch(/maximum-scale/);
    // double-tap zoom in play is stopped by touch-action:none on the body / pad instead
    expect(css).toMatch(/body\{[^}]*touch-action:none/);
  });

  it('the rotate prompt can be dismissed and every line speaks 해라체', () => {
    const nag = html.slice(html.indexOf('id="nag-rotate"'), html.indexOf('</noscript>'));
    expect(nag).toContain('data-act="dismissNag"');
    expect(nag).toContain('그래도 계속');
    expect(nag).toContain('data-nonav');
    expect(html).not.toMatch(/(주세요|합니다|습니다|해요|어요|아요)[.!…]?</);
    expect(html).toContain('이 게임은 JavaScript가 필요하다.');
  });

  it('has the world canvas, the HUD live region and touch controls', () => {
    expect(html).toMatch(/<canvas[^>]*id="world"/);
    expect(html).toMatch(/<[a-z]+[^>]*id="hud-sr"[^>]*aria-live="polite"/);
    expect(html).toMatch(/id="hud-touch"/);
    expect(html).toMatch(/data-touch="jump"/);
    expect(html).toMatch(/data-touch="dash"/);
    expect(html).toMatch(/id="tpad-move"/);
    expect(html).toMatch(/id="nag-rotate"/);
  });

  it('is Korean-first and boots on the boot screen', () => {
    expect(html).toMatch(/<html[^>]*lang="ko"/);
    expect(html).toMatch(/id="scr-boot"[^>]*class="[^"]*is-active|class="[^"]*is-active[^"]*"[^>]*id="scr-boot"/);
    expect(html).toContain('메아리의 탑');
    expect(html).toContain('ECHO TOWER');
  });

  it('title menu reaches select, daily, endless, settings and credits', () => {
    for (const act of ['openSelect', 'openDaily', 'endless', 'openSettings', 'openCredits']) {
      expect(html).toContain(`data-act="${act}"`);
    }
  });

  it('declares the PWA head tags from the contract (manifest, mobile / apple meta, icons)', () => {
    const head = html.slice(0, html.indexOf('</head>'));
    expect(head).toContain('<link rel="manifest" href="/manifest.webmanifest">');
    expect(head).toContain('<meta name="mobile-web-app-capable" content="yes">');
    expect(head).toContain('<meta name="apple-mobile-web-app-capable" content="yes">');
    expect(head).toContain('<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">');
    expect(head).toContain('<meta name="apple-mobile-web-app-title" content="ECHO TOWER">');
    expect(head).toContain('<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">');
    expect(head).toContain('<link rel="icon" type="image/png" sizes="192x192" href="/icons/icon-192.png">');
    expect(head).toMatch(/<meta name="theme-color" content="#050A12">/);
    // every PWA resource is same-origin and unhashed (the worker precaches them by path)
    for (const m of head.matchAll(/href="([^"]+)"/g)) {
      const href = m[1];
      if (href.startsWith('https://')) continue;
      expect(href.startsWith('/'), href).toBe(true);
      expect(href).not.toMatch(/\.[0-9a-f]{8}\./);
    }
  });

  it('title menu has the hidden install entry, the footer the offline badge and the dismissable iOS hint', () => {
    const title = html.slice(html.indexOf('id="scr-title"'), html.indexOf('id="scr-select"'));
    const install = /<button class="menu__item" data-act="install" hidden>홈 화면에 추가<small>전체 화면 · 오프라인 플레이<\/small><\/button>/;
    expect(title).toMatch(install);
    // the install entry is the last menu item so the phone layout budget stays with the real menu
    const menu = title.slice(title.indexOf('id="title-menu"'), title.indexOf('</nav>'));
    const acts = [...menu.matchAll(/data-act="([^"]+)"/g)].map((m) => m[1]);
    expect(acts.at(-1)).toBe('install');
    expect(acts).toContain('openSelect');
    expect(acts).toContain('openCredits');
    const foot = title.slice(title.indexOf('class="title__foot"'));
    expect(foot).toMatch(/<span class="badge badge--offline" id="offline-badge"[^>]*hidden>오프라인<\/span>/);
    expect(foot).toMatch(/id="ios-hint"[^>]*hidden>공유 → 홈 화면에 추가 하면 전체 화면으로 플레이할 수 있다/);
    expect(foot).toContain('data-act="dismissIos"');
    expect(foot).toMatch(/data-act="dismissIos"[^>]*data-nonav/);
  });

  it('has a hidden update bar with the ready text and a refresh button outside every screen', () => {
    const at = html.indexOf('id="upbar"');
    expect(at).toBeGreaterThan(0);
    const bar = html.slice(at, html.indexOf('</div>', html.indexOf('</div>', at) + 1));
    expect(bar).toContain('새 버전이 준비됐다');
    expect(bar).toMatch(/<button[^>]*data-act="applyUpdate"[^>]*>새로고침<\/button>/);
    expect(bar).toMatch(/data-act="applyUpdate"[^>]*data-nonav/);
    expect(html.slice(0, at)).toMatch(/hidden/);
    expect(/<div class="upbar" id="upbar"[^>]*hidden>/.test(html)).toBe(true);
    // not nested in a <section class="screen"> — it must be able to show over any menu
    const lastSectionOpen = html.lastIndexOf('<section', at);
    const lastSectionClose = html.lastIndexOf('</section>', at);
    expect(lastSectionClose).toBeGreaterThan(lastSectionOpen);
  });
});

describe('public/styles.css', () => {
  it('zeroes UI motion under prefers-reduced-motion', () => {
    const i = css.indexOf('prefers-reduced-motion');
    expect(i).toBeGreaterThan(0);
    const block = css.slice(i, i + 600);
    expect(block).toMatch(/animation-duration\s*:\s*0?\.?0*1?m?s/);
    expect(block).toMatch(/transition-duration/);
  });

  it('uses the Outfit / Noto Sans KR stack and tidepool accents', () => {
    expect(css).toMatch(/"Outfit"/);
    expect(css).toMatch(/"Noto Sans KR"/);
    expect(css.toUpperCase()).toContain('#7FE3D6');
    expect(css.toUpperCase()).toContain('#F28C6A');
  });

  it('styles the portrait prompt and touch controls', () => {
    expect(css).toMatch(/\.nag\b/);
    expect(css).toMatch(/\.nag__skip\b/);
    expect(css).toMatch(/\.tpad\b/);
    expect(css).toMatch(/touch-action\s*:\s*none/);
  });

  it('has a compact landscape-phone title layout as a media query, not the inert @container rule', () => {
    expect(css).not.toMatch(/@container\s*\(/);
    const i = css.indexOf('@media (max-height:430px)');
    expect(i).toBeGreaterThan(0);
    const block = css.slice(i, css.indexOf('\n}\n', i));
    expect(block).toMatch(/\.title__kicker\{display:none\}/);
    expect(block).toMatch(/\.title__logo\{font-size:clamp\([^)]*vh[^)]*\)\}/);
    expect(block).toMatch(/\.screen--title\{[^}]*overflow-y:auto/);
    expect(block).toMatch(/\.menu__item small\{display:none\}/);
  });

  it('lifts the HUD hint above the touch pads and styles the queued / PWA states', () => {
    expect(css).toMatch(/#ui\.is-touch \.hud__hint\{[^}]*bottom:calc\(10rem \+ env\(safe-area-inset-bottom\)\)[^}]*max-width:56vw/);
    expect(css).toMatch(/\.submit--queued\b/);
    expect(css).toMatch(/\.upbar\b/);
    expect(css).toMatch(/\.upbar__btn\b/);
    expect(css).toMatch(/\.badge--offline\b/);
    expect(css).toMatch(/\.title__ios\b/);
    // the bar must be clickable inside the pointer-events:none shell
    expect(css).toMatch(/\.upbar\{[^}]*pointer-events:auto/);
  });
});

describe('public/favicon.svg', () => {
  it('is a standalone SVG with no scripts', () => {
    expect(svg.trim().startsWith('<svg')).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).not.toMatch(/<script/i);
  });
});
