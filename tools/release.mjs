#!/usr/bin/env node
/**
 * Release orchestrator for CLAWD JUMP: ECHO TOWER.
 *
 *   node tools/release.mjs [patch|minor] [--no-deploy] [--no-tag] [--dry-run]
 *                          [--outputs cdk-outputs.json] [--region ap-northeast-2]
 *
 * Runs, in order, and stops at the first failure:
 *   1. typecheck        npm run typecheck
 *   2. levels           npx tsx levels/build.ts --check   (generated level table is current)
 *   3. test             npx vitest run
 *   4. version          npm version <bump> + CHANGELOG (before compiling the version badge)
 *   5. build            npm run build
 *   6. deploy           npm run deploy                     (skipped with --no-deploy)
 *   7. postdeploy       node tools/postdeploy.mjs          (edge path + /api/health.simVersion)
 *   8. invalidate       aws cloudfront create-invalidation for / /index.html /sw.js
 *                       /manifest.webmanifest, then waits until it is Completed
 *   9. assets           GET /index.html and every /assets/* it references, 20 times each, all 200
 *  10. tag              git commit + annotated tag vx.y.z        (skipped with --no-tag)
 *
 * Every step is a plain function over a `ctx` ({ exec, fetch, readFile, writeFile,
 * log, now, root }) so the tests drive the whole sequence with a fake exec and a
 * fake fetch; `--dry-run` prints the plan and runs nothing.
 *
 * Exit codes: 0 released · 1 a step failed · 2 usage error.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveOutputs } from './postdeploy.mjs';

export const INVALIDATION_PATHS = ['/', '/index.html', '/sw.js', '/manifest.webmanifest'];
/** How many times each referenced asset is fetched after the invalidation. */
export const ASSET_ROUNDS = 20;
export const USAGE = [
  'usage: node tools/release.mjs [patch|minor] [--no-deploy] [--no-tag] [--dry-run]',
  '                              [--outputs cdk-outputs.json] [--region ap-northeast-2]',
  '',
  '  typecheck → levels --check → vitest → npm version + CHANGELOG → build → cdk deploy →',
  '  postdeploy:check → CloudFront invalidation (waits for Completed) → /assets/* × 20 → git tag',
  '  --no-deploy   skip `npm run deploy`; version preparation, build and checks still run',
  '  --no-tag      bump package.json and CHANGELOG.md but do not git commit / tag',
  '  --dry-run     print the plan and run nothing',
].join('\n');

// ---------------------------------------------------------------- arguments
export function parseArgs(argv) {
  const opts = {
    bump: 'patch', deploy: true, tag: true, dryRun: false, help: false,
    outputsPath: 'cdk-outputs.json', region: undefined, errors: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === 'patch' || a === 'minor') opts.bump = a;
    else if (a === '--no-deploy') opts.deploy = false;
    else if (a === '--no-tag') opts.tag = false;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--outputs' && argv[i + 1]) opts.outputsPath = argv[++i];
    else if (a === '--region' && argv[i + 1]) opts.region = argv[++i];
    else opts.errors.push(`unknown argument: ${a}`);
  }
  return opts;
}

// ---------------------------------------------------------------- pure helpers
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** `x.y.z` after a patch or minor bump; pre-release suffixes are not supported. */
export function nextVersion(current, bump) {
  const m = SEMVER.exec(String(current).trim());
  if (!m) throw new Error(`package.json version "${current}" is not x.y.z`);
  const [, x, y, z] = m.map(Number);
  if (bump === 'minor') return `${x}.${y + 1}.0`;
  if (bump === 'patch') return `${x}.${y}.${z + 1}`;
  throw new Error(`unknown bump "${bump}"`);
}

const UNRELEASED = '## [Unreleased]';

/**
 * Keep a Changelog: the notes under `## [Unreleased]` become `## [version] - date`
 * and an empty Unreleased section stays on top. Refuses a changelog without the
 * section or with nothing written under it — a release must say what changed.
 */
export function bumpChangelog(text, version, date) {
  const at = text.indexOf(UNRELEASED);
  if (at < 0) throw new Error(`CHANGELOG.md has no "${UNRELEASED}" section`);
  const afterHeading = at + UNRELEASED.length;
  const nextHeading = text.indexOf('\n## ', afterHeading);
  const body = text.slice(afterHeading, nextHeading < 0 ? text.length : nextHeading);
  if (!/^\s*[-*]\s+\S/m.test(body)) throw new Error('CHANGELOG.md: the [Unreleased] section is empty — write the release notes first');
  return `${text.slice(0, afterHeading)}\n\n## [${version}] - ${date}${text.slice(afterHeading)}`;
}

/** Unique same-origin `/assets/...` paths referenced by an index.html, in document order. */
export function assetRefs(html) {
  const out = [];
  for (const m of String(html).matchAll(/["'(](\/assets\/[A-Za-z0-9._\-/]+)["')]/g)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** `YYYY-MM-DD` in UTC. */
const isoDate = (d) => d.toISOString().slice(0, 10);

// ---------------------------------------------------------------- execution
class StepError extends Error {}

function fail(msg) {
  throw new StepError(msg);
}

/** Run a command through ctx.exec; non-zero exit or spawn error fails the step. Returns stdout. */
function run(ctx, cmd, args, { capture = false } = {}) {
  ctx.log(`$ ${[cmd, ...args].join(' ')}`);
  const r = ctx.exec(cmd, args, { cwd: ctx.root, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) fail(`${cmd}: ${r.error.message}`);
  if (r.status !== 0) fail(`${cmd} ${args.join(' ')} exited with ${r.status}`);
  return String(r.stdout ?? '');
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return fail(`${label}: unparsable JSON (${e instanceof Error ? e.message : String(e)})`);
  }
}

/** Stack outputs (SiteUrl, DistributionId) — resolved once and cached on the state. */
function outputs(ctx, opts, state) {
  if (state.outputs) return state.outputs;
  const r = resolveOutputs({ outputsPath: resolve(ctx.root, opts.outputsPath), region: opts.region, spawn: ctx.exec });
  if (!r.outputs) fail(`stack outputs not found: ${r.errors.join('; ')}`);
  if (!r.outputs.DistributionId) fail('stack outputs have no DistributionId');
  state.outputs = r.outputs;
  return r.outputs;
}

/**
 * The ordered steps. `commands(opts)` is what the plan prints; `run(ctx, opts,
 * state)` performs the step and may return a note for the summary table.
 */
export const STEPS = [
  {
    id: 'typecheck', title: 'TypeScript (app + infra)',
    commands: () => ['npm run typecheck'],
    run: (ctx) => { run(ctx, 'npm', ['run', 'typecheck']); },
  },
  {
    id: 'levels', title: 'generated level table is current',
    commands: () => ['npx tsx levels/build.ts --check'],
    run: (ctx) => { run(ctx, 'npx', ['tsx', 'levels/build.ts', '--check']); },
  },
  {
    id: 'test', title: 'vitest',
    commands: () => ['npx vitest run'],
    run: (ctx) => { run(ctx, 'npx', ['vitest', 'run']); },
  },
  {
    id: 'version', title: 'prepare npm version + CHANGELOG before building',
    commands: (opts, current) => {
      const next = current ? nextVersion(current, opts.bump) : `<${opts.bump}>`;
      return [
        `npm version ${opts.bump} --no-git-tag-version   (${current ?? '?'} → ${next})`,
        `CHANGELOG.md: [Unreleased] → [${next}] - <today>`,
      ];
    },
    run: (ctx, opts, state) => {
      const current = parseJson(ctx.readFile(resolve(ctx.root, 'package.json')), 'package.json').version;
      const next = nextVersion(current, opts.bump);
      const changelogPath = resolve(ctx.root, 'CHANGELOG.md');
      // Missing notes must stop the release before a build or AWS mutation.
      const bumped = bumpChangelog(ctx.readFile(changelogPath), next, isoDate(ctx.now()));
      const printed = run(ctx, 'npm', ['version', opts.bump, '--no-git-tag-version'], { capture: true }).trim();
      if (printed && printed !== `v${next}`) fail(`npm version printed ${printed}, expected v${next}`);
      ctx.writeFile(changelogPath, bumped);
      state.version = next;
      return `v${next} prepared`;
    },
  },
  {
    id: 'build', title: 'esbuild client + server + service worker',
    commands: () => ['npm run build'],
    run: (ctx) => { run(ctx, 'npm', ['run', 'build']); },
  },
  {
    id: 'deploy', title: 'cdk deploy',
    when: (opts) => opts.deploy,
    commands: () => ['npm run deploy'],
    run: (ctx) => { run(ctx, 'npm', ['run', 'deploy']); },
  },
  {
    id: 'postdeploy', title: 'post-deploy checks (edge, API, sim version)',
    commands: (opts) => [`node tools/postdeploy.mjs --outputs ${opts.outputsPath}${opts.region ? ` --region ${opts.region}` : ''}`],
    run: (ctx, opts) => {
      const args = ['tools/postdeploy.mjs', '--outputs', opts.outputsPath];
      if (opts.region) args.push('--region', opts.region);
      run(ctx, 'node', args);
    },
  },
  {
    id: 'invalidate', title: 'CloudFront invalidation',
    commands: () => [
      `aws cloudfront create-invalidation --distribution-id <DistributionId> --paths ${INVALIDATION_PATHS.join(' ')}`,
      'aws cloudfront wait invalidation-completed --distribution-id <DistributionId> --id <InvalidationId>',
      'aws cloudfront get-invalidation … (Status must be Completed)',
    ],
    run: (ctx, opts, state) => {
      const { DistributionId } = outputs(ctx, opts, state);
      const created = parseJson(run(ctx, 'aws', [
        'cloudfront', 'create-invalidation', '--distribution-id', DistributionId, '--paths', ...INVALIDATION_PATHS, '--output', 'json',
      ], { capture: true }), 'create-invalidation');
      const id = created?.Invalidation?.Id;
      if (typeof id !== 'string' || !id) fail('create-invalidation returned no Invalidation.Id');
      run(ctx, 'aws', ['cloudfront', 'wait', 'invalidation-completed', '--distribution-id', DistributionId, '--id', id]);
      const got = parseJson(run(ctx, 'aws', [
        'cloudfront', 'get-invalidation', '--distribution-id', DistributionId, '--id', id, '--output', 'json',
      ], { capture: true }), 'get-invalidation');
      const status = got?.Invalidation?.Status;
      if (status !== 'Completed') fail(`invalidation ${id} is ${status ?? 'unknown'}, not Completed`);
      state.invalidationId = id;
      return `${id} Completed`;
    },
  },
  {
    id: 'assets', title: `index.html + referenced /assets/* × ${ASSET_ROUNDS}`,
    commands: () => [`GET <SiteUrl>/index.html`, `GET <SiteUrl>/assets/* × ${ASSET_ROUNDS} (every response 200)`],
    run: async (ctx, opts, state) => {
      const site = String(outputs(ctx, opts, state).SiteUrl).replace(/\/$/, '');
      const index = await ctx.fetch(`${site}/index.html`, { cache: 'no-store' });
      if (index.status !== 200) fail(`GET ${site}/index.html → ${index.status}`);
      const refs = assetRefs(await index.text());
      if (!refs.length) fail('index.html references no /assets/* file');
      let hits = 0;
      const bad = [];
      for (const ref of refs) {
        for (let i = 0; i < ASSET_ROUNDS; i++) {
          const res = await ctx.fetch(`${site}${ref}`, { cache: 'no-store' });
          if (res.status !== 200) bad.push(`${ref} → ${res.status} (round ${i + 1})`);
          else if (/Hit from cloudfront/i.test(res.headers?.get?.('x-cache') ?? '')) hits++;
        }
      }
      if (bad.length) fail(`${bad.length} asset fetches were not 200: ${bad.slice(0, 5).join(', ')}${bad.length > 5 ? ', …' : ''}`);
      return `${refs.length} assets × ${ASSET_ROUNDS} all 200 (${hits} edge hits)`;
    },
  },
  {
    id: 'tag', title: 'commit and tag the verified release',
    when: (opts) => opts.tag,
    commands: (opts, current) => {
      const next = current ? nextVersion(current, opts.bump) : `<${opts.bump}>`;
      return ['git add package.json package-lock.json CHANGELOG.md', `git commit -m "release: v${next}"`, `git tag -a v${next} -m "v${next}"`];
    },
    run: (ctx, opts, state) => {
      const next = state.version;
      if (typeof next !== 'string') fail('release version was not prepared');
      const current = parseJson(ctx.readFile(resolve(ctx.root, 'package.json')), 'package.json').version;
      if (current !== next) fail(`package.json changed during release: ${current}, expected ${next}`);
      run(ctx, 'git', ['add', 'package.json', 'package-lock.json', 'CHANGELOG.md']);
      run(ctx, 'git', ['commit', '-m', `release: v${next}`]);
      run(ctx, 'git', ['tag', '-a', `v${next}`, '-m', `v${next}`]);
      return `v${next} tagged`;
    },
  },
];

/** The steps that apply to `opts`, with the command lines the plan prints. */
export function plan(opts, current) {
  return STEPS
    .filter((s) => !s.when || s.when(opts))
    .map((s) => ({ id: s.id, title: s.title, commands: s.commands(opts, current) }));
}

export function formatPlan(opts, current) {
  const lines = [`release plan: ${opts.bump}${current ? ` (${current} → ${nextVersion(current, opts.bump)})` : ''}${opts.deploy ? '' : ', no deploy'}${opts.tag ? '' : ', no tag'}`];
  plan(opts, current).forEach((s, i) => {
    lines.push(`${String(i + 1).padStart(2)}. ${s.id.padEnd(10)} ${s.title}`);
    for (const c of s.commands) lines.push(`      ${c}`);
  });
  return lines.join('\n');
}

function defaultContext(ctx = {}) {
  return {
    exec: ctx.exec ?? spawnSync,
    fetch: ctx.fetch ?? ((url, init) => fetch(url, init)),
    readFile: ctx.readFile ?? ((p) => readFileSync(p, 'utf8')),
    writeFile: ctx.writeFile ?? ((p, s) => writeFileSync(p, s)),
    log: ctx.log ?? ((line) => console.log(line)),
    now: ctx.now ?? (() => new Date()),
    root: ctx.root ?? process.cwd(),
  };
}

/**
 * Run the release. Resolves (never rejects) with `{ ok, steps, version, exitCode }`;
 * `steps` has one row per applicable step, in order, and stops after the first failure.
 */
export async function release(opts, partial = {}) {
  const ctx = defaultContext(partial);
  const state = {};
  const results = [];
  for (const step of STEPS) {
    if (step.when && !step.when(opts)) continue;
    const t0 = Date.now();
    ctx.log(`\n▶ ${step.id}: ${step.title}`);
    try {
      const note = await step.run(ctx, opts, state);
      results.push({ id: step.id, title: step.title, ok: true, ms: Date.now() - t0, note: note ?? undefined });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      results.push({ id: step.id, title: step.title, ok: false, ms: Date.now() - t0, error: message });
      ctx.log(`✗ ${step.id}: ${message}`);
      return { ok: false, steps: results, version: state.version, exitCode: 1 };
    }
  }
  return { ok: true, steps: results, version: state.version, exitCode: 0 };
}

export function formatSummary(result) {
  const w = Math.max(...result.steps.map((s) => s.id.length));
  const rows = result.steps.map((s) => `${s.id.padEnd(w)}  ${s.ok ? 'PASS' : 'FAIL'}  ${(s.ms / 1000).toFixed(1)}s  ${s.ok ? s.note ?? '' : s.error}`);
  rows.push(result.ok ? `\nreleased v${result.version}` : '\nrelease aborted — nothing after the failed step ran');
  return rows.join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  if (opts.errors.length) {
    for (const e of opts.errors) console.error(`release: ${e}`);
    console.error(`\n${USAGE}`);
    return 2;
  }
  let current;
  try {
    current = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')).version;
  } catch {
    current = undefined;
  }
  if (opts.dryRun) {
    console.log(formatPlan(opts, current));
    return 0;
  }
  console.log(formatPlan(opts, current));
  const result = await release(opts);
  console.log(`\n${formatSummary(result)}`);
  return result.exitCode;
}

/** True when run as `node tools/release.mjs`, false when imported (tests). */
function isMain() {
  const entry = process.argv[1];
  return typeof entry === 'string' && resolve(entry) === fileURLToPath(import.meta.url);
}

if (isMain()) process.exit(await main());
