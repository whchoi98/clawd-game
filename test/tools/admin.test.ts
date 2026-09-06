/**
 * tools/admin.mjs — delist / rename / export-board against an injected repo
 * (MemoryRepo here, DynamoRepo via TABLE_NAME in production) and ban-name
 * against the blocklist file. The command line is exercised through tsx, the
 * way `npm run admin` runs it.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isBadName, parseBlocklist } from '../../src/shared/names.js';
import { MemoryRepo } from '../../src/server/repo/memory.js';
import type { StoredRun } from '../../src/server/repo/types.js';
import {
  COMMANDS, DEFAULT_BLOCKLIST, DEFAULT_LIMIT, USAGE, appendBanned, exportBoard, parseArgs, runAdmin, validName,
} from '../../tools/admin.mjs';
import { makeApp } from '../server/fixtures.js';

vi.mock('../../src/server/levels.js', async () => ({ resolveLevel: (await import('../server/levelfix.js')).fakeResolveLevel }));

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const SCRIPT = join(ROOT, 'tools', 'admin.mjs');
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const SCRATCH = '/tmp/claude-1000/-home-ec2-user-my-project-clawd-game/f8aa643c-bc48-400a-8c09-d71da38a73d7/scratchpad';

function run(over: Partial<StoredRun>): StoredRun {
  return {
    runId: 'r1', mode: 'story', board: 't1', levelId: 't1', seed: 1, assist: false, masks: 'AAA=',
    playerId: 'p1', name: 'P1', score: 100, ticks: 100, shards: 0, deaths: 0, cleared: true, height: 0,
    createdAt: '2026-09-06T00:00:00.000Z', ...over,
  };
}

/** A repo with three runs on t1 (a < b < c), one on t2. */
async function seeded() {
  const repo = new MemoryRepo();
  await repo.saveBest(run({ runId: 'a', playerId: 'p1', name: '일등', score: 500, hash: 'a'.repeat(64), hx: { ticks: 500, edges: 20, edgesPerSec: 4.8, presses: 6, press1: 0, frameAligned: 1, dashJumps: 0, dashJumpPerfect: 0 } }));
  await repo.saveBest(run({ runId: 'b', playerId: 'p2', name: '씨발놈', score: 600, hash: 'b'.repeat(64) }));
  await repo.saveBest(run({ runId: 'c', playerId: 'p3', name: '삼등', score: 700 }));
  await repo.saveBest(run({ runId: 'd', playerId: 'p1', board: 't2', levelId: 't2', name: '일등', score: 900 }));
  return repo;
}

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, ctx: { out: (l: string) => { out.push(l); }, err: (l: string) => { err.push(l); }, now: () => new Date('2026-09-06T12:00:00.000Z') } };
}

describe('tools/admin.mjs', () => {
  describe('parseArgs', () => {
    it('reads the command, its arguments and the options', () => {
      expect(COMMANDS).toEqual(['delist', 'rename', 'ban-name', 'export-board']);
      expect(parseArgs(['delist', 'run-1'])).toMatchObject({ command: 'delist', args: ['run-1'], file: DEFAULT_BLOCKLIST, limit: DEFAULT_LIMIT, errors: [] });
      expect(parseArgs(['rename', 'run-1', '플레이어'])).toMatchObject({ command: 'rename', args: ['run-1', '플레이어'], errors: [] });
      expect(parseArgs(['ban-name', 'zorblax', '--file', '/tmp/x.json'])).toMatchObject({ command: 'ban-name', args: ['zorblax'], file: '/tmp/x.json', errors: [] });
      expect(parseArgs(['export-board', 'story', 't1', '--limit', '7'])).toMatchObject({ command: 'export-board', args: ['story', 't1'], limit: 7, errors: [] });
      expect(parseArgs(['--help'])).toMatchObject({ help: true });
      expect(DEFAULT_BLOCKLIST).toBe('src/shared/names.blocklist.json');
    });

    it('reports usage errors instead of guessing', () => {
      expect(parseArgs([]).errors).toEqual(['missing command']);
      expect(parseArgs(['frobnicate']).errors).toEqual(['unknown command: frobnicate']);
      expect(parseArgs(['delist']).errors).toEqual(['delist takes <runId>']);
      expect(parseArgs(['rename', 'r']).errors).toEqual(['rename takes <runId> <name>']);
      expect(parseArgs(['delist', 'a', 'b']).errors).toEqual(['delist takes <runId>']);
      expect(parseArgs(['export-board', 'story', 't1', '--limit', 'x']).errors).toEqual(['--limit needs a positive integer, got x']);
      expect(parseArgs(['delist', 'a', '--bogus']).errors).toEqual(['unknown option: --bogus']);
    });
  });

  it('validName mirrors PlayerRef.name: 1–12 code points, no control or HTML-active characters', () => {
    expect(validName('플레이어')).toBe(true);
    expect(validName('  Clawd 1  ')).toBe(true);
    expect(validName('')).toBe(false);
    expect(validName('가'.repeat(13))).toBe(false);
    expect(validName('<script>')).toBe(false);
    expect(validName('a"b')).toBe(false);
    expect(validName('tab\there')).toBe(false);
  });

  describe('delist', () => {
    it('removes the run from topRuns, marks it flagged: true and drops the player best', async () => {
      const repo = await seeded();
      const { out, ctx } = io();
      expect(await runAdmin(parseArgs(['delist', 'b']), { ...ctx, repo })).toBe(0);
      expect(out[0]).toContain('delisted b');
      expect((await repo.topRuns('story', 't1', 10)).map((r) => r.runId)).toEqual(['a', 'c']);
      expect((await repo.getRun('b'))).toMatchObject({ runId: 'b', flagged: true, name: '씨발놈' });
      expect(await repo.getPlayerBest('p2', 'story', 't1')).toBeNull();
      expect(await repo.rankOf('story', 't1', 700)).toEqual({ better: 1, total: 2 });
      // the other board is untouched
      expect((await repo.topRuns('story', 't2', 10)).map((r) => r.runId)).toEqual(['d']);
    });

    it('exits 1 for an unknown run and writes nothing', async () => {
      const repo = await seeded();
      const { err, ctx } = io();
      expect(await runAdmin(parseArgs(['delist', 'nope']), { ...ctx, repo })).toBe(1);
      expect(err[0]).toContain('run not found: nope');
      expect((await repo.topRuns('story', 't1', 10))).toHaveLength(3);
    });

    it('a delisted run is gone from GET /api/ghost as well (404)', async () => {
      const repo = await seeded();
      const { app } = await makeApp({ repo });
      try {
        expect((await app.inject({ method: 'GET', url: '/api/ghost/b' })).statusCode).toBe(200);
        expect(await runAdmin(parseArgs(['delist', 'b']), { ...io().ctx, repo })).toBe(0);
        expect((await app.inject({ method: 'GET', url: '/api/ghost/b' })).statusCode).toBe(404);
        const board = (await app.inject({ method: 'GET', url: '/api/leaderboard?mode=story&board=t1' })).json();
        expect(board.entries.map((e: { runId: string }) => e.runId)).toEqual(['a', 'c']);
        expect(board.total).toBe(2);
      } finally {
        await app.close();
      }
    });

    it('needs a repo (TABLE_NAME) — exit 2 without one', async () => {
      const { err, ctx } = io();
      expect(await runAdmin(parseArgs(['delist', 'b']), ctx)).toBe(2);
      expect(err[0]).toContain('TABLE_NAME');
    });
  });

  describe('rename', () => {
    it('renames the run and its board entry', async () => {
      const repo = await seeded();
      const { out, ctx } = io();
      expect(await runAdmin(parseArgs(['rename', 'b', '플레이어']), { ...ctx, repo })).toBe(0);
      expect(out[0]).toContain('"씨발놈" → "플레이어"');
      expect((await repo.getRun('b'))!.name).toBe('플레이어');
      expect((await repo.topRuns('story', 't1', 10)).map((r) => r.name)).toEqual(['일등', '플레이어', '삼등']);
      expect((await repo.getPlayerBest('p2', 'story', 't1'))!.name).toBe('플레이어');
    });

    it('refuses an invalid name (exit 2) and an unknown run (exit 1)', async () => {
      const repo = await seeded();
      const { err, ctx } = io();
      expect(await runAdmin(parseArgs(['rename', 'b', '<b>']), { ...ctx, repo })).toBe(2);
      expect(err[0]).toContain('invalid name');
      expect((await repo.getRun('b'))!.name).toBe('씨발놈');
      expect(await runAdmin(parseArgs(['rename', 'zz', '플레이어']), { ...ctx, repo })).toBe(1);
    });
  });

  describe('export-board', () => {
    it('prints the board as JSON: entries in board order, hx included, masks and nothing else dropped', async () => {
      const repo = await seeded();
      const { out, ctx } = io();
      expect(await runAdmin(parseArgs(['export-board', 'story', 't1', '--limit', '2']), { ...ctx, repo })).toBe(0);
      const json = JSON.parse(out.join('\n'));
      expect(json).toMatchObject({ mode: 'story', board: 't1', exportedAt: '2026-09-06T12:00:00.000Z', count: 2 });
      expect(json.entries.map((e: { runId: string }) => e.runId)).toEqual(['a', 'b']);
      expect(json.entries[0]).toMatchObject({ runId: 'a', name: '일등', score: 500, hash: 'a'.repeat(64), hx: { frameAligned: 1, press1: 0 } });
      for (const e of json.entries) expect(e).not.toHaveProperty('masks');
      expect(await exportBoard(repo, 'story', 't2', 10)).toHaveLength(1);
    });

    it('fills hx from the RUN item when the board projection lacks it', async () => {
      const repo = await seeded();
      const spy = vi.spyOn(repo, 'topRuns').mockResolvedValue([{ ...run({ runId: 'a', playerId: 'p1', score: 500 }), masks: '' }]);
      const entries = await exportBoard(repo, 'story', 't1', 10);
      expect(entries[0]).toMatchObject({ runId: 'a', hx: { frameAligned: 1 } });
      spy.mockRestore();
    });

    it('rejects a mode other than story / daily', async () => {
      const repo = await seeded();
      const { err, ctx } = io();
      expect(await runAdmin(parseArgs(['export-board', 'weekly', 't1']), { ...ctx, repo })).toBe(2);
      expect(err[0]).toContain('mode must be story or daily');
    });
  });

  describe('ban-name', () => {
    it('appendBanned adds a term once to { "words": [...] } and starts a file from empty text', () => {
      const first = appendBanned('', 'zorblax');
      expect(first.added).toBe(true);
      expect(JSON.parse(first.text)).toEqual({ words: ['zorblax'] });
      const second = appendBanned(first.text, 'Zor blax');
      expect(second.added).toBe(false);
      expect(JSON.parse(second.text)).toEqual({ words: ['zorblax'] });
      const third = appendBanned(first.text, '새단어');
      expect(JSON.parse(third.text)).toEqual({ words: ['zorblax', '새단어'] });
      expect(third.text.endsWith('\n')).toBe(true);
      expect(() => appendBanned('{ "nope": 1 }', 'x')).toThrow(/words/);
      expect(() => appendBanned('', '   ')).toThrow(/non-empty/);
    });

    it('writes the file through the injected fs and names.ts picks the word up as an extra term', async () => {
      const files = new Map<string, string>();
      const { out, ctx } = io();
      const fs = { readFile: (p: string) => files.get(p) ?? '', writeFile: (p: string, t: string) => { files.set(p, t); }, root: '/repo' };
      expect(await runAdmin(parseArgs(['ban-name', 'zorblax']), { ...ctx, ...fs })).toBe(0);
      const path = resolve('/repo', DEFAULT_BLOCKLIST);
      expect(files.has(path)).toBe(true);
      expect(out[0]).toContain('added "zorblax"');
      const words = parseBlocklist(files.get(path)!);
      expect(words).toEqual(['zorblax']);
      expect(isBadName('xZorblax9', words)).toBe(true);
      expect(isBadName('xZorblax9')).toBe(false); // the shipped file is untouched
      // a second ban of the same word is a no-op
      expect(await runAdmin(parseArgs(['ban-name', 'ZORBLAX']), { ...ctx, ...fs })).toBe(0);
      expect(out[1]).toContain('already');
    });
  });

  describe('command line (tsx tools/admin.mjs)', () => {
    let dir: string;
    afterEach(() => { dir = ''; });
    const cli = (args: string[], env: Record<string, string> = {}) =>
      spawnSync(process.execPath, [TSX, SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 60_000, env: { ...process.env, TABLE_NAME: '', ...env } });

    it('ban-name --file appends to the given blocklist file', () => {
      mkdirSync(SCRATCH, { recursive: true });
      dir = mkdtempSync(join(SCRATCH, 'admin-'));
      const file = join(dir, 'blocklist.json');
      writeFileSync(file, '{ "words": ["first"] }\n');
      const r = cli(['ban-name', 'zorblax', '--file', file]);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('added "zorblax"');
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ words: ['first', 'zorblax'] });
    });

    it('--help prints the usage; a usage error exits 2', () => {
      const help = cli(['--help']);
      expect(help.status).toBe(0);
      expect(help.stdout).toContain('usage: npm run admin');
      expect(USAGE).toContain('export-board <mode> <board>');
      const bad = cli(['frobnicate']);
      expect(bad.status).toBe(2);
      expect(bad.stderr).toContain('unknown command: frobnicate');
    });

    it('a repo command without TABLE_NAME exits 2 and explains', () => {
      const r = cli(['delist', 'run-1']);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('TABLE_NAME');
    });
  });
});
