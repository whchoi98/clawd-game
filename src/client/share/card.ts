/**
 * Share card (P3-4) — a 1200×630 result picture drawn from zero assets on an
 * offscreen canvas: the zone's sky gradient, the Clawd portrait (painted by the
 * renderer through a callback, so this module knows neither the DOM nor the
 * renderer), zone name (Korean + English), time, rank letter, stars, "세계 N위 /
 * M명" when the submission was accepted, the link the card carries and the site
 * name.
 *
 * `shareCard` turns the canvas into a PNG and prefers, in order:
 *   files      navigator.share({ files: [png], text, url }) when canShare says the platform takes files
 *   link       navigator.share({ text, url }) — the picture is dropped, the link travels
 *   clipboard  navigator.clipboard.writeText(url) — the caller toasts
 *   cancelled  the share sheet was dismissed (AbortError): nothing else is tried
 *   failed     none of the above worked
 * Every platform handle is injected (`CardEnv`), so the whole flow runs in Node.
 */
import { BIOMES, C } from '../../shared/biomes.js';
import type { BiomeId } from '../../sim/types.js';

export const CARD_W = 1200;
export const CARD_H = 630;
export const SITE_NAME = 'CLAWD JUMP: ECHO TOWER';
export const SITE_TAGLINE = '메아리의 탑 · 검증된 리플레이 · 매일 바뀌는 탑';
/** File name of the shared PNG. */
export const CARD_FILE = 'clawd-echo-tower.png';
export const CARD_MIME = 'image/png';

/** Korean copy the shell toasts after a share (tests assert on these). */
export const CARD_KR = {
  files: '결과 카드를 공유했다',
  link: '링크를 공유했다',
  clipboard: '링크를 복사했다',
  failed: '공유하지 못했다',
  noResult: '공유할 결과가 없다',
} as const;

export type PortraitPainter = (ctx: CanvasRenderingContext2D, skin: string, size: number, t: number) => void;

/** Everything the card prints; the shell derives it from the finished run. */
export interface ShareCardView {
  biome: BiomeId;
  /** Korean zone name and its English name. */
  zoneName: string;
  zoneEn: string;
  /** Formatted run time ('0:34.72'). */
  timeText: string;
  /** Rank letter (S / A / B / C). */
  rank: string;
  /** 0..3. */
  stars: number;
  /** The zone was cleared (tide modes end in the tide, not the goal). */
  cleared: boolean;
  /** Tide modes: height reached, whole tiles. */
  height?: number;
  /** World rank of the accepted submission, when known. */
  world?: { rank: number; total?: number } | null;
  playerName: string;
  /** Skin id for the portrait painter. */
  skin: string;
  /** The link printed on the card and shared with it (race link, or the site). */
  url: string;
}

/** The share payload: the race / site link, a line of text and — when the platform takes them — the PNG. */
export interface CardShareData { url: string; title?: string; text?: string; files?: File[] }

/** A canvas the card can be drawn on (an HTMLCanvasElement, or a fake in tests). */
export interface CardCanvas {
  width: number;
  height: number;
  getContext(type: '2d'): CanvasRenderingContext2D | null;
  toBlob(cb: (blob: Blob | null) => void, type?: string): void;
}

/** The platform pieces a card share needs; every field optional (Node, old browsers). */
export interface CardEnv {
  share?: ((data: CardShareData) => Promise<void>) | null;
  canShare?: ((data: CardShareData) => boolean) | null;
  writeText?: ((text: string) => Promise<void>) | null;
  /** An offscreen canvas of the given size, or null where the platform has none. */
  createCanvas?: ((w: number, h: number) => CardCanvas | null) | null;
  /** Wrap PNG bytes as a File (what navigator.share wants), or null where File does not exist. */
  makeFile?: ((blob: Blob, name: string, type: string) => File) | null;
}

export type CardOutcome = 'files' | 'link' | 'clipboard' | 'cancelled' | 'failed';

/** `navigator` / `document` bound into a CardEnv, or the empty env where the platform has none. */
export function defaultCardEnv(
  nav: Navigator | undefined = typeof navigator === 'undefined' ? undefined : navigator,
  doc: Document | undefined = typeof document === 'undefined' ? undefined : document,
): CardEnv {
  const env: CardEnv = {};
  try {
    if (nav) {
      if (typeof nav.share === 'function') env.share = (d) => nav.share(d as ShareData);
      if (typeof nav.canShare === 'function') env.canShare = (d) => nav.canShare(d as ShareData);
      const clip = nav.clipboard;
      if (clip && typeof clip.writeText === 'function') env.writeText = (t) => clip.writeText(t);
    }
    if (doc && typeof doc.createElement === 'function') {
      env.createCanvas = (w, h) => {
        const c = doc.createElement('canvas');
        if (typeof c.getContext !== 'function' || typeof c.toBlob !== 'function') return null;
        c.width = w;
        c.height = h;
        return c;
      };
    }
    if (typeof File === 'function') env.makeFile = (blob, name, type) => new File([blob], name, { type });
  } catch { /* a locked-down platform */ }
  return env;
}

/** The text line that travels with the card / link: "클로드 · 첫 물결 0:34.72 · A등급 · 세계 12위 / 340명". */
export function cardText(view: ShareCardView): string {
  const parts = [view.playerName, view.cleared ? `${view.zoneName} ${view.timeText}` : `${view.zoneName} 높이 ${view.height ?? 0}`];
  parts.push(`${view.rank}등급`);
  const w = worldLine(view);
  if (w) parts.push(w);
  parts.push(SITE_NAME);
  return parts.join(' · ');
}

/** "세계 12위 / 340명" (or "세계 12위") when a rank is known, else null. */
export function worldLine(view: ShareCardView): string | null {
  const w = view.world;
  if (!w || !(w.rank > 0)) return null;
  return w.total && w.total > 0 ? `세계 ${w.rank}위 / ${w.total.toLocaleString('ko-KR')}명` : `세계 ${w.rank}위`;
}

// ---------------------------------------------------------------- drawing
const F_KR = '"Noto Sans KR","Outfit","Apple SD Gothic Neo","Malgun Gothic","Noto Sans CJK KR",system-ui,sans-serif';
const F_EN = '"Outfit","Noto Sans KR",system-ui,sans-serif';
const PAPER = '#F3F6F4';
const MUTED = 'rgba(243,246,244,0.68)';
const RANK_COLORS: Record<string, [string, string, string]> = {
  S: ['#FFF0BE', '#F4C95D', '#3A2A05'],
  A: ['#CFFBF4', '#7FE3D6', '#08262A'],
  B: ['#C9D6DC', '#7F94A0', '#0F1A22'],
  C: ['#C9D6DC', '#7F94A0', '#0F1A22'],
};

/** Draw the whole card into `ctx` (a CARD_W × CARD_H surface). */
export function drawShareCard(ctx: CanvasRenderingContext2D, view: ShareCardView, portrait?: PortraitPainter | null): void {
  const biome = BIOMES[view.biome] ?? BIOMES.tidepool;
  const W = CARD_W, H = CARD_H;
  ctx.save();
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  // Sky: the zone's four-stop gradient, top → horizon, then a soft sun glow.
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, biome.sky[0]);
  sky.addColorStop(0.45, biome.sky[1]);
  sky.addColorStop(0.8, biome.sky[2]);
  sky.addColorStop(1, biome.sky[3]);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);
  const sunX = biome.sun.x * W, sunY = biome.sun.y * H;
  const glow = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, H * 0.55);
  glow.addColorStop(0, hexAlpha(biome.sun.glow, 0.55));
  glow.addColorStop(1, hexAlpha(biome.sun.glow, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  // Echo rings — the game's motif — fading toward the right edge.
  ctx.strokeStyle = hexAlpha(biome.accent, 0.16);
  ctx.lineWidth = 2;
  for (let i = 0; i < 5; i++) {
    ctx.beginPath();
    ctx.arc(W * 0.79, H * 0.62, 90 + i * 58, 0, Math.PI * 2);
    ctx.stroke();
  }
  // Ridges: three parallax silhouettes along the bottom.
  for (let r = 0; r < 3; r++) {
    ctx.fillStyle = biome.ridge[r];
    ctx.beginPath();
    ctx.moveTo(0, H);
    const base = H - 150 + r * 42;
    for (let x = 0; x <= W; x += 40) {
      const y = base + Math.sin((x + r * 300) * 0.011) * 22 + Math.sin((x + r * 90) * 0.031) * 9;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fill();
  }
  // Scrim behind the text column.
  const scrim = ctx.createLinearGradient(0, 0, W * 0.72, 0);
  scrim.addColorStop(0, 'rgba(5,10,18,0.72)');
  scrim.addColorStop(1, 'rgba(5,10,18,0)');
  ctx.fillStyle = scrim;
  ctx.fillRect(0, 0, W, H);

  // Kicker and zone names.
  const x = 72;
  ctx.fillStyle = biome.accent;
  ctx.font = `800 20px ${F_EN}`;
  fillTracked(ctx, 'CLAWD JUMP · ECHO TOWER', x, 92, 6);
  ctx.fillStyle = PAPER;
  ctx.font = `900 72px ${F_KR}`;
  ctx.fillText(view.zoneName, x, 190);
  ctx.fillStyle = MUTED;
  ctx.font = `700 26px ${F_EN}`;
  ctx.fillText(`${view.zoneEn}  ·  ${biome.name}`, x, 232);

  // Record: the time (or the height for a tide run) in large digits.
  ctx.fillStyle = MUTED;
  ctx.font = `700 22px ${F_KR}`;
  ctx.fillText(view.cleared ? '기록' : '도달 높이', x, 306);
  ctx.fillStyle = PAPER;
  ctx.font = `800 84px ${F_EN}`;
  const main = view.cleared ? view.timeText : `${view.height ?? 0}`;
  ctx.fillText(main, x, 384);
  if (!view.cleared) {
    ctx.fillStyle = MUTED;
    ctx.font = `700 28px ${F_EN}`;
    ctx.fillText(view.timeText, x + ctx.measureText(main).width * 3 + 24, 384);
  }

  // Stars (three, lit up to view.stars) and the world rank line.
  for (let i = 0; i < 3; i++) drawStar(ctx, x + 22 + i * 56, 438, 22, i < view.stars ? C.relic : 'rgba(255,255,255,0.22)');
  const world = worldLine(view);
  ctx.font = `700 30px ${F_KR}`;
  ctx.fillStyle = world ? biome.accent : MUTED;
  ctx.fillText(world ?? SITE_TAGLINE, x + 200, 450);

  // Rank badge, top right.
  const rc = RANK_COLORS[view.rank] ?? RANK_COLORS.B;
  const bx = W - 72 - 150, by = 64;
  const badge = ctx.createLinearGradient(bx, by, bx + 150, by + 150);
  badge.addColorStop(0, rc[0]);
  badge.addColorStop(1, rc[1]);
  ctx.fillStyle = badge;
  roundRect(ctx, bx, by, 150, 150, 34);
  ctx.fill();
  ctx.fillStyle = rc[2];
  ctx.font = `900 110px ${F_EN}`;
  ctx.textAlign = 'center';
  ctx.fillText(view.rank, bx + 75, by + 114);
  ctx.textAlign = 'left';

  // Portrait: the renderer paints the skin; the card only reserves the box.
  if (portrait) {
    const size = 260;
    ctx.save();
    ctx.translate(W - 72 - size - 30, H - 96 - size);
    try { portrait(ctx, view.skin, size, 0); } catch { /* a skin the renderer refuses: the card ships without it */ }
    ctx.restore();
    ctx.fillStyle = MUTED;
    ctx.font = `700 24px ${F_KR}`;
    ctx.textAlign = 'center';
    ctx.fillText(`${view.playerName}의 메아리`, W - 72 - size / 2 - 30, H - 64);
    ctx.textAlign = 'left';
  }

  // Footer: the link and the site name.
  ctx.fillStyle = 'rgba(5,10,18,0.55)';
  ctx.fillRect(0, H - 54, W, 54);
  ctx.fillStyle = PAPER;
  ctx.font = `600 22px ${F_EN}`;
  ctx.fillText(view.url, x, H - 19);
  ctx.fillStyle = biome.accent;
  ctx.font = `800 20px ${F_EN}`;
  ctx.textAlign = 'right';
  ctx.fillText(SITE_NAME, W - 72, H - 19);
  ctx.textAlign = 'left';
  ctx.restore();
}

/** Letter-spaced text (canvas has no letterSpacing everywhere). */
function fillTracked(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, tracking: number): void {
  let cx = x;
  for (const ch of text) {
    ctx.fillText(ch, cx, y);
    cx += ctx.measureText(ch).width + tracking;
  }
}

function drawStar(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rad = i % 2 === 0 ? r : r * 0.46;
    const px = cx + Math.cos(a) * rad, py = cy + Math.sin(a) * rad;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/** '#RRGGBB' → 'rgba(r,g,b,a)' (anything else is passed through). */
export function hexAlpha(hex: string, a: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
}

// ---------------------------------------------------------------- sharing
/** Draw the card on a fresh canvas and encode it as PNG; null where there is no canvas or the encoder refuses. */
export async function renderShareCard(view: ShareCardView, env: CardEnv, portrait?: PortraitPainter | null): Promise<Blob | null> {
  if (!env.createCanvas) return null;
  try {
    const canvas = env.createCanvas(CARD_W, CARD_H);
    const ctx = canvas?.getContext('2d') ?? null;
    if (!canvas || !ctx) return null;
    drawShareCard(ctx, view, portrait);
    return await new Promise<Blob | null>((resolve) => {
      try { canvas.toBlob((b) => resolve(b), CARD_MIME); } catch { resolve(null); }
    });
  } catch {
    return null;
  }
}

/**
 * Share the card: the PNG through the Web Share API when the platform takes
 * files, else the link through it, else the clipboard. A dismissed share sheet
 * (AbortError) is 'cancelled' and nothing else is tried.
 */
export async function shareCard(view: ShareCardView, env: CardEnv, portrait?: PortraitPainter | null): Promise<CardOutcome> {
  const text = cardText(view);
  const link: CardShareData = { url: view.url, title: SITE_NAME, text };
  if (env.share && env.canShare && env.makeFile) {
    const blob = await renderShareCard(view, env, portrait);
    if (blob) {
      const data: CardShareData = { ...link, files: [env.makeFile(blob, CARD_FILE, CARD_MIME)] };
      if (safeCanShare(env.canShare, data)) {
        try {
          await env.share(data);
          return 'files';
        } catch (err) {
          if (isAbort(err)) return 'cancelled';
          // the platform refused the files after all: the link still goes
        }
      }
    }
  }
  if (env.share && (!env.canShare || safeCanShare(env.canShare, link, true))) {
    try {
      await env.share(link);
      return 'link';
    } catch (err) {
      if (isAbort(err)) return 'cancelled';
    }
  }
  if (env.writeText) {
    try {
      await env.writeText(view.url);
      return 'clipboard';
    } catch { /* denied */ }
  }
  return 'failed';
}

function isAbort(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === 'AbortError';
}

/** `canShare` that throws counts as "no" for files and "try anyway" for a bare link (`onThrow`). */
function safeCanShare(fn: (d: CardShareData) => boolean, data: CardShareData, onThrow = false): boolean {
  try { return fn(data); } catch { return onThrow; }
}
