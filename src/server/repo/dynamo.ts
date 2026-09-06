/**
 * Single-table DynamoDB Repo (spec §2.4). Table keys: `pk` (S) / `sk` (S),
 * TTL attribute `ttl`.
 *
 *   Leaderboard entry  LB#<mode>#<board>   <score zero-padded 12>#<runId>
 *   Run / ghost        RUN#<runId>         META
 *   Player best        PLAYER#<playerId>   BEST#<mode>#<board>
 *
 * The replay (`masks`) is stored on the RUN item only; LB and PLAYER items are
 * index-like projections without it (a leaderboard page must not read 20
 * replays), so `topRuns` / `getPlayerBest` return runs with `masks: ''`.
 * `getRun` is the only way to read a replay, which is all the ghost route needs.
 *
 * The client is injected so tests can pass a recorder; only the `send` method
 * of DynamoDBDocumentClient is used.
 */
import { GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { Mode } from '../../shared/protocol.js';
import type { Repo, StoredRun } from './types.js';

export const SCORE_DIGITS = 12;

export function padScore(score: number): string {
  const n = Math.max(0, Math.floor(score));
  return String(n).padStart(SCORE_DIGITS, '0');
}

export const KEY = {
  lbPk: (mode: Mode, board: string) => `LB#${mode}#${board}`,
  lbSk: (score: number, runId: string) => `${padScore(score)}#${runId}`,
  runPk: (runId: string) => `RUN#${runId}`,
  RUN_SK: 'META',
  playerPk: (playerId: string) => `PLAYER#${playerId}`,
  bestSk: (mode: Mode, board: string) => `BEST#${mode}#${board}`,
} as const;

/** Structural subset of DynamoDBDocumentClient so tests can inject a fake. */
export interface DocumentClientLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  send(command: any): Promise<any>;
}

type Item = Record<string, unknown>;

const RUN_FIELDS: (keyof StoredRun)[] = [
  'runId', 'mode', 'board', 'levelId', 'seed', 'assist', 'masks', 'playerId', 'name',
  'score', 'ticks', 'shards', 'deaths', 'cleared', 'height', 'createdAt', 'ttl',
];

/** Copy the StoredRun fields, dropping undefined values (DynamoDB rejects them unless configured). */
function projectRun(run: StoredRun, withMasks: boolean): Item {
  const out: Item = {};
  for (const f of RUN_FIELDS) {
    if (f === 'masks' && !withMasks) continue;
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

export class DynamoRepo implements Repo {
  constructor(private readonly client: DocumentClientLike, private readonly table: string) {}

  async getPlayerBest(playerId: string, mode: Mode, board: string): Promise<StoredRun | null> {
    const res = await this.client.send(new GetCommand({
      TableName: this.table,
      Key: { pk: KEY.playerPk(playerId), sk: KEY.bestSk(mode, board) },
    }));
    return res?.Item ? fromItem(res.Item as Item) : null;
  }

  async saveBest(run: StoredRun, previousRunId?: string): Promise<void> {
    const items: Item[] = [
      { Put: { TableName: this.table, Item: { pk: KEY.runPk(run.runId), sk: KEY.RUN_SK, ...projectRun(run, true) } } },
      { Put: { TableName: this.table, Item: { pk: KEY.lbPk(run.mode, run.board), sk: KEY.lbSk(run.score, run.runId), ...projectRun(run, false) } } },
      { Put: { TableName: this.table, Item: { pk: KEY.playerPk(run.playerId), sk: KEY.bestSk(run.mode, run.board), ...projectRun(run, false) } } },
    ];
    if (previousRunId && previousRunId !== run.runId) {
      // The LB sort key embeds the old score, which the caller does not pass; read it from the RUN item.
      const prev = await this.getRun(previousRunId);
      if (prev) {
        items.push({ Delete: { TableName: this.table, Key: { pk: KEY.lbPk(run.mode, run.board), sk: KEY.lbSk(prev.score, prev.runId) } } });
      }
    }
    await this.client.send(new TransactWriteCommand({ TransactItems: items }));
  }

  async topRuns(mode: Mode, board: string, limit: number): Promise<StoredRun[]> {
    const res = await this.client.send(new QueryCommand({
      TableName: this.table,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': KEY.lbPk(mode, board) },
      ScanIndexForward: true,
      Limit: Math.max(1, limit),
    }));
    return ((res?.Items ?? []) as Item[]).map(fromItem);
  }

  async rankOf(mode: Mode, board: string, score: number): Promise<{ better: number; total: number }> {
    const pk = KEY.lbPk(mode, board);
    const better = await this.count('pk = :pk AND sk < :sk', { ':pk': pk, ':sk': padScore(score) });
    const total = await this.count('pk = :pk', { ':pk': pk });
    return { better, total };
  }

  async getRun(runId: string): Promise<StoredRun | null> {
    const res = await this.client.send(new GetCommand({
      TableName: this.table,
      Key: { pk: KEY.runPk(runId), sk: KEY.RUN_SK },
    }));
    return res?.Item ? fromItem(res.Item as Item) : null;
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
