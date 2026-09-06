/**
 * tools/postdeploy.mjs must find the stack outputs even when `cdk-outputs.json`
 * was never written: fall back to `aws cloudformation describe-stacks`, and only
 * when both fail print a usage hint and exit 2 (before any network check runs).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_REGION, STACK_NAME, describeStacksArgs, regionFromEnv, resolveOutputs,
} from '../../tools/postdeploy.mjs';

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const SCRIPT = join(ROOT, 'tools', 'postdeploy.mjs');
const SCRATCH = '/tmp/claude-1000/-home-ec2-user-my-project-clawd-game/f8aa643c-bc48-400a-8c09-d71da38a73d7/scratchpad';

const OUTPUTS = {
  ClawdEchoTowerStack: {
    SiteUrl: 'https://d1example.cloudfront.net/',
    AlbDnsName: 'alb-1.ap-northeast-2.elb.amazonaws.com',
    DistributionId: 'E1EXAMPLE',
  },
};

const DESCRIBE_STACKS = {
  Stacks: [
    {
      StackName: 'ClawdEchoTowerStack',
      Outputs: [
        { OutputKey: 'SiteUrl', OutputValue: 'https://d2fromcfn.cloudfront.net/' },
        { OutputKey: 'AlbDnsName', OutputValue: 'alb-2.ap-northeast-2.elb.amazonaws.com' },
      ],
    },
  ],
};

type SpawnCall = { cmd: string; args: string[] };

/** A spawnSync stand-in that records the call and answers with `result`. */
function fakeSpawn(result: { status: number | null; stdout?: string; stderr?: string; error?: Error }, calls: SpawnCall[]) {
  return (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error };
  };
}

describe('tools/postdeploy.mjs outputs resolution', () => {
  let dir: string;
  beforeAll(() => {
    mkdirSync(SCRATCH, { recursive: true });
    dir = mkdtempSync(join(SCRATCH, 'postdeploy-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads cdk-outputs.json when it exists and never calls the CLI', () => {
    const file = join(dir, 'cdk-outputs.json');
    writeFileSync(file, JSON.stringify(OUTPUTS));
    const calls: SpawnCall[] = [];
    const r = resolveOutputs({ outputsPath: file, spawn: fakeSpawn({ status: 0 }, calls) });
    expect(r.outputs).toEqual(OUTPUTS.ClawdEchoTowerStack);
    expect(r.source).toBe(file);
    expect(r.errors).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('accepts an outputs file keyed by a differently named stack', () => {
    const file = join(dir, 'other.json');
    writeFileSync(file, JSON.stringify({ SomeOtherStack: OUTPUTS.ClawdEchoTowerStack }));
    const r = resolveOutputs({ outputsPath: file, spawn: fakeSpawn({ status: 0 }, []) });
    expect(r.outputs?.SiteUrl).toBe(OUTPUTS.ClawdEchoTowerStack.SiteUrl);
  });

  it('falls back to `aws cloudformation describe-stacks` when the file is missing', () => {
    const missing = join(dir, 'nope', 'cdk-outputs.json');
    const calls: SpawnCall[] = [];
    const r = resolveOutputs({
      outputsPath: missing,
      env: { AWS_REGION: 'us-west-2' },
      spawn: fakeSpawn({ status: 0, stdout: JSON.stringify(DESCRIBE_STACKS) }, calls),
    });
    expect(r.outputs).toEqual({
      SiteUrl: 'https://d2fromcfn.cloudfront.net/',
      AlbDnsName: 'alb-2.ap-northeast-2.elb.amazonaws.com',
    });
    expect(r.source).toMatch(/describe-stacks/);
    expect(r.errors).toHaveLength(1); // the missing file is reported, not fatal
    expect(r.errors[0]).toContain(missing);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('aws');
    expect(calls[0].args).toEqual(
      describeStacksArgs({ stackName: STACK_NAME, region: 'us-west-2' }),
    );
    expect(calls[0].args).toEqual(
      expect.arrayContaining(['cloudformation', 'describe-stacks', '--stack-name', 'ClawdEchoTowerStack', '--region', 'us-west-2']),
    );
  });

  it('falls back when the file exists but is unusable (bad JSON or no SiteUrl)', () => {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{ not json');
    const calls: SpawnCall[] = [];
    const r = resolveOutputs({ outputsPath: bad, env: {}, spawn: fakeSpawn({ status: 0, stdout: JSON.stringify(DESCRIBE_STACKS) }, calls) });
    expect(r.outputs?.SiteUrl).toBe('https://d2fromcfn.cloudfront.net/');
    expect(calls).toHaveLength(1);

    const empty = join(dir, 'empty.json');
    writeFileSync(empty, JSON.stringify({ ClawdEchoTowerStack: { TableName: 't' } }));
    const r2 = resolveOutputs({ outputsPath: empty, env: {}, spawn: fakeSpawn({ status: 0, stdout: JSON.stringify(DESCRIBE_STACKS) }, []) });
    expect(r2.outputs?.SiteUrl).toBe('https://d2fromcfn.cloudfront.net/');
    expect(r2.errors[0]).toMatch(/SiteUrl/);
  });

  it('picks the region from AWS_REGION, then CDK_DEFAULT_REGION, then ap-northeast-2', () => {
    expect(DEFAULT_REGION).toBe('ap-northeast-2');
    expect(regionFromEnv({})).toBe('ap-northeast-2');
    expect(regionFromEnv({ CDK_DEFAULT_REGION: 'eu-west-1' })).toBe('eu-west-1');
    expect(regionFromEnv({ AWS_REGION: 'us-east-1', CDK_DEFAULT_REGION: 'eu-west-1' })).toBe('us-east-1');
    const calls: SpawnCall[] = [];
    resolveOutputs({ outputsPath: join(dir, 'missing.json'), env: {}, spawn: fakeSpawn({ status: 1, stderr: 'x' }, calls) });
    expect(calls[0].args).toEqual(expect.arrayContaining(['--region', 'ap-northeast-2']));
  });

  it('reports both failures when the file is missing and the CLI is unavailable or errors', () => {
    const missing = join(dir, 'missing.json');
    const notFound = resolveOutputs({
      outputsPath: missing,
      env: {},
      spawn: fakeSpawn({ status: null, error: Object.assign(new Error('spawnSync aws ENOENT'), { code: 'ENOENT' }) }, []),
    });
    expect(notFound.outputs).toBeNull();
    expect(notFound.errors).toHaveLength(2);
    expect(notFound.errors[1]).toMatch(/ENOENT/);

    const denied = resolveOutputs({
      outputsPath: missing,
      env: {},
      spawn: fakeSpawn({ status: 254, stderr: 'An error occurred (ValidationError): Stack with id ClawdEchoTowerStack does not exist' }, []),
    });
    expect(denied.outputs).toBeNull();
    expect(denied.errors).toHaveLength(2);
    expect(denied.errors[1]).toMatch(/does not exist/);
  });

  it('as a CLI: exits 2 with a usage hint when both sources fail, before any network check', () => {
    const emptyBin = join(dir, 'empty-bin');
    mkdirSync(emptyBin, { recursive: true });
    const r = spawnSync(process.execPath, [SCRIPT, '--outputs', join(dir, 'absent.json')], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 20_000,
      // No `aws` on PATH: the fallback must fail fast with ENOENT, not hang.
      env: { PATH: emptyBin, HOME: process.env.HOME ?? dir },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/absent\.json/);
    expect(r.stderr).toMatch(/describe-stacks/);
    expect(r.stderr).toMatch(/npm run deploy/);
    expect(r.stderr).toMatch(/usage: node tools\/postdeploy\.mjs/);
    expect(r.stdout).not.toMatch(/post-deploy checks/);
  });
});
