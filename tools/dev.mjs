#!/usr/bin/env node
/**
 * Dev loop: `node tools/dev.mjs`
 *
 * Runs esbuild in watch mode for both bundles into DIST (default dist/), keeps
 * dist/public/index.html pointing at the current hashed assets, and runs the
 * server bundle on PORT (default 8099) with STATIC_DIR=dist/public. TABLE_NAME
 * is stripped from the child's env so the server uses its in-memory repo. The
 * server child is restarted whenever its bundle changes; public/ edits
 * (styles.css, index.html, favicon) are republished on save.
 */
import { context } from 'esbuild';
import { spawn } from 'node:child_process';
import { existsSync, watch as fsWatch } from 'node:fs';
import { join } from 'node:path';
import {
  clientOptions, findEntryOutput, publishPublic, resolvePaths, serverOptions, shortHash, writeBuildInfo,
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

function publish() {
  if (!appJs) return;
  try {
    const { appName, cssName } = publishPublic(paths, appJs);
    log(`client  ${appName} + ${cssName} → ${paths.distPublic}`);
  } catch (err) {
    log(`publish failed: ${err instanceof Error ? err.message : String(err)}`);
  }
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
        publish();
        clientReady.resolve();
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

// public/ is flat; a non-recursive watch is enough and works on every platform.
if (existsSync(paths.publicDir)) {
  let timer = null;
  fsWatch(paths.publicDir, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; log('public/ changed'); publish(); }, 120);
  });
}
