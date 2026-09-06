import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
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
    expect(csp).toContain("style-src 'self' https://fonts.googleapis.com");
    expect(csp).toContain('font-src https://fonts.gstatic.com');
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("worker-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('*');
    // The client sets styles through the CSSOM and spawns no blob: workers, so
    // neither relaxation is needed; every directive is a single token list.
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain('blob:');
    for (const directive of csp.split('; ')) expect(directive).toMatch(/^[a-z-]+( [^ ;]+)+$/);
    expect(sec.ContentSecurityPolicy.Override).toBe(true);
    expect(sec.StrictTransportSecurity).toEqual({ AccessControlMaxAgeSec: 31536000, IncludeSubdomains: true, Override: true });
    expect(sec.ContentTypeOptions).toEqual({ Override: true });
    expect(sec.FrameOptions).toEqual({ FrameOption: 'DENY', Override: true });
    expect(sec.ReferrerPolicy).toEqual({ ReferrerPolicy: 'strict-origin-when-cross-origin', Override: true });

    const [, dist] = only(t, 'AWS::CloudFront::Distribution');
    const cfg = dist.Properties.DistributionConfig;
    expect(references(cfg.DefaultCacheBehavior.ResponseHeadersPolicyId, policyId)).toBe(true);
  });

  it('does not cache 404/403 at the edge (a rolling deploy must not pin a missing hashed asset)', () => {
    const [, dist] = only(t, 'AWS::CloudFront::Distribution');
    const errors = dist.Properties.DistributionConfig.CustomErrorResponses as Array<Record<string, unknown>>;
    expect(errors).toHaveLength(2);
    expect(errors).toEqual(
      expect.arrayContaining([
        { ErrorCode: 404, ErrorCachingMinTTL: 0 },
        { ErrorCode: 403, ErrorCachingMinTTL: 0 },
      ]),
    );
    // The status must reach the client unchanged: no custom page, no rewritten code.
    for (const e of errors) {
      expect(e).not.toHaveProperty('ResponsePagePath');
      expect(e).not.toHaveProperty('ResponseCode');
    }
  });

  it('compresses static behaviours at the edge and leaves /api/* to the origin (CACHING_DISABLED cannot compress)', () => {
    const [, dist] = only(t, 'AWS::CloudFront::Distribution');
    const cfg = dist.Properties.DistributionConfig;
    const byPath = Object.fromEntries(cfg.CacheBehaviors.map((b: any) => [b.PathPattern, b]));
    expect(cfg.DefaultCacheBehavior.Compress).toBe(true);
    expect(byPath['/assets/*'].Compress).toBe(true);
    expect(byPath['/api/*'].Compress).not.toBe(true);
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

describe('container image build context', () => {
  const SCRATCH = '/tmp/claude-1000/-home-ec2-user-my-project-clawd-game/f8aa643c-bc48-400a-8c09-d71da38a73d7/scratchpad';

  /** Every file below `dir` as a path relative to it. */
  function walk(dir: string, prefix = '', out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (statSync(p).isDirectory()) walk(p, rel, out);
      else out.push(rel);
    }
    return out;
  }

  it('stages only what `npm run build` needs, so unrelated edits do not churn APP_VERSION', () => {
    mkdirSync(SCRATCH, { recursive: true });
    const outdir = mkdtempSync(join(SCRATCH, 'cdk-synth-'));
    try {
      const app = new cdk.App({ context: FLAGS, outdir });
      new ClawdEchoTowerStack(app, 'ClawdEchoTowerStackTest', {
        env: ENV,
        vpcId: VPC_ID,
        cloudfrontPrefixListId: PREFIX_LIST,
        desiredCount: 2,
      });
      const assembly = app.synth();
      const staged = readdirSync(assembly.directory)
        .filter((n) => n.startsWith('asset.') && statSync(join(assembly.directory, n)).isDirectory());
      expect(staged, 'exactly one asset: the Docker build context').toHaveLength(1);
      const context = join(assembly.directory, staged[0]);

      expect(readdirSync(context).sort()).toEqual(
        ['.dockerignore', 'Dockerfile', 'package-lock.json', 'package.json', 'public', 'src', 'tools', 'tsconfig.json'],
      );
      expect(readdirSync(join(context, 'tools')).sort()).toEqual(['build.mjs', 'lib.mjs']);
      expect(readdirSync(join(context, 'src')).sort()).toEqual(
        expect.arrayContaining(['client', 'server', 'shared', 'sim']),
      );
      const files = walk(context);
      expect(files.some((f) => f.startsWith('src/sim/levels.generated.ts'))).toBe(true);
      expect(files.filter((f) => f.endsWith('.md') || f.endsWith('.log'))).toEqual([]);
      expect(files.filter((f) => /^(levels|test|docs|infra|cdk\.out|node_modules|dist)\//.test(f))).toEqual([]);
      expect(files).not.toContain('cdk-outputs.json');
      expect(files).not.toContain('LICENSE');
    } finally {
      rmSync(outdir, { recursive: true, force: true });
    }
  });
});

describe('custom domain', () => {
  const DOMAIN = 'clawd-game.whchoi.net';
  const CERT = 'arn:aws:acm:us-east-1:061525506239:certificate/7d53182a-2a2a-4225-a319-4f94030561b7';

  it('serves the default *.cloudfront.net certificate and no aliases when no domain is configured', () => {
    const [, dist] = only(t, 'AWS::CloudFront::Distribution');
    const cfg = dist.Properties.DistributionConfig;
    expect(cfg.Aliases ?? []).toEqual([]);
    expect(cfg.ViewerCertificate?.AcmCertificateArn).toBeUndefined();
  });

  it('attaches the alias and the us-east-1 certificate (SNI, TLS 1.2 2021) when configured', () => {
    const d = synth({ domainName: DOMAIN, certificateArn: CERT });
    const [, dist] = only(d, 'AWS::CloudFront::Distribution');
    const cfg = dist.Properties.DistributionConfig;
    expect(cfg.Aliases).toEqual([DOMAIN]);
    expect(cfg.ViewerCertificate).toEqual({
      AcmCertificateArn: CERT,
      MinimumProtocolVersion: 'TLSv1.2_2021',
      SslSupportMethod: 'sni-only',
    });
    // DNS is managed outside the stack: no Route 53 records are created.
    d.resourceCountIs('AWS::Route53::RecordSet', 0);
  });

  it('publishes the custom URL as SiteUrl and keeps the distribution name for the CNAME', () => {
    const d = synth({ domainName: DOMAIN, certificateArn: CERT });
    const outs = d.findOutputs('SiteUrl');
    expect(Object.values(outs)[0].Value).toBe('https://' + DOMAIN + '/');
    expect(Object.keys(d.findOutputs('DistributionDomainName'))).toHaveLength(1);
  });

  it('refuses a domain without a certificate and vice versa', () => {
    expect(() => synth({ domainName: DOMAIN })).toThrow(/together/);
    expect(() => synth({ certificateArn: CERT })).toThrow(/together/);
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
  it('uses only the characters EC2 accepts in security group rule descriptions (a real deploy failed on an arrow)', () => {
    const ok = /^[a-zA-Z0-9. _\-:/()#,@[\]+=&;{}!$*]{1,255}$/;
    const rules = Object.values(t.findResources('AWS::EC2::SecurityGroupIngress')) as Resource[];
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) expect(r.Properties.Description, JSON.stringify(r.Properties)).toMatch(ok);
    const groups = Object.values(t.findResources('AWS::EC2::SecurityGroup')) as Resource[];
    for (const g of groups) {
      expect(g.Properties.GroupDescription).toMatch(ok);
      for (const e of g.Properties.SecurityGroupEgress ?? []) expect(e.Description ?? 'x').toMatch(ok);
      for (const e of g.Properties.SecurityGroupIngress ?? []) expect(e.Description ?? 'x').toMatch(ok);
    }
    // Keep every free-text description ASCII so no other service trips on it either.
    for (const r of Object.values(t.toJSON().Resources) as Resource[]) {
      const d = r.Properties?.Description ?? r.Properties?.Comment;
      if (typeof d === 'string') expect(d, r.Type).toMatch(/^[\x20-\x7E]*$/);
    }
    expect(t.toJSON().Description ?? '').toMatch(/^[\x20-\x7E]*$/);
  });
});
