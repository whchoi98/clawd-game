/**
 * 다른 기기로 옮기기 — the progress-transfer widgets of settings → 데이터 (P3-5).
 *
 * Two rows and a result block: '코드 만들기' asks the shell for a one-time
 * 8-character code (transferExport), the code comes back big next to a
 * procedurally drawn 21×21 module picture (a *code display*, deliberately
 * labelled as not a scannable QR) with a 복사 button; '코드로 가져오기' takes a
 * code typed on the other device (transferImport). The panel keeps the last
 * code and status so a settings rebuild does not lose them. No network, no
 * game state: the shell answers through `setCode` / `setStatus`.
 */
import { TransferCode } from '../../shared/protocol.js';
import type { UiSound } from '../contracts.js';
import { el } from './screens.js';

/** The wire alphabet: no I · O · 0 · 1, so a hand-copied code never has to guess. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 8;
/** Modules per side of the code picture (quiet zone excluded). */
export const CODE_MODULES = 21;
/** Canvas size of the code picture in CSS px (drawn at 1 px per device pixel). */
export const CODE_CANVAS_PX = 168;

export type TransferStatusKind = 'ok' | 'error' | 'busy';

/** Korean copy shared with the shell (tests assert on these). */
export const TRANSFER_KR = {
  export: '다른 기기로 옮기기',
  exportSub: '8자 코드를 만들어 다른 기기에서 입력한다 · 코드는 한 번만 쓸 수 있고 7일 뒤 사라진다 · 메아리는 옮기지 않는다',
  makeCode: '코드 만들기',
  copy: '복사',
  display: '코드 표시 · 스캔용 QR이 아니다',
  import: '코드로 가져오기',
  importSub: '다른 기기에서 만든 코드를 넣는다 · 더 좋은 기록을 남기고 플레이어 id는 그 기기의 것이 된다',
  take: '가져오기',
  badCode: '코드가 틀렸다',
  badCodeHint: '코드가 틀렸다 · 8자 (I · O · 0 · 1 은 없다)',
  gone: '이미 사용된 코드다',
  offline: '서버에 닿지 않는다',
  tooBig: '진행도가 너무 커서 옮길 수 없다',
  busyRate: '요청이 너무 잦다. 잠시 후 다시',
  unsupported: '이 서버는 옮기기를 지원하지 않는다',
  inRun: '플레이 중에는 가져올 수 없다',
  creating: '코드를 만들고 있다…',
  created: '코드를 만들었다 · 7일 안에 다른 기기에서 입력한다',
  createFailed: '코드를 만들지 못했다',
  importing: '가져오고 있다…',
  imported: '진행도를 가져왔다',
  importFailed: '가져오지 못했다',
  copied: '코드를 복사했다',
  copyFailed: '복사하지 못했다 · 코드를 직접 적는다',
} as const;

/** Uppercase, drop separators and whitespace; null unless the result is a valid wire code. */
export function normalizeCode(raw: string): string | null {
  const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return TransferCode.safeParse(code).success ? code : null;
}

/** 'ABCD EFGH' — the code as it is shown and read aloud. */
export function fmtCode(code: string): string {
  return code.length === CODE_LENGTH ? `${code.slice(0, 4)} ${code.slice(4)}` : code;
}

/**
 * The code picture: CODE_MODULES² cells, 1 = dark. Three finder-like squares
 * anchor the corners so it reads as a code at a glance; the body is a
 * deterministic pseudo-random field seeded by the code (FNV-1a → xorshift32),
 * so the same code always draws the same picture and two codes never share
 * one. It is not a QR symbol and cannot be scanned — the label says so.
 */
export function codeModules(code: string): Uint8Array {
  const n = CODE_MODULES;
  const m = new Uint8Array(n * n);
  let h = 0x811c9dc5;
  for (let i = 0; i < code.length; i++) { h ^= code.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  let x = h || 0x9e3779b9;
  const next = (): number => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; };
  for (let i = 0; i < m.length; i++) m[i] = next() & 1;
  const finder = (ox: number, oy: number): void => {
    for (let dy = -1; dy <= 7; dy++) for (let dx = -1; dx <= 7; dx++) {
      const cx = ox + dx, cy = oy + dy;
      if (cx < 0 || cy < 0 || cx >= n || cy >= n) continue;
      const ring = dx < 0 || dy < 0 || dx > 6 || dy > 6 ? 0
        : dx === 0 || dy === 0 || dx === 6 || dy === 6 ? 1
          : dx === 1 || dy === 1 || dx === 5 || dy === 5 ? 0 : 1;
      m[cy * n + cx] = ring;
    }
  };
  finder(0, 0); finder(n - 7, 0); finder(0, n - 7);
  return m;
}

/** Paint the code picture into `cv` (square, `px` a side); false when the canvas has no 2D context (tests). */
export function drawCodeCanvas(cv: HTMLCanvasElement, code: string, px = CODE_CANVAS_PX): boolean {
  let ctx: CanvasRenderingContext2D | null = null;
  try { ctx = cv.getContext('2d'); } catch { ctx = null; }
  if (!ctx) return false;
  cv.width = px; cv.height = px;
  const n = CODE_MODULES, cell = px / (n + 2);
  ctx.fillStyle = '#F3F6F4';
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = '#0A1420';
  const m = codeModules(code);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (m[y * n + x]) ctx.fillRect(Math.round((x + 1) * cell), Math.round((y + 1) * cell), Math.ceil(cell), Math.ceil(cell));
  }
  return true;
}

export interface TransferPanelDeps {
  doc: Document;
  sound: (n: UiSound) => void;
  /** Pressing Enter in the code field: the UI runs its import path. */
  onSubmit: () => void;
}

export class TransferPanel {
  /** The last code the shell created, kept across pane rebuilds. */
  code: string | null = null;
  expiresAt: string | null = null;
  private status: { text: string; kind: TransferStatusKind } | null = null;
  private out: HTMLElement | null = null;
  private codeEl: HTMLElement | null = null;
  private noteEl: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private statusEl: HTMLElement | null = null;
  private input: HTMLInputElement | null = null;

  constructor(private readonly d: TransferPanelDeps) {}

  /** Fresh DOM for the data pane (SettingsPanel.build calls this on every rebuild). */
  rows(): HTMLElement[] {
    const doc = this.d.doc;
    const exportRow = this.row(TRANSFER_KR.export, TRANSFER_KR.exportSub);
    exportRow.ctl.appendChild(el(doc, 'button', { class: 'bindbtn', type: 'button', 'data-act': 'transferExport' }, TRANSFER_KR.makeCode));

    this.canvas = el(doc, 'canvas', { class: 'transfer__qr', width: CODE_CANVAS_PX, height: CODE_CANVAS_PX, 'aria-hidden': 'true' });
    this.codeEl = el(doc, 'b', { class: 'transfer__code', id: 'transfer-code', 'aria-live': 'polite' });
    this.noteEl = el(doc, 'small', { class: 'transfer__note', id: 'transfer-note' }, TRANSFER_KR.display);
    const copy = el(doc, 'button', { class: 'bindbtn', type: 'button', 'data-act': 'transferCopy' }, TRANSFER_KR.copy);
    this.out = el(doc, 'div', { class: 'transfer', id: 'transfer-out', hidden: true },
      this.canvas, el(doc, 'div', { class: 'transfer__side' }, this.codeEl, this.noteEl, copy));

    const importRow = this.row(TRANSFER_KR.import, TRANSFER_KR.importSub);
    this.input = el(doc, 'input', {
      class: 'transfer__input', id: 'transfer-input', type: 'text', inputmode: 'latin', autocomplete: 'off', autocapitalize: 'characters',
      spellcheck: 'false', maxlength: '10', placeholder: 'ABCD EFGH', 'aria-label': TRANSFER_KR.import,
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.code === 'Enter' || e.key === 'Enter') { e.preventDefault(); this.d.onSubmit(); }
      else if (e.code === 'Escape' || e.key === 'Escape') { try { this.input?.blur(); } catch { /* best-effort */ } }
    });
    importRow.ctl.classList.add('transfer__import');
    importRow.ctl.append(this.input, el(doc, 'button', { class: 'bindbtn', type: 'button', 'data-act': 'transferImport' }, TRANSFER_KR.take));

    this.statusEl = el(doc, 'p', { class: 'row__note transfer__status', id: 'transfer-status', role: 'status', hidden: true });

    this.paintCode();
    this.paintStatus();
    return [exportRow.row, this.out, importRow.row, this.statusEl];
  }

  /** What the player typed in the code field ('' without a field). */
  inputValue(): string { return this.input?.value ?? ''; }

  clearInput(): void { if (this.input) this.input.value = ''; }

  setCode(code: string, expiresAt: string): void {
    this.code = code;
    this.expiresAt = expiresAt;
    this.paintCode();
  }

  setStatus(text: string | null, kind: TransferStatusKind = 'ok'): void {
    this.status = text ? { text, kind } : null;
    this.paintStatus();
  }

  /** Select the code text (the clipboard fallback); false when there is nothing to select. */
  selectCode(): boolean {
    const codeEl = this.codeEl, doc = this.d.doc;
    if (!codeEl || !this.code) return false;
    try {
      const sel = doc.getSelection?.();
      if (!sel) return false;
      const range = doc.createRange();
      range.selectNodeContents(codeEl);
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    } catch {
      return false;
    }
  }

  private row(label: string, sub: string): { row: HTMLElement; ctl: HTMLElement } {
    const doc = this.d.doc;
    const lab = el(doc, 'div', { class: 'row__label' }, label, el(doc, 'small', {}, sub));
    const ctl = el(doc, 'div', { class: 'row__ctl' });
    return { row: el(doc, 'div', { class: 'row', 'data-row': '' }, lab, ctl), ctl };
  }

  private paintCode(): void {
    if (!this.out) return;
    const code = this.code;
    this.out.hidden = !code;
    if (!code) return;
    if (this.codeEl) { this.codeEl.textContent = fmtCode(code); this.codeEl.dataset.code = code; }
    if (this.noteEl) {
      const exp = this.expiresAt ? Date.parse(this.expiresAt) : NaN;
      this.noteEl.textContent = Number.isFinite(exp) ? `${TRANSFER_KR.display} · ${fmtExpiry(exp)}` : TRANSFER_KR.display;
    }
    if (this.canvas) drawCodeCanvas(this.canvas, code);
  }

  private paintStatus(): void {
    const s = this.statusEl;
    if (!s) return;
    const st = this.status;
    s.hidden = !st;
    s.textContent = st?.text ?? '';
    s.classList.toggle('is-error', st?.kind === 'error');
    s.classList.toggle('is-ok', st?.kind === 'ok');
    s.classList.toggle('is-busy', st?.kind === 'busy');
  }
}

/** '09-13 까지' — the UTC day the code stops working. */
function fmtExpiry(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} 까지`;
}
