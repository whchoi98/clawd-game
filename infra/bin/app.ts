#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ClawdEchoTowerStack } from '../lib/stack.js';

const app = new cdk.App();

function contextString(key: string): string | undefined {
  const v: unknown = app.node.tryGetContext(key);
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

function contextNumber(key: string, fallback: number): number {
  const v: unknown = app.node.tryGetContext(key);
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`context "${key}" must be a non-negative number, got ${String(v)}`);
  return n;
}

new ClawdEchoTowerStack(app, 'ClawdEchoTowerStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  // `cdk.json` carries the defaults; `-c key=value` overrides them.
  vpcId: contextString('vpcId') ?? 'vpc-0dfa5610180dfa628',
  cloudfrontPrefixListId: contextString('cloudfrontPrefixListId') ?? 'pl-22a6434b',
  desiredCount: contextNumber('desiredCount', 2),
  domainName: contextString('domainName'),
  certificateArn: contextString('certificateArn'),
  // Deliberately absent from cdk.json: pass `-c alarmEmail=ops@example.com` (or
  // leave unset and subscribe to the AlarmTopicArn output by hand).
  alarmEmail: contextString('alarmEmail'),
});
