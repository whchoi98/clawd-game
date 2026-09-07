import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as appscaling from 'aws-cdk-lib/aws-applicationautoscaling';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct, type IConstruct } from 'constructs';

/** Header CloudFront adds and the ALB listener rule checks. */
export const ORIGIN_VERIFY_HEADER = 'X-Origin-Verify';
/** Container port the Fastify server listens on. */
export const APP_PORT = 8080;

/**
 * Paths kept out of the Docker build context (dockerignore syntax). `npm run
 * build` compiles src/ (including the generated src/sim/levels.generated.ts)
 * and public/ with tools/build.mjs + tools/lib.mjs; nothing else is needed.
 */
export const IMAGE_CONTEXT_EXCLUDE: readonly string[] = [
  'node_modules', 'dist', 'cdk.out', '.git', '.github', '.gitignore', '.claude', '.superpowers', 'docs', 'test', 'levels',
  'tools/dev.mjs', 'tools/qa', 'tools/load', 'tools/postdeploy.*', 'tools/icons.*', 'tools/release.*', 'tools/stats.*', 'tools/solve.ts', 'tools/hash-corpus.ts', 'infra', 'cdk.json', 'cdk.context.json',
  'cdk-outputs.json', 'vitest.config.ts', 'clawd-jump.tar.gz', 'LICENSE', '**/*.md', '*.log', '.env',
];

// ---------------------------------------------------------------- sizing knobs (P3-12)
/**
 * Task size and fleet ceiling, read from CDK context so an operator changes
 * them with `-c taskCpu=1024 -c taskMemory=2048 -c maxTasks=20` (or cdk.json)
 * without touching code. Props win over context, context over these defaults.
 * The floor stays at 2 tasks (one per AZ, and the healthy-hosts alarm assumes it).
 */
export const DEFAULT_TASK_CPU = 512;
export const DEFAULT_TASK_MEMORY_MIB = 1024;
export const DEFAULT_MAX_TASKS = 10;
export const MIN_TASKS = 2;

const mibRange = (from: number, to: number, step = 1024): number[] => {
  const out: number[] = [];
  for (let m = from; m <= to; m += step) out.push(m);
  return out;
};
/** Memory (MiB) Fargate accepts for each CPU size (Linux tasks). */
export const FARGATE_MEMORY_BY_CPU: Readonly<Record<number, readonly number[]>> = {
  256: [512, 1024, 2048],
  512: mibRange(1024, 4096),
  1024: mibRange(2048, 8192),
  2048: mibRange(4096, 16384),
  4096: mibRange(8192, 30720),
};

/** Target-tracking policies (unchanged from launch). */
export const SCALING_TARGETS = { cpuPercent: 60, requestsPerTarget: 400 } as const;
/**
 * Step scaling on ALB TargetResponseTime p95: target tracking cannot follow a
 * percentile, so a CloudWatch alarm on the p95 (1-minute periods, two in a
 * row above 0.8 s) adds two tasks at once, then waits out the cooldown.
 */
export const LATENCY_STEP_SCALING = {
  thresholdSeconds: 0.8,
  periodMinutes: 1,
  evaluationPeriods: 2,
  addTasks: 2,
  cooldownSeconds: 60,
} as const;

export interface TaskSizing {
  /** Fargate CPU units (256 = 0.25 vCPU). */
  cpu: number;
  memoryMiB: number;
  /** Autoscaling ceiling; the floor is MIN_TASKS. */
  maxTasks: number;
}

/** A numeric context value (`-c key=value` or cdk.json), or `fallback` when unset. */
export function contextNumber(scope: IConstruct, key: string, fallback: number): number {
  const v: unknown = scope.node.tryGetContext(key);
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`context "${key}" must be a non-negative number, got ${String(v)}`);
  return n;
}

/** Throws with a readable message when the combination is not one Fargate runs. */
export function validateTaskSizing(sizing: TaskSizing, desiredCount?: number): TaskSizing {
  const allowed = FARGATE_MEMORY_BY_CPU[sizing.cpu];
  if (!allowed) {
    throw new Error(`taskCpu ${sizing.cpu} is not a Fargate CPU size (one of ${Object.keys(FARGATE_MEMORY_BY_CPU).join(', ')})`);
  }
  if (!allowed.includes(sizing.memoryMiB)) {
    throw new Error(`taskMemory ${sizing.memoryMiB} MiB is not valid for ${sizing.cpu} CPU units (allowed: ${allowed.join(', ')})`);
  }
  if (!Number.isInteger(sizing.maxTasks) || sizing.maxTasks < MIN_TASKS) {
    throw new Error(`maxTasks must be an integer >= ${MIN_TASKS}, got ${sizing.maxTasks}`);
  }
  if (desiredCount !== undefined && desiredCount > sizing.maxTasks) {
    throw new Error(`desiredCount ${desiredCount} exceeds maxTasks ${sizing.maxTasks}`);
  }
  return sizing;
}

export interface ServiceProps {
  readonly vpc: ec2.IVpc;
  readonly albSubnets: ec2.SubnetSelection;
  readonly serviceSubnets: ec2.SubnetSelection;
  readonly assignPublicIp: boolean;
  /** `com.amazonaws.global.cloudfront.origin-facing` managed prefix list id for the region. */
  readonly cloudfrontPrefixListId: string;
  readonly desiredCount: number;
  readonly table: dynamodb.ITableV2;
  /** Docker build context; defaults to the repository root. */
  readonly imageDirectory?: string;
  /** Fargate CPU units; default context `taskCpu`, then DEFAULT_TASK_CPU. */
  readonly taskCpu?: number;
  /** Task memory in MiB; default context `taskMemory`, then DEFAULT_TASK_MEMORY_MIB. */
  readonly taskMemory?: number;
  /** Autoscaling ceiling; default context `maxTasks`, then DEFAULT_MAX_TASKS. */
  readonly maxTasks?: number;
}

/** The sizing a Service will use: explicit props, else context, else defaults — validated. */
export function resolveTaskSizing(scope: IConstruct, props: Pick<ServiceProps, 'taskCpu' | 'taskMemory' | 'maxTasks' | 'desiredCount'>): TaskSizing {
  return validateTaskSizing({
    cpu: props.taskCpu ?? contextNumber(scope, 'taskCpu', DEFAULT_TASK_CPU),
    memoryMiB: props.taskMemory ?? contextNumber(scope, 'taskMemory', DEFAULT_TASK_MEMORY_MIB),
    maxTasks: props.maxTasks ?? contextNumber(scope, 'maxTasks', DEFAULT_MAX_TASKS),
  }, props.desiredCount);
}

/**
 * ALB → ECS Fargate (Graviton) running the Fastify server.
 *
 * The ALB is internet-facing but its security group admits only CloudFront's
 * origin-facing prefix list, and the listener answers 403 unless the request
 * carries the `X-Origin-Verify` token. The token is generated by Secrets
 * Manager and only ever appears in the template as a dynamic reference.
 *
 * Scaling (P3-12): MIN_TASKS..maxTasks with three policies — CPU 60 % and
 * 400 requests/target (target tracking) plus a step policy on the ALB
 * TargetResponseTime p95 (> 0.8 s for two minutes → +2 tasks). Task size and
 * the ceiling come from context (`taskCpu`, `taskMemory`, `maxTasks`).
 */
export class Service extends Construct {
  readonly cluster: ecs.Cluster;
  readonly service: ecs.FargateService;
  readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  readonly listener: elbv2.ApplicationListener;
  readonly targetGroup: elbv2.ApplicationTargetGroup;
  readonly albSecurityGroup: ec2.SecurityGroup;
  readonly serviceSecurityGroup: ec2.SecurityGroup;
  /** Secrets Manager secret holding the origin-verify token. */
  readonly originToken: secretsmanager.Secret;
  /**
   * The token as a CloudFormation dynamic reference (`{{resolve:secretsmanager:…}}`).
   * Safe to embed in the template: CloudFormation resolves it at deploy time.
   */
  readonly originTokenValue: string;
  readonly dailySecret: secretsmanager.Secret;
  /** HMAC key for playerTag; the server falls back to DAILY_SECRET when unset. */
  readonly tagSecret: secretsmanager.Secret;
  readonly logGroup: logs.LogGroup;
  /** Content hash of the container image; exported to the app as APP_VERSION. */
  readonly imageHash: string;
  /** The sizing this service was synthesized with. */
  readonly sizing: TaskSizing;

  constructor(scope: Construct, id: string, props: ServiceProps) {
    super(scope, id);
    const stack = cdk.Stack.of(this);
    this.sizing = resolveTaskSizing(this, props);

    // --- secrets -----------------------------------------------------------
    this.originToken = new secretsmanager.Secret(this, 'OriginToken', {
      description: 'CLAWD ECHO TOWER: CloudFront to ALB X-Origin-Verify token',
      generateSecretString: { excludePunctuation: true, passwordLength: 40 },
    });
    // unsafeUnwrap() is the documented escape hatch: the rendered value is a
    // dynamic reference, not the plaintext secret.
    this.originTokenValue = this.originToken.secretValue.unsafeUnwrap();

    this.dailySecret = new secretsmanager.Secret(this, 'DailySecret', {
      description: 'CLAWD ECHO TOWER: HMAC key for daily tower seeds',
      generateSecretString: { excludePunctuation: true, passwordLength: 48 },
    });

    // Separate from DAILY_SECRET so either can rotate on its own: rotating this
    // one changes every playerTag, rotating DAILY_SECRET changes future seeds.
    this.tagSecret = new secretsmanager.Secret(this, 'TagSecret', {
      description: 'CLAWD ECHO TOWER: HMAC key for player tags',
      generateSecretString: { excludePunctuation: true, passwordLength: 48 },
    });

    // --- security groups ---------------------------------------------------
    this.albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc: props.vpc,
      description: 'ALB: ingress only from the CloudFront origin-facing prefix list',
      allowAllOutbound: true,
    });
    this.albSecurityGroup.addIngressRule(
      ec2.Peer.prefixList(props.cloudfrontPrefixListId),
      ec2.Port.tcp(80),
      'CloudFront origin-facing',
    );

    this.serviceSecurityGroup = new ec2.SecurityGroup(this, 'ServiceSg', {
      vpc: props.vpc,
      description: 'Fargate tasks: ingress only from the ALB',
      allowAllOutbound: true,
    });
    this.serviceSecurityGroup.addIngressRule(this.albSecurityGroup, ec2.Port.tcp(APP_PORT), 'ALB to app');

    // --- load balancer -----------------------------------------------------
    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: props.vpc,
      internetFacing: true,
      vpcSubnets: props.albSubnets,
      securityGroup: this.albSecurityGroup,
      idleTimeout: cdk.Duration.seconds(60),
    });

    this.targetGroup = new elbv2.ApplicationTargetGroup(this, 'Tg', {
      vpc: props.vpc,
      port: APP_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      deregistrationDelay: cdk.Duration.seconds(15),
      healthCheck: {
        path: '/healthz',
        healthyHttpCodes: '200',
        interval: cdk.Duration.seconds(15),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });

    // `open: false` keeps CDK from adding a 0.0.0.0/0 ingress rule to the SG.
    this.listener = this.loadBalancer.addListener('Http', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: false,
      defaultAction: elbv2.ListenerAction.fixedResponse(403, {
        contentType: 'text/plain',
        messageBody: 'Forbidden',
      }),
    });
    this.listener.addAction('Verified', {
      priority: 1,
      conditions: [elbv2.ListenerCondition.httpHeader(ORIGIN_VERIFY_HEADER, [this.originTokenValue])],
      action: elbv2.ListenerAction.forward([this.targetGroup]),
    });

    // --- container image ---------------------------------------------------
    const image = new ecr_assets.DockerImageAsset(this, 'Image', {
      directory: props.imageDirectory ?? fileURLToPath(new URL('../../../', import.meta.url)),
      file: 'Dockerfile',
      platform: ecr_assets.Platform.LINUX_ARM64,
      // Only what `npm run build` needs goes into the build context; everything
      // else would just churn the asset hash (and APP_VERSION) without changing
      // the image. Mirror of .dockerignore (CDK merges both). What remains:
      // package.json, package-lock.json, tsconfig.json, Dockerfile, src, public,
      // tools/build.mjs, tools/lib.mjs.
      exclude: [...IMAGE_CONTEXT_EXCLUDE],
    });
    this.imageHash = image.assetHash;

    // --- cluster / task ----------------------------------------------------
    this.cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: props.vpc,
      containerInsightsV2: ecs.ContainerInsights.ENHANCED,
    });

    this.logGroup = new logs.LogGroup(this, 'Logs', {
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: this.sizing.cpu,
      memoryLimitMiB: this.sizing.memoryMiB,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    taskDefinition.addContainer('app', {
      containerName: 'app',
      image: ecs.ContainerImage.fromDockerImageAsset(image),
      portMappings: [{ containerPort: APP_PORT, protocol: ecs.Protocol.TCP }],
      logging: ecs.LogDrivers.awsLogs({ logGroup: this.logGroup, streamPrefix: 'app' }),
      environment: {
        NODE_ENV: 'production',
        PORT: String(APP_PORT),
        STATIC_DIR: '/app/dist/public',
        TABLE_NAME: props.table.tableName,
        AWS_REGION: stack.region,
        APP_VERSION: this.imageHash,
      },
      secrets: {
        DAILY_SECRET: ecs.Secret.fromSecretsManager(this.dailySecret),
        TAG_SECRET: ecs.Secret.fromSecretsManager(this.tagSecret),
      },
    });

    props.table.grantReadWriteData(taskDefinition.taskRole);

    // --- service -----------------------------------------------------------
    this.service = new ecs.FargateService(this, 'Service', {
      cluster: this.cluster,
      taskDefinition,
      desiredCount: props.desiredCount,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      circuitBreaker: { enable: true, rollback: true },
      healthCheckGracePeriod: cdk.Duration.seconds(60),
      vpcSubnets: props.serviceSubnets,
      assignPublicIp: props.assignPublicIp,
      securityGroups: [this.serviceSecurityGroup],
    });
    this.service.attachToApplicationTargetGroup(this.targetGroup);

    // --- autoscaling -------------------------------------------------------
    const scaling = this.service.autoScaleTaskCount({ minCapacity: MIN_TASKS, maxCapacity: this.sizing.maxTasks });
    scaling.scaleOnCpuUtilization('Cpu', {
      targetUtilizationPercent: SCALING_TARGETS.cpuPercent,
      scaleInCooldown: cdk.Duration.seconds(120),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });
    scaling.scaleOnRequestCount('Requests', {
      requestsPerTarget: SCALING_TARGETS.requestsPerTarget,
      targetGroup: this.targetGroup,
      scaleInCooldown: cdk.Duration.seconds(120),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });
    // Latency is what players feel; CPU and request counts lag a verification
    // burst. Two one-minute p95 datapoints above the threshold add two tasks
    // at once (scale-in is left to the target-tracking policies).
    scaling.scaleOnMetric('LatencyP95', {
      metric: this.targetGroup.metrics.targetResponseTime({
        statistic: 'p95',
        period: cdk.Duration.minutes(LATENCY_STEP_SCALING.periodMinutes),
      }),
      scalingSteps: [
        { upper: LATENCY_STEP_SCALING.thresholdSeconds, change: 0 },
        { lower: LATENCY_STEP_SCALING.thresholdSeconds, change: +LATENCY_STEP_SCALING.addTasks },
      ],
      adjustmentType: appscaling.AdjustmentType.CHANGE_IN_CAPACITY,
      evaluationPeriods: LATENCY_STEP_SCALING.evaluationPeriods,
      cooldown: cdk.Duration.seconds(LATENCY_STEP_SCALING.cooldownSeconds),
    });
  }
}
