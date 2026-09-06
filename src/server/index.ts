/**
 * Production entrypoint (bundled to dist/server/index.js).
 *
 * Environment:
 *   PORT          listen port (default 8080)
 *   TABLE_NAME    DynamoDB table; unset → in-memory repo (local dev only)
 *   DAILY_SECRET  HMAC key for daily seeds; unset → random per process (seeds differ across tasks!)
 *   STATIC_DIR    built client to serve (dist/public); unset → API only
 *   APP_VERSION   reported by /api/health
 */
import { randomBytes } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { verifyReplayChunked } from '../sim/replay.js';
import { buildApp } from './app.js';
import { asyncVerifier } from './runs.js';
import { MemoryRepo } from './repo/memory.js';
import { DynamoRepo } from './repo/dynamo.js';
import type { Repo } from './repo/types.js';

async function main(): Promise<void> {
  const port = Number.parseInt(process.env.PORT ?? '8080', 10);
  const tableName = process.env.TABLE_NAME;
  const warnings: string[] = [];

  let repo: Repo;
  if (tableName) {
    const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });
    repo = new DynamoRepo(doc, tableName);
  } else {
    repo = new MemoryRepo();
    warnings.push('TABLE_NAME is not set: using the in-memory repo; runs are lost on restart');
  }

  let dailySecret = process.env.DAILY_SECRET;
  if (!dailySecret) {
    dailySecret = randomBytes(32).toString('hex');
    warnings.push('DAILY_SECRET is not set: using a random per-process secret; daily seeds will differ between tasks and restarts');
  }

  const app = await buildApp({
    repo,
    now: () => new Date(),
    dailySecret,
    // Cooperative verifier: yields to the event loop every 2400 ticks so a long replay cannot stall /healthz.
    verify: asyncVerifier(verifyReplayChunked),
    staticDir: process.env.STATIC_DIR || undefined,
    version: process.env.APP_VERSION ?? 'dev',
    logger: true,
  });
  for (const w of warnings) app.log.warn(w);

  let closing = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    const timer = setTimeout(() => {
      app.log.error('shutdown timed out; exiting');
      process.exit(1);
    }, 10_000);
    timer.unref();
    app.close().then(
      () => process.exit(0),
      (err: unknown) => {
        app.log.error({ err }, 'error during shutdown');
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await app.listen({ port, host: '0.0.0.0' });
  app.log.info({ port, table: tableName ?? '(memory)', staticDir: process.env.STATIC_DIR ?? '(none)', version: process.env.APP_VERSION ?? 'dev' }, 'clawd echo tower server up');
}

main().catch((err: unknown) => {
  // The logger belongs to the app, which may not exist yet; stderr is the only channel left.
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
