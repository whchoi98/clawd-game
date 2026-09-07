// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyTitleMeta, formatVersion, towerSummary, TOWER_NOTE_ID, VERSION_ID } from '../../src/client/ui/title-meta.js';
import { LEVELS } from '../../src/sim/levels.generated.js';

describe('title-meta: version badge + tower summary', () => {
  it('formats version and an 8-char build id', () => {
    expect(formatVersion('0.3.0', '5a9af50a6b8ee877a9')).toBe('v0.3.0 · 빌드 5a9af50a');
    expect(formatVersion('1.2.3', 'abcd1234')).toBe('v1.2.3 · 빌드 abcd1234');
  });

  it('reads dev when nothing was inlined, and drops the build when only it is dev', () => {
    expect(formatVersion('dev', 'dev')).toBe('dev');
    expect(formatVersion('', '')).toBe('dev');
    expect(formatVersion('0.3.0', 'dev')).toBe('v0.3.0');
    expect(formatVersion('dev', 'deadbeef')).toBe('dev · 빌드 deadbeef');
  });

  it('counts tiers as distinct biomes and zones as the list length', () => {
    expect(towerSummary([{ biome: 'tidepool' }, { biome: 'tidepool' }, { biome: 'stormspire' }])).toBe('스토리 · 2개 층 · 3개 구역');
    expect(towerSummary(LEVELS)).toBe(`스토리 · ${new Set(LEVELS.map((l) => l.biome)).size}개 층 · ${LEVELS.length}개 구역`);
  });

  it('writes both strings into the DOM and tolerates missing elements', () => {
    document.body.innerHTML = `<small id="${TOWER_NOTE_ID}">stale</small><span id="${VERSION_ID}">dev</span>`;
    applyTitleMeta(document, { version: '0.3.0', build: '0123456789', levels: LEVELS });
    expect(document.getElementById(VERSION_ID)?.textContent).toBe('v0.3.0 · 빌드 01234567');
    expect(document.getElementById(TOWER_NOTE_ID)?.textContent).toBe(towerSummary(LEVELS));
    document.body.innerHTML = '';
    expect(() => applyTitleMeta(document, { version: 'dev', build: 'dev', levels: [] })).not.toThrow();
  });

  it('the shipped template carries both hooks and the badge closes the title footer', () => {
    const html = readFileSync(join(process.cwd(), 'public', 'index.html'), 'utf8');
    expect(html).toContain(`id="${VERSION_ID}"`);
    expect(html).toContain(`id="${TOWER_NOTE_ID}"`);
    const footStart = html.indexOf('class="title__foot"');
    const foot = html.slice(footStart, html.indexOf('</section>', footStart));
    expect(foot.lastIndexOf('id="title-version"')).toBeGreaterThan(foot.lastIndexOf('id="ios-hint"'));
  });
});
