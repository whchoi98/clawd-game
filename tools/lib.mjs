/**
 * Helpers shared by tools/build.mjs and tools/dev.mjs: path resolution from
 * env, esbuild option factories, the hashed-asset publish step (styles.css,
 * favicon and other public files, index.html marker rewrite), the service
 * worker publish step (precache list + sw.js bundle), and the size table.
 * Plain ESM, no TypeScript, no dependencies beyond esbuild.
 */
import { build as esbuild } from 'esbuild';
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

export const CSS_MARKER = '<!--CSS-->';
export const APP_MARKER = '<!--APP-->';
/** The service worker is served unhashed from the site root (scope "/"). */
export const SW_NAME = 'sw.js';

/** First 8 hex chars of the sha256 of `data` (string or Buffer). */
export function shortHash(data) {
  return createHash('sha256').update(data).digest('hex').slice(0, 8);
}

/**
 * Resolve the build layout from the environment. Every relative path is taken
 * against ROOT (default: cwd).
 *   DIST=dist  SRC_CLIENT=src/client/main.ts  SRC_SERVER=src/server/index.ts  PUBLIC=public
 *   SRC_SW=src/client/sw/sw.ts
 */
export function resolvePaths(env = process.env) {
  const root = resolve(env.ROOT || process.cwd());
  const at = (p, fallback) => resolve(root, p || fallback);
  const dist = at(env.DIST, 'dist');
  return {
    root,
    dist,
    distPublic: join(dist, 'public'),
    distAssets: join(dist, 'public', 'assets'),
    distServer: join(dist, 'server'),
    srcClient: at(env.SRC_CLIENT, 'src/client/main.ts'),
    srcServer: at(env.SRC_SERVER, 'src/server/index.ts'),
    srcSw: at(env.SRC_SW, 'src/client/sw/sw.ts'),
    publicDir: at(env.PUBLIC, 'public'),
  };
}

/**
 * A deterministic build id: hash of every file under the source and public
 * directories (sorted relative path + content), plus the lockfile when present.
 * Identical sources therefore produce identical `__BUILD__` values and, through
 * esbuild's content hashing, identical asset names. BUILD_ID in the env wins.
 */
export function buildId(paths, env = process.env) {
  if (env.BUILD_ID) return String(env.BUILD_ID);
  const h = createHash('sha256');
  const dirs = new Set();
  const srcRoot = join(paths.root, 'src');
  if (existsSync(srcRoot)) dirs.add(srcRoot);
  else {
    dirs.add(dirname(paths.srcClient));
    dirs.add(dirname(paths.srcServer));
  }
  if (existsSync(paths.publicDir)) dirs.add(paths.publicDir);
  for (const dir of [...dirs].sort()) {
    for (const file of walk(dir).sort()) {
      h.update(relative(paths.root, file).split(sep).join('/'));
      h.update('\0');
      h.update(readFileSync(file));
      h.update('\0');
    }
  }
  const lock = join(paths.root, 'package-lock.json');
  if (existsSync(lock)) h.update(readFileSync(lock));
  return h.digest('hex').slice(0, 8);
}

/** All regular files below `dir`, skipping node_modules / dist / dot-directories. */
export function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (st.isFile()) out.push(p);
  }
  return out;
}

/** esbuild options for the browser bundle → DIST/public/assets/app.<hash>.js */
export function clientOptions(paths, { prod, build }) {
  return {
    absWorkingDir: paths.root,
    entryPoints: { app: paths.srcClient },
    outdir: paths.distAssets,
    entryNames: '[name].[hash]',
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: prod,
    sourcemap: 'external',
    metafile: true,
    charset: 'utf8',
    legalComments: 'none',
    define: {
      'process.env.NODE_ENV': JSON.stringify(prod ? 'production' : 'development'),
      __BUILD__: JSON.stringify(build),
    },
    logLevel: 'warning',
  };
}

/**
 * esbuild options for the server bundle → DIST/server/index.js. Everything is
 * bundled (no externals) so the runtime image needs no node_modules; the banner
 * gives CJS dependencies a working `require` under ESM.
 */
export function serverOptions(paths, { build }) {
  return {
    absWorkingDir: paths.root,
    entryPoints: { index: paths.srcServer },
    outdir: paths.distServer,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    packages: 'bundle',
    sourcemap: 'external',
    metafile: true,
    charset: 'utf8',
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
    define: { __BUILD__: JSON.stringify(build) },
    logLevel: 'warning',
  };
}

/**
 * esbuild options for the service worker → DIST/public/sw.js. Unhashed (the
 * browser finds updates by byte-comparing the script at a fixed URL), classic
 * script (iife), es2020. `precache` and `build` are inlined as
 * `__PRECACHE__` / `__BUILD__`, so the worker changes whenever an asset does.
 */
export function swOptions(paths, { prod, build, precache }) {
  return {
    absWorkingDir: paths.root,
    entryPoints: { sw: paths.srcSw },
    outdir: paths.distPublic,
    entryNames: '[name]',
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    minify: prod,
    sourcemap: 'external',
    metafile: true,
    charset: 'utf8',
    legalComments: 'none',
    define: {
      __PRECACHE__: JSON.stringify(precache),
      __BUILD__: JSON.stringify(build),
    },
    logLevel: 'warning',
  };
}

/**
 * Same-origin paths the worker precaches, read from the published DIST/public:
 * "/", "/index.html", every /assets/* file except source maps, then
 * /favicon.svg, /manifest.webmanifest and every /icons/* file that exists.
 * Sorted within each group so identical builds give identical lists.
 */
export function precacheList(distPublic) {
  const list = ['/', '/index.html'];
  const assets = join(distPublic, 'assets');
  if (existsSync(assets)) {
    for (const name of readdirSync(assets).sort()) {
      if (name.endsWith('.map') || !statSync(join(assets, name)).isFile()) continue;
      list.push(`/assets/${name}`);
    }
  }
  for (const name of ['favicon.svg', 'manifest.webmanifest']) {
    if (existsSync(join(distPublic, name))) list.push(`/${name}`);
  }
  const icons = join(distPublic, 'icons');
  if (existsSync(icons)) {
    for (const file of walk(icons).sort()) {
      list.push(`/${relative(distPublic, file).split(sep).join('/')}`);
    }
  }
  return [...new Set(list)];
}

/**
 * Bundle the service worker into DIST/public/sw.js with the precache list
 * computed from what publishPublic() just wrote. Call it after publishPublic.
 * Returns { swPath, precache, metafile }.
 */
export async function publishServiceWorker(paths, { prod, build }) {
  if (!existsSync(paths.srcSw)) throw new Error(`missing service worker entry ${paths.srcSw}`);
  const precache = precacheList(paths.distPublic);
  const result = await esbuild(swOptions(paths, { prod, build, precache }));
  return { swPath: join(paths.distPublic, SW_NAME), precache, metafile: result.metafile };
}

/** Absolute path of the JS file esbuild produced for an entry point, from a metafile. */
export function findEntryOutput(metafile, root) {
  for (const [out, info] of Object.entries(metafile.outputs)) {
    if (info.entryPoint && out.endsWith('.js')) return resolve(root, out);
  }
  throw new Error('esbuild metafile has no JS entry output');
}

/**
 * Publish the static side of the client: copy styles.css under a content hash,
 * copy every other public file except index.html, and write index.html with
 * the two markers replaced by tags for the hashed stylesheet and `appJs`.
 * Returns { cssName, appName, indexPath }.
 */
export function publishPublic(paths, appJs) {
  const appName = basename(appJs);
  const stylesSrc = join(paths.publicDir, 'styles.css');
  if (!existsSync(stylesSrc)) throw new Error(`missing ${stylesSrc}`);
  const css = readFileSync(stylesSrc);
  const cssName = `styles.${shortHash(css)}.css`;
  mkdirSync(paths.distAssets, { recursive: true });
  writeFileSync(join(paths.distAssets, cssName), css);
  pruneAssets(paths.distAssets, new Set([appName, `${appName}.map`, cssName]));

  copyPublicFiles(paths.publicDir, paths.distPublic);

  const templatePath = join(paths.publicDir, 'index.html');
  if (!existsSync(templatePath)) throw new Error(`missing ${templatePath}`);
  const template = readFileSync(templatePath, 'utf8');
  const html = rewriteIndex(template, { cssName, appName });
  const indexPath = join(paths.distPublic, 'index.html');
  writeFileSync(indexPath, html);
  return { cssName, appName, indexPath };
}

/** Replace the two markers; throws when either is missing (the page would be broken). */
export function rewriteIndex(template, { cssName, appName }) {
  for (const m of [CSS_MARKER, APP_MARKER]) {
    if (!template.includes(m)) throw new Error(`index.html is missing the ${m} marker`);
  }
  return template
    .replace(CSS_MARKER, `<link rel="stylesheet" href="/assets/${cssName}">`)
    .replace(APP_MARKER, `<script type="module" src="/assets/${appName}"></script>`);
}

/** Recursively copy `from` → `to`, skipping index.html and styles.css at the top level. */
export function copyPublicFiles(from, to) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    if (name === 'index.html' || name === 'styles.css' || name.startsWith('.')) continue;
    const src = join(from, name);
    const dst = join(to, name);
    if (statSync(src).isDirectory()) copyTree(src, dst);
    else copyFileSync(src, dst);
  }
}

function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    const dst = join(to, name);
    if (statSync(src).isDirectory()) copyTree(src, dst);
    else copyFileSync(src, dst);
  }
}

/** Delete hashed app.*.js(.map) / styles.*.css files in `assetsDir` that are not in `keep`. */
export function pruneAssets(assetsDir, keep) {
  if (!existsSync(assetsDir)) return;
  const stale = /^(app\.[^.]+\.js(\.map)?|styles\.[^.]+\.css)$/;
  for (const name of readdirSync(assetsDir)) {
    if (stale.test(name) && !keep.has(name)) rmSync(join(assetsDir, name), { force: true });
  }
}

/** Write DIST/build.json = { build, at } and return it. */
export function writeBuildInfo(paths, build) {
  const info = { build, at: new Date().toISOString() };
  mkdirSync(paths.dist, { recursive: true });
  writeFileSync(join(paths.dist, 'build.json'), `${JSON.stringify(info, null, 2)}\n`);
  return info;
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/** A fixed-width table of output files: path relative to DIST, raw size, gzip size. */
export function sizeTable(dist, files) {
  const rows = files
    .filter((f) => existsSync(f))
    .map((f) => {
      const buf = readFileSync(f);
      const gz = f.endsWith('.map') ? '' : formatBytes(gzipSync(buf).length);
      return [relative(dist, f).split(sep).join('/'), formatBytes(buf.length), gz];
    });
  const head = ['file', 'size', 'gzip'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r) => r.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
  return [line(head), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}

/** Every file written by a build, for the size table. */
export function collectOutputs(metafiles, root) {
  const out = [];
  for (const m of metafiles) for (const k of Object.keys(m.outputs)) out.push(resolve(root, k));
  return out;
}
