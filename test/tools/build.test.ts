/**
 * End-to-end check of tools/build.mjs on a tiny stub project laid out like the
 * real one (public/ + src/client/main.ts + src/client/sw/sw.ts +
 * src/server/index.ts). The script is run as a child process, exactly the way
 * `npm run build` runs it.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const BUILD = join(ROOT, 'tools', 'build.mjs');
const SCRATCH = '/tmp/claude-1000/-home-ec2-user-my-project-clawd-game/f8aa643c-bc48-400a-8c09-d71da38a73d7/scratchpad';

const INDEX_HTML = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>스텁</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<!--CSS-->
</head>
<body>
<canvas id="world"></canvas>
<section id="scr-title">타이틀</section>
<!--APP-->
</body>
</html>
`;

const STYLES_CSS = 'body{margin:0;background:#050a12}\n#world{display:block}\n';
const FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="3"/></svg>\n';
const MANIFEST = '{"name":"스텁","short_name":"스텁","start_url":"/","icons":[{"src":"/icons/icon-192.png","sizes":"192x192","type":"image/png"}]}\n';
/** Not a real PNG; the build copies bytes, it does not decode them. */
const ICON_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

/** A stub worker that uses both defines the way the real one does. */
const CLIENT_SW = `declare const __PRECACHE__: string[];
declare const __BUILD__: string;
const precache: string[] = __PRECACHE__;
const build: string = __BUILD__;
self.addEventListener('install', () => {
  (self as unknown as { stub: { precache: string[]; build: string } }).stub = { precache, build };
});
export {};
`;

const CLIENT_MAIN = `declare const __BUILD__: string;
declare const __VERSION__: string;
import { greet } from './greet.js';
const mode: string = process.env.NODE_ENV ?? 'unknown';
const el = document.getElementById('scr-title');
if (el) el.textContent = greet('클로드') + ' ' + mode + ' ' + __BUILD__ + ' v' + __VERSION__;
export {};
`;
const CLIENT_GREET = `export function greet(name: string): string {
  return '안녕, ' + name;
}
`;
const SERVER_INDEX = `import { join } from 'node:path';
const port: number = Number.parseInt(process.env.PORT ?? '8080', 10);
// Exercise the CJS shim from the banner: a bundled ESM file has no \`require\`.
const version: string = (require('node:process') as { version: string }).version;
console.log('stub server ' + join('a', 'b') + ' ' + port + ' ' + (version.length > 0 ? 'ok' : 'no'));
`;

interface Names { pub: string; client: string; sw: string; server: string }
const DEFAULT_NAMES: Names = { pub: 'public', client: 'src/client/main.ts', sw: 'src/client/sw/sw.ts', server: 'src/server/index.ts' };

/** Lay out the stub project at `dir` (optionally with different folder names). */
function scaffold(dir: string, names: Names = DEFAULT_NAMES): void {
  mkdirSync(join(dir, names.pub, 'icons'), { recursive: true });
  writeFileSync(join(dir, names.pub, 'index.html'), INDEX_HTML);
  writeFileSync(join(dir, names.pub, 'styles.css'), STYLES_CSS);
  writeFileSync(join(dir, names.pub, 'favicon.svg'), FAVICON_SVG);
  writeFileSync(join(dir, names.pub, 'robots.txt'), 'User-agent: *\nAllow: /\n');
  writeFileSync(join(dir, names.pub, 'manifest.webmanifest'), MANIFEST);
  writeFileSync(join(dir, names.pub, 'icons', 'icon-192.png'), ICON_PNG);
  const clientDir = join(dir, names.client, '..');
  mkdirSync(clientDir, { recursive: true });
  writeFileSync(join(dir, names.client), CLIENT_MAIN);
  // The stub's package.json version becomes __VERSION__ (title-screen badge).
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'stub', private: true, version: '9.9.9' }));
  writeFileSync(join(clientDir, 'greet.ts'), CLIENT_GREET);
  mkdirSync(join(dir, names.sw, '..'), { recursive: true });
  writeFileSync(join(dir, names.sw), CLIENT_SW);
  mkdirSync(join(dir, names.server, '..'), { recursive: true });
  writeFileSync(join(dir, names.server), SERVER_INDEX);
}

function runBuild(env: Record<string, string>, args: string[] = []): { status: number; out: string } {
  const r = spawnSync(process.execPath, [BUILD, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 50_000,
  });
  return { status: r.status ?? -1, out: `${r.stdout}\n${r.stderr}` };
}

const APP_RE = /^app\.[A-Z0-9]{8}\.js$/;
const CSS_RE = /^styles\.[0-9a-f]{8}\.css$/;

/** Every string literal that looks like a same-origin path inside a bundle. */
function pathLiterals(src: string): string[] {
  return [...src.matchAll(/"(\/[^"\s]*)"/g)].map((m) => m[1]);
}

describe('tools/build.mjs', () => {
  let dir: string;

  beforeAll(() => {
    mkdirSync(SCRATCH, { recursive: true });
    dir = mkdtempSync(join(SCRATCH, 'build-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('builds a stub project with default paths relative to ROOT', () => {
    const root = join(dir, 'defaults');
    scaffold(root);
    const r = runBuild({ ROOT: root, NODE_ENV: 'development' });
    expect(r.status, r.out).toBe(0);

    const assets = join(root, 'dist', 'public', 'assets');
    const files = readdirSync(assets);
    const app = files.find((f) => APP_RE.test(f));
    const css = files.find((f) => CSS_RE.test(f));
    expect(app, files.join(',')).toBeDefined();
    expect(css, files.join(',')).toBeDefined();
    // External sourcemap next to the bundle, no inline map.
    expect(files).toContain(`${app}.map`);
    const appSrc = readFileSync(join(assets, app!), 'utf8');
    expect(appSrc).not.toContain('sourceMappingURL=data:');
    // Stylesheet is copied byte for byte under a content hash.
    expect(readFileSync(join(assets, css!), 'utf8')).toBe(STYLES_CSS);

    // index.html: both markers replaced by tags pointing at the hashed files.
    const html = readFileSync(join(root, 'dist', 'public', 'index.html'), 'utf8');
    expect(html).not.toContain('<!--CSS-->');
    expect(html).not.toContain('<!--APP-->');
    expect(html).toContain(`<link rel="stylesheet" href="/assets/${css}">`);
    expect(html).toContain(`<script type="module" src="/assets/${app}"></script>`);
    // The rest of the template is untouched.
    expect(html).toContain('<section id="scr-title">타이틀</section>');

    // Other public files are copied as-is; the template and stylesheet are not duplicated.
    expect(readFileSync(join(root, 'dist', 'public', 'favicon.svg'), 'utf8')).toBe(FAVICON_SVG);
    expect(existsSync(join(root, 'dist', 'public', 'robots.txt'))).toBe(true);
    expect(existsSync(join(root, 'dist', 'public', 'styles.css'))).toBe(false);

    // Client define()s: NODE_ENV inlined, __BUILD__ inlined with the build id.
    const buildJson = JSON.parse(readFileSync(join(root, 'dist', 'build.json'), 'utf8')) as { build: string; at: string };
    expect(buildJson.build).toMatch(/^[0-9a-f]{8}$/);
    expect(Number.isNaN(Date.parse(buildJson.at))).toBe(false);
    expect(appSrc).toContain('"development"');
    // esbuild constant-folds the concatenation, so look for the id itself.
    expect(appSrc).toContain(buildJson.build);
    expect(appSrc).not.toContain('__BUILD__');
    // __VERSION__ inlined from the stub's package.json (title-screen badge).
    expect(appSrc).toContain('9.9.9');
    expect(appSrc).not.toContain('__VERSION__');
    // Korean strings survive un-escaped (charset utf8).
    expect(appSrc).toContain('안녕');

    // PWA statics copied verbatim: manifest at the root, icons/ as a tree.
    expect(readFileSync(join(root, 'dist', 'public', 'manifest.webmanifest'), 'utf8')).toBe(MANIFEST);
    expect(readFileSync(join(root, 'dist', 'public', 'icons', 'icon-192.png')).equals(ICON_PNG)).toBe(true);

    // Service worker: unhashed at the root, a classic script, both defines inlined.
    const swJs = join(root, 'dist', 'public', 'sw.js');
    expect(existsSync(swJs)).toBe(true);
    expect(existsSync(`${swJs}.map`)).toBe(true);
    const rootFiles = readdirSync(join(root, 'dist', 'public'));
    expect(rootFiles.filter((f) => /^sw\..*\.js$/.test(f))).toEqual([]);
    expect(files.filter((f) => f.startsWith('sw'))).toEqual([]);
    const swSrc = readFileSync(swJs, 'utf8');
    expect(swSrc).not.toMatch(/^\s*(import|export)\b/m);
    // Both identifiers are replaced; only esbuild's "// <define:…>" marker comment may still name them.
    const swCode = swSrc.replace(/\/\/ <define:\w+>/g, '');
    expect(swCode).not.toContain('__PRECACHE__');
    expect(swCode).not.toContain('__BUILD__');
    expect(swSrc).toContain(`"${buildJson.build}"`);
    expect(swSrc).toContain("addEventListener(\"install\"");
    const precached = pathLiterals(swSrc);
    for (const p of ['/', '/index.html', `/assets/${app}`, `/assets/${css}`, '/favicon.svg', '/manifest.webmanifest', '/icons/icon-192.png']) {
      expect(precached, precached.join(',')).toContain(p);
    }
    // Source maps and the worker itself are never precached; nor is anything unlisted.
    expect(precached).not.toContain(`/assets/${app}.map`);
    expect(precached).not.toContain('/sw.js');
    expect(precached).not.toContain('/robots.txt');
    expect(new Set(precached).size).toBe(precached.length);

    // Server bundle: ESM, banner shim, and it actually runs under node.
    const serverJs = join(root, 'dist', 'server', 'index.js');
    expect(existsSync(serverJs)).toBe(true);
    const serverSrc = readFileSync(serverJs, 'utf8');
    expect(serverSrc.startsWith("import { createRequire } from 'node:module';")).toBe(true);
    expect(serverSrc).toContain('createRequire(import.meta.url)');
    expect(serverSrc).toContain('console.log(');
    const ran = execFileSync(process.execPath, [serverJs], { encoding: 'utf8', env: { ...process.env, PORT: '8123' } });
    expect(ran.trim()).toBe('stub server a/b 8123 ok');

    // Size table printed.
    expect(r.out).toMatch(/app\.[A-Z0-9]{8}\.js/);
    expect(r.out).toMatch(/public\/sw\.js/);
    expect(r.out).toMatch(/server\/index\.js/);
    expect(r.out).toMatch(/sw\.js precaches 7 paths/);
  });

  it('is deterministic: rebuilding identical sources yields identical asset names and sw.js', () => {
    const root = join(dir, 'defaults');
    const before = readdirSync(join(root, 'dist', 'public', 'assets')).sort();
    const build1 = (JSON.parse(readFileSync(join(root, 'dist', 'build.json'), 'utf8')) as { build: string }).build;
    const sw1 = readFileSync(join(root, 'dist', 'public', 'sw.js'), 'utf8');
    const r = runBuild({ ROOT: root, NODE_ENV: 'development' });
    expect(r.status, r.out).toBe(0);
    const after = readdirSync(join(root, 'dist', 'public', 'assets')).sort();
    expect(after).toEqual(before);
    const build2 = (JSON.parse(readFileSync(join(root, 'dist', 'build.json'), 'utf8')) as { build: string }).build;
    expect(build2).toBe(build1);
    expect(readFileSync(join(root, 'dist', 'public', 'sw.js'), 'utf8')).toBe(sw1);
  });

  it('honours explicit env paths and --prod (minified, NODE_ENV=production)', () => {
    const root = join(dir, 'custom');
    scaffold(root, { pub: 'web', client: 'app/entry.ts', sw: 'app/worker.ts', server: 'srv/boot.ts' });
    const dist = join(dir, 'custom-out');
    const r = runBuild(
      {
        ROOT: root,
        DIST: dist,
        SRC_CLIENT: join(root, 'app', 'entry.ts'),
        SRC_SW: 'app/worker.ts',
        SRC_SERVER: 'srv/boot.ts',
        PUBLIC: 'web',
        NODE_ENV: 'development',
      },
      ['--prod'],
    );
    expect(r.status, r.out).toBe(0);
    const files = readdirSync(join(dist, 'public', 'assets'));
    const app = files.find((f) => APP_RE.test(f))!;
    const appSrc = readFileSync(join(dist, 'public', 'assets', app), 'utf8');
    expect(appSrc).toContain('"production"');
    expect(appSrc).not.toContain('"development"');
    // Minified: essentially a single line, and the local name `greet` is gone.
    expect(appSrc.trim().split('\n').length).toBeLessThanOrEqual(2);
    expect(appSrc).not.toMatch(/function greet\(/);
    expect(existsSync(join(dist, 'server', 'index.js'))).toBe(true);
    expect(existsSync(join(dist, 'public', 'favicon.svg'))).toBe(true);
    expect(existsSync(join(dist, 'build.json'))).toBe(true);
    // The worker is minified too, still unhashed, and still lists the hashed app.
    const swSrc = readFileSync(join(dist, 'public', 'sw.js'), 'utf8');
    expect(swSrc.trim().split('\n').length).toBeLessThanOrEqual(2);
    expect(swSrc).toContain(`/assets/${app}`);
    expect(existsSync(join(dist, 'public', 'icons', 'icon-192.png'))).toBe(true);
    // Nothing leaked into the default location.
    expect(existsSync(join(root, 'dist'))).toBe(false);
  });

  it('replaces stale hashed assets instead of accumulating them, and sw.js follows the new names', () => {
    const root = join(dir, 'defaults');
    const oldCss = readdirSync(join(root, 'dist', 'public', 'assets')).find((f) => CSS_RE.test(f))!;
    writeFileSync(join(root, 'public', 'styles.css'), `${STYLES_CSS}h1{color:red}\n`);
    const r = runBuild({ ROOT: root, NODE_ENV: 'development' });
    expect(r.status, r.out).toBe(0);
    const css = readdirSync(join(root, 'dist', 'public', 'assets')).filter((f) => CSS_RE.test(f));
    expect(css).toHaveLength(1);
    expect(css[0]).not.toBe(oldCss);
    const html = readFileSync(join(root, 'dist', 'public', 'index.html'), 'utf8');
    expect(html).toContain(`/assets/${css[0]}`);
    const swSrc = readFileSync(join(root, 'dist', 'public', 'sw.js'), 'utf8');
    expect(swSrc).toContain(`/assets/${css[0]}`);
    expect(swSrc).not.toContain(oldCss);
  });

  it('exits non-zero when the service worker entry is missing', () => {
    const root = join(dir, 'nosw');
    scaffold(root);
    rmSync(join(root, 'src', 'client', 'sw', 'sw.ts'));
    const r = runBuild({ ROOT: root });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/service worker entry/);
  });

  it('exits non-zero when a marker is missing from index.html', () => {
    const root = join(dir, 'broken');
    scaffold(root);
    writeFileSync(join(root, 'public', 'index.html'), INDEX_HTML.replace('<!--APP-->', ''));
    const r = runBuild({ ROOT: root });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/<!--APP-->/);
  });

  it('exits non-zero when the client entry does not compile', () => {
    const root = join(dir, 'syntax');
    scaffold(root);
    writeFileSync(join(root, 'src', 'client', 'main.ts'), 'const = ;\n');
    const r = runBuild({ ROOT: root });
    expect(r.status).not.toBe(0);
  });
});
