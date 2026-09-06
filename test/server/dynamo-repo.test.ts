import { describe, expect, it } from 'vitest';
import { GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoRepo, KEY, SCORE_DIGITS, padScore } from '../../src/server/repo/dynamo.js';
import type { StoredRun } from '../../src/server/repo/types.js';

/** Records every command and answers from a queue — nothing reaches AWS. */
class FakeClient {
  sent: { name: string; input: Record<string, unknown> }[] = [];
  responses: unknown[] = [];
  async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
    this.sent.push({ name: cmd.constructor.name, input: cmd.input });
    return this.responses.length ? this.responses.shift() : {};
  }
}

function run(over: Partial<StoredRun> = {}): StoredRun {
  return {
    runId: 'run-new', mode: 'daily', board: '2026-09-06', levelId: 'daily', seed: 42, assist: false, masks: 'QUJD',
    playerId: 'p1', name: '클로드', score: 4321, ticks: 4321, shards: 7, deaths: 1, cleared: true, height: 0,
    createdAt: '2026-09-06T12:00:00.000Z', ttl: 1_760_000_000, ...over,
  };
}

describe('key builders', () => {
  it('zero-pads scores to a fixed width so string order equals numeric order', () => {
    expect(SCORE_DIGITS).toBe(12);
    expect(padScore(45)).toBe('000000000045');
    expect(padScore(0)).toBe('000000000000');
    expect(padScore(1_000_099_999)).toBe('001000099999');
    expect(padScore(99) < padScore(100)).toBe(true);
    expect(padScore(999_999) < padScore(1_000_000_000)).toBe(true);
  });

  it('builds the spec §2.4 keys', () => {
    expect(KEY.lbPk('story', 't1')).toBe('LB#story#t1');
    expect(KEY.lbPk('daily', '2026-09-06')).toBe('LB#daily#2026-09-06');
    expect(KEY.lbSk(45, 'abc')).toBe('000000000045#abc');
    expect(KEY.runPk('abc')).toBe('RUN#abc');
    expect(KEY.RUN_SK).toBe('META');
    expect(KEY.playerPk('p1')).toBe('PLAYER#p1');
    expect(KEY.bestSk('daily', '2026-09-06')).toBe('BEST#daily#2026-09-06');
  });

  it('rankOf boundary: sk < padScore(s) selects exactly the strictly lower scores', () => {
    expect(KEY.lbSk(99, 'zzz') < padScore(100)).toBe(true);
    expect(KEY.lbSk(100, 'aaa') < padScore(100)).toBe(false);
    expect(KEY.lbSk(100, 'aaa') > padScore(100)).toBe(true);
    expect(KEY.lbSk(101, 'aaa') < padScore(100)).toBe(false);
  });
});

describe('DynamoRepo', () => {
  const TABLE = 'clawd-table';
  const setup = () => { const client = new FakeClient(); return { client, repo: new DynamoRepo(client, TABLE) }; };

  it('saveBest writes RUN, LB and PLAYER items in one transaction (masks only on RUN, ttl everywhere for daily)', async () => {
    const { client, repo } = setup();
    await repo.saveBest(run());
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0].name).toBe(TransactWriteCommand.name);
    const items = client.sent[0].input.TransactItems as Array<Record<string, { TableName: string; Item?: Record<string, unknown>; Key?: Record<string, unknown> }>>;
    expect(items).toHaveLength(3);
    const puts = items.map((i) => i.Put!);
    expect(puts.every((p) => p.TableName === TABLE)).toBe(true);
    const [runItem, lbItem, playerItem] = puts.map((p) => p.Item!);
    expect(runItem).toMatchObject({ pk: 'RUN#run-new', sk: 'META', masks: 'QUJD', score: 4321, ttl: 1_760_000_000, playerId: 'p1' });
    expect(lbItem).toMatchObject({ pk: 'LB#daily#2026-09-06', sk: '000000004321#run-new', runId: 'run-new', score: 4321, ttl: 1_760_000_000 });
    expect(lbItem).not.toHaveProperty('masks');
    expect(playerItem).toMatchObject({ pk: 'PLAYER#p1', sk: 'BEST#daily#2026-09-06', runId: 'run-new', score: 4321, ttl: 1_760_000_000 });
    expect(playerItem).not.toHaveProperty('masks');
  });

  it('saveBest omits ttl for story runs and never sends undefined attributes', async () => {
    const { client, repo } = setup();
    await repo.saveBest(run({ mode: 'story', board: 't1', levelId: 't1', ttl: undefined }));
    const items = client.sent[0].input.TransactItems as Array<{ Put: { Item: Record<string, unknown> } }>;
    for (const { Put } of items) {
      expect(Put.Item).not.toHaveProperty('ttl');
      expect(Object.values(Put.Item).some((v) => v === undefined)).toBe(false);
    }
  });

  it('saveBest deletes the previous board entry, looking its score up from the RUN item', async () => {
    const { client, repo } = setup();
    client.responses.push({ Item: { pk: 'RUN#run-old', sk: 'META', ...run({ runId: 'run-old', score: 5000, ticks: 5000 }) } }, {});
    await repo.saveBest(run(), 'run-old');
    expect(client.sent.map((s) => s.name)).toEqual([GetCommand.name, TransactWriteCommand.name]);
    expect(client.sent[0].input).toMatchObject({ TableName: TABLE, Key: { pk: 'RUN#run-old', sk: 'META' } });
    const items = client.sent[1].input.TransactItems as Array<Record<string, { TableName: string; Key?: Record<string, unknown> }>>;
    expect(items).toHaveLength(4);
    expect(items[3].Delete).toEqual({ TableName: TABLE, Key: { pk: 'LB#daily#2026-09-06', sk: '000000005000#run-old' } });
  });

  it('saveBest skips the delete when the previous run is gone (expired)', async () => {
    const { client, repo } = setup();
    client.responses.push({}, {});
    await repo.saveBest(run(), 'run-old');
    const items = client.sent[1].input.TransactItems as unknown[];
    expect(items).toHaveLength(3);
  });

  it('topRuns queries the board partition ascending with the limit', async () => {
    const { client, repo } = setup();
    client.responses.push({ Items: [
      { pk: 'LB#story#t1', sk: '000000000500#a', ...run({ runId: 'a', mode: 'story', board: 't1', score: 500, masks: undefined as never }) },
      { pk: 'LB#story#t1', sk: '000000000600#b', ...run({ runId: 'b', mode: 'story', board: 't1', score: 600, masks: undefined as never }) },
    ] });
    const top = await repo.topRuns('story', 't1', 20);
    expect(client.sent[0].name).toBe(QueryCommand.name);
    const input = client.sent[0].input;
    expect(input.TableName).toBe(TABLE);
    expect(input.ScanIndexForward).toBe(true);
    expect(input.Limit).toBe(20);
    expect(input.KeyConditionExpression).toBe('pk = :pk');
    expect(input.ExpressionAttributeValues).toEqual({ ':pk': 'LB#story#t1' });
    expect(top.map((r) => r.runId)).toEqual(['a', 'b']);
    expect(top[0]).not.toHaveProperty('pk');
    expect(top[0].masks).toBe('');
  });

  it('rankOf issues two COUNT queries and sums pages', async () => {
    const { client, repo } = setup();
    client.responses.push(
      { Count: 3, LastEvaluatedKey: { pk: 'x', sk: 'y' } }, { Count: 2 },   // better, two pages
      { Count: 9 },                                                         // total
    );
    const r = await repo.rankOf('story', 't1', 700);
    expect(r).toEqual({ better: 5, total: 9 });
    expect(client.sent.map((s) => s.name)).toEqual([QueryCommand.name, QueryCommand.name, QueryCommand.name]);
    expect(client.sent[0].input).toMatchObject({
      TableName: TABLE, Select: 'COUNT', KeyConditionExpression: 'pk = :pk AND sk < :sk',
      ExpressionAttributeValues: { ':pk': 'LB#story#t1', ':sk': '000000000700' },
    });
    expect(client.sent[1].input.ExclusiveStartKey).toEqual({ pk: 'x', sk: 'y' });
    expect(client.sent[2].input).toMatchObject({ Select: 'COUNT', KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': 'LB#story#t1' } });
  });

  it('getRun and getPlayerBest read single items and return null when absent', async () => {
    const { client, repo } = setup();
    client.responses.push({}, { Item: { pk: 'PLAYER#p1', sk: 'BEST#daily#2026-09-06', ...run() } });
    expect(await repo.getRun('missing')).toBeNull();
    expect(client.sent[0].name).toBe(GetCommand.name);
    expect(client.sent[0].input).toMatchObject({ Key: { pk: 'RUN#missing', sk: 'META' } });
    const best = await repo.getPlayerBest('p1', 'daily', '2026-09-06');
    expect(client.sent[1].input).toMatchObject({ Key: { pk: 'PLAYER#p1', sk: 'BEST#daily#2026-09-06' } });
    expect(best).toMatchObject({ runId: 'run-new', score: 4321, playerId: 'p1' });
    expect(best).not.toHaveProperty('pk');
    expect(best).not.toHaveProperty('sk');
  });
});
