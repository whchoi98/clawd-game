#!/usr/bin/env node
/**
 * Post-deploy smoke for CLAWD JUMP: ECHO TOWER.
 *
 * Finds the stack outputs — cdk-outputs.json written by `npm run deploy`
 * (`cdk deploy --outputs-file`), or, when that file is missing or unusable,
 * `aws cloudformation describe-stacks` — and checks the edge path end to end:
 * the CloudFront URL serves the game with the expected caching headers, the
 * API answers, and the ALB refuses direct requests (security group + 403
 * default action). Finally runs the Playwright smoke against the live site
 * when `--smoke` is passed.
 *
 *   node tools/postdeploy.mjs [--smoke] [--outputs cdk-outputs.json]
 *                             [--stack ClawdEchoTowerStack] [--region ap-northeast-2]
 *
 * Exit codes: 0 all checks passed · 1 a check failed · 2 no stack outputs found.
 * The outputs helpers are exported so tests can exercise them without a network.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STACK_NAME = 'ClawdEchoTowerStack';
export const DEFAULT_REGION = 'ap-northeast-2';
export const USAGE = [
  'usage: node tools/postdeploy.mjs [--smoke] [--outputs cdk-outputs.json]',
  '                                 [--stack ClawdEchoTowerStack] [--region ap-northeast-2]',
  '',
  '  Stack outputs come from cdk-outputs.json (written by `npm run deploy`) or, when',
  '  that file is missing, from `aws cloudformation describe-stacks` (needs AWS credentials',
  '  for the deployed account; region from AWS_REGION / CDK_DEFAULT_REGION, default ap-northeast-2).',
].join('\n');

/** Region for the describe-stacks fallback: AWS_REGION, then CDK_DEFAULT_REGION, then the default. */
export function regionFromEnv(env = process.env) {
  return env.AWS_REGION || env.CDK_DEFAULT_REGION || DEFAULT_REGION;
}

/** Arguments to the AWS CLI for the fallback. */
export function describeStacksArgs({ stackName, region }) {
  return ['cloudformation', 'describe-stacks', '--stack-name', stackName, '--region', region, '--output', 'json'];
}

/**
 * Outputs from a `cdk deploy --outputs-file` JSON ({ StackName: { Key: value } }).
 * Prefers STACK_NAME, else the first stack in the file.
 */
export function outputsFromFile(path) {
  if (!existsSync(path)) return { outputs: null, error: `${path}: not found (run \`npm run deploy\`, or pass --outputs <file>)` };
  let json;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return { outputs: null, error: `${path}: ${e instanceof Error ? e.message : String(e)}` };
  }
  const stack = json?.[STACK_NAME] ?? Object.values(json ?? {})[0];
  if (!stack || typeof stack !== 'object' || typeof stack.SiteUrl !== 'string') {
    return { outputs: null, error: `${path}: no SiteUrl output` };
  }
  return { outputs: stack, error: null };
}

/** Outputs via `aws cloudformation describe-stacks`; `spawn` defaults to child_process.spawnSync. */
export function outputsFromCloudFormation({ stackName, region, spawn = spawnSync }) {
  const args = describeStacksArgs({ stackName, region });
  const label = `aws ${args.slice(0, 6).join(' ')}`;
  const r = spawn('aws', args, { encoding: 'utf8', timeout: 30_000 });
  if (r.error) return { outputs: null, error: `${label}: ${r.error.message}` };
  if (r.status !== 0) {
    const detail = String(r.stderr ?? '').trim().split('\n').pop() || `exit ${r.status}`;
    return { outputs: null, error: `${label}: ${detail}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(String(r.stdout));
  } catch (e) {
    return { outputs: null, error: `${label}: unparsable output (${e instanceof Error ? e.message : String(e)})` };
  }
  const list = parsed?.Stacks?.[0]?.Outputs;
  if (!Array.isArray(list)) return { outputs: null, error: `${label}: no Outputs in response` };
  const outputs = Object.fromEntries(list.map((o) => [o.OutputKey, o.OutputValue]));
  if (typeof outputs.SiteUrl !== 'string') return { outputs: null, error: `${label}: no SiteUrl output` };
  return { outputs, error: null };
}

/**
 * The stack outputs from the first source that works: the outputs file, then
 * CloudFormation. `errors` lists every source that failed, in order.
 */
export function resolveOutputs({
  outputsPath = 'cdk-outputs.json',
  stackName = STACK_NAME,
  region,
  env = process.env,
  spawn = spawnSync,
} = {}) {
  const errors = [];
  const fromFile = outputsFromFile(outputsPath);
  if (fromFile.outputs) return { outputs: fromFile.outputs, source: outputsPath, errors };
  errors.push(fromFile.error);

  const resolvedRegion = region || regionFromEnv(env);
  const fromCfn = outputsFromCloudFormation({ stackName, region: resolvedRegion, spawn });
  if (fromCfn.outputs) {
    return { outputs: fromCfn.outputs, source: `aws cloudformation describe-stacks ${stackName} (${resolvedRegion})`, errors };
  }
  errors.push(fromCfn.error);
  return { outputs: null, source: null, errors };
}

function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const outputsPath = flag(args, '--outputs') ?? 'cdk-outputs.json';
  const resolved = resolveOutputs({
    outputsPath,
    stackName: flag(args, '--stack') ?? STACK_NAME,
    region: flag(args, '--region'),
  });
  if (!resolved.outputs) {
    console.error('postdeploy: could not find the stack outputs');
    for (const e of resolved.errors) console.error(`  - ${e}`);
    console.error(`\n${USAGE}`);
    return 2;
  }
  console.log(`stack outputs from ${resolved.source}`);
  for (const e of resolved.errors) console.log(`  (skipped: ${e})`);

  const site = resolved.outputs.SiteUrl.replace(/\/$/, '');
  const alb = resolved.outputs.AlbDnsName;
  let failures = 0;
  const rows = [];
  const ok = (name, pass, note) => { rows.push([name, pass ? 'PASS' : 'FAIL', note]); if (!pass) failures++; };

  async function get(url, init = {}) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), init.timeout ?? 15000);
    try {
      const res = await fetch(url, { ...init, signal: ctl.signal, redirect: 'manual' });
      const text = await res.text();
      return { status: res.status, headers: res.headers, text };
    } catch (e) {
      return { status: 0, headers: new Headers(), text: String(e?.cause?.code ?? e?.name ?? e) };
    } finally { clearTimeout(t); }
  }

  // 1. index.html through CloudFront
  const home = await get(`${site}/`);
  ok('site /', home.status === 200 && home.text.includes('ECHO TOWER'), `status ${home.status}, cache-control "${home.headers.get('cache-control')}"`);
  ok('site security headers',
    /max-age=31536000/.test(home.headers.get('strict-transport-security') ?? '') &&
    (home.headers.get('content-security-policy') ?? '').includes("default-src 'self'") &&
    home.headers.get('x-content-type-options') === 'nosniff',
    `hsts "${home.headers.get('strict-transport-security')}", csp ${home.headers.has('content-security-policy') ? 'present' : 'MISSING'}`);

  // 2. hashed asset is immutable-cached
  const asset = home.text.match(/\/assets\/app\.[A-Za-z0-9]+\.js/)?.[0];
  if (asset) {
    const a = await get(`${site}${asset}`);
    ok('asset immutable', a.status === 200 && /immutable/.test(a.headers.get('cache-control') ?? ''), `${asset} → ${a.status}, "${a.headers.get('cache-control')}", x-cache "${a.headers.get('x-cache')}"`);
  } else ok('asset immutable', false, 'no hashed asset reference in index.html');

  // 3. API through CloudFront (never cached)
  const health = await get(`${site}/api/health`);
  ok('api health', health.status === 200 && health.text.includes('"ok":true'), `status ${health.status}, x-cache "${health.headers.get('x-cache')}", body ${health.text.slice(0, 80)}`);
  const daily = await get(`${site}/api/daily`);
  let dailyJson = null;
  try { dailyJson = JSON.parse(daily.text); } catch { /* handled below */ }
  ok('api daily', daily.status === 200 && dailyJson?.levelId === 'daily' && Number.isInteger(dailyJson?.seed), daily.text.slice(0, 120));
  const lb = await get(`${site}/api/leaderboard?mode=story&board=t1&limit=3`);
  ok('api leaderboard', lb.status === 200 && lb.text.includes('"entries"'), lb.text.slice(0, 120));
  const bogus = await get(`${site}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"nope":1}' });
  ok('api rejects bad run', bogus.status === 400, `status ${bogus.status} ${bogus.text.slice(0, 80)}`);

  // 4. the ALB must not be reachable except through CloudFront
  if (alb) {
    const direct = await get(`http://${alb}/`, { timeout: 8000 });
    ok('alb direct blocked', direct.status === 0 || direct.status === 403, direct.status === 0 ? `no response (${direct.text}) — security group` : `status ${direct.status} (listener default)`);
  }

  // 5. optional browser smoke against the live site
  if (args.includes('--smoke')) {
    const r = spawnSync('npx', ['tsx', 'tools/qa/smoke.ts', '--no-shots'], { stdio: 'inherit', env: { ...process.env, BASE_URL: site } });
    ok('playwright smoke', r.status === 0, `exit ${r.status}`);
  }

  const w = Math.max(...rows.map((r) => r[0].length));
  console.log(`\npost-deploy checks for ${site}\n`);
  for (const [n, s, note] of rows) console.log(`${n.padEnd(w)}  ${s}  ${note}`);
  console.log(`\n${rows.length - failures}/${rows.length} passed`);
  return failures ? 1 : 0;
}

/** True when run as `node tools/postdeploy.mjs`, false when imported (tests). */
function isMain() {
  const entry = process.argv[1];
  return typeof entry === 'string' && resolve(entry) === fileURLToPath(import.meta.url);
}

if (isMain()) process.exit(await main());
