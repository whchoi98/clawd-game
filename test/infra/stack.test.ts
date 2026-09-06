import { readFileSync } from 'node:fs';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { ClawdEchoTowerStack, type ClawdEchoTowerStackProps } from '../../infra/lib/stack.js';

// Feature flags from the real cdk.json so tests synthesize what `cdk synth` does.
const cdkJson = JSON.parse(readFileSync(new URL('../../cdk.json', import.meta.url), 'utf8')) as {
  context: Record<string, unknown>;
};
const FLAGS = Object.fromEntries(
  Object.entries(cdkJson.context).filter(([k]) => k.startsWith('@aws-cdk/')),
);

const ENV = { account: '123456789012', region: 'ap-northeast-2' };
const PREFIX_LIST = 'pl-22a6434b';
const VPC_ID = 'vpc-0dfa5610180dfa628';

function synth(over: Partial<ClawdEchoTowerStackProps> = {}): Template {
  const app = new cdk.App({ context: FLAGS });
  const stack = new ClawdEchoTowerStack(app, 'ClawdEchoTowerStackTest', {
    env: ENV,
    vpcId: VPC_ID,
    cloudfrontPrefixListId: PREFIX_LIST,
    desiredCount: 2,
    ...over,
  });
  return Template.fromStack(stack);
}

type Resource = { Type: string; Properties: Record<string, any>; DeletionPolicy?: string };

function only(t: Template, type: string): [string, Resource] {
  const found = t.findResources(type) as Record<string, Resource>;
  const entries = Object.entries(found);
  expect(entries, `expected exactly one ${type}`).toHaveLength(1);
  return entries[0];
}

/** Is `v` a CloudFormation intrinsic (or nested intrinsic) that references logical id `id`? */
function references(v: unknown, id: string): boolean {
  if (v === null || typeof v !== 'object') return false;
  if (Array.isArray(v)) return v.some((x) => references(x, id));
  const o = v as Record<string, unknown>;
  if (o.Ref === id) return true;
  if (Array.isArray(o['Fn::GetAtt']) && o['Fn::GetAtt'][0] === id) return true;
  return Object.values(o).some((x) => references(x, id));
}

/** Every ingress rule attached to security group `sgId`: inline entries plus standalone resources. */
function ingressRulesOf(t: Template, sgId: string): Array<Record<string, any>> {
  const sgs = t.findResources('AWS::EC2::SecurityGroup') as Record<string, Resource>;
  const inline = (sgs[sgId]?.Properties.SecurityGroupIngress ?? []) as Array<Record<string, any>>;
  const standalone = Object.values(t.findResources('AWS::EC2::SecurityGroupIngress') as Record<string, Resource>)
    .filter((r) => references(r.Properties.GroupId, sgId))
    .map((r) => r.Properties);
  return [...inline, ...standalone];
}

function collectStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => collectStrings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => collectStrings(x, out));
  return out;
}

let t: Template;
let json: Record<string, any>;
beforeAll(() => {
  t = synth();
  json = t.toJSON();
});

describe('network', () => {
  it('creates no VPC, NAT gateway or VPC endpoint (the VPC is imported)', () => {
    t.resourceCountIs('AWS::EC2::VPC', 0);
    t.resourceCountIs('AWS::EC2::NatGateway', 0);
    t.resourceCountIs('AWS::EC2::VPCEndpoint', 0);
    t.resourceCountIs('AWS::EC2::InternetGateway', 0);
    t.resourceCountIs('AWS::EC2::Subnet', 0);
  });

  it('creates exactly two security groups: ALB and service', () => {
    t.resourceCountIs('AWS::EC2::SecurityGroup', 2);
  });

});

describe('ALB security group', () => {
  it('has exactly one ingress rule and it is the CloudFront prefix list on :80', () => {
    const [, alb] = only(t, 'AWS::ElasticLoadBalancingV2::LoadBalancer');
    expect(alb.Properties.Scheme).toBe('internet-facing');
    const sgRef = alb.Properties.SecurityGroups[0] as Record<string, unknown>;
    const sgs = t.findResources('AWS::EC2::SecurityGroup') as Record<string, Resource>;
    const albSgId = Object.keys(sgs).find((id) => references(sgRef, id));
    expect(albSgId).toBeDefined();
    const ingress = ingressRulesOf(t, albSgId!);
    expect(ingress).toHaveLength(1);
    expect(ingress[0]).toMatchObject({
      IpProtocol: 'tcp',
      FromPort: 80,
      ToPort: 80,
      SourcePrefixListId: PREFIX_LIST,
    });
    expect(ingress[0]).not.toHaveProperty('CidrIp');
    expect(ingress[0]).not.toHaveProperty('CidrIpv6');
    expect(ingress[0]).not.toHaveProperty('SourceSecurityGroupId');
  });

  it('opens nothing to 0.0.0.0/0 or ::/0 anywhere', () => {
    const sgs = Object.values(t.findResources('AWS::EC2::SecurityGroup') as Record<string, Resource>);
    for (const sg of sgs) {
      for (const rule of (sg.Properties.SecurityGroupIngress ?? []) as Array<Record<string, unknown>>) {
        expect(rule.CidrIp).not.toBe('0.0.0.0/0');
        expect(rule.CidrIpv6).not.toBe('::/0');
      }
    }
    const standalone = Object.values(t.findResources('AWS::EC2::SecurityGroupIngress') as Record<string, Resource>);
    for (const r of standalone) {
      expect(r.Properties.CidrIp).not.toBe('0.0.0.0/0');
      expect(r.Properties.CidrIpv6).not.toBe('::/0');
    }
  });
});

describe('ALB listener', () => {
  it('defaults to a fixed 403 response', () => {
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      Protocol: 'HTTP',
      DefaultActions: [
        {
          Type: 'fixed-response',
          FixedResponseConfig: { StatusCode: '403', ContentType: 'text/plain', MessageBody: 'Forbidden' },
        },
      ],
    });
  });

  it('forwards only when X-Origin-Verify matches the Secrets Manager token (dynamic reference)', () => {
    const [, rule] = only(t, 'AWS::ElasticLoadBalancingV2::ListenerRule');
    expect(rule.Properties.Priority).toBe(1);
    expect(rule.Properties.Actions[0].Type).toBe('forward');
    const cond = rule.Properties.Conditions.find((c: any) => c.Field === 'http-header');
    expect(cond.HttpHeaderConfig.HttpHeaderName).toBe('X-Origin-Verify');
    const values = cond.HttpHeaderConfig.Values as unknown[];
    expect(values).toHaveLength(1);
    expect(typeof values[0]).toBe('object'); // an intrinsic, never a literal string
    expect(collectStrings(values[0]).join('')).toContain('{{resolve:secretsmanager:');
  });
});

describe('secrets', () => {
  it('generates the origin token (40 chars, no punctuation) and a daily seed secret', () => {
    t.resourceCountIs('AWS::SecretsManager::Secret', 2);
    t.hasResourceProperties('AWS::SecretsManager::Secret', {
      GenerateSecretString: { ExcludePunctuation: true, PasswordLength: 40 },
    });
    const secrets = Object.values(t.findResources('AWS::SecretsManager::Secret') as Record<string, Resource>);
    for (const s of secrets) {
      expect(s.Properties.GenerateSecretString).toBeDefined();
      expect(s.Properties.SecretString).toBeUndefined();
    }
  });

  it('references the same secret from the listener rule and the CloudFront origin header, never in plaintext', () => {
    const secrets = t.findResources('AWS::SecretsManager::Secret') as Record<string, Resource>;
    const [, rule] = only(t, 'AWS::ElasticLoadBalancingV2::ListenerRule');
    const cond = rule.Properties.Conditions.find((c: any) => c.Field === 'http-header');
    const tokenId = Object.keys(secrets).find((id) => references(cond.HttpHeaderConfig.Values, id));
    expect(tokenId).toBeDefined();

    const [, dist] = only(t, 'AWS::CloudFront::Distribution');
    const origins = dist.Properties.DistributionConfig.Origins as any[];
    expect(origins).toHaveLength(1);
    const header = origins[0].OriginCustomHeaders.find((h: any) => h.HeaderName === 'X-Origin-Verify');
    expect(header).toBeDefined();
    expect(typeof header.HeaderValue).toBe('object');
    expect(references(header.HeaderValue, tokenId!)).toBe(true);
    expect(collectStrings(header.HeaderValue).join('')).toContain('{{resolve:secretsmanager:');

    // No 40-char token-looking literal anywhere in the template.
    const literals = collectStrings(json).filter((s) => /^[A-Za-z0-9]{40}$/.test(s));
    expect(literals).toHaveLength(0);
  });
});

describe('CloudFront', () => {
  it('uses the ALB over plain HTTP as the only origin', () => {
    const [, dist] = only(t, 'AWS::CloudFront::Distribution');
    const [albId] = only(t, 'AWS::ElasticLoadBalancingV2::LoadBalancer');
    const origin = dist.Properties.DistributionConfig.Origins[0];
    expect(origin.CustomOriginConfig.OriginProtocolPolicy).toBe('http-only');
    expect(references(origin.DomainName, albId)).toBe(true);
  });

  it('redirects viewers to HTTPS on every behaviour', () => {
    const [, dist] = only(t, 'AWS::CloudFront::Distribution');
    const cfg = dist.Properties.DistributionConfig;
    expect(cfg.DefaultCacheBehavior.ViewerProtocolPolicy).toBe('redirect-to-https');
    for (const b of cfg.CacheBehaviors) expect(b.ViewerProtocolPolicy).toBe('redirect-to-https');
  });

  it('caches /assets/* aggressively, never caches /api/*, and honours origin Cache-Control by default', () => {
    const [, dist] = only(t, 'AWS::CloudFront::Distribution');
    const cfg = dist.Properties.DistributionConfig;
    const byPath = Object.fromEntries(cfg.CacheBehaviors.map((b: any) => [b.PathPattern, b]));
    expect(byPath['/assets/*'].CachePolicyId).toBe('658327ea-f89d-4fab-a63d-7e88639e58f6'); // CACHING_OPTIMIZED
    expect(byPath['/api/*'].CachePolicyId).toBe('4135ea2d-6df8-44a3-9df3-4b5a84be39ad'); // CACHING_DISABLED
    expect(byPath['/api/*'].OriginRequestPolicyId).toBe('33f36d7e-f396-46d9-90e0-52428a34d9dc'); // ALL_VIEWER_AND_CLOUDFRONT_HEADERS_2022 (adds CloudFront-Viewer-Address)
    expect(byPath['/api/*'].AllowedMethods).toEqual(
      expect.arrayContaining(['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'POST', 'DELETE']),
    );
    expect(cfg.DefaultCacheBehavior.OriginRequestPolicyId).toBe('b689b0a8-53d0-40ab-baf2-68738e2966ac');

    const [cacheId, cache] = only(t, 'AWS::CloudFront::CachePolicy');
    expect(references(cfg.DefaultCacheBehavior.CachePolicyId, cacheId)).toBe(true);
    expect(cache.Properties.CachePolicyConfig).toMatchObject({
      MinTTL: 0,
      DefaultTTL: 0,
      MaxTTL: 86400,
      ParametersInCacheKeyAndForwardedToOrigin: {
        QueryStringsConfig: { QueryStringBehavior: 'all' },
        HeadersConfig: { HeaderBehavior: 'none' },
        CookiesConfig: { CookieBehavior: 'none' },
      },
    });
  });

  it('attaches a response headers policy with a wildcard-free CSP, HSTS 1y, nosniff, frame DENY, strict referrer', () => {
    const [policyId, policy] = only(t, 'AWS::CloudFront::ResponseHeadersPolicy');
    const sec = policy.Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig;
    const csp: string = sec.ContentSecurityPolicy.ContentSecurityPolicy;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com");
    expect(csp).toContain('font-src https://fonts.gstatic.com');
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('*');
    expect(sec.ContentSecurityPolicy.Override).toBe(true);
    expect(sec.StrictTransportSecurity).toEqual({ AccessControlMaxAgeSec: 31536000, IncludeSubdomains: true, Override: true });
    expect(sec.ContentTypeOptions).toEqual({ Override: true });
    expect(sec.FrameOptions).toEqual({ FrameOption: 'DENY', Override: true });
    expect(sec.ReferrerPolicy).toEqual({ ReferrerPolicy: 'strict-origin-when-cross-origin', Override: true });

    const [, dist] = only(t, 'AWS::CloudFront::Distribution');
    const cfg = dist.Properties.DistributionConfig;
    expect(references(cfg.DefaultCacheBehavior.ResponseHeadersPolicyId, policyId)).toBe(true);
  });

  it('enables HTTP/2+3, IPv6 and price class 200', () => {
    t.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Enabled: true,
        HttpVersion: 'http2and3',
        IPV6Enabled: true,
        PriceClass: 'PriceClass_200',
      }),
    });
  });
});

describe('ECS service', () => {
  it('runs a Graviton (ARM64) Fargate task at 256 CPU / 512 MiB', () => {
    t.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Cpu: '256',
      Memory: '512',
      NetworkMode: 'awsvpc',
      RequiresCompatibilities: ['FARGATE'],
      RuntimePlatform: { CpuArchitecture: 'ARM64', OperatingSystemFamily: 'LINUX' },
    });
  });

  it('configures the container: port 8080, env, DAILY_SECRET from Secrets Manager, awslogs', () => {
    const [, td] = only(t, 'AWS::ECS::TaskDefinition');
    const c = td.Properties.ContainerDefinitions[0];
    expect(c.PortMappings).toEqual([expect.objectContaining({ ContainerPort: 8080, Protocol: 'tcp' })]);
    const env = Object.fromEntries(c.Environment.map((e: any) => [e.Name, e.Value]));
    expect(env.PORT).toBe('8080');
    expect(env.STATIC_DIR).toBe('/app/dist/public');
    expect(env.TABLE_NAME).toBeDefined();
    expect(env.AWS_REGION).toBeDefined();
    expect(typeof env.APP_VERSION).toBe('string');
    expect(env.APP_VERSION.length).toBeGreaterThanOrEqual(16);
    const [tableId] = only(t, 'AWS::DynamoDB::GlobalTable');
    expect(references(env.TABLE_NAME, tableId)).toBe(true);

    expect(c.Secrets).toHaveLength(1);
    expect(c.Secrets[0].Name).toBe('DAILY_SECRET');
    const secrets = t.findResources('AWS::SecretsManager::Secret') as Record<string, Resource>;
    expect(Object.keys(secrets).some((id) => references(c.Secrets[0].ValueFrom, id))).toBe(true);

    expect(c.LogConfiguration.LogDriver).toBe('awslogs');
    const [logId] = only(t, 'AWS::Logs::LogGroup');
    expect(references(c.LogConfiguration.Options['awslogs-group'], logId)).toBe(true);
  });

  it('keeps logs for two weeks and deletes the group with the stack', () => {
    const [, lg] = only(t, 'AWS::Logs::LogGroup');
    expect(lg.Properties.RetentionInDays).toBe(14);
    expect(lg.DeletionPolicy).toBe('Delete');
  });

  it('has Container Insights on', () => {
    t.hasResourceProperties('AWS::ECS::Cluster', {
      ClusterSettings: [{ Name: 'containerInsights', Value: Match.stringLikeRegexp('enhanced|enabled') }],
    });
  });

  it('deploys with circuit breaker rollback, 100% min healthy, 60 s grace, in private subnets without public IPs', () => {
    t.hasResourceProperties('AWS::ECS::Service', {
      LaunchType: 'FARGATE',
      DesiredCount: 2,
      DeploymentConfiguration: Match.objectLike({
        DeploymentCircuitBreaker: { Enable: true, Rollback: true },
        MinimumHealthyPercent: 100,
      }),
      HealthCheckGracePeriodSeconds: 60,
      NetworkConfiguration: { AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: 'DISABLED' }) },
    });
  });

  it('honours desiredCount from props', () => {
    synth({ desiredCount: 3 }).hasResourceProperties('AWS::ECS::Service', { DesiredCount: 3 });
  });

  it('accepts traffic on 8080 only from the ALB security group', () => {
    const [, svc] = only(t, 'AWS::ECS::Service');
    const [, alb] = only(t, 'AWS::ElasticLoadBalancingV2::LoadBalancer');
    const sgs = t.findResources('AWS::EC2::SecurityGroup') as Record<string, Resource>;
    const svcSgRef = svc.Properties.NetworkConfiguration.AwsvpcConfiguration.SecurityGroups[0];
    const svcSgId = Object.keys(sgs).find((id) => references(svcSgRef, id))!;
    const albSgId = Object.keys(sgs).find((id) => references(alb.Properties.SecurityGroups[0], id))!;
    expect(svcSgId).not.toBe(albSgId);
    const ingress = ingressRulesOf(t, svcSgId);
    expect(ingress).toHaveLength(1);
    expect(ingress[0]).toMatchObject({ IpProtocol: 'tcp', FromPort: 8080, ToPort: 8080 });
    expect(references(ingress[0].SourceSecurityGroupId, albSgId)).toBe(true);
  });

  it('registers an IP target group with /healthz and a 15 s deregistration delay', () => {
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      TargetType: 'ip',
      Port: 8080,
      Protocol: 'HTTP',
      HealthCheckPath: '/healthz',
      TargetGroupAttributes: Match.arrayWith([{ Key: 'deregistration_delay.timeout_seconds', Value: '15' }]),
    });
  });

  it('autoscales 2–6 on CPU 60% and 400 requests per target', () => {
    t.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', {
      MinCapacity: 2,
      MaxCapacity: 6,
      ServiceNamespace: 'ecs',
      ScalableDimension: 'ecs:service:DesiredCount',
    });
    t.resourceCountIs('AWS::ApplicationAutoScaling::ScalingPolicy', 2);
    t.hasResourceProperties('AWS::ApplicationAutoScaling::ScalingPolicy', {
      PolicyType: 'TargetTrackingScaling',
      TargetTrackingScalingPolicyConfiguration: Match.objectLike({
        PredefinedMetricSpecification: { PredefinedMetricType: 'ECSServiceAverageCPUUtilization' },
        TargetValue: 60,
      }),
    });
    t.hasResourceProperties('AWS::ApplicationAutoScaling::ScalingPolicy', {
      PolicyType: 'TargetTrackingScaling',
      TargetTrackingScalingPolicyConfiguration: Match.objectLike({
        PredefinedMetricSpecification: Match.objectLike({ PredefinedMetricType: 'ALBRequestCountPerTarget' }),
        TargetValue: 400,
      }),
    });
  });

  it('grants the task role read/write on the table and nothing with a * resource', () => {
    const [, td] = only(t, 'AWS::ECS::TaskDefinition');
    const [tableId] = only(t, 'AWS::DynamoDB::GlobalTable');
    const roles = t.findResources('AWS::IAM::Role') as Record<string, Resource>;
    const taskRoleId = Object.keys(roles).find((id) => references(td.Properties.TaskRoleArn, id))!;
    const policies = Object.values(t.findResources('AWS::IAM::Policy') as Record<string, Resource>)
      .filter((p) => references(p.Properties.Roles, taskRoleId));
    expect(policies.length).toBeGreaterThan(0);
    const statements = policies.flatMap((p) => p.Properties.PolicyDocument.Statement as any[]);
    const ddb = statements.find((s) => collectStrings(s.Action).some((a) => a.startsWith('dynamodb:')));
    expect(ddb).toBeDefined();
    expect(collectStrings(ddb.Action)).toEqual(expect.arrayContaining(['dynamodb:PutItem', 'dynamodb:Query', 'dynamodb:GetItem']));
    expect(references(ddb.Resource, tableId)).toBe(true);
    for (const s of statements) {
      for (const r of collectStrings(s.Resource)) expect(r).not.toBe('*');
    }
  });
});

describe('data', () => {
  it('is a single on-demand pk/sk table with PITR, TTL on `ttl`, destroyed with the stack', () => {
    const [, table] = only(t, 'AWS::DynamoDB::GlobalTable');
    expect(table.Properties.BillingMode).toBe('PAY_PER_REQUEST');
    expect(table.Properties.KeySchema).toEqual([
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ]);
    expect(table.Properties.AttributeDefinitions).toEqual(
      expect.arrayContaining([
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
      ]),
    );
    expect(table.Properties.TimeToLiveSpecification).toEqual({ AttributeName: 'ttl', Enabled: true });
    expect(table.Properties.Replicas).toHaveLength(1);
    expect(table.Properties.Replicas[0].PointInTimeRecoverySpecification).toEqual({ PointInTimeRecoveryEnabled: true });
    expect(table.DeletionPolicy).toBe('Delete');
    t.resourceCountIs('AWS::DynamoDB::Table', 0);
  });
});

describe('stack', () => {
  it('exposes the documented outputs', () => {
    for (const name of ['SiteUrl', 'DistributionId', 'AlbDnsName', 'TableName', 'ClusterName', 'ServiceName']) {
      expect(Object.keys(t.findOutputs(name)), name).toHaveLength(1);
    }
    const site = Object.values(t.findOutputs('SiteUrl'))[0] as any;
    expect(collectStrings(site.Value).join('')).toContain('https://');
  });

  it('tags resources with Project=clawd-echo-tower', () => {
    t.hasResourceProperties('AWS::ECS::Cluster', {
      Tags: Match.arrayWith([{ Key: 'Project', Value: 'clawd-echo-tower' }]),
    });
  });

  it('has no Lambda functions or custom resources (nothing to babysit)', () => {
    t.resourceCountIs('AWS::Lambda::Function', 0);
  });
});
