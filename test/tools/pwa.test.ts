/**
 * The committed PWA statics: the manifest matches the contract, the icon PNGs
 * exist at the sizes the manifest and the Apple tag promise (read from the PNG
 * IHDR header — no image library), and tools/icons.mjs agrees with them.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { VARIANTS, pngSize } from '../../tools/icons.mjs';

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const PUBLIC = join(ROOT, 'public');
const ICONS = join(PUBLIC, 'icons');

interface ManifestIcon { src: string; sizes: string; type: string; purpose: string }
interface Manifest {
  name: string; short_name: string; lang: string; start_url: string; scope: string;
  display: string; display_override: string[]; orientation: string;
  background_color: string; theme_color: string; icons: ManifestIcon[];
}

function manifest(): Manifest {
  return JSON.parse(readFileSync(join(PUBLIC, 'manifest.webmanifest'), 'utf8')) as Manifest;
}

describe('public/manifest.webmanifest', () => {
  it('matches the PWA contract', () => {
    const m = manifest();
    expect(m.name).toBe('CLAWD JUMP: ECHO TOWER');
    expect(m.short_name).toBe('ECHO TOWER');
    expect(m.lang).toBe('ko');
    expect(m.start_url).toBe('/');
    expect(m.scope).toBe('/');
    expect(m.display).toBe('fullscreen');
    expect(m.display_override).toEqual(['fullscreen', 'standalone']);
    expect(m.orientation).toBe('landscape');
    expect(m.background_color).toBe('#050A12');
    expect(m.theme_color).toBe('#050A12');
    expect(m.icons).toEqual([
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ]);
  });

  it('every icon it lists is a committed PNG of the declared size', () => {
    for (const icon of manifest().icons) {
      const file = join(PUBLIC, icon.src.replace(/^\//, ''));
      expect(existsSync(file), icon.src).toBe(true);
      const [w, h] = icon.sizes.split('x').map(Number);
      expect(pngSize(readFileSync(file)), icon.src).toEqual({ width: w, height: h });
    }
  });
});

describe('public/icons', () => {
  it('icon.svg is a square 512 source with the ids the renderer needs', () => {
    const svg = readFileSync(join(ICONS, 'icon.svg'), 'utf8');
    expect(svg).toMatch(/viewBox="0 0 512 512"/);
    expect(svg).toContain('id="bg"');
    expect(svg).toContain('id="art"');
    // Palette from the brief: shell, highlight, navy ground.
    for (const hex of ['#E8825C', '#FFB088', '#050A12']) expect(svg).toContain(hex);
    // No raster data smuggled in: it is drawn, not embedded.
    expect(svg).not.toMatch(/data:image/);
  });

  it('the four PNGs exist at 192, 512, 512 (maskable) and 180 (Apple)', () => {
    const expected: Record<string, number> = {
      'icon-192.png': 192,
      'icon-512.png': 512,
      'icon-maskable-512.png': 512,
      'apple-touch-icon.png': 180,
    };
    for (const [file, size] of Object.entries(expected)) {
      const path = join(ICONS, file);
      expect(existsSync(path), file).toBe(true);
      expect(pngSize(readFileSync(path)), file).toEqual({ width: size, height: size });
    }
  });

  it('tools/icons.mjs renders exactly those four files at those sizes', () => {
    const byFile = Object.fromEntries(VARIANTS.map((v) => [v.file, v.size]));
    expect(byFile).toEqual({
      'icon-192.png': 192,
      'icon-512.png': 512,
      'icon-maskable-512.png': 512,
      'apple-touch-icon.png': 180,
    });
    // Maskable and Apple variants are full-bleed (the OS masks them); the plain tiles keep clear corners.
    for (const v of VARIANTS) {
      const fullBleed = v.file.includes('maskable') || v.file.startsWith('apple');
      expect(v.fullBleed, v.file).toBe(fullBleed);
      expect(v.transparent, v.file).toBe(!fullBleed);
      if (fullBleed) expect(v.art, v.file).toBeLessThan(1);
    }
  });

  it('pngSize rejects non-PNG bytes', () => {
    expect(() => pngSize(Buffer.from('<svg/>'))).toThrow(/not a PNG/);
  });
});
