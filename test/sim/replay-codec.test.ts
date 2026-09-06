import { describe, it, expect } from 'vitest';
import { IN, IN_ALL } from '../../src/sim/types.js';
import { decodeMasks, encodeMasks, rleDecode, rleEncode } from '../../src/sim/replay.js';

describe('mask codec (7-bit RLE + base64)', () => {
  it('round-trips every 7-bit mask, RETRY (64) included', () => {
    const all = Uint8Array.from({ length: 128 }, (_, i) => i);
    expect(Array.from(decodeMasks(encodeMasks(all)))).toEqual(Array.from(all));
    const taps = Uint8Array.from([IN.RIGHT, IN.RIGHT, IN.RIGHT | IN.RETRY, IN.RIGHT, IN.RETRY, IN.RETRY, 0]);
    const back = decodeMasks(encodeMasks(taps));
    expect(Array.from(back)).toEqual(Array.from(taps));
    expect(back[2] & IN.RETRY).toBe(IN.RETRY);
    expect(IN.RETRY & IN_ALL).toBe(IN.RETRY);
  });

  it('strips bit 7 (above IN_ALL) and compresses long holds', () => {
    const masks = new Uint8Array(1000).fill(IN.RIGHT | 0x80);
    const rle = rleEncode(masks);
    expect(rle.length).toBe(8); // 1000 = 255 + 255 + 255 + 235 → 4 (mask, count) pairs
    expect(Array.from(rleDecode(rle))).toEqual(new Array<number>(1000).fill(IN.RIGHT));
    expect(encodeMasks(masks).length).toBeLessThan(16);
  });

  it('rejects a zero run length, an odd byte count and a log past the tick cap', () => {
    expect(() => rleDecode(Uint8Array.from([1, 0]))).toThrow('bad-rle');
    expect(() => rleDecode(Uint8Array.from([1]))).toThrow('bad-rle');
    expect(() => rleDecode(Uint8Array.from([1, 255]), 100)).toThrow('too-long');
    expect(() => decodeMasks('not base64!')).toThrow('bad-base64');
  });
});
