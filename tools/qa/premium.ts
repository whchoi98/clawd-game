/**
 * Real-input premium-quality QA against an integrated, running build.
 *
 *   BASE_URL=http://127.0.0.1:8099 node --import tsx tools/qa/premium.ts
 *   npx tsx tools/qa/premium.ts                 CHROME=... for a system browser
 *
 * Fresh desktop 1440x900, landscape phone 750x340 and portrait phone 390x844
 * contexts exercise campaign/replay, suspended-run restoration, checkpoint
 * retry, mastery journal/goal persistence and native modal Tab navigation. Actions use pointer/touch
 * and keyboard APIs only. Page evaluations read diagnostics, DOM or geometry;
 * they never drive Scenes, step a Sim, inject inputs or seed storage.
 *
 * Screenshots: tools/qa/out/premium-<profile>-<step>.png, including a final
 * capture even after a failed journey. External font failures are warnings;
 * same-origin console, HTTP and request failures and page errors fail QA.
 * Each virtual device has its own synthetic edge viewer address. Requests
 * still reach the real server with its normal per-viewer rate limits.
 * QA_ENGINE=chromium|webkit|firefox selects the browser.
 * Run after the replay DOM and window.__clawd.playback getter are integrated.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit, type Browser, type JSHandle, type Locator, type Page, type Request } from 'playwright';
import { GOAL_ECHOES } from '../../src/sim/echoes.generated.js';
import { IN } from '../../src/sim/types.js';
import type { RunSummary, SimState } from '../../src/sim/types.js';

const BASE_URL = (process.env.BASE_URL ?? 'http://127.0.0.1:8099').replace(/\/+$/, '');
const ORIGIN = new URL(BASE_URL).origin;
const ENGINE = process.env.QA_ENGINE ?? 'chromium';
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'out', ENGINE === 'webkit' ? 'webkit' : ENGINE === 'firefox' ? 'firefox' : '');
const TIMEOUT_MS = 30_000;
const MOTION_TIMEOUT_MS = 10_000;
const PAUSE_OBSERVE_MS = 350;
const EPS = 1;
/** Same small-text floor used by the mobile QA. */
const MIN_LABEL_PX = 11;
const OPEN_SELECT = '#title-menu [data-act="openSelect"]';
const JOURNAL_GOAL = '#journal-body [data-journal-key="goal:t1:nodeath"]';
const CLOSE_JOURNAL = '#scr-journal header [data-act="close"]';
const FIRST_CARD = '#sel-tiers .card[data-act="start"][data-id="t1"]';
const TOGGLE = '#replay-toggle[data-act="replayToggle"]';
const RESTART = '#replay-restart[data-act="replayRestart"]';
const CLOSE_REPLAY = '#replay-close[data-act="closeReplay"]';
const SPEEDS = [0.5, 1, 2] as const;
const FOCUSABLE = 'a[href],button,input:not([type="hidden"]),select,textarea,[tabindex],[contenteditable="true"]';

interface Profile { id: string; viewport: { width: number; height: number }; touch: boolean }
const PROFILES: Profile[] = [
  { id: 'desktop', viewport: { width: 1440, height: 900 }, touch: false },
  { id: 'phone-landscape', viewport: { width: 750, height: 340 }, touch: true },
  { id: 'phone-portrait', viewport: { width: 390, height: 844 }, touch: true },
];
interface Row { profile: string; step: string; ok: boolean; ms: number; note: string }
interface Issue { profile: string; step: string; kind: 'console' | 'pageerror' | 'http' | 'request' | 'assert'; text: string }
interface ProbeSim {
  def: { id: string }; state: SimState; seed: number; assist: boolean; finished: boolean;
  summary(): RunSummary;
}
interface ProbeRun { sim: ProbeSim; def: { id: string }; t: number; masks: { length: number; bytes(): Uint8Array } }
interface ProbePlayback {
  sim: ProbeSim; cursor: number; duration: number; playing: boolean; speed: number; mask: number;
  checkpoints: readonly { tick: number; label: string }[];
}
interface ProbeShell {
  run: ProbeRun | null;
  readonly playback: ProbePlayback | null;
  save: { progress: unknown; settings: unknown };
}
interface RunIdentity { run: ProbeRun; sim: ProbeSim; masks: ProbeRun['masks'] }
interface PlaybackTarget { cursor?: number; playing?: boolean; speed?: number; finished?: boolean; after?: number; before?: number }

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function sameOrigin(url: string): boolean {
  try { return new URL(url).origin === ORIGIN; } catch { return false; }
}

function externalFont(text: string): boolean {
  return /https:\/\/fonts\.(?:googleapis|gstatic)\.com\b/i.test(text);
}

/** Browser probes must be self-contained (no module values or named inner functions). */
function readPlayback() {
  const playback = (window as unknown as { __clawd?: ProbeShell }).__clawd?.playback;
  if (!playback) throw new Error('window.__clawd.playback is missing/null; replay integration is required');
  return {
    cursor: playback.cursor, duration: playback.duration, playing: playback.playing, speed: playback.speed,
    mask: playback.mask, levelId: playback.sim.def.id, tick: playback.sim.state.tick,
    seed: playback.sim.seed, assist: playback.sim.assist, finished: playback.sim.finished,
    state: JSON.stringify(playback.sim.state), summary: playback.sim.summary(),
    checkpoints: playback.checkpoints.map((cp) => ({ tick: cp.tick, label: cp.label })),
  };
}

function playbackMatches(target: PlaybackTarget): boolean {
  const playback = (window as unknown as { __clawd?: ProbeShell }).__clawd?.playback;
  return !!playback
    && (target.cursor === undefined || playback.cursor === target.cursor)
    && (target.playing === undefined || playback.playing === target.playing)
    && (target.speed === undefined || playback.speed === target.speed)
    && (target.finished === undefined || playback.sim.finished === target.finished)
    && (target.after === undefined || playback.cursor > target.after)
    && (target.before === undefined || playback.cursor < target.before);
}

function readSave() {
  const shell = (window as unknown as { __clawd?: ProbeShell }).__clawd;
  if (!shell?.save) throw new Error('window.__clawd.save is unavailable for read-only progress diagnostics');
  return { progress: JSON.stringify(shell.save.progress), settings: JSON.stringify(shell.save.settings) };
}

function readRun(identity: RunIdentity) {
  const run = (window as unknown as { __clawd?: ProbeShell }).__clawd?.run;
  return {
    sameRun: run === identity.run, sameSim: run?.sim === identity.sim, sameLog: run?.masks === identity.masks,
    levelId: identity.run.def.id, tick: identity.sim.state.tick, phase: identity.sim.state.phase,
    time: identity.sim.state.time, runTime: identity.run.t,
    deaths: identity.sim.state.stats.deaths, state: JSON.stringify(identity.sim.state),
    length: identity.masks.length, masks: Array.from(identity.masks.bytes()),
  };
}

function readFocus({ selector, modal }: { selector: string; modal: string }) {
  const root = document.getElementById(`scr-${modal}`);
  if (!root) throw new Error(`${modal} modal missing`);
  const controls = [...root.querySelectorAll<HTMLElement>(selector)].filter((el) =>
    el.tabIndex >= 0 && !el.matches(':disabled') && !el.closest('[hidden],[inert]')
    && el.getClientRects().length > 0 && getComputedStyle(el).visibility === 'visible');
  return {
    inside: root.contains(document.activeElement), count: controls.length,
    index: controls.indexOf(document.activeElement as HTMLElement),
    active: (document.activeElement as HTMLElement | null)?.outerHTML.slice(0, 180),
  };
}

async function waitPlayback(page: Page, target: PlaybackTarget): Promise<ReturnType<typeof readPlayback>> {
  await page.waitForFunction(playbackMatches, target, { timeout: MOTION_TIMEOUT_MS });
  return page.evaluate(readPlayback);
}

async function screen(page: Page, name: string): Promise<void> {
  await page.locator(`#scr-${name}.is-active:not([inert])`).waitFor({ state: 'visible' });
}

/** Allow scrolling, but reject clipping by the viewport OR any overflow ancestor. */
async function inView(locator: Locator, label: string): Promise<void> {
  await locator.waitFor({ state: 'visible' });
  const element = await locator.elementHandle();
  check(element, `${label} is missing`);
  try {
    // Playwright's visible state includes opacity:0 during screenIn/fadeUp.
    // Observe finite entry/hover animations without finishing or disabling them.
    await locator.page().waitForFunction((el) => {
      if (!el.isConnected) return false;
      for (let node: Element | null = el; node; node = node.parentElement) {
        if (Number(getComputedStyle(node).opacity) === 0) return false;
        if (node.getAnimations().some((animation) => animation.playState === 'running'
          && Number.isFinite(animation.effect?.getComputedTiming().endTime))) return false;
      }
      return true;
    }, element, { timeout: MOTION_TIMEOUT_MS });
  } finally {
    await element.dispose();
  }
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    let left = 0, top = 0, right = innerWidth, bottom = innerHeight, opacity = 1;
    let hidden = false;
    for (let node: Element | null = el; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      opacity *= Number(style.opacity);
      hidden ||= style.visibility !== 'visible' || style.display === 'none' || node.hasAttribute('hidden') || node.hasAttribute('inert');
      if (node === el) continue;
      const clip = node.getBoundingClientRect();
      if (/^(auto|scroll|hidden|clip)$/.test(style.overflowX)) {
        left = Math.max(left, clip.left + node.clientLeft);
        right = Math.min(right, clip.left + node.clientLeft + node.clientWidth);
      }
      if (/^(auto|scroll|hidden|clip)$/.test(style.overflowY)) {
        top = Math.max(top, clip.top + node.clientTop);
        bottom = Math.min(bottom, clip.top + node.clientTop + node.clientHeight);
      }
    }
    return { x: r.left, y: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height, left, top, clipRight: right, clipBottom: bottom, hidden, opacity };
  });
  check(!box.hidden && box.opacity > 0 && box.w > 0 && box.h > 0, `${label} is hidden/transparent`);
  check(box.x >= box.left - EPS && box.y >= box.top - EPS && box.right <= box.clipRight + EPS && box.bottom <= box.clipBottom + EPS,
    `${label} is clipped after scrolling: ${JSON.stringify(box)}`);
}

async function activate(page: Page, profile: Profile, selector: string): Promise<void> {
  const control = page.locator(selector);
  await inView(control, selector);
  check(await control.isEnabled(), `${selector} is disabled`);
  if (profile.touch) await control.tap();
  else await control.click();
}

async function auditControls(page: Page, selector: string): Promise<number> {
  let count = 0;
  for (const control of await page.locator(selector).all()) {
    if (!(await control.isVisible())) continue;
    await inView(control, (await control.getAttribute('id')) ?? selector);
    count++;
  }
  check(count > 0, `no visible controls for ${selector}`);
  return count;
}

async function readable(locator: Locator, label: string): Promise<void> {
  await inView(locator, label);
  const reading = await locator.evaluate((el) => {
    let opacity = 1, blurred = false;
    for (let node: Element | null = el; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      opacity *= Number(style.opacity);
      blurred ||= /blur\((?!0(?:px)?\))/.test(style.filter);
    }
    return { text: el.textContent?.trim() ?? '', size: parseFloat(getComputedStyle(el).fontSize), opacity, blurred,
      clippedText: el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1 };
  });
  check(reading.text.length > 1 && !/^[?？\s]+$/.test(reading.text), `${label} is anonymous`);
  check(reading.size >= MIN_LABEL_PX && reading.opacity >= 0.6 && !reading.blurred && !reading.clippedText,
    `${label} is not readable: ${JSON.stringify(reading)} (minimum ${MIN_LABEL_PX}px)`);
}

async function seekWithKeyboard(page: Page, key: 'Home' | 'End'): Promise<ReturnType<typeof readPlayback>> {
  const range = page.locator('#replay-seek');
  await inView(range, '#replay-seek');
  // A real pointer focuses the native range; Home/End must pass through the app's input handling.
  await range.click();
  check(await range.evaluate((el) => document.activeElement === el), 'pointer did not focus #replay-seek');
  await page.keyboard.press(key);
  const duration = (await page.evaluate(readPlayback)).duration;
  const cursor = key === 'Home' ? 0 : duration;
  const playback = await waitPlayback(page, { cursor, playing: false });
  check(await range.inputValue() === String(cursor), `${key}: range value does not equal tick ${cursor}`);
  return playback;
}

async function unchangedSave(page: Page, before: ReturnType<typeof readSave>, activity = 'watching a replay'): Promise<void> {
  const after = await page.evaluate(readSave);
  check(after.progress === before.progress, `${activity} changed progress`);
  check(after.settings === before.settings, `${activity} changed settings`);
}

async function nodeathHud(page: Page, state: 'active' | 'missed', deaths: number): Promise<void> {
  const hud = page.locator(`#hud-objective[data-state="${state}"]`);
  await hud.waitFor({ state: 'visible', timeout: MOTION_TIMEOUT_MS });
  check((await hud.locator('b').textContent())?.trim() === '무사 통과', 'HUD lost the selected nodeath goal');
  check((await hud.textContent())?.includes(`쓰러짐 ${deaths}회`), `nodeath HUD does not report ${deaths} deaths`);
}

/** The QA uses keyboard seeking even on touch profiles; the hint must adapt its glyphs. */
function hintMeaning(text: string): string {
  return text.replace(/왼쪽 스틱|← →/gu, '{move}').replace(/JUMP|Space/gu, '{jump}');
}

async function frozenRun(page: Page, identity: JSHandle<RunIdentity>, before: ReturnType<typeof readRun>): Promise<void> {
  const after = await page.evaluate(readRun, identity);
  check(after.sameRun && after.sameSim && after.sameLog, 'overlay replaced the suspended Run, Sim or MaskLog');
  check(after.tick === before.tick && after.state === before.state, `suspended Sim changed at tick ${before.tick} → ${after.tick}`);
  check(after.time === before.time && after.runTime === before.runTime, 'overlay advanced the suspended simulation/run clock');
  check(after.length === before.length && JSON.stringify(after.masks) === JSON.stringify(before.masks), 'overlay changed the suspended mask recording');
}

async function nativeTabCycle(page: Page, modal = 'settings'): Promise<number> {
  const probe = { selector: FOCUSABLE, modal };
  let focus = await page.evaluate(readFocus, probe);
  check(focus.inside, `opening ${modal} left focus outside the modal: ${focus.active}`);
  const count = focus.count;
  check(count >= 2 && count <= 150, `unexpected ${modal} focusable count: ${count}`);
  for (const key of ['Tab', 'Shift+Tab']) {
    const seen = new Set<number>();
    let wrapped = false;
    for (let i = 0; i <= count; i++) {
      const previous = focus.index;
      await page.keyboard.press(key);
      focus = await page.evaluate(readFocus, probe);
      check(focus.inside && focus.index >= 0 && focus.count === count, `${key} escaped ${modal}: ${focus.active}`);
      seen.add(focus.index);
      if (previous >= 0) wrapped ||= key === 'Tab' ? focus.index < previous : focus.index > previous;
    }
    check(wrapped && seen.size === count, `${key} did not cycle through all ${count} ${modal} controls (visited ${seen.size})`);
  }
  return count;
}

async function profileJourney(browser: Browser, profile: Profile, rows: Row[], issues: Issue[], warnings: string[]): Promise<void> {
  const context = await browser.newContext({
    viewport: profile.viewport, deviceScaleFactor: profile.touch ? 2 : 1,
    isMobile: profile.touch && ENGINE !== 'firefox', hasTouch: profile.touch, colorScheme: 'dark', locale: 'ko-KR',
  });
  const page = await context.newPage();
  const family = ENGINE === 'webkit' ? 20 : ENGINE === 'firefox' ? 30 : 10;
  const viewer = `192.0.2.${family + PROFILES.indexOf(profile)}:43210`;
  await page.route('**/api/**', async (route) => {
    if (!sameOrigin(route.request().url())) { await route.continue(); return; }
    await route.continue({ headers: { ...route.request().headers(), 'cloudfront-viewer-address': viewer } });
  });
  page.setDefaultTimeout(TIMEOUT_MS);
  let current = 'boot';
  let closing = false;
  let original: JSHandle<RunIdentity> | undefined;
  let baseline: ReturnType<typeof readRun> | undefined;
  let onboardingHint: string | undefined;
  let pinnedSave: ReturnType<typeof readSave> | undefined;
  const submissions: string[] = [];
  const responseStatuses = new WeakMap<Request, number>();
  const issue = (kind: Issue['kind'], text: string) => issues.push({ profile: profile.id, step: current, kind, text });
  const warning = (text: string) => warnings.push(`[${profile.id}/${current}] ${text}`);
  const shot = (name: string) => page.screenshot({ path: join(OUT_DIR, `premium-${profile.id}-${name}.png`) });

  page.on('console', (msg) => {
    if (closing) return;
    const text = msg.text(), url = msg.location().url;
    if (msg.type() === 'warning') { warning(text); return; }
    if (msg.type() !== 'error') return;
    if ((url && !sameOrigin(url)) || (!url && externalFont(text))) {
      warning(`external resource console error: ${text} ${url}`);
    } else issue('console', `${text}${url ? ` (${url})` : ''}`);
  });
  page.on('pageerror', (err) => { if (!closing) issue('pageerror', err.message); });
  page.on('response', (response) => {
    if (closing) return;
    responseStatuses.set(response.request(), response.status());
    if (response.status() < 400) return;
    const text = `${response.status()} ${response.url()}`;
    if (sameOrigin(response.url())) issue('http', text);
    else warning(`external resource: ${text}`);
  });
  page.on('requestfailed', (request) => {
    if (closing) return;
    const error = request.failure()?.errorText ?? 'request failed';
    const text = `${error} ${request.url()}`;
    // Observed in Chromium: a completed telemetry fetch reports ERR_ABORTED
    // after its 204 response. Require that response on this exact request.
    if (sameOrigin(request.url()) && request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/api/events')
      && error === 'net::ERR_ABORTED' && responseStatuses.get(request) === 204) {
      warning(`telemetry accepted (HTTP 204), Chromium reported ${error}`);
      return;
    }
    if (sameOrigin(request.url())) issue('request', text);
    else warning(`external resource: ${text}`);
  });
  page.on('request', (request) => {
    if (sameOrigin(request.url()) && request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/api/runs')) {
      submissions.push(request.url());
    }
  });

  const step = async (name: string, body: () => Promise<string | void>): Promise<boolean> => {
    current = name;
    const start = Date.now();
    try {
      const note = await body();
      rows.push({ profile: profile.id, step: name, ok: true, ms: Date.now() - start, note: note ?? '' });
      process.stdout.write(`PASS ${profile.id}/${name}${note ? `: ${note}` : ''}\n`);
      return true;
    } catch (error) {
      const text = (error instanceof Error ? error.message : String(error)).split('\n')[0];
      rows.push({ profile: profile.id, step: name, ok: false, ms: Date.now() - start, note: text });
      issue('assert', text);
      process.stdout.write(`FAIL ${profile.id}/${name}: ${text}\n`);
      try { await shot(`${name}-failed`); } catch (error) { warning(`failure screenshot: ${String(error)}`); }
      return false;
    }
  };

  try {
    if (!await step('title', async () => {
      await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
      // The portrait prompt may already own focus and make the title inert.
      await page.locator('#scr-title.is-active').waitFor({ state: 'visible' });
      if (profile.touch && !(await page.locator('#nag-rotate').isVisible())) {
        // Establish real touch modality on a decorative, non-actionable title element.
        await page.locator('#scr-title .title__logo').tap();
      }
      if (await page.locator('#nag-rotate').isVisible()) {
        await activate(page, profile, '#nag-rotate [data-act="dismissNag"]');
        await page.locator('#nag-rotate').waitFor({ state: 'hidden' });
      }
      await screen(page, 'title');
      await page.waitForTimeout(1500); // title entrance/stagger, as in mobile.ts
      check(await page.evaluate(() => {
        const shell = (window as unknown as { __clawd?: ProbeShell }).__clawd;
        return !!shell && shell.run === null && shell.playback === null;
      }), 'fresh title must expose playback=null and run=null');
      await inView(page.locator(OPEN_SELECT), OPEN_SELECT);
      await shot('title');
      const build = (await page.locator('#title-version').textContent())?.trim() ?? 'unlabelled build';
      return `${profile.viewport.width}x${profile.viewport.height}; ${build}; fresh context`;
    })) return;

    if (!await step('journal-goal', async () => {
      const saved = await page.evaluate(readSave);
      const sent = submissions.length;
      await activate(page, profile, '#title-menu [data-act="openJournal"]');
      await screen(page, 'journal');
      check(await page.locator('#scr-journal').getAttribute('aria-modal') === 'true'
        && await page.locator('#scr-title').getAttribute('inert') !== null, 'journal does not isolate the title as a modal');
      const ids = await page.locator('#journal-body [data-journal-zone]').evaluateAll((zones) =>
        zones.map((zone) => zone.getAttribute('data-journal-zone')));
      check(ids.length === 16 && new Set(ids).size === 16 && ids.includes('t1'), `expected 16 unique journal zones, got ${ids}`);
      for (const id of ids) {
        const zone = page.locator(`#journal-body [data-journal-zone="${id}"]`);
        await readable(zone.locator('.journal-zone__name'), `${id} journal name`);
        const controls = await zone.locator('button').evaluateAll((buttons) => buttons.map((button) => ({
          disabled: button.matches(':disabled'), ariaDisabled: button.getAttribute('aria-disabled'), label: button.getAttribute('aria-label') ?? '',
        })));
        check(controls.length === 6, `${id} is missing goal modes/medals`);
        if (id !== 't1') {
          check(controls.every((button) => button.disabled && button.ariaDisabled === 'true' && button.label.includes('클리어')),
            `${id} locked goals are enabled or lack unlock conditions`);
          await readable(zone.locator('.journal-zone__target'), `${id} journal unlock condition`);
        }
      }
      for (const criterion of await page.locator('[data-journal-zone="t1"] .journal-zone__criteria').all()) {
        await readable(criterion, 't1 medal criterion');
      }
      await activate(page, profile, '#scr-journal header [data-act="journalSkins"]');
      const skins = page.locator('#journal-body [data-journal-skin]');
      const skinIds = await skins.evaluateAll((cards) => cards.map((card) => card.getAttribute('data-journal-skin')));
      check(skinIds.length === 8 && new Set(skinIds).size === 8, `expected eight unique skins, got ${skinIds}`);
      for (const card of await skins.all()) {
        const id = await card.getAttribute('data-journal-skin');
        const equip = card.locator('button');
        await readable(card.locator('.journal-skin__name'), `${id} skin name`);
        if (id === 'clawd') {
          check(await equip.isEnabled() && await equip.getAttribute('aria-pressed') === 'true', 'default skin is not available/equipped');
        } else {
          check(await equip.isDisabled() && await equip.getAttribute('aria-disabled') === 'true', `${id} locked skin is enabled`);
          await readable(card.locator('.journal-skin__hint'), `${id} skin unlock condition`);
          await readable(card.locator('.journal-skin__progress'), `${id} skin unlock progress`);
        }
      }
      const azure = page.locator('#journal-body [data-journal-skin="azure"]');
      check(await azure.locator('[data-journal-key="skin:azure"]').isDisabled(), 'fresh azure is unlocked');
      check(/0\s*\/\s*6\s*별/u.test(await azure.locator('.journal-skin__progress').innerText()), 'azure does not show zero of six stars');
      await inView(azure.locator('[data-journal-key="skin:azure"]'), 'locked azure');
      await shot('journal-skins');
      await activate(page, profile, '#scr-journal header [data-act="journalZones"]');
      await unchangedSave(page, saved, 'browsing the journal');
      await activate(page, profile, JOURNAL_GOAL);
      check(await page.locator(JOURNAL_GOAL).getAttribute('aria-pressed') === 'true', 'nodeath was not selected through the journal');
      pinnedSave = await page.evaluate(readSave);
      check(pinnedSave.progress === saved.progress, 'pinning nodeath awarded progress');
      check(JSON.parse(pinnedSave.settings).goalTargets?.t1 === 'nodeath', 'pinning nodeath did not update the goal preference');
      const count = await nativeTabCycle(page, 'journal');
      await inView(page.locator(JOURNAL_GOAL), JOURNAL_GOAL);
      await shot('journal-goal');
      await activate(page, profile, CLOSE_JOURNAL);
      await screen(page, 'title');
      await unchangedSave(page, pinnedSave, 'closing the journal');
      check(submissions.length === sent, 'journal browsing/pinning submitted a run');
      return `16 zones, eight skins, readable locks; nodeath pinned without progress; ${count} keyboard controls`;
    })) return;

    if (!await step('journal-reload', async () => {
      check(pinnedSave, 'missing pinned-goal save baseline');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('#scr-title.is-active').waitFor({ state: 'visible' });
      if (await page.locator('#nag-rotate').isVisible()) {
        await activate(page, profile, '#nag-rotate [data-act="dismissNag"]');
        await page.locator('#nag-rotate').waitFor({ state: 'hidden' });
      }
      await screen(page, 'title');
      await unchangedSave(page, pinnedSave, 'reloading the pinned goal');
      await activate(page, profile, '#title-menu [data-act="openJournal"]');
      await screen(page, 'journal');
      check(await page.locator(JOURNAL_GOAL).getAttribute('aria-pressed') === 'true', 'journal lost its persisted nodeath selection');
      check(await page.locator('[data-journal-key="goal:t1:auto"]').getAttribute('aria-pressed') === 'false', 'reload selected auto instead of nodeath');
      await inView(page.locator(JOURNAL_GOAL), JOURNAL_GOAL);
      await shot('journal-reload');
      await activate(page, profile, CLOSE_JOURNAL);
      await screen(page, 'title');
      await unchangedSave(page, pinnedSave, 'restoring the title after journal reload');
      check(await page.evaluate(() => {
        const shell = (window as unknown as { __clawd: ProbeShell }).__clawd;
        return shell.run === null && shell.playback === null;
      }), 'journal reload created a run/playback');
      return 'goal preference and selected state survive a real reload; normal title restored';
    })) return;

    if (!await step('campaign', async () => {
      await activate(page, profile, OPEN_SELECT);
      await screen(page, 'select');
      await page.waitForTimeout(400);
      check(await page.locator('#campaign-detail').getAttribute('data-level') === 't1', 'fresh campaign preview is not t1');
      check(await page.locator('#campaign-watch').getAttribute('data-id') === 't1', 'campaign watch does not target t1');
      check(await page.locator('#campaign-watch').isEnabled(), 'fresh t1 watch is disabled');
      check(await page.locator(FIRST_CARD).isEnabled(), 'fresh t1 card is disabled');
      await inView(page.locator('#campaign-watch'), '#campaign-watch');
      await shot('campaign');
      return 't1 preview and watch enabled';
    })) return;

    // A readability failure should not prevent the independent replay journey.
    await step('campaign-layout', async () => {
      const controls = await auditControls(page, '#scr-select button');
      const locked = await page.locator('#sel-tiers .card[disabled]').all();
      check(locked.length > 0, 'fresh campaign has no locked zones to inspect');
      for (const card of locked) {
        const id = await card.getAttribute('data-id');
        const title = card.locator('.card__title'), reason = card.locator('.card__lock span');
        await readable(title, `${id} locked title`);
        await readable(reason, `${id} unlock instruction`);
        const text = (await title.textContent())?.trim() ?? '';
        check((await card.getAttribute('aria-label'))?.includes(text), `${id} accessible label lost its zone name`);
        check((await reason.textContent())?.trim() !== '잠김', `${id} only says locked, without an unlock instruction`);
        const a = await title.boundingBox(), b = await card.locator('.card__lock').boundingBox();
        check(a && b && a.y + a.height <= b.y + EPS, `${id} lock overlay covers the zone title`);
      }
      return `${locked.length} readable locked labels >= ${MIN_LABEL_PX}px; ${controls} controls fit after scrolling`;
    });

    if (!await step('campaign-replay', async () => {
      const before = await page.evaluate(readSave);
      const sent = submissions.length;
      await activate(page, profile, '#campaign-watch');
      await screen(page, 'replay');
      const opened = await page.evaluate(readPlayback);
      check(opened.levelId === 't1' && opened.duration > 0, 'campaign opened the wrong/empty replay');
      check(opened.playing && opened.speed === 1, 'replay did not start playing at 1×');
      await waitPlayback(page, { after: opened.cursor, playing: true });
      await activate(page, profile, TOGGLE);
      const paused = await waitPlayback(page, { playing: false });
      await page.waitForTimeout(PAUSE_OBSERVE_MS);
      const stopped = await page.evaluate(readPlayback);
      check(stopped.cursor === paused.cursor && stopped.state === paused.state, 'paused replay still advances');
      check(await page.evaluate(() => (window as unknown as { __clawd: ProbeShell }).__clawd.run === null), 'campaign replay created an active run');
      const range = page.locator('#replay-seek');
      const rail = await range.boundingBox(), desk = await page.locator('.replay__transport').boundingBox();
      check(rail && desk && rail.width >= desk.width * 0.8, 'the replay seek control is too short for the transport');
      check(await range.getAttribute('type') === 'range' && await range.getAttribute('min') === '0'
        && Number(await range.getAttribute('max')) === paused.duration, 'seek range is not 0..duration ticks');
      const start = await seekWithKeyboard(page, 'Home');
      check(start.tick === 0 && start.mask === 0 && !start.finished, 'Home did not restore the initial Sim');
      check(start.checkpoints.length > 1 && start.checkpoints[0].tick === 0 && start.checkpoints[0].label === '시작', 'checkpoint navigation has no start/visited checkpoint');
      check(start.checkpoints.every((cp, i, all) => Number.isInteger(cp.tick) && cp.tick <= start.duration
        && (i === 0 || cp.tick > all[i - 1].tick)), 'checkpoint ticks are not unique and chronological');
      await activate(page, profile, '#replay-next');
      await waitPlayback(page, { cursor: start.checkpoints[1].tick, playing: false });
      await activate(page, profile, '#replay-prev');
      await waitPlayback(page, { cursor: 0, playing: false });
      for (const speed of SPEEDS) {
        await activate(page, profile, `#scr-replay [data-act="replaySpeed"][data-speed="${speed}"]`);
        await waitPlayback(page, { speed, cursor: 0, playing: false });
      }
      const end = await seekWithKeyboard(page, 'End');
      check(end.cursor === end.duration && end.tick === end.duration && end.finished && end.summary.cleared,
        'End did not reach the exact goal finish');
      check(end.summary.ticks === GOAL_ECHOES.t1.ticks && end.summary.deaths === 0
        && end.seed === GOAL_ECHOES.t1.seed && !end.assist, 'goal finish disagrees with the bundled t1 recording');
      await page.waitForTimeout(PAUSE_OBSERVE_MS);
      check((await page.evaluate(readPlayback)).state === end.state, 'finished replay keeps animating its Sim');
      await auditControls(page, '#scr-replay button, #replay-seek');
      await shot('replay-end');
      await activate(page, profile, RESTART);
      const restarted = await waitPlayback(page, { playing: true, finished: false, speed: 2, before: end.duration / 2 });
      await waitPlayback(page, { playing: true, after: restarted.cursor });
      await activate(page, profile, CLOSE_REPLAY);
      await screen(page, 'select');
      check(await page.evaluate(() => {
        const shell = (window as unknown as { __clawd: ProbeShell }).__clawd;
        return shell.run === null && shell.playback === null;
      }), 'closing campaign replay left a run/playback active');
      await unchangedSave(page, before);
      check(submissions.length === sent, 'watching a goal submitted a run');
      return `${end.duration} input ticks; native Home/End, pause, checkpoints, 0.5×/1×/2× and restart`;
    })) return;

    if (!await step('paused-run-replay', async () => {
      await activate(page, profile, FIRST_CARD);
      await screen(page, 'play');
      await page.waitForFunction(() => (window as unknown as { __clawd?: ProbeShell }).__clawd?.run?.sim.state.phase === 'play',
        undefined, { timeout: MOTION_TIMEOUT_MS });
      await nodeathHud(page, 'active', 0);
      // Wait for the real first-run onboarding timer. Do not fabricate HUD text
      // or advance the run: restoring only Sim/masks can still erase this hint.
      const hint = page.locator('#hud-hint');
      await hint.waitFor({ state: 'visible', timeout: MOTION_TIMEOUT_MS });
      onboardingHint = (await hint.textContent())?.trim();
      check(onboardingHint, 'the visible onboarding hint has no text');
      await page.keyboard.press('Escape');
      await screen(page, 'pause');
      const identity = await page.evaluateHandle(() => {
        const run = (window as unknown as { __clawd?: ProbeShell }).__clawd?.run;
        if (!run) throw new Error('t1 card did not create a run');
        return { run, sim: run.sim, masks: run.masks };
      });
      original = identity;
      const before = await page.evaluate(readRun, identity);
      baseline = before;
      check(before.levelId === 't1' && before.phase === 'play', 'paused run is not an interactive t1 run');
      const saved = await page.evaluate(readSave);
      const sent = submissions.length;
      await auditControls(page, '#scr-pause button');
      await activate(page, profile, '#pause-watch[data-act="watchReplay"]');
      await screen(page, 'replay');
      const opened = await page.evaluate(readPlayback);
      check(opened.levelId === 't1', 'pause watch opened the wrong zone');
      await waitPlayback(page, { after: opened.cursor, playing: true });
      await frozenRun(page, identity, before);
      await activate(page, profile, TOGGLE);
      await waitPlayback(page, { playing: false });
      for (const key of ['End', 'Home', 'End'] as const) {
        await seekWithKeyboard(page, key);
        await frozenRun(page, identity, before);
      }
      await shot('suspended-replay');
      await activate(page, profile, CLOSE_REPLAY);
      await screen(page, 'pause');
      await page.waitForTimeout(PAUSE_OBSERVE_MS);
      await frozenRun(page, identity, before);
      check(await page.evaluate(() => (window as unknown as { __clawd: ProbeShell }).__clawd.playback === null), 'pause replay was not closed');
      await unchangedSave(page, saved);
      check(submissions.length === sent, 'pause replay submitted a run');
      await shot('restored-pause');
      return `same Run/Sim/MaskLog; tick ${before.tick} and all ${before.length} input bytes unchanged`;
    })) return;

    const identity = original, before = baseline;
    check(identity && before, 'missing suspended-run baseline');
    await step('hint-restore', async () => {
      check(onboardingHint, 'missing pre-pause onboarding hint');
      const hint = page.locator('#hud-hint');
      const text = (await hint.textContent())?.trim() ?? '';
      const visible = await hint.isVisible();
      check(visible && hintMeaning(text) === hintMeaning(onboardingHint),
        `viewer close erased/changed onboarding hint: expected "${onboardingHint}", got "${text}", visible=${visible}`);
      await frozenRun(page, identity, before);
      await shot('restored-hint');
      return `same visible onboarding hint: ${text}`;
    });
    if (!await step('paused-journal', async () => {
      const saved = await page.evaluate(readSave);
      const sent = submissions.length;
      await nodeathHud(page, 'active', before.deaths);
      await activate(page, profile, '#scr-pause [data-act="openJournal"]');
      await screen(page, 'journal');
      await page.waitForTimeout(PAUSE_OBSERVE_MS);
      await frozenRun(page, identity, before);
      check(await page.locator('#scr-pause').getAttribute('inert') !== null, 'journal left pause controls active');
      await unchangedSave(page, saved, 'opening the paused journal');
      // Toggle the pinned medal to free play, then restore it using real inputs.
      await activate(page, profile, JOURNAL_GOAL);
      check(await page.locator('[data-journal-key="goal:t1:free"]').getAttribute('aria-pressed') === 'true',
        'selecting the pinned medal did not switch to free play');
      check(JSON.parse((await page.evaluate(readSave)).settings).goalTargets?.t1 === 'free', 'free-play preference was not applied');
      check(await page.locator('#hud-objective').isHidden(), 'free play left a medal goal on the HUD');
      check((await page.evaluate(readSave)).progress === saved.progress, 'changing a paused goal awarded progress');
      await frozenRun(page, identity, before);
      await activate(page, profile, JOURNAL_GOAL);
      check(await page.locator(JOURNAL_GOAL).getAttribute('aria-pressed') === 'true', 'paused journal did not restore nodeath');
      await unchangedSave(page, saved, 'restoring the paused goal');
      await frozenRun(page, identity, before);
      await shot('paused-journal');
      await activate(page, profile, CLOSE_JOURNAL);
      await screen(page, 'pause');
      await page.waitForTimeout(PAUSE_OBSERVE_MS);
      await frozenRun(page, identity, before);
      await nodeathHud(page, 'active', before.deaths);
      await unchangedSave(page, saved, 'closing the paused journal');
      check(submissions.length === sent, 'paused journal submitted a run');
      await shot('journal-restored-pause');
      return `same Run/Sim/MaskLog, state and clocks at tick ${before.tick}; reversible goal choice; still paused`;
    })) return;

    if (!await step('checkpoint-retry', async () => {
      await activate(page, profile, '#scr-pause [data-act="checkpointRetry"]');
      await screen(page, 'play');
      const immediate = await page.evaluate(readRun, identity);
      check(immediate.sameRun && immediate.sameSim && immediate.sameLog, 'checkpoint retry created a new run');
      await page.waitForFunction(({ identity: saved, deaths }) =>
        saved.sim.state.stats.deaths >= deaths + 1 && saved.sim.state.phase === 'play',
      { identity, deaths: before.deaths }, { timeout: MOTION_TIMEOUT_MS });
      const recovered = await page.evaluate(readRun, identity);
      // Observe another half-second of simulation: a stuck retry latch must not append more RETRY ticks.
      await page.waitForFunction(({ identity: saved, tick }) => saved.sim.state.tick >= tick + 60,
        { identity, tick: recovered.tick }, { timeout: MOTION_TIMEOUT_MS });
      const after = await page.evaluate(readRun, identity);
      check(after.sameRun && after.sameSim && after.sameLog, 'retry recovery replaced the original run');
      check(after.deaths === before.deaths + 1, `retry deaths ${before.deaths} → ${after.deaths}, expected exactly +1`);
      check(after.length > before.length && JSON.stringify(after.masks.slice(0, before.length)) === JSON.stringify(before.masks),
        'checkpoint retry reset or rewrote the recording prefix');
      const retries = after.masks.slice(before.length).filter((mask) => (mask & IN.RETRY) !== 0).length;
      check(retries === 1, `checkpoint retry recorded IN.RETRY ${retries} times, expected exactly once`);
      check(after.phase === 'play', 'retry did not recover to play');
      await nodeathHud(page, 'missed', after.deaths);
      await shot('retry');
      return `same run; deaths +1; nodeath missed; exactly one RETRY input across ${after.length - before.length} new ticks`;
    })) return;

    // All baseline identity/prefix assertions are complete before replacing the run.
    if (!await step('goal-restart', async () => {
      await page.keyboard.press('Escape');
      await screen(page, 'pause');
      const saved = await page.evaluate(readSave);
      const sent = submissions.length;
      await activate(page, profile, '#scr-pause [data-act="restart"]');
      await screen(page, 'play');
      await page.waitForFunction(() => (window as unknown as { __clawd?: ProbeShell }).__clawd?.run?.sim.state.phase === 'play',
        undefined, { timeout: MOTION_TIMEOUT_MS });
      check(await page.evaluate((previous) => {
        const run = (window as unknown as { __clawd?: ProbeShell }).__clawd?.run;
        return !!run && run.def.id === 't1' && run !== previous.run && run.sim !== previous.sim && run.masks !== previous.masks
          && run.sim.state.stats.deaths === 0 && run.sim.state.time < previous.sim.state.time
          && run.masks.length < previous.masks.length && !run.sim.finished;
      }, identity), 'whole-run restart did not reset the t1 Run/Sim/MaskLog, deaths and time');
      await nodeathHud(page, 'active', 0);
      await unchangedSave(page, saved, 'restarting the selected goal');
      check(submissions.length === sent, 'whole-run restart submitted a run');
      await shot('goal-restart');
      return 'fresh t1 run with zero deaths and reset time/log; persisted nodeath is active again';
    })) return;

    if (!await step('settings-focus', async () => {
      await page.keyboard.press('Escape');
      await screen(page, 'pause');
      await activate(page, profile, '#scr-pause [data-act="quit"]');
      await screen(page, 'select');
      await activate(page, profile, '#scr-select [data-act="back"]');
      await screen(page, 'title');
      await activate(page, profile, '#title-menu [data-act="openSettings"]');
      await screen(page, 'settings');
      await page.waitForTimeout(400);
      await auditControls(page, '#scr-settings button, #scr-settings input, #scr-settings select, #scr-settings a[href]');
      const count = await nativeTabCycle(page);
      await shot('settings');
      await activate(page, profile, '#scr-settings [data-act="close"]');
      await screen(page, 'title');
      await page.keyboard.press('Tab');
      check(await page.evaluate(() => document.getElementById('scr-title')?.contains(document.activeElement)),
        'closing settings did not return native focus to the title menu');
      await activate(page, profile, OPEN_SELECT);
      await screen(page, 'select');
      check(await page.evaluate(() => {
        const shell = (window as unknown as { __clawd: ProbeShell }).__clawd;
        return shell.run === null && shell.playback === null;
      }), 'returning to the menu left a run/playback active');
      check(submissions.length === 0, 'a non-completing QA journey submitted a run');
      return `${count} controls reached with Tab and Shift+Tab; normal menu restored`;
    })) return;
  } finally {
    await step('final', async () => {
      await shot('final');
      return `premium-${profile.id}-final.png`;
    });
    await original?.dispose();
    closing = true; // Context teardown aborts are not failures of the application.
    await context.close();
  }
}

function table(rows: Row[]): string {
  const head = ['profile', 'step', 'result', 'ms', 'note'];
  const cells = rows.map((row) => [row.profile, row.step, row.ok ? 'PASS' : 'FAIL', String(row.ms), row.note]);
  const widths = head.map((value, i) => Math.max(value.length, ...cells.map((row) => row[i].length)));
  const line = (row: string[]) => row.map((value, i) => i === 3 ? value.padStart(widths[i]) : value.padEnd(widths[i])).join('  ').trimEnd();
  return [line(head), widths.map((width) => '-'.repeat(width)).join('  '), ...cells.map(line)].join('\n');
}

async function main(): Promise<number> {
  mkdirSync(OUT_DIR, { recursive: true });
  const launcher = ENGINE === 'chromium' ? chromium : ENGINE === 'webkit' ? webkit : ENGINE === 'firefox' ? firefox : null;
  if (!launcher) throw new Error(`unknown QA_ENGINE: ${ENGINE}`);
  const args = ENGINE === 'chromium' ? ['--disable-dev-shm-usage'] : [];
  if (ENGINE === 'chromium' && typeof process.getuid === 'function' && process.getuid() === 0) args.push('--no-sandbox');
  const browser = await launcher.launch({ headless: true, args, executablePath: ENGINE === 'chromium' ? process.env.CHROME || undefined : undefined });
  const rows: Row[] = [], issues: Issue[] = [];
  const warnings: string[] = [];
  try {
    for (const profile of PROFILES) {
      try {
        await profileJourney(browser, profile, rows, issues, warnings);
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        issues.push({ profile: profile.id, step: 'profile', kind: 'assert', text });
        rows.push({ profile: profile.id, step: 'profile', ok: false, ms: 0, note: text.split('\n')[0] });
      }
    }
  } finally {
    await browser.close();
  }
  const failed = rows.filter((row) => !row.ok).length;
  const output = [`premium ${BASE_URL} (${ENGINE})`, '', table(rows), ''];
  if (issues.length) {
    output.push(`issues (${issues.length}):`, ...issues.map((item) => `  [${item.profile}/${item.step}] ${item.kind}: ${item.text}`), '');
  }
  if (warnings.length) output.push(`warnings (${warnings.length}, not fatal):`, ...warnings.map((text) => `  ${text}`), '');
  output.push(`${rows.length - failed}/${rows.length} attempted steps passed, ${issues.length} issue(s); screenshots in ${OUT_DIR}`);
  process.stdout.write(`${output.join('\n')}\n`);
  return failed || issues.length ? 1 : 0;
}

main().then(
  (code) => { process.exitCode = code; },
  (error: unknown) => {
    process.stderr.write(`premium QA crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
