// @vitest-environment happy-dom
/**
 * Static assertions on the HTML template, plus the DOM behaviour of the
 * surfaces added in Phase 1 (the data notice and the urgent update bar) driven
 * through the real `UI`. The template is served under a CSP without
 * 'unsafe-inline', so no inline scripts, handlers or style attributes may
 * exist; the build replaces the two markers with hashed asset tags.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Binds, InputPort, MenuAction, Progress, Screen, Settings, TouchState } from '../../src/client/contracts.js';
import type { LevelDef } from '../../src/sim/types.js';
import { FONTS_HREF } from '../../src/client/fonts.js';
import { UI } from '../../src/client/ui/ui.js';

// happy-dom replaces the global URL, so the template path is resolved with node:url/path.
const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(here, '../../public/index.html'), 'utf8');
const css = readFileSync(resolve(here, '../../public/styles.css'), 'utf8');
const svg = readFileSync(resolve(here, '../../public/favicon.svg'), 'utf8');

const SCREENS: Screen[] = ['boot', 'title', 'select', 'daily', 'settings', 'credits', 'data', 'play', 'pause', 'result', 'over', 'name', 'assist'];

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

  it('has the data notice screen, reached from the credits, saying what leaves the device and how to have it removed', () => {
    const dataAt = html.indexOf('<!-- DATA NOTICE');
    expect(dataAt).toBeGreaterThan(0);
    const credits = html.slice(html.indexOf('id="scr-credits"'), dataAt);
    expect(credits).toMatch(/<button class="menu__item" data-act="openData">데이터 안내/);
    const data = html.slice(dataAt, html.indexOf('id="upbar"'));
    expect(data).toMatch(/<section class="screen screen--modal" id="scr-data" aria-label="데이터 안내">/);
    expect(data).toContain('<h2>데이터 안내</h2>');
    // collected · not collected · deletion path · the run ids to quote
    expect(data).toContain('입력 기록(리플레이)');
    expect(data).toContain('익명 플레이어 id');
    expect(data).toMatch(/플레이어 id와 이름은 플레이 통계에 절대 넣지 않는다/);
    expect(data).toMatch(/IP 주소는 서버 기록에도 남기지 않는다/);
    expect(data).toMatch(/기록 번호를 적어 GitHub 이슈나 이메일로 요청한다/);
    expect(data).toMatch(/<ul class="data__runs" id="data-runs"><\/ul>/);
    expect(data).toContain('data-act="close"');
    expect(css).toMatch(/\.data__runs\b/);
    expect(css).toMatch(/\.upbar--urgent\b/);
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

  it('touch buttons rest at 35% opacity, read 90% while pressed, and sit 12px above the pad line', () => {
    const tbtn = /\n\.tbtn\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(tbtn).toMatch(/(^|;)opacity:\.35(;|$)/);
    const down = /\.tbtn:active,\.tbtn\.is-down\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(down).toMatch(/opacity:\.9/);
    const tbtns = /\.tbtns\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(tbtns).toMatch(/translate:0 -12px/);
  });

  it('result modal has the unlock row and the rank / unlock / card animations respect reduced motion', () => {
    expect(html).toMatch(/<div class="res__unlock" id="res-unlock"[^>]*hidden>/);
    expect(css).toMatch(/\.res__rank\.pop\{/);
    expect(css).toMatch(/@keyframes rankPop/);
    expect(css).toMatch(/\.card\.is-unlocking\{/);
    const i = css.indexOf('prefers-reduced-motion');
    const block = css.slice(i, css.indexOf('\n}\n', i));
    expect(block).toMatch(/\.res__rank\.pop[^{]*\{animation:none\}/);
    expect(block).toMatch(/\.card\.is-unlocking/);
  });

  it('P2-3 · the daily card carries the 7-day strip, the streak badge, the yesterday row and a hidden 재도전 entry', () => {
    const daily = html.slice(html.indexOf('id="scr-daily"'), html.indexOf('id="scr-play"'));
    expect(daily).toMatch(/<div class="daily__week" id="daily-week" role="list"/);
    expect(daily).toMatch(/<b class="daily__badge" id="daily-streak" hidden>/);
    expect(daily).toMatch(/<p class="daily__yday" id="daily-yday" role="status" hidden>/);
    expect(daily).toMatch(/<button class="menu__item" data-act="retryYesterday" hidden>어제의 탑 재도전/);
    expect(daily).toContain('id="daily-mine"');
    expect(daily).not.toContain('<dt>내 기록</dt>');
    expect(html).toMatch(/data-act="openDaily">데일리 타워<small id="daily-note">/);
    expect(css).toMatch(/\.daily__week\{[^}]*grid-template-columns:repeat\(7,/);
    expect(css).toMatch(/\.daily__day\.is-today\{/);
    expect(css).toMatch(/\.daily__badge--final\{/);
  });

  it('P2-2 · the game-over modal has the best-height bar (--pct) and the 같은 탑 다시 / 새 탑 entries next to 다시 도전', () => {
    const over = html.slice(html.indexOf('id="scr-over"'), html.indexOf('id="scr-name"'));
    expect(over).toMatch(/<div class="over__bar" id="over-bar" role="progressbar"[^>]*><i><\/i><span id="over-bar-text"><\/span><\/div>/);
    expect(over).toMatch(/data-act="sameTower" hidden>같은 탑 다시/);
    expect(over).toMatch(/data-act="newTower" hidden>새 탑/);
    expect(over).toMatch(/data-act="retry">다시 도전/);
    expect(css).toMatch(/\.over__bar i::after\{[^}]*width:calc\(var\(--pct,0\) \* 100%\)/);
    expect(css).toMatch(/\.over__bar\.is-best\{/);
    expect(css).toMatch(/\.name-inline\{/);
  });

  it('P2-6 · the assist offer modal speaks the exact line and answers with 다시 시작 / 이번엔 괜찮다 / 다시 묻지 않기', () => {
    const assist = html.slice(html.indexOf('<!-- ASSIST OFFER'), html.indexOf('id="scr-settings"'));
    expect(assist).toMatch(/<section class="screen screen--modal" id="scr-assist" aria-label="보조 모드 제안">/);
    expect(assist).toContain('보조 모드로 이 구역을 다시 시작할까? 기록은 순위표에 오르지 않는다 · 설정에서 언제든 끈다');
    expect(assist).toMatch(/data-act="assistAccept">다시 시작/);
    expect(assist).toMatch(/data-act="assistDecline">이번엔 괜찮다/);
    expect(assist).toMatch(/data-act="assistNever">다시 묻지 않기/);
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

  it('parks the touch hint as a plate under the HUD top row and styles the queued / PWA states', () => {
    // touch: the pads own the bottom of the screen, so the hint anchors to the top (never `bottom`)
    const touchHint = /#ui\.is-touch \.hud__hint\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(touchHint).toMatch(/top:calc\([0-9.]+rem \+ env\(safe-area-inset-top\)\)/);
    expect(touchHint).toMatch(/bottom:auto/);
    expect(touchHint).toMatch(/max-width:\d+vw/);
    expect(css).toMatch(/\.submit--queued\b/);
    expect(css).toMatch(/\.upbar\b/);
    expect(css).toMatch(/\.upbar__btn\b/);
    expect(css).toMatch(/\.badge--offline\b/);
    expect(css).toMatch(/\.title__ios\b/);
    // the bar must be clickable inside the pointer-events:none shell
    expect(css).toMatch(/\.upbar\{[^}]*pointer-events:auto/);
  });
});

// ------------------------------------------------------------------ DOM behaviour (real UI over the template)
function mountTemplate(): void {
  const body = html.slice(html.indexOf('<body>') + '<body>'.length, html.lastIndexOf('</body>'));
  document.body.innerHTML = body;
}

const BINDS: Binds = {
  left: ['ArrowLeft'], right: ['ArrowRight'], up: ['ArrowUp'], down: ['ArrowDown'], jump: ['Space'], dash: ['ShiftLeft'],
  pause: ['Escape'], confirm: ['Enter'], cancel: ['Escape'], restart: ['KeyR'],
};
function makeSettings(): Settings {
  return {
    v: 1, master: 0.8, music: 0.6, sfx: 0.9, shake: 1, bloom: true, grain: true, quality: 'auto', flashes: true, showTimer: true,
    skin: 'clawd', assist: false, invincible: false, echoSelf: true, echoWorld: false, binds: structuredClone(BINDS),
  };
}
interface FakeInput extends InputPort { queue: MenuAction[] }
function makeInput(): FakeInput {
  const touch: TouchState = { active: false, x: 0, y: 0, jump: false, dash: false, jumpPressed: false, dashPressed: false };
  const fi: FakeInput = {
    queue: [],
    poll() {}, held() { return 0; }, takeLatched() { return 0; },
    takeMenu() { return fi.queue.splice(0); },
    menuHeld() { return false; },
    setBinds() {}, capture() {}, reset() {},
    lastDevice: 'keyboard', touch,
    keyLabel(code) { return code.replace(/^Key/, ''); },
  };
  return fi;
}
const LEVELS: LevelDef[] = [
  { id: 't1', name: '첫 물결', en: 'T1', biome: 'tidepool', par: 45, seed: 1, rows: ['P.G', '###'] },
  { id: 't2', name: '해초 숲', en: 'T2', biome: 'tidepool', par: 55, seed: 2, rows: ['P.G', '###'] },
];
function makeProgress(): Progress {
  return {
    v: 1,
    levels: {
      t1: { done: true, bestTicks: 5400, bestShards: 20, stars: 3, relics: 1, deaths: 0, runId: 'run-t1-abc' },
      t2: { done: true, bestTicks: 6000, bestShards: 10, stars: 1, relics: 0, deaths: 2 },
    },
    endless: { bestHeight: 0, bestShards: 0, runs: 0 },
    daily: { '2026-09-05': { bestTicks: 7000, cleared: true, height: 0, seed: 7, runId: 'run-daily-xyz' } },
    totals: { deaths: 2, shards: 30 }, seen: {}, lastLevel: 't1', player: { id: 'abcdefghij', name: '클로드' },
  };
}

describe('UI · data notice (#scr-data)', () => {
  let ui: UI;
  let input: FakeInput;
  let reloads = 0;
  beforeEach(() => {
    mountTemplate();
    input = makeInput();
    reloads = 0;
    ui = new UI({ document, input, audio: null, defaultBinds: BINDS, build: 'test', reload: () => { reloads++; } });
    ui.applySettings(makeSettings());
    ui.refreshSelect(makeProgress(), LEVELS);
    ui.show('title');
  });
  afterEach(() => { document.body.innerHTML = ''; });

  it('opens from the credits button, lists the submitted run ids, and closes back to the credits', () => {
    document.querySelector<HTMLElement>('[data-act="openCredits"]')!.click();
    expect(ui.screen).toBe('credits');
    document.querySelector<HTMLElement>('#scr-credits [data-act="openData"]')!.click();
    expect(ui.screen).toBe('data');
    const scr = document.getElementById('scr-data')!;
    expect(scr.classList.contains('is-active')).toBe(true);
    expect(document.getElementById('scr-credits')!.classList.contains('is-active')).toBe(true); // stacked over the credits
    const rows = [...document.querySelectorAll('#data-runs li')].map((li) => li.textContent);
    expect(rows).toEqual(['첫 물결run-t1-abc', '데일리 2026-09-05run-daily-xyz']);
    // the menu cursor is on the notice's close button, and cancel closes it
    expect(document.querySelector('#scr-data .is-cursor')).not.toBeNull();
    input.queue.push('cancel');
    ui.frame(1 / 60, input);
    expect(ui.screen).toBe('credits');
    expect(scr.classList.contains('is-active')).toBe(false);
    expect(document.querySelector('#scr-credits .is-cursor')).not.toBeNull();
  });

  it('shows a placeholder without any submitted record and closes when another screen is shown', () => {
    const empty = makeProgress();
    delete empty.levels.t1.runId;
    empty.daily = {};
    ui.refreshSelect(empty, LEVELS);
    ui.show('credits');
    ui.show('data');
    expect([...document.querySelectorAll('#data-runs li')].map((li) => li.textContent)).toEqual(['서버에 올린 기록이 없다']);
    ui.show('title');
    expect(ui.screen).toBe('title');
    expect(document.getElementById('scr-data')!.classList.contains('is-active')).toBe(false);
  });

  it('the update bar turns urgent when the server sim is newer and reloads without a waiting worker; hidden during play', () => {
    const bar = document.getElementById('upbar')!;
    expect(bar.hidden).toBe(true);
    ui.setVersionBehind(true);
    expect(bar.hidden).toBe(false);
    expect(bar.classList.contains('upbar--urgent')).toBe(true);
    expect(bar.querySelector('span')!.textContent).toContain('새 버전');
    ui.show('play');
    expect(bar.hidden).toBe(true);
    ui.show('title');
    expect(bar.hidden).toBe(false);
    document.querySelector<HTMLElement>('[data-act="applyUpdate"]')!.click();
    expect(reloads).toBe(1);
    // the page is reloading; should that fail, the bar stays as the way out
    expect(bar.hidden).toBe(false);
    // a waiting worker takes precedence over the plain reload
    let applied = 0;
    ui.showUpdate(() => { applied++; });
    document.querySelector<HTMLElement>('[data-act="applyUpdate"]')!.click();
    expect(applied).toBe(1);
    expect(reloads).toBe(1);
    // and turning the flag off with nothing waiting hides the bar again
    ui.setVersionBehind(false);
    expect(bar.hidden).toBe(true);
    expect(bar.classList.contains('upbar--urgent')).toBe(false);
  });
});

describe('public/favicon.svg', () => {
  it('is a standalone SVG with no scripts', () => {
    expect(svg.trim().startsWith('<svg')).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).not.toMatch(/<script/i);
  });
});
