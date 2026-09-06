/**
 * Race link helpers (P3-3, src/client/echo/race.ts): the URL format, the boot
 * query parser, the address-bar cleanup, the daily freshness rule and the
 * share flow with its clipboard fallback — all pure, driven with fake
 * environments.
 */
import { describe, expect, it } from 'vitest';
import {
  RACE_COLOR, RACE_KR, RACE_LABEL_PREFIX, RUN_ID_RE, buildRaceUrl, defaultShareEnv, isFreshDailyDate, parseRaceQuery, raceBanner,
  raceLabel, shareRaceLink, stripRaceQuery, type ShareData,
} from '../../src/client/echo/race.js';
import { C } from '../../src/shared/biomes.js';
import { GOAL_COLOR } from '../../src/client/echo/goal.js';
import { GUIDE_COLOR } from '../../src/client/echo/guide.js';

describe('race links · URL and query', () => {
  it('buildRaceUrl is <origin>/?race=<runId>&z=<levelId>, encoded, without a doubled slash', () => {
    expect(buildRaceUrl('https://clawd-game.whchoi.net', 'run-abc_123', 't1')).toBe('https://clawd-game.whchoi.net/?race=run-abc_123&z=t1');
    expect(buildRaceUrl('https://x.test/', 'r1', 'daily')).toBe('https://x.test/?race=r1&z=daily');
    expect(buildRaceUrl('', 'r1', 'v3')).toBe('/?race=r1&z=v3');
    expect(buildRaceUrl('https://x.test', 'a b', 't1')).toBe('https://x.test/?race=a%20b&z=t1');
  });

  it('parseRaceQuery reads a valid run id (with or without the zone hint) and ignores everything else', () => {
    expect(parseRaceQuery('?race=run-9&z=t2')).toEqual({ runId: 'run-9', levelId: 't2' });
    expect(parseRaceQuery('race=run-9')).toEqual({ runId: 'run-9', levelId: null });
    expect(parseRaceQuery(new URLSearchParams('shot=t1&race=abcDEF_-9'))).toEqual({ runId: 'abcDEF_-9', levelId: null });
    // a bad zone hint is dropped, not the race
    expect(parseRaceQuery('?race=run-9&z=T2!')).toEqual({ runId: 'run-9', levelId: null });
    expect(parseRaceQuery('')).toBeNull();
    expect(parseRaceQuery('?shot=t1')).toBeNull();
    expect(parseRaceQuery('?race=')).toBeNull();
    expect(parseRaceQuery('?race=<script>')).toBeNull();
    expect(parseRaceQuery(`?race=${'a'.repeat(65)}`)).toBeNull();
    expect(RUN_ID_RE.test('run-1')).toBe(true);
  });

  it('stripRaceQuery removes only the race parameters', () => {
    expect(stripRaceQuery('https://x.test/?race=run-9&z=t1')).toBe('https://x.test/');
    expect(stripRaceQuery('https://x.test/?fps=1&race=run-9&z=t1#h')).toBe('https://x.test/?fps=1#h');
    expect(stripRaceQuery('not a url')).toBe('not a url');
  });

  it('labels: 경주 · <name>, the banner in 해라체, a colour apart from the other echoes', () => {
    expect(raceLabel('바다')).toBe(`${RACE_LABEL_PREFIX} · 바다`);
    expect(raceLabel('바다')).toBe('경주 · 바다');
    expect(raceBanner('바다')).toBe('바다의 메아리와 경주한다');
    expect(new Set([RACE_COLOR, C.echoSelf, C.echoWorld, GOAL_COLOR, GUIDE_COLOR]).size).toBe(5);
    for (const line of Object.values(RACE_KR)) expect(line).toMatch(/다(\s·|$)|다 · /);
  });

  it('isFreshDailyDate: today or yesterday (UTC) only', () => {
    expect(isFreshDailyDate('2026-09-06', '2026-09-06')).toBe(true);
    expect(isFreshDailyDate('2026-09-05', '2026-09-06')).toBe(true);
    expect(isFreshDailyDate('2026-09-04', '2026-09-06')).toBe(false);
    expect(isFreshDailyDate('2026-09-07', '2026-09-06')).toBe(false);   // a date from the future is not a board the server accepts
    expect(isFreshDailyDate('nope', '2026-09-06')).toBe(false);
  });
});

describe('race links · sharing', () => {
  const URL_ = 'https://x.test/?race=run-1&z=t1';

  it('prefers navigator.share and reports it', async () => {
    const shared: ShareData[] = [];
    const copies: string[] = [];
    const out = await shareRaceLink(URL_, '경주하자', {
      share: async (d) => { shared.push(d); },
      canShare: () => true,
      writeText: async (t) => { copies.push(t); },
    });
    expect(out).toBe('shared');
    expect(shared).toEqual([{ url: URL_, title: 'CLAWD JUMP: ECHO TOWER', text: '경주하자' }]);
    expect(copies).toEqual([]);
  });

  it('falls back to the clipboard when share is missing, refused by canShare, or throws; a dismissed sheet is cancelled', async () => {
    const copies: string[] = [];
    const writeText = async (t: string): Promise<void> => { copies.push(t); };
    expect(await shareRaceLink(URL_, 't', { writeText })).toBe('copied');
    expect(await shareRaceLink(URL_, 't', { share: async () => undefined, canShare: () => false, writeText })).toBe('copied');
    expect(await shareRaceLink(URL_, 't', { share: async () => { throw new TypeError('no'); }, writeText })).toBe('copied');
    expect(copies).toEqual([URL_, URL_, URL_]);
    const abort = Object.assign(new Error('dismissed'), { name: 'AbortError' });
    expect(await shareRaceLink(URL_, 't', { share: async () => { throw abort; }, writeText })).toBe('cancelled');
    expect(copies).toHaveLength(3);
  });

  it('reports failure when nothing works, and defaultShareEnv reads only what the navigator offers', async () => {
    expect(await shareRaceLink(URL_, 't', {})).toBe('failed');
    expect(await shareRaceLink(URL_, 't', { writeText: async () => { throw new Error('denied'); } })).toBe('failed');
    expect(defaultShareEnv(undefined)).toEqual({});
    const nav = { clipboard: { writeText: async (_t: string) => undefined } } as unknown as Navigator;
    const env = defaultShareEnv(nav);
    expect(env.share).toBeUndefined();
    expect(typeof env.writeText).toBe('function');
    const full = defaultShareEnv({ share: async () => undefined, canShare: () => true, clipboard: { writeText: async () => undefined } } as unknown as Navigator);
    expect(typeof full.share).toBe('function');
    expect(typeof full.canShare).toBe('function');
  });
});
