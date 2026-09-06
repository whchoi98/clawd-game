#!/usr/bin/env node
/**
 * Dev loop: `node tools/dev.mjs`
 *
 * Runs esbuild in watch mode for both bundles into DIST (default dist/), keeps
 * dist/public/index.html pointing at the current hashed assets, rebuilds
 * dist/public/sw.js with the matching precache list after every publish, and
 * runs the server bundle on PORT (default 8099) with STATIC_DIR=dist/public. TABLE_NAME
 * is stripped from the child's env so the server uses its in-memory repo. The
 * server child is restarted whenever its bundle changes; public/ edits
 * (styles.css, index.html, favicon) are republished on save.
 */
import { context } from 'esbuild';
import { spawn } from 'node:child_process';
import { existsSync, watch as fsWatch } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import {
  clientOptions, findEntryOutput, publishPublic, publishServiceWorker, resolvePaths, serverOptions, shortHash,
  writeBuildInfo,
} from './lib.mjs';

const PORT = process.env.PORT || '8099';
const paths = resolvePaths({ ...process.env, DIST: process.env.DIST || 'dist' });
const build = `dev-${shortHash(String(Date.now()))}`;

const log = (msg) => {
  const t = new Date().toISOString().slice(11, 19);
  process.stdout.write(`[dev ${t}] ${msg}\n`);
};

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

let appJs = null;
let server = null;
let started = false;
let stopping = false;
let restarting = false;
let restartPending = false;

const clientReady = deferred();
const serverReady = deferred();

let publishing = null;
let publishAgain = false;

/** Publish index.html + public files, then rebuild sw.js against them. Serialised: the SW must see the final tree. */
function publish() {
  if (!appJs) return Promise.resolve();
  if (publishing) {
    publishAgain = true;
    return publishing;
  }
  publishing = (async () => {
    try {
      const { appName, cssName } = publishPublic(paths, appJs);
      const sw = await publishServiceWorker(paths, { prod: false, build });
      log(`client  ${appName} + ${cssName} + sw.js (${sw.precache.length} precached) → ${paths.distPublic}`);
    } catch (err) {
      log(`publish failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      publishing = null;
      if (publishAgain) {
        publishAgain = false;
        void publish();
      }
    }
  })();
  return publishing;
}

const clientCtx = await context({
  ...clientOptions(paths, { prod: false, build }),
  logLevel: 'info',
  plugins: [{
    name: 'publish-public',
    setup(b) {
      b.onEnd((result) => {
        if (result.errors.length || !result.metafile) return;
        appJs = findEntryOutput(result.metafile, paths.root);
        void publish().then(() => clientReady.resolve());
      });
    },
  }],
});

const serverCtx = await context({
  ...serverOptions(paths, { build }),
  logLevel: 'info',
  plugins: [{
    name: 'restart-server',
    setup(b) {
      b.onEnd((result) => {
        if (result.errors.length) return;
        serverReady.resolve();
        if (started) void restartServer();
      });
    },
  }],
});

function startServer() {
  const env = { ...process.env, PORT, STATIC_DIR: paths.distPublic, NODE_ENV: process.env.NODE_ENV || 'development' };
  delete env.TABLE_NAME; // in-memory repo for local play
  server = spawn(process.execPath, ['--enable-source-maps', join(paths.distServer, 'index.js')], { env, stdio: 'inherit' });
  const child = server;
  child.on('exit', (code, signal) => {
    if (!stopping && !restarting && server === child) log(`server exited (${code ?? signal}); waiting for the next rebuild`);
  });
  started = true;
  log(`server  http://127.0.0.1:${PORT}/  (pid ${child.pid}, memory repo)`);
}

function stopServer() {
  return new Promise((resolve) => {
    const child = server;
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    const hammer = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.once('exit', () => { clearTimeout(hammer); resolve(); });
    child.kill('SIGTERM');
  });
}

async function restartServer() {
  if (restarting) { restartPending = true; return; }
  restarting = true;
  log('server  bundle changed, restarting');
  await stopServer();
  if (!stopping) startServer();
  restarting = false;
  if (restartPending) { restartPending = false; void restartServer(); }
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  log('stopping');
  await stopServer();
  await Promise.all([clientCtx.dispose(), serverCtx.dispose()]);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

log(`watching ${paths.srcClient} and ${paths.srcServer}`);
await Promise.all([clientCtx.watch(), serverCtx.watch()]);
await Promise.all([clientReady.promise, serverReady.promise]);
writeBuildInfo(paths, build);
startServer();

// public/ top level plus icons/ — non-recursive watches work on every platform.
// Edits to the worker source are picked up by the client watcher's onEnd only when
// main.ts rebuilds, so sw.ts gets its own watch too.
{
  let timer = null;
  const schedule = (what) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; log(`${what} changed`); void publish(); }, 120);
  };
  for (const dir of [paths.publicDir, join(paths.publicDir, 'icons'), dirname(paths.srcSw)]) {
    if (existsSync(dir)) fsWatch(dir, () => schedule(relative(paths.root, dir) || '.'));
  }
}
