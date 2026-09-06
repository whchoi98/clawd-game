/**
 * Settings panes: display & sound, controls (rebinding with conflict refusal),
 * accessibility, data. Widgets mutate the shared Settings object in place and
 * report through `onChange` / `onRebind`; persistence belongs to the shell.
 */
import type { BindAction, Binds, Settings, UiSound } from '../contracts.js';
import { cloneBinds } from '../input/binds.js';
import { ECHO_WORLD_MODES, echoWorldMode, setEchoWorldMode, type EchoWorldMode } from '../save.js';
import { el } from './screens.js';

export type PortraitPainter = (ctx: CanvasRenderingContext2D, skin: string, size: number, t: number) => void;

/** Rebindable gameplay actions in panel order. Also the conflict-check set. */
export const BIND_ROWS: readonly (readonly [BindAction, string])[] = [
  ['left', '왼쪽'], ['right', '오른쪽'], ['up', '위 / 올려보기'], ['down', '아래 / 스톰프'],
  ['jump', '점프'], ['dash', '대시'], ['pause', '일시정지'], ['restart', '재시작'],
];
const BIND_SLOTS = 2;
/** Seconds a refused binding stays red before the button reads its old key again. */
export const CLASH_MS = 1400;

/**
 * The gameplay action that already owns `code`, or null when the key is free
 * for `action`. `confirm` and `cancel` are not in the set: they deliberately
 * share Space and Escape with jump and pause.
 */
export function findBindConflict(binds: Binds, action: BindAction, code: string): BindAction | null {
  for (const [a] of BIND_ROWS) {
    if (a !== action && (binds[a] ?? []).includes(code)) return a;
  }
  return null;
}

export function bindLabel(action: BindAction): string {
  return BIND_ROWS.find(([a]) => a === action)?.[1] ?? action;
}

type BoolKey = 'bloom' | 'grain' | 'flashes' | 'showTimer' | 'assist' | 'invincible' | 'echoSelf' | 'echoWorld';
type NumKey = 'master' | 'music' | 'sfx' | 'shake';
/** Segmented choices; `echoWorldMode` is not on the Settings contract yet and goes through save.ts's accessors. */
type SegKey = 'quality' | 'skin' | 'echoWorldMode';

function segValue(s: Settings, key: SegKey): string {
  return key === 'echoWorldMode' ? echoWorldMode(s) : s[key];
}

function setSegValue(s: Settings, key: SegKey, value: string): void {
  if (key === 'echoWorldMode') {
    if ((ECHO_WORLD_MODES as readonly string[]).includes(value)) setEchoWorldMode(s, value as EchoWorldMode);
  } else (s as Record<'quality' | 'skin', string>)[key] = value;
}

export interface SettingsPanelDeps {
  doc: Document;
  settings: () => Settings | null;
  skins: () => Record<string, { name: string; kr: string }>;
  keyLabel: (code: string) => string;
  /** Start a rebind capture through the input layer; false when no input layer is attached yet. */
  capture: (cb: (code: string | null) => void) => boolean;
  defaultBinds: () => Binds;
  onChange: () => void;
  onRebind: (binds: Binds) => void;
  /** Called after every (re)build so the cursor can re-collect elements. */
  onRebuilt: () => void;
  sound: (n: UiSound) => void;
  portrait: () => PortraitPainter | null;
  build?: string;
}

export class SettingsPanel {
  private listening: HTMLButtonElement | null = null;
  private readonly clashTimers = new WeakMap<HTMLButtonElement, ReturnType<typeof setTimeout>>();
  private readonly d: SettingsPanelDeps;

  constructor(deps: SettingsPanelDeps) {
    this.d = deps;
  }

  /** True while a rebind button waits for a key: menu navigation must stand still. */
  get capturing(): boolean { return this.listening !== null; }

  /** Whether build() has populated the panes at least once. */
  get built(): boolean { return this.wasBuilt; }
  private wasBuilt = false;

  /**
   * Re-read every widget from the settings without rebuilding the DOM — safe to
   * call on every `applySettings`, even while a slider is being dragged.
   */
  sync(): void {
    const s = this.d.settings();
    const doc = this.d.doc;
    if (!s) return;
    const bag = s as unknown as Record<string, unknown>;
    for (const b of doc.querySelectorAll<HTMLElement>('#scr-settings .switch[data-key]')) {
      b.setAttribute('aria-checked', String(!!bag[b.dataset.key ?? '']));
    }
    for (const i of doc.querySelectorAll<HTMLInputElement>('#scr-settings input[type="range"][data-key]')) {
      const v = Number(bag[i.dataset.key ?? '']);
      if (Number.isFinite(v) && Number(i.value) !== v) i.value = String(v);
      const val = i.parentElement?.querySelector<HTMLElement>('.row__val');
      if (val) val.textContent = `${Math.round(Number(i.value) * 100)}%`;
    }
    for (const b of doc.querySelectorAll<HTMLElement>('#scr-settings .seg button[data-key]')) {
      const key = b.dataset.key ?? '';
      const cur = key === 'echoWorldMode' ? echoWorldMode(s) : bag[key];
      const on = cur === b.dataset.value;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
    this.refreshBindLabels();
  }

  build(): void {
    const s = this.d.settings();
    const doc = this.d.doc;
    const av = doc.getElementById('pane-av');
    const ctrl = doc.getElementById('pane-ctrl');
    const a11y = doc.getElementById('pane-a11y');
    const data = doc.getElementById('pane-data');
    if (!s || !av || !ctrl || !a11y || !data) return;
    this.listening = null;

    av.replaceChildren(
      this.sliderRow('마스터 볼륨', 'master'),
      this.sliderRow('음악', 'music'),
      this.sliderRow('효과음', 'sfx'),
      this.segRow('화질', 'quality', [['auto', '자동'], ['high', '높음'], ['balanced', '균형'], ['low', '낮음']]),
      this.skinRow(),
      this.segRow('세계 메아리', 'echoWorldMode', [['rival', '라이벌'], ['top', '1위']], '라이벌은 내 바로 위 순위의 기록과 달린다 · 체크포인트마다 스플릿'),
      this.toggleRow('블룸 (발광)', 'bloom', '발광체 주변의 빛 번짐'),
      this.toggleRow('필름 그레인', 'grain', '미세한 입자감'),
    );

    ctrl.replaceChildren(...BIND_ROWS.map(([action, label]) => this.bindRow(action, label)));
    const resetRow = this.row('기본 조작으로', '모든 키를 처음 상태로 되돌린다');
    const rb = el(doc, 'button', { class: 'bindbtn', type: 'button' }, 'RESET');
    rb.addEventListener('click', () => {
      const cur = this.d.settings();
      if (!cur) return;
      cur.binds = cloneBinds(this.d.defaultBinds());
      this.d.onRebind(cur.binds);
      this.d.sound('cancel');
      this.build();
    });
    resetRow.ctl.appendChild(rb);
    ctrl.append(resetRow.row, el(doc, 'p', { class: 'row__note' }, 'Enter · Space로 확인, Esc · Backspace로 뒤로. 게임패드는 표준 매핑을 따른다.'));

    a11y.replaceChildren(
      this.toggleRow('보조 모드', 'assist', '중력 완화 · 3단 점프 · 짧은 대시 쿨다운 · 순위표에는 오르지 않는다'),
      this.toggleRow('무적', 'invincible', '가시와 적에게 피해를 입지 않는다 (순위표 제외)'),
      this.toggleRow('섬광 효과', 'flashes', '끄면 전체 화면 번쩍임을 억제한다'),
      this.sliderRow('화면 흔들림', 'shake'),
      this.toggleRow('타이머 표시', 'showTimer'),
    );

    const nameRow = this.row('이름', '순위표와 메아리에 표시된다');
    nameRow.ctl.appendChild(el(doc, 'button', { class: 'bindbtn', type: 'button', 'data-act': 'name' }, '바꾸기'));
    const wipeRow = this.row('진행도 초기화', '구역 기록과 메아리를 모두 지운다 · 되돌릴 수 없다');
    wipeRow.ctl.appendChild(el(doc, 'button', { class: 'bindbtn', type: 'button', 'data-act': 'resetProgress' }, 'WIPE'));
    data.replaceChildren(nameRow.row, wipeRow.row);
    if (this.d.build) data.appendChild(el(doc, 'p', { class: 'row__note' }, `빌드 ${this.d.build}`));

    this.wasBuilt = true;
    this.d.onRebuilt();
  }

  // ------------------------------------------------------------ widgets
  private row(label: string, sub?: string): { row: HTMLElement; ctl: HTMLElement } {
    const doc = this.d.doc;
    const lab = el(doc, 'div', { class: 'row__label' }, label);
    if (sub) lab.appendChild(el(doc, 'small', {}, sub));
    const ctl = el(doc, 'div', { class: 'row__ctl' });
    const row = el(doc, 'div', { class: 'row', 'data-row': '' }, lab, ctl);
    return { row, ctl };
  }

  private toggleRow(label: string, key: BoolKey, sub?: string): HTMLElement {
    const doc = this.d.doc;
    const { row, ctl } = this.row(label, sub);
    const s = this.d.settings();
    const b = el(doc, 'button', {
      class: 'switch', type: 'button', role: 'switch', 'data-key': key,
      'aria-checked': String(!!s?.[key]), 'aria-label': label,
    });
    b.addEventListener('click', () => {
      const cur = this.d.settings();
      if (!cur) return;
      cur[key] = !cur[key];
      b.setAttribute('aria-checked', String(cur[key]));
      this.d.sound('toggle');
      this.d.onChange();
    });
    ctl.appendChild(b);
    return row;
  }

  private sliderRow(label: string, key: NumKey): HTMLElement {
    const doc = this.d.doc;
    const { row, ctl } = this.row(label);
    const s = this.d.settings();
    const input = el(doc, 'input', {
      type: 'range', min: '0', max: '1', step: '0.05', 'data-key': key, 'aria-label': label,
    });
    input.value = String(s?.[key] ?? 0);
    const val = el(doc, 'span', { class: 'row__val' });
    const paint = () => { val.textContent = `${Math.round(Number(input.value) * 100)}%`; };
    paint();
    input.addEventListener('input', () => {
      const cur = this.d.settings();
      if (!cur) return;
      cur[key] = Math.min(1, Math.max(0, Number(input.value) || 0));
      paint();
      this.d.onChange();
    });
    ctl.append(input, val);
    return row;
  }

  private segRow(label: string, key: SegKey, opts: readonly (readonly [string, string])[], sub?: string): HTMLElement {
    const doc = this.d.doc;
    const { row, ctl } = this.row(label, sub);
    const seg = el(doc, 'div', { class: 'seg', role: 'radiogroup', 'aria-label': label });
    for (const [value, text] of opts) seg.appendChild(this.segButton(seg, key, value, text));
    ctl.appendChild(seg);
    return row;
  }

  private segButton(seg: HTMLElement, key: SegKey, value: string, text: string, extra?: Node): HTMLButtonElement {
    const doc = this.d.doc;
    const s = this.d.settings();
    const on = s !== null && segValue(s, key) === value;
    const b = el(doc, 'button', { type: 'button', role: 'radio', 'data-key': key, 'data-value': value, 'aria-checked': String(on) });
    if (on) b.classList.add('on');
    if (extra) b.appendChild(extra);
    b.appendChild(el(doc, 'span', {}, text));
    b.addEventListener('click', () => {
      const cur = this.d.settings();
      if (!cur) return;
      setSegValue(cur, key, value);
      for (const x of seg.querySelectorAll<HTMLElement>('button')) {
        const active = x === b;
        x.classList.toggle('on', active);
        x.setAttribute('aria-checked', String(active));
      }
      this.d.sound('confirm');
      this.d.onChange();
    });
    return b;
  }

  /** Skin picker: a small painted portrait per skin when the renderer lent us its painter. */
  private skinRow(): HTMLElement {
    const doc = this.d.doc;
    const { row, ctl } = this.row('캐릭터');
    const seg = el(doc, 'div', { class: 'seg seg--skins', role: 'radiogroup', 'aria-label': '캐릭터' });
    const painter = this.d.portrait();
    const skins = Object.entries(this.d.skins());
    const list = skins.length ? skins : [['clawd', { name: 'Clawd', kr: '클로드' }] as const];
    for (const [id, sk] of list) {
      let portrait: Node | undefined;
      if (painter) {
        const cv = el(doc, 'canvas', { width: 44, height: 44, 'aria-hidden': 'true' });
        let ctx: CanvasRenderingContext2D | null = null;
        try { ctx = cv.getContext('2d'); } catch { ctx = null; }
        if (ctx) {
          try { painter(ctx, id, 44, 0); portrait = cv; } catch { portrait = undefined; }
        }
      }
      seg.appendChild(this.segButton(seg, 'skin', id, sk.kr, portrait));
    }
    ctl.appendChild(seg);
    return row;
  }

  private bindRow(action: BindAction, label: string): HTMLElement {
    const { row, ctl } = this.row(label);
    for (let slot = 0; slot < BIND_SLOTS; slot++) ctl.appendChild(this.bindButton(action, slot));
    return row;
  }

  private labelFor(action: BindAction, slot: number): string {
    const code = this.d.settings()?.binds[action]?.[slot];
    return code ? this.d.keyLabel(code) : '—';
  }

  private bindButton(action: BindAction, slot: number): HTMLButtonElement {
    const doc = this.d.doc;
    const b = el(doc, 'button', {
      class: 'bindbtn', type: 'button', 'data-bind': action, 'data-slot': slot,
      'aria-label': `${bindLabel(action)} 키 ${slot + 1}`,
    }, this.labelFor(action, slot));
    b.addEventListener('click', () => this.listen(b, action, slot));
    return b;
  }

  private clearClash(b: HTMLButtonElement): void {
    const t = this.clashTimers.get(b);
    if (t !== undefined) { clearTimeout(t); this.clashTimers.delete(b); }
    b.classList.remove('bindbtn--clash');
  }

  private listen(b: HTMLButtonElement, action: BindAction, slot: number): void {
    if (this.listening) return;
    this.clearClash(b);
    const started = this.d.capture((code) => this.captured(b, action, slot, code));
    if (!started) { this.d.sound('error'); return; }
    this.listening = b;
    b.classList.add('listening');
    b.textContent = '입력…';
  }

  private captured(b: HTMLButtonElement, action: BindAction, slot: number, code: string | null): void {
    this.listening = null;
    b.classList.remove('listening');
    const s = this.d.settings();
    if (!s) return;
    if (code) {
      const clash = findBindConflict(s.binds, action, code);
      if (clash) {
        // Refuse: a key another gameplay action owns would make both fire at once.
        b.classList.add('bindbtn--clash');
        b.textContent = `${bindLabel(clash)} 중복`;
        this.d.sound('error');
        this.clashTimers.set(b, setTimeout(() => {
          this.clashTimers.delete(b);
          b.classList.remove('bindbtn--clash');
          b.textContent = this.labelFor(action, slot);
        }, CLASH_MS));
        return;
      }
      // Dense arrays only: replace the slot when it exists, append otherwise,
      // and drop any other copy of the same code within this action.
      const arr = [...(s.binds[action] ?? [])].filter((c) => !!c);
      if (slot < arr.length) arr[slot] = code; else arr.push(code);
      for (let i = arr.length - 1; i >= 0; i--) if (i !== slot && arr[i] === code) arr.splice(i, 1);
      s.binds[action] = arr;
      this.d.onRebind(s.binds);
      this.d.sound('confirm');
      this.refreshBindLabels();
      return;
    }
    this.d.sound('cancel');
    b.textContent = this.labelFor(action, slot);
  }

  /** Re-read every bind button's label from the settings (slots may have shifted). */
  private refreshBindLabels(): void {
    const pane = this.d.doc.getElementById('pane-ctrl');
    if (!pane) return;
    for (const b of pane.querySelectorAll<HTMLButtonElement>('button[data-bind]')) {
      if (b === this.listening || b.classList.contains('bindbtn--clash')) continue;
      const action = b.dataset.bind as BindAction;
      const slot = Number(b.dataset.slot ?? 0);
      b.textContent = this.labelFor(action, slot);
    }
  }
}
