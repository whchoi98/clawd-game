#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ClawdEchoTowerStack } from '../lib/stack.js';
import { contextNumber, DEFAULT_MAX_TASKS, DEFAULT_TASK_CPU, DEFAULT_TASK_MEMORY_MIB, validateTaskSizing } from '../lib/constructs/service.js';

const app = new cdk.App();

function contextString(key: string): string | undefined {
  const v: unknown = app.node.tryGetContext(key);
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

const desiredCount = contextNumber(app, 'desiredCount', 2);

// Task sizing knobs (P3-12) live in cdk.json context — `taskCpu`, `taskMemory`,
// `maxTasks` — and the Service construct reads them itself. Validating them
// here fails a bad `-c` override before any construct is built, with the
// Fargate combination rules in the message instead of a CloudFormation error.
validateTaskSizing({
  cpu: contextNumber(app, 'taskCpu', DEFAULT_TASK_CPU),
  memoryMiB: contextNumber(app, 'taskMemory', DEFAULT_TASK_MEMORY_MIB),
  maxTasks: contextNumber(app, 'maxTasks', DEFAULT_MAX_TASKS),
}, desiredCount);

new ClawdEchoTowerStack(app, 'ClawdEchoTowerStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  // `cdk.json` carries the defaults; `-c key=value` overrides them.
  vpcId: contextString('vpcId') ?? 'vpc-0dfa5610180dfa628',
  cloudfrontPrefixListId: contextString('cloudfrontPrefixListId') ?? 'pl-22a6434b',
  desiredCount,
  domainName: contextString('domainName'),
  certificateArn: contextString('certificateArn'),
  // Deliberately absent from cdk.json: pass `-c alarmEmail=ops@example.com` (or
  // leave unset and subscribe to the AlarmTopicArn output by hand).
  alarmEmail: contextString('alarmEmail'),
});
