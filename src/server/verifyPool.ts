/**
 * Replay verification off the request thread, with backpressure (P3-12).
 *
 * The sim is pure CPU: on the main thread even the cooperative
 * `verifyReplayChunked` competes with every other request for the one event
 * loop. `createVerifyPool()` moves it into a single `worker_threads` Worker
 * and puts a semaphore in front — at most `concurrent` (4) verifications run
 * in the worker at once, at most `queue` (16) wait for a slot, and anything
 * beyond that is refused immediately with `VerifyBusyError`, which the runs
 * route answers as `503 { error: 'busy' }` + `Retry-After: 3` so a burst
 * degrades into retries instead of a latency cliff.
 *
 * Worker script: this module's own bundle. `tools/build.mjs` bundles the
 * whole server into dist/server/index.js, so `new Worker(import.meta.url)`
 * re-executes that file in a worker thread; there the module-level guard
 * below (not the main thread, `workerData.role` set) starts the message loop
 * and `index.ts` skips `main()`. No second esbuild entry, no blob: URL. Under
 * vitest the source is TypeScript, which a Worker cannot load, so tests build a
 * small bundle of this file with esbuild and pass it as `workerUrl` — or
 * inject `run` (any async verifier) to exercise the semaphore alone.
 *
 * Protocol (structured clone): main → worker `{ id, def, replay, claim }`,
 * worker → main `{ id, result }` or `{ id, error }`. Inside the worker the
 * chunked verifier still yields, so four in-flight jobs interleave and a short
 * replay is not stuck behind a ten-minute one. A job that outlives
 * `timeoutMs` means the worker is wedged: it is terminated, every in-flight
 * job fails as busy (the client retries), and the next job spawns a new one.
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { verifyReplayChunked } from '../sim/replay.js';
import type { LevelDef, Replay, RunClaim, VerifyResult } from '../sim/types.js';
import type { LogSink } from './metrics.js';

/** Verifications in flight inside the worker at once. */
export const VERIFY_CONCURRENCY = 4;
/** Verifications waiting for a slot before the route starts refusing. */
export const VERIFY_QUEUE = 16;
/** Seconds the 503 asks the client to wait. */
export const VERIFY_BUSY_RETRY_AFTER_SEC = 3;
/** A verification longer than this means the worker is stuck (a full 72000-tick replay takes ~300 ms). */
export const VERIFY_TIMEOUT_MS = 20_000;
/** `workerData.role` that turns a thread running this bundle into the verify worker. */
export const VERIFY_WORKER_ROLE = 'clawd-verify-worker';

export type VerifyBusyReason = 'capacity' | 'timeout' | 'worker' | 'closed';

/** Thrown by the pool's `verify` when the submission cannot be verified right now. */
export class VerifyBusyError extends Error {
  override readonly name = 'VerifyBusyError';
  constructor(
    public readonly reason: VerifyBusyReason = 'capacity',
    public readonly retryAfterSec: number = VERIFY_BUSY_RETRY_AFTER_SEC,
  ) {
    super(`verify-busy:${reason}`);
  }
}

export function isVerifyBusy(err: unknown): err is VerifyBusyError {
  return err instanceof Error && err.name === 'VerifyBusyError';
}

// ---------------------------------------------------------------- semaphore
/**
 * `concurrent` slots plus a bounded FIFO of `queue` waiters. `acquire()` hands
 * out a release function (now, or once a slot frees) and returns null when the
 * queue is full — the caller decides what "busy" means.
 */
export class Semaphore {
  private inUse = 0;
  private readonly waiters: Array<(release: () => void) => void> = [];

  constructor(readonly concurrent: number, readonly queue: number) {
    if (!Number.isInteger(concurrent) || concurrent < 1) throw new Error('Semaphore: concurrent must be a positive integer');
    if (!Number.isInteger(queue) || queue < 0) throw new Error('Semaphore: queue must be a non-negative integer');
  }

  get running(): number { return this.inUse; }
  get waiting(): number { return this.waiters.length; }

  acquire(): Promise<() => void> | null {
    if (this.inUse < this.concurrent) {
      this.inUse++;
      return Promise.resolve(this.releaser());
    }
    if (this.waiters.length >= this.queue) return null;
    return new Promise((resolve) => { this.waiters.push(resolve); });
  }

  /** Each release function works once: the slot passes to the next waiter or frees up. */
  private releaser(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.waiters.shift();
      if (next) next(this.releaser());
      else this.inUse--;
    };
  }
}

// ---------------------------------------------------------------- worker side
interface Job { id: number; def: LevelDef; replay: Replay; claim?: RunClaim }
interface Outcome { id: number; result?: VerifyResult; error?: string }

interface PortLike {
  on(event: 'message', listener: (value: Job) => void): unknown;
  postMessage(value: Outcome): void;
}

/** The worker's message loop: verify each job with the chunked verifier and post the outcome back. */
export function runVerifyWorker(port: PortLike): void {
  port.on('message', (job: Job) => {
    verifyReplayChunked(job.def, job.replay, job.claim).then(
      (result) => port.postMessage({ id: job.id, result }),
      (err: unknown) => port.postMessage({ id: job.id, error: err instanceof Error ? err.message : String(err) }),
    );
  });
}

const role = (workerData as { role?: unknown } | null)?.role;
if (!isMainThread && parentPort && role === VERIFY_WORKER_ROLE) runVerifyWorker(parentPort);

// ---------------------------------------------------------------- main side
export type VerifyFn = (def: LevelDef, replay: Replay, claim?: RunClaim) => Promise<VerifyResult>;

interface Pending { resolve: (r: VerifyResult) => void; reject: (e: Error) => void }

/** One worker thread; jobs are matched to replies by id. Respawns lazily after a failure. */
class WorkerVerifier {
  private worker: Worker | undefined;
  private readonly pending = new Map<number, Pending>();
  private timer: NodeJS.Timeout | undefined;
  private seq = 0;
  private closed = false;

  constructor(private readonly url: URL, private readonly timeoutMs: number, private readonly log: LogSink | undefined) {}

  get alive(): boolean { return this.worker !== undefined; }

  spawn(): void {
    if (this.closed || this.worker) return;
    const w = new Worker(this.url, { workerData: { role: VERIFY_WORKER_ROLE } });
    w.on('message', (m: Outcome) => this.settle(m));
    w.on('error', (err: Error) => {
      this.log?.({ err: err.message }, 'verify worker error');
      if (this.worker === w) this.drop(new VerifyBusyError('worker'));
    });
    w.on('exit', (code) => {
      if (this.worker !== w) return;
      this.log?.({ code }, 'verify worker exited');
      this.drop(new VerifyBusyError('worker'));
    });
    this.worker = w;
  }

  verify(def: LevelDef, replay: Replay, claim?: RunClaim): Promise<VerifyResult> {
    if (this.closed) return Promise.reject(new VerifyBusyError('closed'));
    this.spawn();
    const id = ++this.seq;
    return new Promise<VerifyResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.armTimer();
      this.worker!.postMessage({ id, def, replay, claim } satisfies Job);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const w = this.worker;
    this.worker = undefined;
    this.clearTimer();
    this.rejectAll(new VerifyBusyError('closed'));
    if (w) await w.terminate();
  }

  private settle(m: Outcome): void {
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    this.armTimer();
    if (m.result) p.resolve(m.result);
    else p.reject(new Error(m.error ?? 'verify worker returned nothing'));
  }

  /** One timer for the oldest in-flight job: rearmed whenever a job settles, cleared when none is pending. */
  private armTimer(): void {
    this.clearTimer();
    if (this.pending.size === 0) return;
    this.timer = setTimeout(() => {
      this.log?.({ pending: this.pending.size, timeoutMs: this.timeoutMs }, 'verify worker timed out; restarting');
      this.drop(new VerifyBusyError('timeout'));
    }, this.timeoutMs);
    this.timer.unref();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Forget the worker (terminating it) and fail everything in flight; the next job spawns a fresh one. */
  private drop(err: VerifyBusyError): void {
    const w = this.worker;
    this.worker = undefined;
    this.clearTimer();
    this.rejectAll(err);
    if (w) void w.terminate();
  }

  private rejectAll(err: Error): void {
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) p.reject(err);
  }
}

export interface VerifyPoolOptions {
  concurrent?: number;
  queue?: number;
  timeoutMs?: number;
  /** Does the work; default a worker thread running verifyReplayChunked. Tests inject a fake to drive the semaphore. */
  run?: VerifyFn;
  /** Script of the worker thread; default this module (the server bundle in production). */
  workerUrl?: URL;
  /** Spawn the worker now instead of on the first verification. */
  warm?: boolean;
  log?: LogSink;
}

export interface VerifyPoolStats {
  running: number;
  waiting: number;
  /** Verifications refused with VerifyBusyError since the pool was created. */
  refused: number;
  /** Verifications completed (ok or not) since the pool was created. */
  completed: number;
}

export interface VerifyPool {
  /** Drop-in for `AppDeps.verify`: resolves the VerifyResult, rejects with VerifyBusyError over capacity. */
  verify: VerifyFn;
  readonly stats: VerifyPoolStats;
  /** True when a worker thread is currently alive (always false for an injected `run`). */
  readonly workerAlive: boolean;
  close(): Promise<void>;
}

export function createVerifyPool(opts: VerifyPoolOptions = {}): VerifyPool {
  const sem = new Semaphore(opts.concurrent ?? VERIFY_CONCURRENCY, opts.queue ?? VERIFY_QUEUE);
  const stats: VerifyPoolStats = { running: 0, waiting: 0, refused: 0, completed: 0 };
  const worker = opts.run ? undefined : new WorkerVerifier(opts.workerUrl ?? new URL(import.meta.url), opts.timeoutMs ?? VERIFY_TIMEOUT_MS, opts.log);
  const run: VerifyFn = opts.run ?? ((def, replay, claim) => worker!.verify(def, replay, claim));
  if (opts.warm && worker) worker.spawn();

  const verify: VerifyFn = async (def, replay, claim) => {
    const slot = sem.acquire();
    if (!slot) {
      stats.refused++;
      opts.log?.({ running: sem.running, waiting: sem.waiting, refused: stats.refused }, 'verify busy');
      throw new VerifyBusyError('capacity');
    }
    const release = await slot;
    try {
      return await run(def, replay, claim);
    } finally {
      release();
      stats.completed++;
    }
  };

  return {
    verify,
    get stats(): VerifyPoolStats {
      return { ...stats, running: sem.running, waiting: sem.waiting };
    },
    get workerAlive(): boolean { return worker?.alive ?? false; },
    close: () => worker?.close() ?? Promise.resolve(),
  };
}
