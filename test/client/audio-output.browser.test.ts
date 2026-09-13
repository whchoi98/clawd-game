/**
 * Actual WebAudio output, not only a graph mock. Opt in with
 * CLAWD_BROWSER_TESTS=1; uses the existing Playwright Chromium installation.
 */
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type AudioModule = typeof import('../../src/client/audio/engine.js') & typeof import('../../src/client/audio/music.js');

describe.runIf(process.env.CLAWD_BROWSER_TESTS === '1')('rendered audio channel silence', () => {
  let browser: Browser;
  let bundle: string;

  beforeAll(async () => {
    const result = await build({
      stdin: {
        contents: `export { AudioEngine } from './src/client/audio/engine.ts'; export { TRACKS } from './src/client/audio/music.ts';`,
        resolveDir: fileURLToPath(new URL('../../', import.meta.url)), loader: 'ts',
      },
      bundle: true, write: false, format: 'iife', globalName: 'AudioUnderTest', platform: 'browser',
    });
    bundle = result.outputFiles[0].text;
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => { await browser?.close(); });

  it('renders exact silence for muted SFX, all muted tracks, and master mute while keeping the other category audible', async () => {
    const page = await browser.newPage();
    await page.route('**/*', (route) => route.abort());
    try {
      await page.addScriptTag({ content: bundle });
      const results = await page.evaluate(async () => {
        const { AudioEngine, TRACKS } = (globalThis as unknown as { AudioUnderTest: AudioModule }).AudioUnderTest;
        const nativeContext = globalThis.AudioContext;
        const cases = [
          { name: 'SFX zero: shard', sound: 'shard', master: 1, sfx: 0, music: 1, silent: true },
          { name: 'SFX zero: noise and tones', sound: 'bubbleBack', master: 1, sfx: 0, music: 1, silent: true },
          ...Object.keys(TRACKS).map((track) => ({ name: `music zero: ${track}`, sound: track, master: 1, sfx: 1, music: 0, silent: true })),
          { name: 'SFX remains audible', sound: 'shard', master: 1, sfx: 1, music: 0, silent: false },
          { name: 'music remains audible', sound: 'title', master: 1, sfx: 0, music: 1, silent: false },
          { name: 'master zero', sound: 'title', master: 0, sfx: 1, music: 1, silent: true },
        ];
        const out: { name: string; peak: number; silent: boolean }[] = [];
        try {
          for (const c of cases) {
            const context = new OfflineAudioContext(1, 48_000 * 3, 48_000);
            // Only the engine's state check is adapted: rendering is native WebAudio.
            Object.defineProperty(context, 'state', { get: () => 'running' });
            globalThis.AudioContext = function () { return context; } as unknown as typeof AudioContext;
            const engine = new AudioEngine({ doc: null });
            try {
              engine.applySettings(c as unknown as Parameters<typeof engine.applySettings>[0]);
              engine.init();
              if (TRACKS[c.sound]) { engine.setTrack(c.sound); engine.tick(); }
              else engine.play(c.sound as 'shard' | 'bubbleBack', { vol: 1, pan: 0.3 });
              const samples = (await context.startRendering()).getChannelData(0);
              let peak = 0;
              for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
              out.push({ name: c.name, peak, silent: c.silent });
            } finally { engine.dispose(); }
          }
        } finally { globalThis.AudioContext = nativeContext; }
        return out;
      });
      for (const r of results) {
        if (r.silent) expect(r.peak, r.name).toBe(0);
        else expect(r.peak, r.name).toBeGreaterThan(0.0001);
      }
    } finally { await page.close(); }
  });
});
