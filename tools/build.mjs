#!/usr/bin/env node
/**
 * Production build: `node tools/build.mjs [--prod]`
 *
 *   client  src/client/main.ts → DIST/public/assets/app.<hash>.js (+ .map)
 *           public/styles.css  → DIST/public/assets/styles.<hash>.css
 *           public/index.html  → DIST/public/index.html (markers rewritten)
 *           other public files → DIST/public/
 *   server  src/server/index.ts → DIST/server/index.js (ESM, everything bundled)
 *   meta    DIST/build.json = { build, at }
 *
 * Env: ROOT (cwd) · DIST (dist) · SRC_CLIENT · SRC_SERVER · PUBLIC · BUILD_ID
 * Minifies when NODE_ENV=production or --prod. Exits 1 on any error.
 */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildId, clientOptions, collectOutputs, findEntryOutput, publishPublic, resolvePaths,
  serverOptions, sizeTable, writeBuildInfo,
} from './lib.mjs';

async function main() {
  const prod = process.argv.includes('--prod') || process.env.NODE_ENV === 'production';
  const paths = resolvePaths();
  const id = buildId(paths);
  const t0 = Date.now();

  // Only the two trees we own; DIST itself may hold unrelated files.
  rmSync(paths.distPublic, { recursive: true, force: true });
  rmSync(paths.distServer, { recursive: true, force: true });

  const [client, server] = await Promise.all([
    build(clientOptions(paths, { prod, build: id })),
    build(serverOptions(paths, { build: id })),
  ]);

  const appJs = findEntryOutput(client.metafile, paths.root);
  const { indexPath, cssName } = publishPublic(paths, appJs);
  writeBuildInfo(paths, id);

  const files = [
    ...collectOutputs([client.metafile], paths.root),
    join(paths.distAssets, cssName),
    indexPath,
    ...collectOutputs([server.metafile], paths.root),
  ];
  process.stdout.write(`build ${id} (${prod ? 'production' : 'development'}) in ${Date.now() - t0} ms → ${paths.dist}\n\n`);
  process.stdout.write(`${sizeTable(paths.dist, dedupe(files))}\n`);
}

function dedupe(list) {
  return [...new Set(list)];
}

main().catch((err) => {
  process.stderr.write(`build failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
