#!/usr/bin/env node
/**
 * Board administration (P3-1). Runs against the production table through
 * the same repo the server uses, so every key stays in one place:
 *
 *   npm run admin -- delist <runId>                 flag the run and take it off its board
 *   npm run admin -- rename <runId> <name>          replace an offensive display name
 *   npm run admin -- ban-name <word> [--file p]     append a term to the name blocklist file
 *   npm run admin -- export-board <mode> <board> [--limit n]   board as JSON on stdout (with hx)
 *
 * `npm run admin` is `tsx tools/admin.mjs`: the repo modules are TypeScript
 * and are imported lazily, so this file itself stays plain JavaScript that
 * the tests import with an injected MemoryRepo. Repo commands need
 * TABLE_NAME (and AWS credentials for the table's account / region);
 * `ban-name` only touches the file, which a redeploy ships.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_BLOCKLIST = 'src/shared/names.blocklist.json';
export const DEFAULT_LIMIT = 100;
export const COMMANDS = ['delist', 'rename', 'ban-name', 'export-board'];
/** Arguments each command takes. */
const ARITY = { delist: ['<runId>'], rename: ['<runId>', '<name>'], 'ban-name': ['<word>'], 'export-board': ['<mode>', '<board>'] };

export const USAGE = [
  'usage: npm run admin -- <command> [options]',
  '',
  '  delist <runId>                    flag the run (flagged: true) and remove its board entry',
  '  rename <runId> <name>             change the display name on the run and its board entry',
  '  ban-name <word> [--file path]     append a term to the name blocklist (default src/shared/names.blocklist.json)',
  '  export-board <mode> <board> [--limit n]   print the board (story <levelId> | daily <YYYY-MM-DD>) as JSON',
  '',
  '  Repo commands read TABLE_NAME from the environment (DynamoDB). Run through tsx: npm run admin -- …',
].join('\n');

// ---------------------------------------------------------------- arguments
export function parseArgs(argv) {
  const opts = { command: undefined, args: [], file: DEFAULT_BLOCKLIST, limit: DEFAULT_LIMIT, help: false, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file' && argv[i + 1] !== undefined) opts.file = argv[++i];
    else if (a === '--limit' && argv[i + 1] !== undefined) {
      const n = Number.parseInt(argv[++i], 10);
      if (Number.isFinite(n) && n > 0) opts.limit = n;
      else opts.errors.push(`--limit needs a positive integer, got ${argv[i]}`);
    } else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('--')) opts.errors.push(`unknown option: ${a}`);
    else if (opts.command === undefined) opts.command = a;
    else opts.args.push(a);
  }
  if (opts.help) return opts;
  if (opts.command === undefined) opts.errors.push('missing command');
  else if (!COMMANDS.includes(opts.command)) opts.errors.push(`unknown command: ${opts.command}`);
  else if (opts.args.length !== ARITY[opts.command].length) {
    opts.errors.push(`${opts.command} takes ${ARITY[opts.command].join(' ')}`);
  }
  return opts;
}

// ---------------------------------------------------------------- names
/** PlayerRef.name (protocol.ts): trimmed, 1–12 code points, no control characters or HTML-active characters. */
const NAME_RE = /^[^\p{C}<>&"'`]+$/u;
export function validName(name) {
  const t = String(name).trim();
  const n = [...t].length;
  return n >= 1 && n <= 12 && NAME_RE.test(t);
}

/**
 * Append `word` to a blocklist file's text (`{ "words": [...] }`; empty text
 * starts a new file). Returns the new text and whether the word was added.
 */
export function appendBanned(text, word) {
  const term = String(word).trim();
  if (!term) throw new Error('ban-name needs a non-empty word');
  let words = [];
  if (text && text.trim()) {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.words)) {
      throw new Error('blocklist file is not { "words": [...] }');
    }
    words = parsed.words.filter((w) => typeof w === 'string');
  }
  const norm = (s) => s.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
  if (words.some((w) => norm(w) === norm(term))) return { text: `${JSON.stringify({ words }, null, 2)}\n`, added: false, words };
  words = [...words, term];
  return { text: `${JSON.stringify({ words }, null, 2)}\n`, added: true, words };
}

// ---------------------------------------------------------------- commands
/** Board entries for export: masks dropped, hx filled from the RUN item when the projection lacks it. */
export async function exportBoard(repo, mode, board, limit) {
  const top = await repo.topRuns(mode, board, limit);
  const entries = [];
  for (const entry of top) {
    const full = entry.hx || !repo.getRun ? entry : (await repo.getRun(entry.runId)) ?? entry;
    const { masks: _masks, ...rest } = { ...entry, ...full };
    entries.push(rest);
  }
  return entries;
}

/**
 * Run one command. `ctx` supplies the repo (a Repo with delistRun / renameRun),
 * file access and output; every field has a Node default. Resolves to the exit
 * code: 0 done · 1 not found / refused · 2 usage.
 */
export async function runAdmin(opts, ctx = {}) {
  const out = ctx.out ?? ((line) => process.stdout.write(`${line}\n`));
  const err = ctx.err ?? ((line) => process.stderr.write(`${line}\n`));
  const readFile = ctx.readFile ?? ((p) => (existsSafe(p) ? readFileSync(p, 'utf8') : ''));
  const writeFile = ctx.writeFile ?? ((p, text) => writeFileSync(p, text));
  const now = ctx.now ?? (() => new Date());
  const root = ctx.root ?? process.cwd();

  if (opts.help) {
    out(USAGE);
    return 0;
  }
  if (opts.errors.length) {
    for (const e of opts.errors) err(`admin: ${e}`);
    err('');
    err(USAGE);
    return 2;
  }

  if (opts.command === 'ban-name') {
    const path = resolve(root, opts.file);
    const { text, added } = appendBanned(readFile(path), opts.args[0]);
    if (!added) {
      out(`admin: "${opts.args[0]}" is already in ${opts.file}`);
      return 0;
    }
    writeFile(path, text);
    out(`admin: added "${opts.args[0]}" to ${opts.file} — redeploy to ship it (the server reads the file at load)`);
    return 0;
  }

  const repo = ctx.repo;
  if (!repo) {
    err('admin: no repository — set TABLE_NAME (DynamoDB) to run this command');
    return 2;
  }

  switch (opts.command) {
    case 'delist': {
      const [runId] = opts.args;
      if (typeof repo.delistRun !== 'function') { err('admin: this repository cannot delist runs'); return 2; }
      const run = await repo.getRun(runId);
      if (!run || !(await repo.delistRun(runId))) { err(`admin: run not found: ${runId}`); return 1; }
      out(`admin: delisted ${runId} (${run.mode} ${run.board}, ${JSON.stringify(run.name)}) — flagged: true, board entry removed`);
      return 0;
    }
    case 'rename': {
      const [runId, name] = opts.args;
      if (!validName(name)) { err(`admin: invalid name ${JSON.stringify(name)} (1–12 code points, no control or <>&"'\` characters)`); return 2; }
      if (typeof repo.renameRun !== 'function') { err('admin: this repository cannot rename runs'); return 2; }
      const run = await repo.getRun(runId);
      const before = run?.name; // read before the rename: an in-memory repo hands out the live object
      if (!run || !(await repo.renameRun(runId, name.trim()))) { err(`admin: run not found: ${runId}`); return 1; }
      out(`admin: renamed ${runId}: ${JSON.stringify(before)} → ${JSON.stringify(name.trim())}`);
      return 0;
    }
    case 'export-board': {
      const [mode, board] = opts.args;
      if (mode !== 'story' && mode !== 'daily') { err(`admin: mode must be story or daily, got ${mode}`); return 2; }
      const entries = await exportBoard(repo, mode, board, opts.limit);
      out(JSON.stringify({ mode, board, exportedAt: now().toISOString(), count: entries.length, entries }, null, 2));
      return 0;
    }
    default:
      err(`admin: unknown command: ${opts.command}`);
      return 2;
  }
}

function existsSafe(path) {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- cli
/** The production repo from TABLE_NAME, or null. The repo modules are TypeScript: this needs tsx. */
async function loadRepo(env) {
  if (!env.TABLE_NAME) return null;
  const [{ DynamoDBClient }, { DynamoDBDocumentClient }, { DynamoRepo }] = await Promise.all([
    import('@aws-sdk/client-dynamodb'),
    import('@aws-sdk/lib-dynamodb'),
    import('../src/server/repo/dynamo.ts'),
  ]);
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  return new DynamoRepo(doc, env.TABLE_NAME);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const needsRepo = opts.command && opts.command !== 'ban-name' && !opts.help && !opts.errors.length;
  let repo = null;
  if (needsRepo) {
    try {
      repo = await loadRepo(process.env);
    } catch (e) {
      console.error(`admin: cannot load the repository (${e instanceof Error ? e.message : String(e)}); run through tsx: npm run admin -- …`);
      return 2;
    }
  }
  return runAdmin(opts, { repo });
}

/** True when run as `tsx tools/admin.mjs`, false when imported (tests). */
function isMain() {
  const entry = process.argv[1];
  return typeof entry === 'string' && resolve(entry) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`admin: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
