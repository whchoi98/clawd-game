import { describe, expect, it } from 'vitest';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { COUNTER_ATTR, DynamoRepo, KEY, SCORE_DIGITS, SEED_SK, SHARD_DIGITS, padScore, padShards } from '../../src/server/repo/dynamo.js';
import { isDuplicateReplay, isSaveConflict } from '../../src/server/repo/errors.js';
import { REPLACED_RUN_TTL_SECONDS } from '../../src/server/repo/ttl.js';
import type { StoredRun } from '../../src/server/repo/types.js';
import { FakeClient } from './fakeDynamo.js';

function run(over: Partial<StoredRun> = {}): StoredRun {
  return {
    runId: 'run-new', mode: 'daily', board: '2026-09-06', levelId: 'daily', seed: 42, assist: false, masks: 'QUJD',
    playerId: 'p1', name: '클로드', score: 4321, ticks: 4321, shards: 7, deaths: 1, cleared: true, height: 0,
    createdAt: '2026-09-06T12:00:00.000Z', ttl: 1_760_000_000, ...over,
  };
}

const HASH = 'ab'.repeat(32);
const HX = { ticks: 4321, edges: 40, edgesPerSec: 1.1, presses: 10, press1: 0, frameAligned: 1, dashJumps: 0, dashJumpPerfect: 0 };

type TxItem = Record<string, {
  TableName: string; Item?: Record<string, unknown>; Key?: Record<string, unknown>; ConditionExpression?: string;
  UpdateExpression?: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, unknown>;
}>;

const cancelled = (reasons?: string[]) => new TransactionCanceledException({
  message: 'cancelled', $metadata: {}, ...(reasons ? { CancellationReasons: reasons.map((Code) => ({ Code })) } : {}),
});
const conditionFailed = () => Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });

describe('key builders', () => {
  it('zero-pads scores to a fixed width so string order equals numeric order', () => {
    expect(SCORE_DIGITS).toBe(12);
    expect(padScore(45)).toBe('000000000045');
    expect(padScore(0)).toBe('000000000000');
    expect(padScore(1_000_099_999)).toBe('001000099999');
    expect(padScore(99) < padScore(100)).toBe(true);
    expect(padScore(999_999) < padScore(1_000_000_000)).toBe(true);
  });

  it('encodes shards descending (99999 - shards) so more shards sort first within a score', () => {
    expect(SHARD_DIGITS).toBe(5);
    expect(padShards(0)).toBe('99999');
    expect(padShards(7)).toBe('99992');
    expect(padShards(99_999)).toBe('00000');
    expect(padShards(1_000_000)).toBe('00000');
    expect(KEY.lbSk(100, 5, 'a') < KEY.lbSk(100, 2, 'a')).toBe(true);
    expect(KEY.lbSk(100, 5, 'a') < KEY.lbSk(101, 99, 'a')).toBe(true);
  });

  it('builds the spec §2.4 keys with the shard tiebreak in the LB sort key, plus HASH / SNAPSHOT / CODE', () => {
    expect(KEY.lbPk('story', 't1')).toBe('LB#story#t1#s4r1');
    expect(KEY.lbPk('daily', '2026-09-06')).toBe('LB#daily#2026-09-06');
    expect(KEY.lbSk(45, 7, 'abc')).toBe('000000000045#99992#abc');
    expect(KEY.runPk('abc')).toBe('RUN#abc');
    expect(KEY.RUN_SK).toBe('META');
    expect(KEY.playerPk('p1')).toBe('PLAYER#p1');
    expect(KEY.bestSk('daily', '2026-09-06')).toBe('BEST#daily#2026-09-06');
    expect(KEY.hashPk('story', 't1', HASH)).toBe(`HASH#story#t1#s4r1#${HASH}`);
    expect(KEY.hashPk('daily', '2026-09-06', HASH)).toBe(`HASH#daily#2026-09-06#${HASH}`);
    expect(KEY.HASH_SK).toBe('META');
    expect(KEY.SNAPSHOT_SK).toBe('SNAPSHOT');
    expect(KEY.codePk('ABCDEFGH')).toBe('CODE#ABCDEFGH');
    expect(KEY.CODE_SK).toBe('META');
    // P3-12 counters
    expect(KEY.boardPk('story', 't1')).toBe('BOARD#story#t1#s4r1');
    expect(KEY.boardPk('daily', '2026-09-06')).toBe('BOARD#daily#2026-09-06');
    expect(KEY.BOARD_SK).toBe('META');
    expect(KEY.ratePk('203.0.113.7', 29_800_000)).toBe('RL#203.0.113.7#29800000');
    expect(KEY.RATE_SK).toBe('META');
    expect(COUNTER_ATTR).toBe('n');
  });

  it('rankOf boundary: sk < padScore(s) selects exactly the strictly lower scores, whatever the shards', () => {
    expect(KEY.lbSk(99, 0, 'zzz') < padScore(100)).toBe(true);
    expect(KEY.lbSk(99, 99_999, 'zzz') < padScore(100)).toBe(true);
    expect(KEY.lbSk(100, 99_999, 'aaa') < padScore(100)).toBe(false);
    expect(KEY.lbSk(100, 0, 'aaa') > padScore(100)).toBe(true);
    expect(KEY.lbSk(101, 0, 'aaa') < padScore(100)).toBe(false);
  });
});

describe('DynamoRepo', () => {
  const TABLE = 'clawd-table';
  const setup = (now?: () => number) => { const client = new FakeClient(); return { client, repo: new DynamoRepo(client, TABLE, now ? { now } : {}) }; };

  it('saveBest writes RUN, LB and PLAYER items plus the BOARD counter step in one transaction (masks only on RUN, ttl everywhere for daily)', async () => {
    const { client, repo } = setup();
    await repo.saveBest(run());
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0].name).toBe(TransactWriteCommand.name);
    const items = client.sent[0].input.TransactItems as TxItem[];
    expect(items).toHaveLength(4);
    const puts = items.slice(0, 3).map((i) => i.Put!);
    expect(puts.every((p) => p.TableName === TABLE)).toBe(true);
    const [runItem, lbItem, playerItem] = puts.map((p) => p.Item!);
    expect(runItem).toMatchObject({ pk: 'RUN#run-new', sk: 'META', masks: 'QUJD', score: 4321, ttl: 1_760_000_000, playerId: 'p1' });
    expect(lbItem).toMatchObject({ pk: 'LB#daily#2026-09-06', sk: '000000004321#99992#run-new', runId: 'run-new', score: 4321, ttl: 1_760_000_000 });
    expect(lbItem).not.toHaveProperty('masks');
    expect(playerItem).toMatchObject({ pk: 'PLAYER#p1', sk: 'BEST#daily#2026-09-06', runId: 'run-new', score: 4321, ttl: 1_760_000_000 });
    expect(playerItem).not.toHaveProperty('masks');
    // P3-12: a first entry on the board steps BOARD#… up by one (creating it at 1); daily counters follow the run's ttl
    expect(items[3].Update).toEqual({
      TableName: TABLE,
      Key: { pk: 'BOARD#daily#2026-09-06', sk: 'META' },
      UpdateExpression: 'SET #ttl = :ttl ADD #n :d',
      ExpressionAttributeNames: { '#n': COUNTER_ATTR, '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':d': 1, ':ttl': 1_760_000_000 },
    });
    expect(items[3].Update!.ConditionExpression).toBeUndefined();
  });

  it('saveBest adds the HASH item with attribute_not_exists(pk) when the run carries a hash; daily HASH items carry the ttl', async () => {
    const { client, repo } = setup();
    await repo.saveBest(run({ hash: HASH, hx: HX }));
    const items = client.sent[0].input.TransactItems as TxItem[];
    expect(items).toHaveLength(5);
    const hashPut = items[3].Put!;
    expect(hashPut.TableName).toBe(TABLE);
    expect(hashPut.ConditionExpression).toBe('attribute_not_exists(pk)');
    expect(hashPut.Item).toEqual({
      pk: `HASH#daily#2026-09-06#${HASH}`, sk: 'META', runId: 'run-new', playerId: 'p1', createdAt: '2026-09-06T12:00:00.000Z', ttl: 1_760_000_000,
    });
    // hash is projected onto LB and PLAYER (the service compares it with the best it read); hx and flagged stay on RUN
    expect(items[0].Put!.Item).toMatchObject({ hash: HASH, hx: HX });
    expect(items[1].Put!.Item).toMatchObject({ hash: HASH });
    expect(items[1].Put!.Item).not.toHaveProperty('hx');
    expect(items[2].Put!.Item).toMatchObject({ hash: HASH });
    expect(items[2].Put!.Item).not.toHaveProperty('hx');
  });

  it('a story HASH item has no ttl', async () => {
    const { client, repo } = setup();
    await repo.saveBest(run({ mode: 'story', board: 't1', levelId: 't1', ttl: undefined, hash: HASH }));
    const items = client.sent[0].input.TransactItems as TxItem[];
    expect(items[3].Put!.Item).toEqual({ pk: `HASH#story#t1#s4r1#${HASH}`, sk: 'META', runId: 'run-new', playerId: 'p1', createdAt: '2026-09-06T12:00:00.000Z' });
  });

  it('saveBest without a previous best guards the PLAYER item with attribute_not_exists(runId)', async () => {
    const { client, repo } = setup();
    await repo.saveBest(run());
    const items = client.sent[0].input.TransactItems as TxItem[];
    expect(items[0].Put!.ConditionExpression).toBeUndefined();
    expect(items[1].Put!.ConditionExpression).toBeUndefined();
    expect(items[2].Put!.ConditionExpression).toBe('attribute_not_exists(runId)');
    expect(items[2].Put!.ExpressionAttributeValues).toBeUndefined();
  });

  it('saveBest with a previous best requires the PLAYER item to still name it (runId = :prev)', async () => {
    const { client, repo } = setup();
    client.responses.push({ Item: { pk: 'RUN#run-old', sk: 'META', ...run({ runId: 'run-old', score: 5000, ticks: 5000 }) } }, {});
    await repo.saveBest(run(), 'run-old');
    const items = client.sent[1].input.TransactItems as TxItem[];
    expect(items[2].Put!.Item!.pk).toBe('PLAYER#p1');
    expect(items[2].Put!.ConditionExpression).toBe('runId = :prev');
    expect(items[2].Put!.ExpressionAttributeValues).toEqual({ ':prev': 'run-old' });
  });

  it('saveBest omits ttl for story runs and never sends undefined attributes', async () => {
    const { client, repo } = setup();
    await repo.saveBest(run({ mode: 'story', board: 't1', levelId: 't1', ttl: undefined }));
    const items = client.sent[0].input.TransactItems as TxItem[];
    expect(items).toHaveLength(4);
    for (const { Put } of items.slice(0, 3)) {
      expect(Put!.Item).not.toHaveProperty('ttl');
      expect(Object.values(Put!.Item!).some((v) => v === undefined)).toBe(false);
    }
    // a story board counter never expires
    expect(items[3].Update).toEqual({
      TableName: TABLE,
      Key: { pk: 'BOARD#story#t1#s4r1', sk: 'META' },
      UpdateExpression: 'ADD #n :d',
      ExpressionAttributeNames: { '#n': COUNTER_ATTR },
      ExpressionAttributeValues: { ':d': 1 },
    });
  });

  it('saveBest that replaces a previous best leaves the BOARD counter alone (the board did not grow)', async () => {
    const { client, repo } = setup();
    client.responses.push({ Item: { pk: 'RUN#run-old', sk: 'META', ...run({ runId: 'run-old', score: 5000, ticks: 5000 }) } }, {});
    await repo.saveBest(run(), 'run-old');
    const items = client.sent[1].input.TransactItems as TxItem[];
    expect(items.some((i) => i.Update?.Key?.pk === 'BOARD#daily#2026-09-06')).toBe(false);
  });

  it('saveBest deletes the previous board entry, rebuilding its sort key (score and shards) from the RUN item', async () => {
    const { client, repo } = setup();
    client.responses.push({ Item: { pk: 'RUN#run-old', sk: 'META', ...run({ runId: 'run-old', score: 5000, ticks: 5000, shards: 12 }) } }, {});
    await repo.saveBest(run(), 'run-old');
    expect(client.sent.map((s) => s.name)).toEqual([GetCommand.name, TransactWriteCommand.name]);
    expect(client.sent[0].input).toMatchObject({ TableName: TABLE, Key: { pk: 'RUN#run-old', sk: 'META' } });
    const items = client.sent[1].input.TransactItems as TxItem[];
    // daily: the old RUN already has a ttl, so no Update follows the Delete
    expect(items).toHaveLength(4);
    expect(items[3].Delete).toEqual({ TableName: TABLE, Key: { pk: 'LB#daily#2026-09-06', sk: '000000005000#99987#run-old' } });
  });

  it('saveBest gives a replaced story RUN a 90-day ttl (Update in the same transaction, from the new best\'s createdAt)', async () => {
    const { client, repo } = setup();
    const story = { mode: 'story' as const, board: 't1', levelId: 't1', ttl: undefined };
    client.responses.push({ Item: { pk: 'RUN#run-old', sk: 'META', ...run({ ...story, runId: 'run-old', score: 5000, ticks: 5000 }) } }, {});
    await repo.saveBest(run({ ...story, hash: HASH }), 'run-old');
    const items = client.sent[1].input.TransactItems as TxItem[];
    expect(items).toHaveLength(6);
    expect(items[4].Delete!.Key).toEqual({ pk: 'LB#story#t1#s4r1', sk: '000000005000#99992#run-old' });
    expect(items[5].Update).toEqual({
      TableName: TABLE,
      Key: { pk: 'RUN#run-old', sk: 'META' },
      UpdateExpression: 'SET #ttl = :ttl',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeNames: { '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':ttl': Math.floor(Date.parse('2026-09-06T12:00:00.000Z') / 1000) + REPLACED_RUN_TTL_SECONDS },
    });
    expect(REPLACED_RUN_TTL_SECONDS).toBe(90 * 86_400);
  });

  it('saveBest skips the delete when the previous run is gone (expired) but keeps the guard', async () => {
    const { client, repo } = setup();
    client.responses.push({}, {});
    await repo.saveBest(run(), 'run-old');
    const items = client.sent[1].input.TransactItems as TxItem[];
    expect(items).toHaveLength(3);
    expect(items[2].Put!.ConditionExpression).toBe('runId = :prev');
  });

  it('saveBest surfaces the store\'s refusal untouched', async () => {
    const { client, repo } = setup();
    client.responses.push(Object.assign(new Error('cancelled'), { name: 'TransactionCanceledException' }));
    await expect(repo.saveBest(run())).rejects.toMatchObject({ name: 'TransactionCanceledException' });
  });

  describe('duplicate replay (HASH condition)', () => {
    it('a transaction cancelled at the HASH item reads the owner and throws DuplicateReplayError', async () => {
      const { client, repo } = setup();
      client.responses.push(cancelled(['None', 'None', 'None', 'ConditionalCheckFailed']), { Item: { pk: 'HASH#…', sk: 'META', runId: 'run-a', playerId: 'p9' } });
      const err = await repo.saveBest(run({ hash: HASH })).catch((e: unknown) => e);
      expect(isDuplicateReplay(err)).toBe(true);
      expect(err).toMatchObject({ runId: 'run-a', playerId: 'p9' });
      expect(client.sent.map((s) => s.name)).toEqual([TransactWriteCommand.name, GetCommand.name]);
      expect(client.sent[1].input.Key).toEqual({ pk: `HASH#daily#2026-09-06#${HASH}`, sk: 'META' });
    });

    it('a cancelled PLAYER guard (or a cancellation without reasons) stays a save conflict', async () => {
      const { client, repo } = setup();
      client.responses.push(cancelled(['None', 'None', 'ConditionalCheckFailed', 'None']));
      await expect(repo.saveBest(run({ hash: HASH }))).rejects.toSatisfy(isSaveConflict);
      client.responses.push(cancelled());
      await expect(repo.saveBest(run({ hash: HASH }))).rejects.toSatisfy(isSaveConflict);
      // without a hash there is no HASH item to blame, whatever the reasons say
      client.responses.push(cancelled(['None', 'None', 'None', 'ConditionalCheckFailed']));
      await expect(repo.saveBest(run())).rejects.toSatisfy(isSaveConflict);
    });

    it('both guards failing at once is reported as the duplicate (the owner decides same-player vs. thief)', async () => {
      const { client, repo } = setup();
      client.responses.push(cancelled(['None', 'None', 'ConditionalCheckFailed', 'ConditionalCheckFailed']), {});
      const err = await repo.saveBest(run({ hash: HASH })).catch((e: unknown) => e);
      expect(isDuplicateReplay(err)).toBe(true);
      expect(err).toMatchObject({ runId: undefined, playerId: undefined });
    });
  });

  it('topRuns queries the board partition ascending with the limit', async () => {
    const { client, repo } = setup();
    client.responses.push({ Items: [
      { pk: 'LB#story#t1#s4r1', sk: '000000000500#99992#a', ...run({ runId: 'a', mode: 'story', board: 't1', score: 500, masks: undefined as never }) },
      { pk: 'LB#story#t1#s4r1', sk: '000000000600#99992#b', ...run({ runId: 'b', mode: 'story', board: 't1', score: 600, masks: undefined as never }) },
    ] });
    const top = await repo.topRuns('story', 't1', 20);
    expect(client.sent[0].name).toBe(QueryCommand.name);
    const input = client.sent[0].input;
    expect(input.TableName).toBe(TABLE);
    expect(input.ScanIndexForward).toBe(true);
    expect(input.Limit).toBe(20);
    // bounded below the seeding sentinel ('SEED' sorts after every digit-prefixed entry key)
    expect(input.KeyConditionExpression).toBe('pk = :pk AND sk < :end');
    expect(input.ExpressionAttributeValues).toEqual({ ':pk': 'LB#story#t1#s4r1', ':end': SEED_SK });
    expect(KEY.lbSk(999_999_999_999, 0, 'zzz') < SEED_SK).toBe(true);
    expect(top.map((r) => r.runId)).toEqual(['a', 'b']);
    expect(top[0]).not.toHaveProperty('pk');
    expect(top[0].masks).toBe('');
  });

  it('rankOf issues two COUNT queries (strictly better, total) and sums pages', async () => {
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
      ExpressionAttributeValues: { ':pk': 'LB#story#t1#s4r1', ':sk': '000000000700' },
    });
    expect(client.sent[1].input.ExclusiveStartKey).toEqual({ pk: 'x', sk: 'y' });
    expect(client.sent[2].input).toMatchObject({
      Select: 'COUNT', KeyConditionExpression: 'pk = :pk AND sk < :end', ExpressionAttributeValues: { ':pk': 'LB#story#t1#s4r1', ':end': SEED_SK },
    });
  });

  describe('P3-12 extras', () => {
    it('boardTotal reads the BOARD counter with one GetItem (clamped at zero)', async () => {
      const { client, repo } = setup();
      client.responses.push({ Item: { pk: 'BOARD#story#t1#s4r1', sk: 'META', n: 42 } });
      expect(await repo.boardTotal('story', 't1')).toBe(42);
      expect(client.sent.map((s) => s.name)).toEqual([GetCommand.name]);
      expect(client.sent[0].input).toEqual({ TableName: TABLE, Key: { pk: 'BOARD#story#t1#s4r1', sk: 'META' } });
      client.responses.push({ Item: { n: -3 } });
      expect(await repo.boardTotal('story', 't1')).toBe(0);
    });

    it('boardTotal falls back to a COUNT for a board without a counter and backfills it guarded by attribute_not_exists(pk)', async () => {
      const { client, repo } = setup(() => Date.parse('2026-09-06T12:00:00.000Z'));
      client.responses.push({}, { Count: 7, LastEvaluatedKey: { pk: 'x', sk: 'y' } }, { Count: 2 }, {});
      expect(await repo.boardTotal('daily', '2026-09-06')).toBe(9);
      expect(client.sent.map((s) => s.name)).toEqual([GetCommand.name, QueryCommand.name, QueryCommand.name, PutCommand.name]);
      expect(client.sent[1].input).toMatchObject({
        Select: 'COUNT', KeyConditionExpression: 'pk = :pk AND sk < :end', ExpressionAttributeValues: { ':pk': 'LB#daily#2026-09-06', ':end': SEED_SK },
      });
      expect(client.sent[3].input).toEqual({
        TableName: TABLE,
        Item: { pk: 'BOARD#daily#2026-09-06', sk: 'META', n: 9, ttl: Math.floor(Date.parse('2026-09-06T12:00:00.000Z') / 1000) + 31 * 86_400 },
        ConditionExpression: 'attribute_not_exists(pk)',
      });
      // story counters have no ttl; a concurrent first entry that created the item first wins the race silently
      client.responses.push({}, { Count: 3 }, conditionFailed());
      expect(await repo.boardTotal('story', 't1')).toBe(3);
      expect(client.sent[6].input).toEqual({ TableName: TABLE, Item: { pk: 'BOARD#story#t1#s4r1', sk: 'META', n: 3 }, ConditionExpression: 'attribute_not_exists(pk)' });
      // other write errors surface
      client.responses.push({}, { Count: 3 }, Object.assign(new Error('boom'), { name: 'InternalServerError' }));
      await expect(repo.boardTotal('story', 't1')).rejects.toThrow('boom');
    });

    it('rankBounded issues one COUNT with Limit = cap and reports capped when a page remains', async () => {
      const { client, repo } = setup();
      client.responses.push({ Count: 12 });
      expect(await repo.rankBounded('story', 't1', 700, 1000)).toEqual({ better: 12, capped: false });
      expect(client.sent[0].input).toMatchObject({
        TableName: TABLE, Select: 'COUNT', Limit: 1000, KeyConditionExpression: 'pk = :pk AND sk < :sk',
        ExpressionAttributeValues: { ':pk': 'LB#story#t1#s4r1', ':sk': '000000000700' },
      });
      client.responses.push({ Count: 1000, LastEvaluatedKey: { pk: 'x', sk: 'y' } });
      expect(await repo.rankBounded('story', 't1', 700, 1000)).toEqual({ better: 1000, capped: true });
      expect(client.sent).toHaveLength(2);
    });

    it('hitRateCounter is one UpdateItem ADD on RL#<ip>#<minute> that sets the ttl only on creation and returns the new count', async () => {
      const { client, repo } = setup();
      client.responses.push({ Attributes: { n: 5 } });
      expect(await repo.hitRateCounter('203.0.113.7', 29_800_000, 1_788_000_120)).toBe(5);
      expect(client.sent.map((s) => s.name)).toEqual([UpdateCommand.name]);
      expect(client.sent[0].input).toEqual({
        TableName: TABLE,
        Key: { pk: 'RL#203.0.113.7#29800000', sk: 'META' },
        UpdateExpression: 'SET #ttl = if_not_exists(#ttl, :ttl) ADD #n :one',
        ExpressionAttributeNames: { '#n': COUNTER_ATTR, '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':one': 1, ':ttl': 1_788_000_120 },
        ReturnValues: 'UPDATED_NEW',
      });
      // a response without attributes counts as the first hit
      client.responses.push({});
      expect(await repo.hitRateCounter('203.0.113.7', 29_800_000, 1_788_000_120)).toBe(1);
    });
  });

  describe('putIfBoardEmpty (board seeding)', () => {
    const seed = (over: Partial<StoredRun> = {}) => run({ runId: 'goal-t1-s4r1', mode: 'story', board: 't1', levelId: 't1', playerId: 'developer-goal-echo-0001', name: '개발자', score: 857, ticks: 857, shards: 8, deaths: 0, ttl: undefined, ...over });

    it('counts the board first and writes nothing when it has entries', async () => {
      const { client, repo } = setup();
      client.responses.push({ Count: 3 });
      expect(await repo.putIfBoardEmpty(seed())).toBe(false);
      expect(client.sent.map((s) => s.name)).toEqual([QueryCommand.name]);
      expect(client.sent[0].input).toMatchObject({
        TableName: TABLE, Select: 'COUNT', KeyConditionExpression: 'pk = :pk AND sk < :end',
        ExpressionAttributeValues: { ':pk': 'LB#story#t1#s4r1', ':end': SEED_SK },
      });
    });

    it('on an empty board writes the sentinel (guarded by attribute_not_exists(pk)) with the RUN, LB, PLAYER items and the BOARD counter in one transaction', async () => {
      const { client, repo } = setup();
      client.responses.push({ Count: 0 }, {});
      expect(await repo.putIfBoardEmpty(seed())).toBe(true);
      expect(client.sent.map((s) => s.name)).toEqual([QueryCommand.name, TransactWriteCommand.name]);
      const items = client.sent[1].input.TransactItems as TxItem[];
      expect(items).toHaveLength(5);
      expect(items[4].Update).toMatchObject({ Key: { pk: 'BOARD#story#t1#s4r1', sk: 'META' }, UpdateExpression: 'ADD #n :d', ExpressionAttributeValues: { ':d': 1 } });
      const [sentinel, runItem, lbItem, playerItem] = items.slice(0, 4).map((i) => i.Put!);
      expect(sentinel.TableName).toBe(TABLE);
      expect(sentinel.Item).toMatchObject({ pk: 'LB#story#t1#s4r1', sk: SEED_SK, runId: 'goal-t1-s4r1', playerId: 'developer-goal-echo-0001' });
      expect(sentinel.Item).not.toHaveProperty('masks');
      expect(sentinel.ConditionExpression).toBe('attribute_not_exists(pk)');
      expect(runItem.Item).toMatchObject({ pk: 'RUN#goal-t1-s4r1', sk: 'META', masks: 'QUJD', name: '개발자', score: 857 });
      expect(lbItem.Item).toMatchObject({ pk: 'LB#story#t1#s4r1', sk: '000000000857#99991#goal-t1-s4r1', runId: 'goal-t1-s4r1' });
      expect(lbItem.Item).not.toHaveProperty('masks');
      expect(lbItem.Item!.sk as string < SEED_SK).toBe(true);
      expect(playerItem.Item).toMatchObject({ pk: 'PLAYER#developer-goal-echo-0001', sk: 'BEST#story#t1#s4r1', runId: 'goal-t1-s4r1' });
      expect(playerItem.ConditionExpression).toBe('attribute_not_exists(runId)');
      for (const { Put } of items.slice(0, 4)) expect(Object.values(Put!.Item!).some((v) => v === undefined)).toBe(false);
    });

    it('a seed run with a hash also writes the HASH item, so the public goal replay cannot be submitted as a player\'s own', async () => {
      const { client, repo } = setup();
      client.responses.push({ Count: 0 }, {});
      expect(await repo.putIfBoardEmpty(seed({ hash: HASH }))).toBe(true);
      const items = client.sent[1].input.TransactItems as TxItem[];
      expect(items).toHaveLength(6);
      expect(items[4].Put!.ConditionExpression).toBe('attribute_not_exists(pk)');
      expect(items[4].Put!.Item).toEqual({ pk: `HASH#story#t1#s4r1#${HASH}`, sk: 'META', runId: 'goal-t1-s4r1', playerId: 'developer-goal-echo-0001', createdAt: '2026-09-06T12:00:00.000Z' });
    });

    it('returns false when another task won the race (the sentinel condition cancels the transaction)', async () => {
      const { client, repo } = setup();
      client.responses.push({ Count: 0 }, Object.assign(new Error('cancelled'), { name: 'TransactionCanceledException' }));
      expect(await repo.putIfBoardEmpty(seed())).toBe(false);
      expect(client.sent).toHaveLength(2);
    });

    it('surfaces other store errors', async () => {
      const { client, repo } = setup();
      client.responses.push({ Count: 0 }, Object.assign(new Error('boom'), { name: 'ProvisionedThroughputExceededException' }));
      await expect(repo.putIfBoardEmpty(seed())).rejects.toThrow('boom');
    });
  });

  it('getRun and getPlayerBest read single items and return null when absent; RUN-only fields come back', async () => {
    const { client, repo } = setup();
    client.responses.push({}, { Item: { pk: 'PLAYER#p1', sk: 'BEST#daily#2026-09-06', ...run() } }, { Item: { pk: 'RUN#r', sk: 'META', ...run({ hash: HASH, hx: HX, flagged: true }) } });
    expect(await repo.getRun('missing')).toBeNull();
    expect(client.sent[0].name).toBe(GetCommand.name);
    expect(client.sent[0].input).toMatchObject({ Key: { pk: 'RUN#missing', sk: 'META' } });
    const best = await repo.getPlayerBest('p1', 'daily', '2026-09-06');
    expect(client.sent[1].input).toMatchObject({ Key: { pk: 'PLAYER#p1', sk: 'BEST#daily#2026-09-06' } });
    expect(best).toMatchObject({ runId: 'run-new', score: 4321, playerId: 'p1' });
    expect(best).not.toHaveProperty('pk');
    expect(best).not.toHaveProperty('sk');
    const full = await repo.getRun('r');
    expect(full).toMatchObject({ hash: HASH, hx: HX, flagged: true });
  });

  describe('transfer snapshots', () => {
    it('putSnapshot writes the SNAPSHOT and CODE items in one transaction and retires the previous code', async () => {
      const { client, repo } = setup();
      client.responses.push({}, {});
      await repo.putSnapshot('p1', 'ABCDEFGH', '{"a":1}', 1_760_600_000);
      expect(client.sent.map((s) => s.name)).toEqual([GetCommand.name, TransactWriteCommand.name]);
      expect(client.sent[0].input).toMatchObject({ Key: { pk: 'PLAYER#p1', sk: 'SNAPSHOT' }, ProjectionExpression: 'code' });
      const items = client.sent[1].input.TransactItems as TxItem[];
      expect(items).toHaveLength(2);
      expect(items[0].Put).toEqual({ TableName: TABLE, Item: { pk: 'PLAYER#p1', sk: 'SNAPSHOT', code: 'ABCDEFGH', blob: '{"a":1}', ttl: 1_760_600_000 } });
      expect(items[1].Put).toEqual({ TableName: TABLE, Item: { pk: 'CODE#ABCDEFGH', sk: 'META', playerId: 'p1', ttl: 1_760_600_000 } });

      client.responses.push({ Item: { code: 'OLDCODE1' } }, {});
      await repo.putSnapshot('p1', 'NEWCODE2', '{"a":2}', 1_760_600_000);
      const again = client.sent[3].input.TransactItems as TxItem[];
      expect(again).toHaveLength(3);
      expect(again[2].Delete).toEqual({ TableName: TABLE, Key: { pk: 'CODE#OLDCODE1', sk: 'META' } });
    });

    it('takeSnapshot reads both items consistently before consuming them in a conditional transaction', async () => {
      const { client, repo } = setup(() => 1_760_000_000_000);
      client.responses.push(
        { Item: { pk: 'CODE#ABCDEFGH', sk: 'META', playerId: 'p1', ttl: 1_760_600_000 } },
        { Item: { pk: 'PLAYER#p1', sk: 'SNAPSHOT', code: 'ABCDEFGH', blob: '{"a":1}', ttl: 1_760_600_000 } },
        {},
      );
      expect(await repo.takeSnapshot('ABCDEFGH')).toEqual({ playerId: 'p1', blob: '{"a":1}' });
      expect(client.sent.map((s) => s.name)).toEqual([GetCommand.name, GetCommand.name, TransactWriteCommand.name]);
      expect(client.sent[0].input).toEqual({
        TableName: TABLE, Key: { pk: 'CODE#ABCDEFGH', sk: 'META' }, ConsistentRead: true,
      });
      expect(client.sent[1].input).toEqual({
        TableName: TABLE, Key: { pk: 'PLAYER#p1', sk: 'SNAPSHOT' }, ConsistentRead: true,
      });
      const items = client.sent[2].input.TransactItems as TxItem[];
      expect(items).toHaveLength(2);
      expect(items[0].Delete).toEqual({
        TableName: TABLE, Key: { pk: 'CODE#ABCDEFGH', sk: 'META' },
        ConditionExpression: 'playerId = :playerId AND #ttl = :ttl AND #ttl > :now',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':playerId': 'p1', ':ttl': 1_760_600_000, ':now': 1_760_000_000 },
      });
      expect(items[1].Delete).toEqual({
        TableName: TABLE, Key: { pk: 'PLAYER#p1', sk: 'SNAPSHOT' },
        ConditionExpression: 'code = :code AND #blob = :blob AND #ttl = :ttl AND #ttl > :now',
        ExpressionAttributeNames: { '#blob': 'blob', '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':code': 'ABCDEFGH', ':blob': '{"a":1}', ':ttl': 1_760_600_000, ':now': 1_760_000_000 },
      });
    });

    it('takeSnapshot is null without writing for an unknown / used code, an expired code, or a snapshot that moved on', async () => {
      const { client, repo } = setup(() => 1_760_000_000_000);
      client.responses.push({});
      expect(await repo.takeSnapshot('ABCDEFGH')).toBeNull();
      expect(client.sent).toHaveLength(1);
      // expired (TTL deletion is lazy)
      client.responses.push({ Item: { playerId: 'p1', ttl: 1_759_000_000 } });
      expect(await repo.takeSnapshot('ABCDEFGH')).toBeNull();
      expect(client.sent).toHaveLength(2);
      // the player made a newer code: the snapshot no longer belongs to this one
      client.responses.push({ Item: { playerId: 'p1', ttl: 1_760_600_000 } }, { Item: { code: 'NEWCODE2', blob: '{}', ttl: 1_760_600_000 } });
      expect(await repo.takeSnapshot('ABCDEFGH')).toBeNull();
      expect(client.sent).toHaveLength(4);
      expect(client.sent.every((s) => s.name === GetCommand.name)).toBe(true);
      // other store errors surface
      client.responses.push(Object.assign(new Error('boom'), { name: 'ProvisionedThroughputExceededException' }));
      await expect(repo.takeSnapshot('ABCDEFGH')).rejects.toThrow('boom');
    });

    it('a failed snapshot read leaves the code available for retry', async () => {
      const { client, repo } = setup(() => 1_760_000_000_000);
      const meta = { playerId: 'p1', ttl: 1_760_600_000 };
      // Return both shapes so the old destructive implementation reaches the failing read too.
      client.responses.push({ Item: meta, Attributes: meta }, new Error('read unavailable'));
      await expect(repo.takeSnapshot('ABCDEFGH')).rejects.toThrow('read unavailable');
      expect(client.sent.map((s) => s.name)).toEqual([GetCommand.name, GetCommand.name]);
      client.responses.push({ Item: meta }, { Item: { code: 'ABCDEFGH', blob: '{"a":1}', ttl: meta.ttl } }, {});
      await expect(repo.takeSnapshot('ABCDEFGH')).resolves.toEqual({ playerId: 'p1', blob: '{"a":1}' });
    });

    it.each([
      ['ConditionalCheckFailed', 'None'],
      ['None', 'ConditionalCheckFailed'],
    ])('refuses a concurrent consume or replacement atomically (%s, %s)', async (first, second) => {
      const { client, repo } = setup(() => 1_760_000_000_000);
      client.responses.push(
        { Item: { playerId: 'p1', ttl: 1_760_600_000 } },
        { Item: { code: 'ABCDEFGH', blob: '{"a":1}', ttl: 1_760_600_000 } },
        cancelled([first, second]),
      );
      expect(await repo.takeSnapshot('ABCDEFGH')).toBeNull();
      expect(client.sent.map((s) => s.name)).toEqual([GetCommand.name, GetCommand.name, TransactWriteCommand.name]);
    });

    it('propagates transient transaction failures instead of reporting the code as gone', async () => {
      const { client, repo } = setup(() => 1_760_000_000_000);
      const err = cancelled(['ProvisionedThroughputExceeded', 'None']);
      client.responses.push(
        { Item: { playerId: 'p1', ttl: 1_760_600_000 } },
        { Item: { code: 'ABCDEFGH', blob: '{"a":1}', ttl: 1_760_600_000 } },
        err,
      );
      await expect(repo.takeSnapshot('ABCDEFGH')).rejects.toBe(err);
    });
  });

  describe('admin', () => {
    const story = run({ runId: 'run-x', mode: 'story', board: 't1', levelId: 't1', ttl: undefined, score: 700, shards: 3, playerId: 'p1' });

    it('delistRun flags the RUN, deletes the LB row and the PLAYER best (when it is this run) in one transaction, then steps the BOARD counter down', async () => {
      const { client, repo } = setup();
      client.responses.push({ Item: { pk: 'RUN#run-x', sk: 'META', ...story } }, { Item: { pk: 'PLAYER#p1', sk: 'BEST#story#t1#s4r1', ...story, masks: undefined as never } }, {}, {});
      expect(await repo.delistRun('run-x')).toBe(true);
      expect(client.sent.map((s) => s.name)).toEqual([GetCommand.name, GetCommand.name, TransactWriteCommand.name, UpdateCommand.name]);
      // the decrement never creates the counter or takes it below zero (a board without one stays on the COUNT fallback)
      expect(client.sent[3].input).toEqual({
        TableName: TABLE, Key: { pk: 'BOARD#story#t1#s4r1', sk: 'META' }, UpdateExpression: 'ADD #n :d',
        ConditionExpression: 'attribute_exists(pk) AND #n > :zero', ExpressionAttributeNames: { '#n': COUNTER_ATTR }, ExpressionAttributeValues: { ':d': -1, ':zero': 0 },
      });
      const items = client.sent[2].input.TransactItems as TxItem[];
      expect(items).toHaveLength(3);
      expect(items[0].Update).toEqual({
        TableName: TABLE, Key: { pk: 'RUN#run-x', sk: 'META' }, UpdateExpression: 'SET flagged = :t',
        ConditionExpression: 'attribute_exists(pk)', ExpressionAttributeValues: { ':t': true },
      });
      expect(items[1].Delete).toEqual({ TableName: TABLE, Key: { pk: 'LB#story#t1#s4r1', sk: KEY.lbSk(700, 3, 'run-x') } });
      expect(items[2].Delete).toEqual({
        TableName: TABLE, Key: { pk: 'PLAYER#p1', sk: 'BEST#story#t1#s4r1' }, ConditionExpression: 'runId = :rid', ExpressionAttributeValues: { ':rid': 'run-x' },
      });
    });

    it('delistRun leaves a newer PLAYER best (and the BOARD counter) alone and is false for an unknown run', async () => {
      const { client, repo } = setup();
      client.responses.push({ Item: { pk: 'RUN#run-x', sk: 'META', ...story } }, { Item: { ...story, runId: 'run-newer' } }, {});
      expect(await repo.delistRun('run-x')).toBe(true);
      expect(client.sent[2].input.TransactItems).toHaveLength(2);
      expect(client.sent.map((s) => s.name)).not.toContain(UpdateCommand.name);
      client.responses.push({});
      expect(await repo.delistRun('nope')).toBe(false);
      expect(client.sent).toHaveLength(4);
    });

    it('delistRun swallows a refused decrement (counter absent or already zero) and surfaces other errors', async () => {
      const { client, repo } = setup();
      client.responses.push({ Item: { pk: 'RUN#run-x', sk: 'META', ...story } }, { Item: { ...story } }, {}, conditionFailed());
      expect(await repo.delistRun('run-x')).toBe(true);
      client.responses.push({ Item: { pk: 'RUN#run-x', sk: 'META', ...story } }, { Item: { ...story } }, {}, Object.assign(new Error('boom'), { name: 'InternalServerError' }));
      await expect(repo.delistRun('run-x')).rejects.toThrow('boom');
    });

    it('renameRun updates the RUN and, while it is the best, the LB and PLAYER projections', async () => {
      const { client, repo } = setup();
      client.responses.push({ Item: { pk: 'RUN#run-x', sk: 'META', ...story } }, { Item: { ...story } }, {});
      expect(await repo.renameRun('run-x', '플레이어')).toBe(true);
      const items = client.sent[2].input.TransactItems as TxItem[];
      expect(items).toHaveLength(3);
      for (const it of items) {
        expect(it.Update).toMatchObject({
          TableName: TABLE, UpdateExpression: 'SET #n = :name', ConditionExpression: 'attribute_exists(pk)',
          ExpressionAttributeNames: { '#n': 'name' }, ExpressionAttributeValues: { ':name': '플레이어' },
        });
      }
      expect(items.map((i) => i.Update!.Key)).toEqual([
        { pk: 'RUN#run-x', sk: 'META' },
        { pk: 'LB#story#t1#s4r1', sk: KEY.lbSk(700, 3, 'run-x') },
        { pk: 'PLAYER#p1', sk: 'BEST#story#t1#s4r1' },
      ]);
      // off the board (replaced): only the RUN is renamed
      client.responses.push({ Item: { pk: 'RUN#run-x', sk: 'META', ...story } }, { Item: { ...story, runId: 'run-newer' } }, {});
      expect(await repo.renameRun('run-x', '플레이어')).toBe(true);
      expect(client.sent[5].input.TransactItems).toHaveLength(1);
      client.responses.push({});
      expect(await repo.renameRun('nope', 'x')).toBe(false);
    });
  });
});
