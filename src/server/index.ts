/**
 * Production entrypoint (bundled to dist/server/index.js).
 *
 * Environment:
 *   PORT          listen port (default 8080)
 *   TABLE_NAME    DynamoDB table; unset → in-memory repo (local dev only)
 *   DAILY_SECRET  HMAC key for daily seeds; unset → random per process (seeds differ across tasks!)
 *   TAG_SECRET    HMAC key for playerTag and transfer-code check characters; unset → DAILY_SECRET
 *   STATIC_DIR    built client to serve (dist/public); unset → API only
 *   APP_VERSION   reported by /api/health
 *   SEED_BOARDS   0 → do not seed empty story boards with the goal runs at boot (default: seed)
 *
 * Replay verification runs in one worker thread behind a semaphore
 * (src/server/verifyPool.ts). The worker is this very bundle re-executed by
 * `worker_threads`, so `main()` only runs on the main thread; in the worker the
 * pool module's guard starts the verification loop instead.
 */
import { randomBytes } from 'node:crypto';
import { isMainThread } from 'node:worker_threads';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildApp } from './app.js';
import { configureTagSecret } from './players.js';
import { MemoryRepo } from './repo/memory.js';
import { DynamoRepo } from './repo/dynamo.js';
import type { Repo } from './repo/types.js';
import { createVerifyPool } from './verifyPool.js';
import type { LogRecord } from './metrics.js';

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

  // Player tags and transfer-code check characters are keyed separately when the
  // deployment provides TAG_SECRET; otherwise they fall back to the daily secret.
  const tagSecret = process.env.TAG_SECRET;
  if (tagSecret) {
    configureTagSecret(tagSecret);
  } else {
    configureTagSecret(undefined);
    warnings.push('TAG_SECRET is not set: player tags and transfer codes fall back to DAILY_SECRET');
  }

  // The pool logs through the app once it exists; a line before that is dropped.
  const poolLines: Array<[LogRecord, string]> = [];
  let poolLog = (record: LogRecord, msg: string): void => { poolLines.push([record, msg]); };
  const pool = createVerifyPool({ warm: true, log: (record, msg) => poolLog(record, msg) });

  const app = await buildApp({
    repo,
    now: () => new Date(),
    dailySecret,
    // Off-thread verifier with backpressure: at most 4 replays in flight, 16 waiting, then 503 busy.
    verify: pool.verify,
    staticDir: process.env.STATIC_DIR || undefined,
    version: process.env.APP_VERSION ?? 'dev',
    logger: true,
  });
  poolLog = (record, msg) => { app.log.warn(record, msg); };
  for (const [record, msg] of poolLines) app.log.warn(record, msg);
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
    app.close().then(() => pool.close()).then(
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

// In the verify worker thread this bundle only provides the sim; the server stays on the main thread.
if (isMainThread) {
  main().catch((err: unknown) => {
    // The logger belongs to the app, which may not exist yet; stderr is the only channel left.
    process.stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });
}
