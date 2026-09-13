/** The demonstration's transport and input readout. The shell owns playback. */
import type { ReplayView, UIAction } from '../contracts.js';
import { IN } from '../../sim/types.js';
import { fmtTicks } from './hud.js';

const ACTIONS = [
  [IN.LEFT, '왼쪽'], [IN.RIGHT, '오른쪽'], [IN.UP, '위'], [IN.DOWN, '아래'],
  [IN.JUMP, '점프'], [IN.DASH, '대시'],
] as const;

export class ReplayPanel {
  private layout: { width: number; height: number; top: number; bottom: number } | null = null;
  constructor(private readonly doc: Document, emit: (action: UIAction) => void) {
    doc.getElementById('replay-seek')?.addEventListener('input', (event) => {
      emit({ type: 'replaySeek', tick: Number((event.target as HTMLInputElement).value) });
    });
  }

  update(v: ReplayView): boolean {
    const set = (id: string, text: string): void => {
      const node = this.doc.getElementById(id);
      if (node && node.textContent !== text) node.textContent = text;
    };
    set('replay-name', v.name);
    set('replay-biome', v.biomeName);
    set('replay-time', `${fmtTicks(v.cursor)} / ${fmtTicks(v.duration)}`);
    set('replay-toggle-label', v.playing ? '일시정지' : v.cursor === v.duration ? '다시 보기' : '재생');
    const section = [...v.checkpoints].reverse().find((cp) => cp.tick <= v.cursor);
    set('replay-status', v.finished ? '길잡이 도착 · 이제 나의 차례' : `${section?.label ?? '시작'} · ${v.playing ? '재생 중' : '일시정지'}`);
    const toggle = this.doc.getElementById('replay-toggle');
    toggle?.setAttribute('aria-label', v.playing ? '길잡이 일시정지' : '길잡이 재생');
    toggle?.classList.toggle('is-playing', v.playing);
    const range = this.doc.getElementById('replay-seek') as HTMLInputElement | null;
    if (range) {
      range.max = String(v.duration);
      if (Number(range.value) !== v.cursor) range.value = String(v.cursor);
      range.style.setProperty('--played', `${v.duration ? v.cursor / v.duration * 100 : 0}%`);
      range.setAttribute('aria-valuetext', `${fmtTicks(v.cursor)} / ${fmtTicks(v.duration)}`);
    }
    for (const b of this.doc.querySelectorAll<HTMLButtonElement>('[data-act="replaySpeed"]')) {
      b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === v.speed));
    }
    const prev = this.doc.getElementById('replay-prev') as HTMLButtonElement | null;
    const next = this.doc.getElementById('replay-next') as HTMLButtonElement | null;
    const oldPrev = prev?.disabled, oldNext = next?.disabled;
    if (prev) prev.disabled = v.cursor <= 0;
    if (next) next.disabled = !v.checkpoints.some((cp) => cp.tick > v.cursor);
    const inputs = this.doc.getElementById('replay-inputs');
    const names: string[] = [];
    for (const [bit, name] of ACTIONS) {
      const on = (v.mask & bit) !== 0;
      inputs?.querySelector(`[data-bit="${bit}"]`)?.classList.toggle('is-held', on);
      if (on) names.push(name);
    }
    inputs?.setAttribute('aria-label', `길잡이 조작: ${names.join(', ') || '입력 없음'}`);
    return oldPrev !== prev?.disabled || oldNext !== next?.disabled;
  }

  /** Layout is stable between viewport changes; never force layout every frame. */
  insets(): { top: number; bottom: number } {
    const width = this.doc.defaultView?.innerWidth ?? 0;
    const height = this.doc.defaultView?.innerHeight ?? 0;
    if (this.layout?.width === width && this.layout.height === height) return this.layout;
    const header = this.doc.querySelector('.replay__head')?.getBoundingClientRect();
    const transport = this.doc.querySelector('.replay__transport')?.getBoundingClientRect();
    if (!height || !header?.height || !transport?.height) return { top: 0.12, bottom: 0.24 };
    this.layout = {
      width, height,
      top: Math.min(0.4, Math.max(0, header.bottom / height)),
      bottom: Math.min(0.5, Math.max(0, (height - transport.top) / height)),
    };
    return this.layout;
  }
}
