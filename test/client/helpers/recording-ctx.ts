/**
 * A recording 2D context for rig tests (Phase 5 character pass).
 *
 * Every method call (name + arguments, numbers rounded to 1e-6), every property
 * assignment and every gradient colour stop is appended to a flat log, so two
 * draws can be compared call-for-call without a rasteriser. `hashLog` folds the
 * log into a short FNV-1a digest that fixtures can pin.
 */

export interface RecordingContext {
  readonly log: string[];
  [k: string]: unknown;
}

const round = (v: unknown): unknown => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v);

export function makeRecordingCtx(): RecordingContext {
  const log: string[] = [];
  let state: Record<string, unknown> = {
    globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '#000000', strokeStyle: '#000000',
    lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic',
  };
  const stack: Record<string, unknown>[] = [];
  const fns = new Map<string, (...args: unknown[]) => unknown>();
  const gradient = (kind: string) => ({
    addColorStop(o: number, c: string) { log.push(`${kind}.stop(${round(o)},${c})`); },
  });
  return new Proxy({} as RecordingContext, {
    get(_t, prop) {
      if (prop === 'log') return log;
      if (typeof prop !== 'string') return undefined;
      if (prop in state) return state[prop];
      let fn = fns.get(prop);
      if (!fn) {
        fn = (...args: unknown[]) => {
          log.push(`${prop}(${args.map((a) => JSON.stringify(round(a))).join(',')})`);
          switch (prop) {
            case 'save': stack.push({ ...state }); return undefined;
            case 'restore': if (stack.length) state = stack.pop()!; return undefined;
            case 'createLinearGradient': return gradient('lin');
            case 'createRadialGradient': return gradient('rad');
            case 'createConicGradient': return gradient('con');
            case 'measureText': return { width: String(args[0]).length * 6 };
            case 'getTransform': return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
            default: return undefined;
          }
        };
        fns.set(prop, fn);
      }
      return fn;
    },
    set(_t, prop, value) {
      if (typeof prop === 'string') {
        state[prop] = value;
        log.push(`${prop}=${JSON.stringify(round(value))}`);
      }
      return true;
    },
    has() { return true; },
  });
}

/** 32-bit FNV-1a over the joined log, as 8 hex digits. */
export function hashLog(log: readonly string[]): string {
  let h = 0x811c9dc5;
  const s = log.join('\n');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
