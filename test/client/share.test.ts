/**
 * Share card (P3-4, src/client/share/card.ts) and the `?go=` deep links
 * (src/client/share/go.ts): the card is drawn 1200×630 through a recording
 * canvas context (the texts it prints, the portrait callback), and the share
 * flow picks files / link / clipboard / cancelled / failed against fake
 * navigators — all in Node, no DOM.
 */
import { describe, expect, it } from 'vitest';
import {
  CARD_FILE, CARD_H, CARD_KR, CARD_MIME, CARD_W, SITE_NAME, cardText, defaultCardEnv, drawShareCard, hexAlpha, renderShareCard,
  shareCard, worldLine, type CardCanvas, type CardEnv, type CardShareData, type ShareCardView,
} from '../../src/client/share/card.js';
import { GO_PARAM, parseGoQuery, stripGoQuery } from '../../src/client/share/go.js';
import { BIOMES } from '../../src/shared/biomes.js';

// ------------------------------------------------------------------ fakes
interface Call { name: string; args: unknown[] }
interface RecordingCtx { ctx: CanvasRenderingContext2D; calls: Call[]; texts: string[]; styles: unknown[] }

/** A CanvasRenderingContext2D stand-in: every method records its call; gradients accept stops; measureText is 10 px a glyph. */
function recordingCtx(): RecordingCtx {
  const calls: Call[] = [];
  const texts: string[] = [];
  const styles: unknown[] = [];
  const props: Record<string, unknown> = {};
  const gradient = () => ({ addColorStop(offset: number, color: string) { calls.push({ name: 'addColorStop', args: [offset, color] }); } });
  const ctx = new Proxy({} as CanvasRenderingContext2D, {
    get(_t, key: string) {
      if (key in props) return props[key];
      if (key === 'createLinearGradient' || key === 'createRadialGradient') return (...args: unknown[]) => { calls.push({ name: key, args }); return gradient(); };
      if (key === 'measureText') return (s: string) => ({ width: [...s].length * 10 });
      if (key === 'fillText') return (text: string, x: number, y: number) => { texts.push(text); calls.push({ name: key, args: [text, x, y] }); };
      return (...args: unknown[]) => { calls.push({ name: key, args }); };
    },
    set(_t, key: string, value: unknown) {
      props[key] = value;
      if (key === 'fillStyle') styles.push(value);
      return true;
    },
  });
  return { ctx, calls, texts, styles };
}

/** A canvas whose toBlob hands back PNG-typed bytes (or null when `broken`). */
function fakeCanvas(rec: RecordingCtx, broken = false): CardCanvas & { blobs: number } {
  const c = {
    width: 0, height: 0, blobs: 0,
    getContext: () => rec.ctx,
    toBlob(cb: (b: Blob | null) => void, type?: string) {
      c.blobs++;
      cb(broken ? null : new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: type ?? 'image/png' }));
    },
  };
  return c;
}

function view(over: Partial<ShareCardView> = {}): ShareCardView {
  return {
    biome: 'stormspire', zoneName: '비의 계단', zoneEn: 'RAIN STAIRS', timeText: '0:34.72', rank: 'A', stars: 2, cleared: true,
    world: { rank: 12, total: 340 }, playerName: '클로드', skin: 'clawd', url: 'https://clawd-game.whchoi.net/?race=run-1&z=s1', ...over,
  };
}

/** A CardEnv with a working canvas plus whatever share pieces the test wires; every call is recorded. */
function env(parts: { share?: boolean | 'abort' | 'throw'; canShare?: boolean | 'throw'; clipboard?: boolean | 'deny'; canvas?: 'ok' | 'none' | 'broken'; file?: boolean } = {}) {
  const shared: CardShareData[] = [];
  const copied: string[] = [];
  const canShareCalls: CardShareData[] = [];
  const rec = recordingCtx();
  const e: CardEnv = {};
  if (parts.share) {
    e.share = async (d) => {
      shared.push(d);
      if (parts.share === 'abort') { const err = new Error('dismissed'); err.name = 'AbortError'; throw err; }
      if (parts.share === 'throw') throw new TypeError('not allowed');
    };
  }
  if (parts.canShare !== undefined) {
    // like a real browser: files are the only payload a platform refuses; a bare link is always shareable
    e.canShare = (d) => { canShareCalls.push(d); if (parts.canShare === 'throw') throw new TypeError('bad'); return d.files ? parts.canShare === true : true; };
  }
  if (parts.clipboard) e.writeText = async (t) => { if (parts.clipboard === 'deny') throw new Error('denied'); copied.push(t); };
  const canvasMode = parts.canvas ?? 'ok';
  const canvas = fakeCanvas(rec, canvasMode === 'broken');
  if (canvasMode !== 'none') e.createCanvas = (w, h) => { canvas.width = w; canvas.height = h; return canvas; };
  if (parts.file !== false) e.makeFile = (blob, name, type) => new File([blob], name, { type });
  return { e, shared, copied, canShareCalls, rec, canvas };
}

// ------------------------------------------------------------------ drawing
describe('drawShareCard', () => {
  it('fills a 1200×630 surface with the zone sky and prints the zone names, the time, the rank, the world rank and the link', () => {
    const rec = recordingCtx();
    const v = view();
    let painted: { skin: string; size: number } | null = null;
    drawShareCard(rec.ctx, v, (_ctx, skin, size) => { painted = { skin, size }; });
    expect(CARD_W).toBe(1200);
    expect(CARD_H).toBe(630);
    // the whole card is covered first
    const firstRect = rec.calls.find((c) => c.name === 'fillRect');
    expect(firstRect?.args).toEqual([0, 0, 1200, 630]);
    // the sky gradient carries the biome's four stops (top → horizon)
    const stops = rec.calls.filter((c) => c.name === 'addColorStop').map((c) => c.args[1]);
    for (const hex of BIOMES.stormspire.sky) expect(stops).toContain(hex);
    // every promised line is drawn as text
    expect(rec.texts).toContain('비의 계단');
    expect(rec.texts.join('\n')).toContain('RAIN STAIRS');
    expect(rec.texts).toContain('0:34.72');
    expect(rec.texts).toContain('A');
    expect(rec.texts).toContain('세계 12위 / 340명');
    expect(rec.texts).toContain(v.url);
    expect(rec.texts).toContain(SITE_NAME);
    expect(rec.texts).toContain('클로드의 메아리');
    // the portrait came from the painter, inside the card, at a readable size
    expect(painted).toEqual({ skin: 'clawd', size: 260 });
    // no image assets anywhere: drawImage is never called
    expect(rec.calls.some((c) => c.name === 'drawImage')).toBe(false);
  });

  it('without a world rank prints the tagline instead; tide runs print the height as the main figure; a missing painter is fine', () => {
    const rec = recordingCtx();
    drawShareCard(rec.ctx, view({ world: null, cleared: false, height: 63, timeText: '0:40.00', zoneName: '끝없는 등반', zoneEn: 'ENDLESS ASCENT', biome: 'voidreef' }));
    expect(rec.texts.some((t) => t.includes('세계'))).toBe(false);
    expect(rec.texts).toContain('63');
    expect(rec.texts).toContain('0:40.00');
    expect(rec.texts).toContain('도달 높이');
    expect(rec.texts.some((t) => t.includes('메아리'))).toBe(true);   // the tagline (no portrait line without a painter)
    expect(rec.texts).not.toContain('클로드의 메아리');
    // a painter that throws does not take the card down
    const rec2 = recordingCtx();
    expect(() => drawShareCard(rec2.ctx, view(), () => { throw new Error('no such skin'); })).not.toThrow();
    expect(rec2.texts).toContain(view().url);
    // unknown biome → tidepool sky, unknown rank → the neutral badge
    const rec3 = recordingCtx();
    drawShareCard(rec3.ctx, view({ biome: 'nope' as ShareCardView['biome'], rank: 'Z' }));
    const stops = rec3.calls.filter((c) => c.name === 'addColorStop').map((c) => c.args[1]);
    for (const hex of BIOMES.tidepool.sky) expect(stops).toContain(hex);
    expect(rec3.texts).toContain('Z');
  });

  it('cardText / worldLine give the share line in Korean; hexAlpha turns #RRGGBB into rgba', () => {
    expect(cardText(view())).toBe('클로드 · 비의 계단 0:34.72 · A등급 · 세계 12위 / 340명 · CLAWD JUMP: ECHO TOWER');
    expect(cardText(view({ world: null }))).toBe('클로드 · 비의 계단 0:34.72 · A등급 · CLAWD JUMP: ECHO TOWER');
    expect(cardText(view({ cleared: false, height: 63, world: { rank: 3 } }))).toBe('클로드 · 비의 계단 높이 63 · A등급 · 세계 3위 · CLAWD JUMP: ECHO TOWER');
    expect(worldLine(view({ world: { rank: 0, total: 5 } }))).toBeNull();
    expect(worldLine(view({ world: { rank: 1, total: 1200 } }))).toBe('세계 1위 / 1,200명');
    expect(hexAlpha('#7FE3D6', 0.5)).toBe('rgba(127,227,214,0.5)');
    expect(hexAlpha('rgba(1,2,3,1)', 0.5)).toBe('rgba(1,2,3,1)');
    for (const line of Object.values(CARD_KR)) expect(line).toMatch(/다$/);
  });
});

// ------------------------------------------------------------------ sharing
describe('shareCard', () => {
  it('files: the PNG goes through navigator.share when canShare accepts files; text and url ride along', async () => {
    const { e, shared, canShareCalls, canvas } = env({ share: true, canShare: true, clipboard: true });
    const v = view();
    expect(await shareCard(v, e)).toBe('files');
    expect(canvas.width).toBe(1200);
    expect(canvas.height).toBe(630);
    expect(canvas.blobs).toBe(1);
    expect(shared).toHaveLength(1);
    const d = shared[0];
    expect(d.files).toHaveLength(1);
    expect(d.files![0].type).toBe(CARD_MIME);
    expect(d.files![0].name).toBe(CARD_FILE);
    expect(d.url).toBe(v.url);
    expect(d.text).toBe(cardText(v));
    expect(d.title).toBe(SITE_NAME);
    // canShare was asked about the files payload itself
    expect(canShareCalls[0].files).toHaveLength(1);
  });

  it('link: a platform that shares but takes no files (canShare false, or absent) gets the link and text only', async () => {
    const a = env({ share: true, canShare: false, clipboard: true });
    expect(await shareCard(view(), a.e)).toBe('link');
    expect(a.shared).toHaveLength(1);
    expect(a.shared[0].files).toBeUndefined();
    expect(a.shared[0].url).toBe(view().url);
    expect(a.copied).toEqual([]);
    // no canShare at all: never try files
    const b = env({ share: true, clipboard: true });
    expect(await shareCard(view(), b.e)).toBe('link');
    expect(b.canvas.blobs).toBe(0);
    expect(b.shared[0].files).toBeUndefined();
    // a canvas that cannot encode: the link still travels
    const c = env({ share: true, canShare: true, canvas: 'broken' });
    expect(await shareCard(view(), c.e)).toBe('link');
    // no canvas at all (Node): same
    const d = env({ share: true, canShare: true, canvas: 'none' });
    expect(await shareCard(view(), d.e)).toBe('link');
    // a canShare that throws counts as "no"
    const f = env({ share: true, canShare: 'throw' });
    expect(await shareCard(view(), f.e)).toBe('link');
  });

  it('clipboard: without navigator.share the url is copied; failed when nothing works', async () => {
    const a = env({ clipboard: true });
    expect(await shareCard(view(), a.e)).toBe('clipboard');
    expect(a.copied).toEqual([view().url]);
    const b = env({ clipboard: 'deny' });
    expect(await shareCard(view(), b.e)).toBe('failed');
    const c = env({});
    expect(await shareCard(view(), c.e)).toBe('failed');
    expect(await shareCard(view(), {})).toBe('failed');
    // a share that throws a non-abort error falls back to the clipboard
    const d = env({ share: 'throw', canShare: true, clipboard: true });
    expect(await shareCard(view(), d.e)).toBe('clipboard');
    expect(d.shared).toHaveLength(2);   // files, then the link, both refused
    expect(d.copied).toEqual([view().url]);
  });

  it('cancelled: a dismissed share sheet (AbortError) stops the flow — nothing is copied', async () => {
    const a = env({ share: 'abort', canShare: true, clipboard: true });
    expect(await shareCard(view(), a.e)).toBe('cancelled');
    expect(a.shared).toHaveLength(1);
    expect(a.copied).toEqual([]);
    const b = env({ share: 'abort', canShare: false, clipboard: true });
    expect(await shareCard(view(), b.e)).toBe('cancelled');
    expect(b.copied).toEqual([]);
  });

  it('renderShareCard draws through the injected canvas and resolves null without one', async () => {
    const a = env({});
    const blob = await renderShareCard(view(), a.e);
    expect(blob?.type).toBe('image/png');
    expect(a.rec.texts).toContain('비의 계단');
    expect(await renderShareCard(view(), {})).toBeNull();
    const broken = env({ canvas: 'broken' });
    expect(await renderShareCard(view(), broken.e)).toBeNull();
  });

  it('defaultCardEnv binds navigator.share / canShare / clipboard and document.createElement, or stays empty', async () => {
    const calls: string[] = [];
    const nav = {
      share: async (d: ShareData) => { calls.push(`share:${d.url ?? ''}`); },
      canShare: (d: ShareData) => { calls.push('canShare'); return !!d.files; },
      clipboard: { writeText: async (t: string) => { calls.push(`copy:${t}`); } },
    } as unknown as Navigator;
    const created: string[] = [];
    const fakeCtx = recordingCtx().ctx;
    const doc = {
      createElement(tag: string) {
        created.push(tag);
        return { width: 0, height: 0, getContext: () => fakeCtx, toBlob(cb: (b: Blob | null) => void) { cb(new Blob(['x'])); } };
      },
    } as unknown as Document;
    const e = defaultCardEnv(nav, doc);
    expect(e.canShare!({ url: 'u', files: [new File(['x'], 'f.png', { type: 'image/png' })] })).toBe(true);
    expect(e.canShare!({ url: 'u' })).toBe(false);
    await e.share!({ url: 'https://x.test/' });
    await e.writeText!('copied');
    expect(calls).toEqual(['canShare', 'canShare', 'share:https://x.test/', 'copy:copied']);
    const c = e.createCanvas!(1200, 630)!;
    expect(created).toEqual(['canvas']);
    expect([c.width, c.height]).toEqual([1200, 630]);
    const file = e.makeFile!(new Blob(['x']), 'a.png', 'image/png');
    expect(file.name).toBe('a.png');
    expect(file.type).toBe('image/png');
    // nothing at all
    const empty = defaultCardEnv(undefined, undefined);
    expect(empty.share).toBeUndefined();
    expect(empty.createCanvas).toBeUndefined();
    // a canvas without toBlob (an old WebView) yields null → the link path
    const noBlob = defaultCardEnv(undefined, { createElement: () => ({ getContext: () => fakeCtx }) } as unknown as Document);
    expect(noBlob.createCanvas!(10, 10)).toBeNull();
  });
});

// ------------------------------------------------------------------ deep links
describe('?go= deep links (go.ts)', () => {
  it('parseGoQuery reads daily / endless and nothing else', () => {
    expect(GO_PARAM).toBe('go');
    expect(parseGoQuery('?go=daily')).toBe('daily');
    expect(parseGoQuery('go=endless')).toBe('endless');
    expect(parseGoQuery(new URLSearchParams('race=run-1&go=daily'))).toBe('daily');
    expect(parseGoQuery('?go=t1')).toBeNull();
    expect(parseGoQuery('?go=')).toBeNull();
    expect(parseGoQuery('?shot=t1')).toBeNull();
    expect(parseGoQuery('')).toBeNull();
  });

  it('stripGoQuery removes only the go parameter', () => {
    expect(stripGoQuery('https://x.test/?go=daily')).toBe('https://x.test/');
    expect(stripGoQuery('https://x.test/?fps=1&go=endless#h')).toBe('https://x.test/?fps=1#h');
    expect(stripGoQuery('https://x.test/?race=run-1&z=t1&go=daily')).toBe('https://x.test/?race=run-1&z=t1');
    expect(stripGoQuery('not a url')).toBe('not a url');
  });
});
