/**
 * Single-table DynamoDB Repo (spec §2.4). Table keys: `pk` (S) / `sk` (S),
 * TTL attribute `ttl`.
 *
 *   Leaderboard entry  LB#<mode>#<board>          <score 12 digits>#<99999-shards 5 digits>#<runId>
 *   Run / ghost        RUN#<runId>                META
 *   Player best        PLAYER#<playerId>          BEST#<mode>#<board>
 *   Replay hash        HASH#<mode>#<board>#<hash> META      (runId, playerId — one copy of a replay per board)
 *   Transfer snapshot  PLAYER#<playerId>          SNAPSHOT  (code, blob, ttl 7 days)
 *   Transfer code      CODE#<code>                META      (playerId, ttl)
 *
 * where <board> is `boardKey(mode, board)`: the date for daily boards and
 * `<levelId>#s<SIM_VERSION>r<rev>` for story boards (e.g. LB#story#t1#s2r0).
 *
 * The LB sort key orders a board fastest first with more shards winning ties
 * (spec §3.5); `rankOf` compares `sk < <score 12 digits>` so it counts exactly
 * the strictly better scores, which is what competition ranking needs.
 *
 * The replay (`masks`), the heuristics (`hx`) and the admin flag live on the
 * RUN item only; LB and PLAYER items are index-like projections without them
 * (a leaderboard page must not read 20 replays), so `topRuns` /
 * `getPlayerBest` return runs with `masks: ''`. `getRun` is the only way to
 * read a replay, which is all the ghost route needs. The `hash` is projected
 * everywhere so the service can compare a resubmission with the best it read.
 *
 * `saveBest` is one transaction guarded on the PLAYER item: the caller names
 * the best it saw (`previousRunId`), and the write is refused with
 * `TransactionCanceledException` when another submission landed in between,
 * so two concurrent runs of one player can never leave two LB rows. The same
 * transaction puts the HASH item with `attribute_not_exists(pk)`; when that
 * is the reason the transaction was cancelled the owner is read and a
 * `DuplicateReplayError` is thrown instead. A replaced story RUN gets a
 * 90-day ttl in the same transaction (daily runs already carry one).
 *
 * `putIfBoardEmpty` seeds a board with the developer's goal run: it queries
 * the LB partition for any entry, then writes a sentinel `<board pk> / SEED`
 * guarded by `attribute_not_exists(pk)` in the same transaction as the run
 * items, so two tasks booting at once seed a board exactly once. Every LB
 * sort key starts with a digit and `SEED` sorts after them all, so board
 * queries bound `sk < 'SEED'` and the sentinel is never read as an entry.
 *
 * `takeSnapshot` is a conditional delete of the CODE item (`attribute_exists`,
 * ReturnValues ALL_OLD): whichever request deletes it wins, so a code works
 * once. DynamoDB TTL deletes lazily, so ttl is also checked against the clock.
 *
 * The client is injected so tests can pass a recorder; only the `send` method
 * of DynamoDBDocumentClient is used.
 */
import { DeleteCommand, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { Mode } from '../../shared/protocol.js';
import { boardKey } from '../boards.js';
import { DuplicateReplayError, cancelledIndices, isConditionalCheckFailed, isSaveConflict } from './errors.js';
import { replacedRunTtl } from './ttl.js';
import type { Repo, StoredRun } from './types.js';

/** Sort key of the seeding sentinel; the upper bound of every LB entry query. */
export const SEED_SK = 'SEED';

export const SCORE_DIGITS = 12;
export const SHARD_DIGITS = 5;
const SHARD_CEIL = 99_999;

export function padScore(score: number): string {
  const n = Math.max(0, Math.floor(score));
  return String(n).padStart(SCORE_DIGITS, '0');
}

/** `99999 - shards`, zero-padded: more shards sort first within a score. */
export function padShards(shards: number): string {
  const n = Math.min(SHARD_CEIL, Math.max(0, Math.floor(shards)));
  return String(SHARD_CEIL - n).padStart(SHARD_DIGITS, '0');
}

/**
 * Key builders. `board` is the wire-level board (levelId / date); story boards
 * are suffixed with `#s<SIM_VERSION>r<rev>` by `boardKey` (see boards.ts), so
 * a sim bump or a zone's geometry change opens a fresh board and the PLAYER
 * best of the previous version cannot shadow a new run.
 */
export const KEY = {
  lbPk: (mode: Mode, board: string) => `LB#${mode}#${boardKey(mode, board)}`,
  lbSk: (score: number, shards: number, runId: string) => `${padScore(score)}#${padShards(shards)}#${runId}`,
  runPk: (runId: string) => `RUN#${runId}`,
  RUN_SK: 'META',
  playerPk: (playerId: string) => `PLAYER#${playerId}`,
  bestSk: (mode: Mode, board: string) => `BEST#${mode}#${boardKey(mode, board)}`,
  hashPk: (mode: Mode, board: string, hash: string) => `HASH#${mode}#${boardKey(mode, board)}#${hash}`,
  HASH_SK: 'META',
  SNAPSHOT_SK: 'SNAPSHOT',
  codePk: (code: string) => `CODE#${code}`,
  CODE_SK: 'META',
} as const;

/** Structural subset of DynamoDBDocumentClient so tests can inject a fake. */
export interface DocumentClientLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  send(command: any): Promise<any>;
}

export interface DynamoRepoOptions {
  /** Clock for ttl checks (ms epoch); default Date.now. */
  now?: () => number;
}

type Item = Record<string, unknown>;

const RUN_FIELDS: (keyof StoredRun)[] = [
  'runId', 'mode', 'board', 'levelId', 'seed', 'assist', 'masks', 'playerId', 'name',
  'score', 'ticks', 'shards', 'deaths', 'cleared', 'height', 'createdAt', 'ttl', 'hash', 'hx', 'flagged',
];
/** Fields that live on the RUN item only. */
const RUN_ONLY: ReadonlySet<keyof StoredRun> = new Set<keyof StoredRun>(['masks', 'hx', 'flagged']);

/** Copy the StoredRun fields, dropping undefined values (DynamoDB rejects them unless configured). */
function projectRun(run: StoredRun, full: boolean): Item {
  const out: Item = {};
  for (const f of RUN_FIELDS) {
    if (!full && RUN_ONLY.has(f)) continue;
    const v = run[f];
    if (v !== undefined) out[f] = v;
  }
  return out;
}

function fromItem(item: Item): StoredRun {
  const run: Item = {};
  for (const f of RUN_FIELDS) if (item[f] !== undefined) run[f] = item[f];
  if (run.masks === undefined) run.masks = '';
  return run as unknown as StoredRun;
}

/** The HASH item of a run: who holds this replay on this board (ttl follows the run's). */
function hashItem(run: StoredRun, hash: string): Item {
  const item: Item = {
    pk: KEY.hashPk(run.mode, run.board, hash), sk: KEY.HASH_SK,
    runId: run.runId, playerId: run.playerId, createdAt: run.createdAt,
  };
  if (run.ttl !== undefined) item.ttl = run.ttl;
  return item;
}

export class DynamoRepo implements Repo {
  private readonly now: () => number;

  constructor(private readonly client: DocumentClientLike, private readonly table: string, opts: DynamoRepoOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  async getPlayerBest(playerId: string, mode: Mode, board: string): Promise<StoredRun | null> {
    const res = await this.client.send(new GetCommand({
      TableName: this.table,
      Key: { pk: KEY.playerPk(playerId), sk: KEY.bestSk(mode, board) },
    }));
    return res?.Item ? fromItem(res.Item as Item) : null;
  }

  async saveBest(run: StoredRun, previousRunId?: string): Promise<void> {
    const guard: Item = previousRunId
      ? { ConditionExpression: 'runId = :prev', ExpressionAttributeValues: { ':prev': previousRunId } }
      : { ConditionExpression: 'attribute_not_exists(runId)' };
    const items: Item[] = [
      { Put: { TableName: this.table, Item: { pk: KEY.runPk(run.runId), sk: KEY.RUN_SK, ...projectRun(run, true) } } },
      { Put: { TableName: this.table, Item: { pk: KEY.lbPk(run.mode, run.board), sk: KEY.lbSk(run.score, run.shards, run.runId), ...projectRun(run, false) } } },
      { Put: { TableName: this.table, Item: { pk: KEY.playerPk(run.playerId), sk: KEY.bestSk(run.mode, run.board), ...projectRun(run, false) }, ...guard } },
    ];
    let hashIndex = -1;
    if (run.hash) {
      hashIndex = items.length;
      items.push({ Put: { TableName: this.table, Item: hashItem(run, run.hash), ConditionExpression: 'attribute_not_exists(pk)' } });
    }
    if (previousRunId && previousRunId !== run.runId) {
      // The LB sort key embeds the old score and shards, which the caller does not pass; read them from the RUN item.
      const prev = await this.getRun(previousRunId);
      if (prev) {
        items.push({ Delete: { TableName: this.table, Key: { pk: KEY.lbPk(run.mode, run.board), sk: KEY.lbSk(prev.score, prev.shards, prev.runId) } } });
        if (run.mode === 'story' && prev.ttl === undefined) {
          items.push({
            Update: {
              TableName: this.table,
              Key: { pk: KEY.runPk(prev.runId), sk: KEY.RUN_SK },
              UpdateExpression: 'SET #ttl = :ttl',
              ConditionExpression: 'attribute_exists(pk)',
              ExpressionAttributeNames: { '#ttl': 'ttl' },
              ExpressionAttributeValues: { ':ttl': replacedRunTtl(run.createdAt) },
            },
          });
        }
      }
    }
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: items }));
    } catch (err) {
      if (hashIndex >= 0 && isSaveConflict(err) && cancelledIndices(err).includes(hashIndex)) {
        const owner = await this.hashOwner(run.mode, run.board, run.hash!);
        throw new DuplicateReplayError(owner?.runId, owner?.playerId);
      }
      throw err;
    }
  }

  async topRuns(mode: Mode, board: string, limit: number): Promise<StoredRun[]> {
    const res = await this.client.send(new QueryCommand({
      TableName: this.table,
      // sk < 'SEED' keeps the seeding sentinel out of the page: entry keys start with a digit
      KeyConditionExpression: 'pk = :pk AND sk < :end',
      ExpressionAttributeValues: { ':pk': KEY.lbPk(mode, board), ':end': SEED_SK },
      ScanIndexForward: true,
      Limit: Math.max(1, limit),
    }));
    return ((res?.Items ?? []) as Item[]).map(fromItem);
  }

  async rankOf(mode: Mode, board: string, score: number): Promise<{ better: number; total: number }> {
    const pk = KEY.lbPk(mode, board);
    // Every sk of a strictly lower score is < padScore(score); equal scores start with padScore(score) + '#', which is greater.
    const better = await this.count('pk = :pk AND sk < :sk', { ':pk': pk, ':sk': padScore(score) });
    const total = await this.count('pk = :pk AND sk < :end', { ':pk': pk, ':end': SEED_SK });
    return { better, total };
  }

  async getRun(runId: string): Promise<StoredRun | null> {
    const res = await this.client.send(new GetCommand({
      TableName: this.table,
      Key: { pk: KEY.runPk(runId), sk: KEY.RUN_SK },
    }));
    return res?.Item ? fromItem(res.Item as Item) : null;
  }

  /**
   * Seed an empty board (see the module note). One COUNT query decides
   * emptiness; the transaction's sentinel condition decides the race. Returns
   * false — writing nothing — when the board has entries or another task
   * seeded it first. The goal replay ships in the client bundle, so its HASH
   * item goes in too: nobody can submit the developer's run as their own.
   */
  async putIfBoardEmpty(run: StoredRun): Promise<boolean> {
    const pk = KEY.lbPk(run.mode, run.board);
    const entries = await this.count('pk = :pk AND sk < :end', { ':pk': pk, ':end': SEED_SK });
    if (entries > 0) return false;
    const items: Item[] = [
      {
        Put: {
          TableName: this.table,
          Item: { pk, sk: SEED_SK, runId: run.runId, playerId: run.playerId, createdAt: run.createdAt },
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      },
      { Put: { TableName: this.table, Item: { pk: KEY.runPk(run.runId), sk: KEY.RUN_SK, ...projectRun(run, true) } } },
      { Put: { TableName: this.table, Item: { pk, sk: KEY.lbSk(run.score, run.shards, run.runId), ...projectRun(run, false) } } },
      {
        Put: {
          TableName: this.table,
          Item: { pk: KEY.playerPk(run.playerId), sk: KEY.bestSk(run.mode, run.board), ...projectRun(run, false) },
          ConditionExpression: 'attribute_not_exists(runId)',
        },
      },
    ];
    if (run.hash) items.push({ Put: { TableName: this.table, Item: hashItem(run, run.hash), ConditionExpression: 'attribute_not_exists(pk)' } });
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: items }));
      return true;
    } catch (err) {
      if (isSaveConflict(err)) return false;
      throw err;
    }
  }

  // ---------------------------------------------------------------- transfer snapshots
  /** One snapshot per player: replaces the previous one and retires its code. */
  async putSnapshot(playerId: string, code: string, blob: string, ttl: number): Promise<void> {
    const old = await this.client.send(new GetCommand({
      TableName: this.table,
      Key: { pk: KEY.playerPk(playerId), sk: KEY.SNAPSHOT_SK },
      ProjectionExpression: 'code',
    }));
    const oldCode = (old?.Item as Item | undefined)?.code;
    const items: Item[] = [
      { Put: { TableName: this.table, Item: { pk: KEY.playerPk(playerId), sk: KEY.SNAPSHOT_SK, code, blob, ttl } } },
      { Put: { TableName: this.table, Item: { pk: KEY.codePk(code), sk: KEY.CODE_SK, playerId, ttl } } },
    ];
    if (typeof oldCode === 'string' && oldCode !== code) {
      items.push({ Delete: { TableName: this.table, Key: { pk: KEY.codePk(oldCode), sk: KEY.CODE_SK } } });
    }
    await this.client.send(new TransactWriteCommand({ TransactItems: items }));
  }

  /** Consume the code (conditional delete), then read and remove the snapshot it points at. */
  async takeSnapshot(code: string): Promise<{ playerId: string; blob: string } | null> {
    let meta: Item | undefined;
    try {
      const res = await this.client.send(new DeleteCommand({
        TableName: this.table,
        Key: { pk: KEY.codePk(code), sk: KEY.CODE_SK },
        ConditionExpression: 'attribute_exists(pk)',
        ReturnValues: 'ALL_OLD',
      }));
      meta = res?.Attributes as Item | undefined;
    } catch (err) {
      if (isConditionalCheckFailed(err)) return null;
      throw err;
    }
    const playerId = meta?.playerId;
    if (typeof playerId !== 'string' || this.expired(meta?.ttl)) return null;
    const snap = await this.client.send(new GetCommand({
      TableName: this.table,
      Key: { pk: KEY.playerPk(playerId), sk: KEY.SNAPSHOT_SK },
    }));
    const item = snap?.Item as Item | undefined;
    if (!item || item.code !== code || typeof item.blob !== 'string' || this.expired(item.ttl)) return null;
    await this.client.send(new DeleteCommand({
      TableName: this.table,
      Key: { pk: KEY.playerPk(playerId), sk: KEY.SNAPSHOT_SK },
      ConditionExpression: 'code = :code',
      ExpressionAttributeValues: { ':code': code },
    })).catch((err: unknown) => { if (!isConditionalCheckFailed(err)) throw err; });
    return { playerId, blob: item.blob };
  }

  // ---------------------------------------------------------------- admin
  /**
   * Flag the RUN, delete its LB row and — when it is still the player's best —
   * the PLAYER item, in one transaction. The HASH item stays: the replay may
   * not come back under another name.
   */
  async delistRun(runId: string): Promise<boolean> {
    const run = await this.getRun(runId);
    if (!run) return false;
    const best = await this.getPlayerBest(run.playerId, run.mode, run.board);
    const items: Item[] = [
      {
        Update: {
          TableName: this.table,
          Key: { pk: KEY.runPk(runId), sk: KEY.RUN_SK },
          UpdateExpression: 'SET flagged = :t',
          ConditionExpression: 'attribute_exists(pk)',
          ExpressionAttributeValues: { ':t': true },
        },
      },
      { Delete: { TableName: this.table, Key: { pk: KEY.lbPk(run.mode, run.board), sk: KEY.lbSk(run.score, run.shards, run.runId) } } },
    ];
    if (best?.runId === runId) {
      items.push({
        Delete: {
          TableName: this.table,
          Key: { pk: KEY.playerPk(run.playerId), sk: KEY.bestSk(run.mode, run.board) },
          ConditionExpression: 'runId = :rid',
          ExpressionAttributeValues: { ':rid': runId },
        },
      });
    }
    await this.client.send(new TransactWriteCommand({ TransactItems: items }));
    return true;
  }

  /** Rename the RUN and, while it is on the board, its LB and PLAYER projections. */
  async renameRun(runId: string, name: string): Promise<boolean> {
    const run = await this.getRun(runId);
    if (!run) return false;
    const best = await this.getPlayerBest(run.playerId, run.mode, run.board);
    const rename = (Key: Item): Item => ({
      Update: {
        TableName: this.table,
        Key,
        UpdateExpression: 'SET #n = :name',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeNames: { '#n': 'name' },
        ExpressionAttributeValues: { ':name': name },
      },
    });
    const items: Item[] = [rename({ pk: KEY.runPk(runId), sk: KEY.RUN_SK })];
    if (best?.runId === runId) {
      items.push(rename({ pk: KEY.lbPk(run.mode, run.board), sk: KEY.lbSk(run.score, run.shards, run.runId) }));
      items.push(rename({ pk: KEY.playerPk(run.playerId), sk: KEY.bestSk(run.mode, run.board) }));
    }
    await this.client.send(new TransactWriteCommand({ TransactItems: items }));
    return true;
  }

  /** Owner of a replay hash on a board, or null. */
  private async hashOwner(mode: Mode, board: string, hash: string): Promise<{ runId: string; playerId: string } | null> {
    const res = await this.client.send(new GetCommand({
      TableName: this.table,
      Key: { pk: KEY.hashPk(mode, board, hash), sk: KEY.HASH_SK },
    }));
    const item = res?.Item as Item | undefined;
    if (!item || typeof item.runId !== 'string' || typeof item.playerId !== 'string') return null;
    return { runId: item.runId, playerId: item.playerId };
  }

  private expired(ttl: unknown): boolean {
    return typeof ttl === 'number' && ttl * 1000 <= this.now();
  }

  /** Select COUNT query, following pagination (COUNT pages are bounded by scanned size, not item count). */
  private async count(keyCondition: string, values: Record<string, unknown>): Promise<number> {
    let total = 0;
    let startKey: Item | undefined;
    do {
      const res = await this.client.send(new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: keyCondition,
        ExpressionAttributeValues: values,
        Select: 'COUNT',
        ExclusiveStartKey: startKey,
      }));
      total += Number(res?.Count ?? 0);
      startKey = res?.LastEvaluatedKey as Item | undefined;
    } while (startKey);
    return total;
  }
}
