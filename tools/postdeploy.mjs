#!/usr/bin/env node
/**
 * Post-deploy smoke for CLAWD JUMP: ECHO TOWER.
 *
 * Reads cdk-outputs.json (written by `npm run deploy`) and checks the edge
 * path end to end: the CloudFront URL serves the game with the expected
 * caching headers, the API answers, and the ALB refuses direct requests
 * (security group + 403 default action). Finally runs the Playwright smoke
 * against the live site when `--smoke` is passed.
 *
 *   node tools/postdeploy.mjs [--smoke] [--outputs cdk-outputs.json]
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const outputsPath = args.includes('--outputs') ? args[args.indexOf('--outputs') + 1] : 'cdk-outputs.json';
const outputs = JSON.parse(readFileSync(outputsPath, 'utf8'));
const stack = outputs.ClawdEchoTowerStack ?? Object.values(outputs)[0];
if (!stack?.SiteUrl) { console.error(`no SiteUrl in ${outputsPath}`); process.exit(2); }

const site = stack.SiteUrl.replace(/\/$/, '');
const alb = stack.AlbDnsName;
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
process.exit(failures ? 1 : 0);
