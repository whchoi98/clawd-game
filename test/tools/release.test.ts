/**
 * tools/release.mjs drives the whole release with an injected exec / fetch, so
 * the sequence (typecheck → levels → test → version → build → deploy → postdeploy →
 * invalidation → assets → tag) is verified here without touching AWS,
 * git or the network. Also covers the sim-version parser the post-deploy
 * check uses.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GEN_VERSION, SIM_VERSION } from '../../src/sim/types.js';
import { readSimVersions, versionsFromSource } from '../../tools/postdeploy.mjs';
import {
  ASSET_ROUNDS, INVALIDATION_PATHS, STEPS, assetRefs, bumpChangelog, formatPlan, nextVersion, parseArgs, plan, release,
  type ExecResult, type FetchResponseLike, type ReleaseOptions,
} from '../../tools/release.mjs';

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const SCRIPT = join(ROOT, 'tools', 'release.mjs');
const SCRATCH = '/tmp/claude-1000/-home-ec2-user-my-project-clawd-game/f8aa643c-bc48-400a-8c09-d71da38a73d7/scratchpad';

const SITE = 'https://clawd.example.net';
const INDEX_HTML = `<!doctype html><html><head>
<link rel="stylesheet" href="/assets/styles.0a1b2c3d.css">
<link rel="icon" href="/favicon.svg">
</head><body><script type="module" src="/assets/app.9f8e7d6c.js"></script>
<script type="module" src="/assets/app.9f8e7d6c.js"></script></body></html>`;
const CHANGELOG = `# Changelog

## [Unreleased]

### Added
- 새 기능 하나

## [0.1.0] - 2026-09-01

### Added
- 최초 릴리스
`;

type Call = { cmd: string; args: string[] };

interface Harness {
  calls: Call[];
  commands: string[];
  fetched: string[];
  written: Record<string, string>;
  artifactVersions: Record<string, string>;
  ctx: Parameters<typeof release>[1];
}

interface HarnessOpts {
  /** Exit status per command prefix (joined with spaces), default 0. */
  fail?: Record<string, number>;
  /** Status per fetched URL suffix, default 200; `nth` fails only that round (1-based) of that URL. */
  fetchFail?: { suffix: string; status: number; nth?: number };
  invalidationStatus?: string;
  outputsPath: string;
}

function harness(o: HarnessOpts): Harness {
  const calls: Call[] = [];
  const fetched: string[] = [];
  const written: Record<string, string> = {};
  const artifactVersions: Record<string, string> = {};
  const rounds = new Map<string, number>();
  const exec = (cmd: string, args: string[]): ExecResult => {
    calls.push({ cmd, args });
    const line = [cmd, ...args].join(' ');
    for (const [prefix, status] of Object.entries(o.fail ?? {})) {
      if (line.startsWith(prefix)) return { status, stdout: '', stderr: 'boom' };
    }
    if (line.startsWith('aws cloudfront create-invalidation')) return { status: 0, stdout: JSON.stringify({ Invalidation: { Id: 'I2ABCDEF', Status: 'InProgress' } }) };
    if (line.startsWith('aws cloudfront get-invalidation')) return { status: 0, stdout: JSON.stringify({ Invalidation: { Id: 'I2ABCDEF', Status: o.invalidationStatus ?? 'Completed' } }) };
    if (line.startsWith('npm run build') || line === 'npm run deploy') {
      artifactVersions[line.startsWith('npm run build') ? 'npm run build' : line] = JSON.parse(files['package.json']).version;
    }
    if (line.startsWith('npm version')) {
      const pkg = JSON.parse(files['package.json']);
      pkg.version = nextVersion(pkg.version, args[1] as 'patch' | 'minor');
      files['package.json'] = JSON.stringify(pkg);
      return { status: 0, stdout: `v${pkg.version}\n` };
    }
    return { status: 0, stdout: '' };
  };
  const fetch = async (url: string): Promise<FetchResponseLike> => {
    fetched.push(url);
    const n = (rounds.get(url) ?? 0) + 1;
    rounds.set(url, n);
    const f = o.fetchFail;
    const status = f && url.endsWith(f.suffix) && (f.nth === undefined || f.nth === n) ? f.status : 200;
    return {
      status,
      headers: { get: (name: string) => (name === 'x-cache' && url.includes('/assets/') ? 'Hit from cloudfront' : null) },
      text: async () => (url.endsWith('/index.html') ? INDEX_HTML : 'bytes'),
    };
  };
  const files: Record<string, string> = { 'package.json': JSON.stringify({ name: 'x', version: '0.1.0' }), 'CHANGELOG.md': CHANGELOG };
  const base = (p: string) => p.split('/').pop()!;
  return {
    calls,
    commands: [] as string[],
    fetched,
    written,
    artifactVersions,
    ctx: {
      exec,
      fetch,
      readFile: (p) => { const c = files[base(p)]; if (c === undefined) throw new Error(`no fixture ${p}`); return c; },
      writeFile: (p, text) => { written[base(p)] = text; files[base(p)] = text; },
      log: () => {},
      now: () => new Date('2026-09-06T12:00:00.000Z'),
      root: ROOT,
    },
  };
}

const lines = (h: Harness) => h.calls.map((c) => [c.cmd, ...c.args].join(' '));
const opts = (over: Partial<ReleaseOptions> = {}): ReleaseOptions => ({
  bump: 'patch', deploy: true, tag: true, dryRun: false, help: false, outputsPath: 'cdk-outputs.json', region: undefined, errors: [], ...over,
});

describe('tools/release.mjs', () => {
  let dir: string;
  let outputsPath: string;
  beforeAll(() => {
    mkdirSync(SCRATCH, { recursive: true });
    dir = mkdtempSync(join(SCRATCH, 'release-'));
    outputsPath = join(dir, 'cdk-outputs.json');
    writeFileSync(outputsPath, JSON.stringify({ ClawdEchoTowerStack: { SiteUrl: `${SITE}/`, DistributionId: 'E1EXAMPLE', AlbDnsName: 'alb.example' } }));
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  describe('arguments and helpers', () => {
    it('parseArgs: defaults to a tagged patch release with deploy', () => {
      expect(parseArgs([])).toMatchObject({ bump: 'patch', deploy: true, tag: true, dryRun: false, outputsPath: 'cdk-outputs.json', errors: [] });
      expect(parseArgs(['minor', '--no-deploy', '--no-tag', '--dry-run', '--outputs', 'o.json', '--region', 'us-east-1']))
        .toMatchObject({ bump: 'minor', deploy: false, tag: false, dryRun: true, outputsPath: 'o.json', region: 'us-east-1' });
      expect(parseArgs(['--bogus']).errors).toEqual(['unknown argument: --bogus']);
      expect(parseArgs(['-h']).help).toBe(true);
    });

    it('nextVersion bumps patch or minor', () => {
      expect(nextVersion('0.1.0', 'patch')).toBe('0.1.1');
      expect(nextVersion('0.1.9', 'minor')).toBe('0.2.0');
      expect(nextVersion('1.2.3', 'minor')).toBe('1.3.0');
      expect(() => nextVersion('1.2', 'patch')).toThrow(/x\.y\.z/);
    });

    it('bumpChangelog turns [Unreleased] into the version section and keeps an empty Unreleased on top', () => {
      const out = bumpChangelog(CHANGELOG, '0.2.0', '2026-09-06');
      expect(out).toContain('## [Unreleased]\n\n## [0.2.0] - 2026-09-06\n\n### Added\n- 새 기능 하나\n');
      expect(out).toContain('## [0.1.0] - 2026-09-01');
      expect(out.indexOf('## [Unreleased]')).toBeLessThan(out.indexOf('## [0.2.0]'));
      expect(out.indexOf('## [0.2.0]')).toBeLessThan(out.indexOf('## [0.1.0]'));
    });

    it('bumpChangelog refuses a changelog without an Unreleased section or with nothing under it', () => {
      expect(() => bumpChangelog('# Changelog\n\n## [0.1.0] - 2026-09-01\n- x\n', '0.1.1', '2026-09-06')).toThrow(/Unreleased/);
      expect(() => bumpChangelog('# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-09-01\n- x\n', '0.1.1', '2026-09-06')).toThrow(/empty/);
    });

    it('assetRefs lists each referenced /assets/* path once, in order', () => {
      expect(assetRefs(INDEX_HTML)).toEqual(['/assets/styles.0a1b2c3d.css', '/assets/app.9f8e7d6c.js']);
      expect(assetRefs('<p>nothing</p>')).toEqual([]);
    });

    it('plan lists the steps in order, drops deploy with --no-deploy and the git lines with --no-tag', () => {
      const ids = plan(opts(), '0.1.0').map((s) => s.id);
      expect(ids).toEqual(['typecheck', 'levels', 'test', 'version', 'build', 'deploy', 'postdeploy', 'invalidate', 'assets', 'tag']);
      expect(ids).toEqual(STEPS.map((s) => s.id));
      expect(plan(opts({ deploy: false })).map((s) => s.id)).not.toContain('deploy');
      const full = formatPlan(opts(), '0.1.0');
      expect(full).toContain('0.1.0 → 0.1.1');
      expect(full).toContain(`aws cloudfront create-invalidation --distribution-id <DistributionId> --paths ${INVALIDATION_PATHS.join(' ')}`);
      expect(full).toContain('git tag -a v0.1.1');
      const untagged = formatPlan(opts({ tag: false }), '0.1.0');
      expect(untagged).not.toContain('git tag -a');
      expect(untagged).not.toContain('git commit');
      expect(untagged).toContain(', no tag');
      expect(INVALIDATION_PATHS).toEqual(['/', '/index.html', '/sw.js', '/manifest.webmanifest']);
    });
  });

  describe('release()', () => {
    it('runs every step in order with the exact commands, fetches each asset 20 times, writes the CHANGELOG and tags', async () => {
      const h = harness({ outputsPath });
      const result = await release(opts({ outputsPath }), h.ctx);
      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.version).toBe('0.1.1');
      expect(h.artifactVersions).toEqual({ 'npm run build': '0.1.1', 'npm run deploy': '0.1.1' });
      expect(result.steps.map((s) => s.id)).toEqual(['typecheck', 'levels', 'test', 'version', 'build', 'deploy', 'postdeploy', 'invalidate', 'assets', 'tag']);
      expect(result.steps.every((s) => s.ok)).toBe(true);
      expect(lines(h)).toEqual([
        'npm run typecheck',
        'npx tsx levels/build.ts --check',
        'npx vitest run',
        'npm version patch --no-git-tag-version',
        'npm run build -- --prod',
        'npm run deploy',
        `node tools/postdeploy.mjs --outputs ${outputsPath}`,
        `aws cloudfront create-invalidation --distribution-id E1EXAMPLE --paths ${INVALIDATION_PATHS.join(' ')} --output json`,
        'aws cloudfront wait invalidation-completed --distribution-id E1EXAMPLE --id I2ABCDEF',
        'aws cloudfront get-invalidation --distribution-id E1EXAMPLE --id I2ABCDEF --output json',
        'git add package.json package-lock.json CHANGELOG.md',
        'git commit -m release: v0.1.1',
        'git tag -a v0.1.1 -m v0.1.1',
      ]);
      // index.html once, then both assets ASSET_ROUNDS times each
      expect(ASSET_ROUNDS).toBe(20);
      expect(h.fetched[0]).toBe(`${SITE}/index.html`);
      expect(h.fetched).toHaveLength(1 + 2 * ASSET_ROUNDS);
      expect(h.fetched.filter((u) => u === `${SITE}/assets/app.9f8e7d6c.js`)).toHaveLength(ASSET_ROUNDS);
      expect(h.fetched.filter((u) => u === `${SITE}/assets/styles.0a1b2c3d.css`)).toHaveLength(ASSET_ROUNDS);
      expect(result.steps.find((s) => s.id === 'assets')?.note).toBe(`2 assets × ${ASSET_ROUNDS} all 200 (${2 * ASSET_ROUNDS} edge hits)`);
      expect(result.steps.find((s) => s.id === 'invalidate')?.note).toBe('I2ABCDEF Completed');
      expect(h.written['CHANGELOG.md']).toContain('## [0.1.1] - 2026-09-06');
      expect(h.written['CHANGELOG.md']).toContain('- 새 기능 하나');
    });

    it('stops at the first failing step and runs nothing after it', async () => {
      const h = harness({ outputsPath, fail: { 'npx vitest run': 1 } });
      const result = await release(opts({ outputsPath }), h.ctx);
      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.steps.map((s) => [s.id, s.ok])).toEqual([['typecheck', true], ['levels', true], ['test', false]]);
      expect(result.steps[2].error).toMatch(/vitest run exited with 1/);
      expect(lines(h)).toEqual(['npm run typecheck', 'npx tsx levels/build.ts --check', 'npx vitest run']);
      expect(h.fetched).toEqual([]);
      expect(h.written).toEqual({});
    });

    it('--no-deploy skips cdk deploy but still verifies, invalidates and tags; --no-tag bumps without git', async () => {
      const a = harness({ outputsPath });
      const ra = await release(opts({ outputsPath, deploy: false }), a.ctx);
      expect(ra.ok).toBe(true);
      expect(lines(a)).not.toContain('npm run deploy');
      expect(lines(a)).toContain('git tag -a v0.1.1 -m v0.1.1');

      const b = harness({ outputsPath });
      const rb = await release(opts({ outputsPath, tag: false, bump: 'minor' }), b.ctx);
      expect(rb.ok).toBe(true);
      expect(rb.version).toBe('0.2.0');
      expect(lines(b).some((l) => l.startsWith('git '))).toBe(false);
      expect(lines(b)).toContain('npm version minor --no-git-tag-version');
      expect(b.written['CHANGELOG.md']).toContain('## [0.2.0] - 2026-09-06');
      expect(rb.steps.find((s) => s.id === 'version')?.note).toBe('v0.2.0 prepared');
      expect(rb.steps.map((s) => s.id)).not.toContain('tag');
      expect(b.artifactVersions).toEqual({ 'npm run build': '0.2.0', 'npm run deploy': '0.2.0' });
    });

    it('fails the asset step when any fetch is not 200 and never tags the prepared version', async () => {
      const h = harness({ outputsPath, fetchFail: { suffix: '/assets/app.9f8e7d6c.js', status: 404, nth: 17 } });
      const result = await release(opts({ outputsPath }), h.ctx);
      expect(result.ok).toBe(false);
      const assets = result.steps.find((s) => s.id === 'assets')!;
      expect(assets.ok).toBe(false);
      expect(assets.error).toMatch(/1 asset fetches were not 200: \/assets\/app\.9f8e7d6c\.js → 404 \(round 17\)/);
      expect(result.steps.map((s) => s.id)).not.toContain('tag');
      expect(lines(h).some((l) => l.startsWith('git '))).toBe(false);
      expect(result.version).toBe('0.1.1');
      expect(h.written['CHANGELOG.md']).toContain('## [0.1.1] - 2026-09-06');
    });

    it('fails the invalidation step when CloudFront does not report Completed', async () => {
      const h = harness({ outputsPath, invalidationStatus: 'InProgress' });
      const result = await release(opts({ outputsPath }), h.ctx);
      expect(result.ok).toBe(false);
      expect(result.steps.at(-1)).toMatchObject({ id: 'invalidate', ok: false });
      expect(result.steps.at(-1)!.error).toMatch(/InProgress, not Completed/);
      expect(h.fetched).toEqual([]);
    });

    it('fails early when the stack outputs cannot be found', async () => {
      const h = harness({ outputsPath: join(dir, 'missing.json'), fail: { 'aws cloudformation describe-stacks': 255 } });
      const result = await release(opts({ outputsPath: join(dir, 'missing.json'), deploy: false }), h.ctx);
      expect(result.ok).toBe(false);
      expect(result.steps.at(-1)).toMatchObject({ id: 'invalidate', ok: false });
      expect(result.steps.at(-1)!.error).toMatch(/stack outputs not found/);
    });

    it('refuses to bump when the CHANGELOG has no release notes, leaving package.json untouched', async () => {
      const h = harness({ outputsPath });
      const ctx = { ...h.ctx, readFile: (p: string) => (p.endsWith('CHANGELOG.md') ? '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-09-01\n- x\n' : h.ctx!.readFile!(p)) };
      const result = await release(opts({ outputsPath }), ctx);
      expect(result.ok).toBe(false);
      expect(result.steps.at(-1)).toMatchObject({ id: 'version', ok: false });
      expect(result.steps.at(-1)!.error).toMatch(/empty/);
      expect(lines(h).some((l) => l.startsWith('npm version'))).toBe(false);
      expect(h.artifactVersions).toEqual({});
    });
  });

  describe('command line', () => {
    it('--dry-run prints the plan and exits 0 without running anything', () => {
      const r = spawnSync(process.execPath, [SCRIPT, '--dry-run', 'minor'], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('release plan: minor');
      expect(r.stdout).toContain('npm run typecheck');
      expect(r.stdout).toContain('aws cloudfront create-invalidation');
      expect(r.stdout).toContain('git tag -a v');
    });

    it('rejects unknown arguments with exit 2 and the usage', () => {
      const r = spawnSync(process.execPath, [SCRIPT, '--nope'], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('unknown argument: --nope');
      expect(r.stderr).toContain('usage:');
    });
  });
});

describe('postdeploy sim-version parsing', () => {
  it('versionsFromSource reads SIM_VERSION and GEN_VERSION out of the contract source', () => {
    expect(versionsFromSource('export const SIM_VERSION = 2;\nexport const GEN_VERSION = 1;\n')).toEqual({ sim: 2, gen: 1 });
    expect(versionsFromSource('/** doc */\nexport const  SIM_VERSION=12 ;\n export const GEN_VERSION = 3;')).toEqual({ sim: 12, gen: 3 });
    expect(versionsFromSource('export const SIM_VERSION = 2;')).toBeNull();
    expect(versionsFromSource('')).toBeNull();
  });

  it('readSimVersions matches the constants the bundle imports', () => {
    expect(readSimVersions(ROOT)).toEqual({ sim: SIM_VERSION, gen: GEN_VERSION });
    expect(readSimVersions('/nonexistent/root')).toBeNull();
  });
});
