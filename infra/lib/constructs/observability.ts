import * as cdk from 'aws-cdk-lib';
import type * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

/** CloudWatch namespace of the app's EMF metrics (mirror of METRIC_NAMESPACE in src/server/routes/events.ts). */
export const METRIC_NAMESPACE = 'ClawdEchoTower';

/**
 * App metrics the alarms watch. The server emits them as Embedded Metric
 * Format lines with a `build` dimension, which makes every deploy a new
 * series; an alarm cannot aggregate across dimension values, so metric
 * filters on the log group republish each as a dimension-less roll-up under
 * the same namespace and name. (Do not add an empty dimension set to the EMF
 * envelope as well: the two would double count.)
 */
export const ROLLUP_METRICS = {
  verifyMs: { name: 'VerifyMs', unit: cloudwatch.Unit.MILLISECONDS },
  submitAccepted: { name: 'SubmitAccepted', unit: cloudwatch.Unit.COUNT },
  submitRejected: { name: 'SubmitRejected', unit: cloudwatch.Unit.COUNT },
} as const;

/** Alarm thresholds, exported so the tests assert the numbers the runbooks quote. */
export const ALARM_THRESHOLDS = {
  /** ALB (ELB + target) 5xx as a percentage of requests, 5-minute window. */
  alb5xxRatePercent: 1,
  /** ALB TargetResponseTime p95, seconds. */
  albP95LatencySeconds: 1,
  /** Unhealthy targets in the target group. */
  unhealthyHosts: 1,
  /** Fewer healthy targets than the service minimum (2 tasks). */
  healthyHostsMin: 2,
  ecsCpuPercent: 80,
  ecsMemoryPercent: 85,
  /** DynamoDB read / write throttle events per minute. */
  ddbThrottles: 0,
  /** Replay verification p95, milliseconds. */
  verifyMsP95: 2000,
  /** SubmitRejected / (SubmitAccepted + SubmitRejected), percent. */
  submitRejectPercent: 30,
  /** Submits needed in a window before the reject ratio is judged (one stray reject is not an incident). */
  submitRatioMinSamples: 10,
} as const;

/** Days ALB access logs stay in the bucket. */
export const ACCESS_LOG_RETENTION_DAYS = 30;

export interface ObservabilityProps {
  readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  readonly targetGroup: elbv2.ApplicationTargetGroup;
  readonly service: ecs.FargateService;
  readonly table: dynamodb.ITableV2;
  readonly distribution: cloudfront.IDistribution;
  /** The app log group (awslogs driver); source of the EMF roll-up metric filters. */
  readonly logGroup: logs.ILogGroup;
  /** Optional e-mail subscribed to the alarm topic (context `alarmEmail`); confirm the subscription mail once. */
  readonly alarmEmail?: string;
}

/**
 * Ops hygiene: one SNS topic, ten alarms, one dashboard, ALB access logs.
 *
 * Alarms (all notify the topic on ALARM and OK):
 *   - ALB 5xx rate > 1% over 5 min (ELB + target 5xx, metric math)
 *   - ALB target p95 latency > 1 s over 5 min
 *   - UnHealthyHostCount >= 1 (2 min)
 *   - HealthyHostCount < 2 (2 min) — a lost task, which never shows as unhealthy
 *   - ECS service CPU > 80% / Memory > 85% over 5 min
 *   - DynamoDB read / write throttle events > 0
 *   - ClawdEchoTower VerifyMs p95 > 2000 ms over 5 min
 *   - ClawdEchoTower SubmitRejected ratio > 30% over 5 min (>= 10 submits)
 *
 * CloudFront publishes its metrics in us-east-1 only and CloudWatch alarms
 * cannot evaluate a metric from another region, so CloudFront requests and
 * error rates are on the dashboard (widgets may be cross-region) but not
 * alarmed from this stack.
 */
export class Observability extends Construct {
  readonly topic: sns.Topic;
  readonly dashboard: cloudwatch.Dashboard;
  readonly accessLogBucket: s3.Bucket;
  readonly alarms: cloudwatch.Alarm[] = [];
  readonly metricFilters: logs.MetricFilter[] = [];

  constructor(scope: Construct, id: string, props: ObservabilityProps) {
    super(scope, id);
    const stack = cdk.Stack.of(this);
    const oneMinute = cdk.Duration.minutes(1);
    const fiveMinutes = cdk.Duration.minutes(5);

    // --- notifications -----------------------------------------------------
    this.topic = new sns.Topic(this, 'Alarms', {
      displayName: 'CLAWD ECHO TOWER alarms',
    });
    if (props.alarmEmail) {
      this.topic.addSubscription(new subscriptions.EmailSubscription(props.alarmEmail));
    }
    const notify = new cw_actions.SnsAction(this.topic);
    const alarm = (id: string, slug: string, alarmProps: cloudwatch.AlarmProps): cloudwatch.Alarm => {
      const a = new cloudwatch.Alarm(this, id, { alarmName: `${stack.stackName}-${slug}`, ...alarmProps });
      a.addAlarmAction(notify);
      a.addOkAction(notify);
      this.alarms.push(a);
      return a;
    };

    // --- ALB access logs ---------------------------------------------------
    // No autoDeleteObjects: that would add a Lambda-backed custom resource
    // (the stack deliberately has none). The 30-day lifecycle keeps the
    // bucket small; empty it by hand before `cdk destroy` if it is not.
    this.accessLogBucket = new s3.Bucket(this, 'AlbAccessLogs', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      lifecycleRules: [{
        id: `expire-${ACCESS_LOG_RETENTION_DAYS}d`,
        expiration: cdk.Duration.days(ACCESS_LOG_RETENTION_DAYS),
        abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
      }],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    props.loadBalancer.logAccessLogs(this.accessLogBucket, 'alb');

    // --- ALB / target group ------------------------------------------------
    const albMetrics = props.loadBalancer.metrics;
    const tgMetrics = props.targetGroup.metrics;
    const requests = albMetrics.requestCount({ period: fiveMinutes, statistic: 'Sum' });
    const elb5xx = albMetrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, { period: fiveMinutes, statistic: 'Sum' });
    const target5xx = albMetrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, { period: fiveMinutes, statistic: 'Sum' });
    const alb5xxRate = new cloudwatch.MathExpression({
      label: 'ALB 5xx %',
      // No traffic is 0%, not missing; the IF keeps the division off the idle path.
      expression: 'IF(FILL(req, 0) > 0, 100 * (FILL(e5, 0) + FILL(t5, 0)) / FILL(req, 1), 0)',
      usingMetrics: { req: requests, e5: elb5xx, t5: target5xx },
      period: fiveMinutes,
    });
    alarm('Alb5xxRate', 'alb-5xx-rate', {
      alarmDescription: `ALB 5xx (ELB + target) above ${ALARM_THRESHOLDS.alb5xxRatePercent}% of requests for 5 minutes`,
      metric: alb5xxRate,
      threshold: ALARM_THRESHOLDS.alb5xxRatePercent,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const latencyP95 = tgMetrics.targetResponseTime({ period: fiveMinutes, statistic: 'p95' });
    alarm('AlbLatencyP95', 'alb-latency-p95', {
      alarmDescription: `ALB target response time p95 above ${ALARM_THRESHOLDS.albP95LatencySeconds} s for 5 minutes`,
      metric: latencyP95,
      threshold: ALARM_THRESHOLDS.albP95LatencySeconds,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Host counts are reported per load balancer node; Average / Maximum, never Sum.
    const unhealthy = tgMetrics.unhealthyHostCount({ period: oneMinute, statistic: 'Maximum' });
    alarm('AlbUnhealthyHosts', 'alb-unhealthy-hosts', {
      alarmDescription: 'A target is failing /healthz (ECS replaces it; investigate if it repeats)',
      metric: unhealthy,
      threshold: ALARM_THRESHOLDS.unhealthyHosts,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const healthy = tgMetrics.healthyHostCount({ period: oneMinute, statistic: 'Average' });
    alarm('AlbHealthyHosts', 'alb-healthy-hosts', {
      alarmDescription: `Fewer than ${ALARM_THRESHOLDS.healthyHostsMin} healthy targets for 2 minutes (a task was lost or cannot start)`,
      metric: healthy,
      threshold: ALARM_THRESHOLDS.healthyHostsMin,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // --- ECS ---------------------------------------------------------------
    const cpu = props.service.metricCpuUtilization({ period: fiveMinutes, statistic: 'Average' });
    alarm('EcsCpu', 'ecs-cpu', {
      alarmDescription: `ECS service CPU above ${ALARM_THRESHOLDS.ecsCpuPercent}% for 5 minutes (autoscaling targets 60%)`,
      metric: cpu,
      threshold: ALARM_THRESHOLDS.ecsCpuPercent,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    const memory = props.service.metricMemoryUtilization({ period: fiveMinutes, statistic: 'Average' });
    alarm('EcsMemory', 'ecs-memory', {
      alarmDescription: `ECS service memory above ${ALARM_THRESHOLDS.ecsMemoryPercent}% for 5 minutes (task limit 512 MiB)`,
      metric: memory,
      threshold: ALARM_THRESHOLDS.ecsMemoryPercent,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // --- DynamoDB ----------------------------------------------------------
    // Table-level throttle metrics (no Operation dimension); only published when throttling happens.
    const readThrottles = props.table.metric('ReadThrottleEvents', { period: oneMinute, statistic: 'Sum' });
    const writeThrottles = props.table.metric('WriteThrottleEvents', { period: oneMinute, statistic: 'Sum' });
    alarm('DdbReadThrottles', 'ddb-read-throttles', {
      alarmDescription: 'DynamoDB read throttle events (on-demand table: hot partition or account limit)',
      metric: readThrottles,
      threshold: ALARM_THRESHOLDS.ddbThrottles,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    alarm('DdbWriteThrottles', 'ddb-write-throttles', {
      alarmDescription: 'DynamoDB write throttle events (on-demand table: hot partition or account limit)',
      metric: writeThrottles,
      threshold: ALARM_THRESHOLDS.ddbThrottles,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // --- app metrics (EMF roll-ups via metric filters) ---------------------
    const rollup = (m: { name: string; unit: cloudwatch.Unit }): logs.MetricFilter => {
      const filter = new logs.MetricFilter(this, `${m.name}Rollup`, {
        logGroup: props.logGroup,
        // An EMF line of ours carrying this metric as a root member (any `build`).
        filterPattern: logs.FilterPattern.literal(
          `{ ($._aws.CloudWatchMetrics[0].Namespace = "${METRIC_NAMESPACE}") && ($.${m.name} >= 0) }`,
        ),
        metricNamespace: METRIC_NAMESPACE,
        metricName: m.name,
        metricValue: `$.${m.name}`,
        unit: m.unit,
      });
      this.metricFilters.push(filter);
      return filter;
    };
    const verifyMs = rollup(ROLLUP_METRICS.verifyMs);
    const submitAccepted = rollup(ROLLUP_METRICS.submitAccepted);
    const submitRejected = rollup(ROLLUP_METRICS.submitRejected);

    alarm('VerifyMsP95', 'verify-ms-p95', {
      alarmDescription: `Replay verification p95 above ${ALARM_THRESHOLDS.verifyMsP95} ms for 5 minutes`,
      metric: verifyMs.metric({ period: fiveMinutes, statistic: 'p95' }),
      threshold: ALARM_THRESHOLDS.verifyMsP95,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const accepted = submitAccepted.metric({ period: fiveMinutes, statistic: 'Sum', label: 'accepted' });
    const rejected = submitRejected.metric({ period: fiveMinutes, statistic: 'Sum', label: 'rejected' });
    const rejectRatio = new cloudwatch.MathExpression({
      label: 'rejected %',
      expression:
        `IF(FILL(a, 0) + FILL(r, 0) >= ${ALARM_THRESHOLDS.submitRatioMinSamples}, 100 * FILL(r, 0) / (FILL(a, 0) + FILL(r, 0)), 0)`,
      usingMetrics: { a: accepted, r: rejected },
      period: fiveMinutes,
    });
    alarm('SubmitRejectRatio', 'submit-reject-ratio', {
      alarmDescription:
        `More than ${ALARM_THRESHOLDS.submitRejectPercent}% of run submissions rejected in 5 minutes ` +
        `(at least ${ALARM_THRESHOLDS.submitRatioMinSamples} submits) - check the reason dimension and SIM_VERSION`,
      metric: rejectRatio,
      threshold: ALARM_THRESHOLDS.submitRejectPercent,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // --- dashboard ---------------------------------------------------------
    // CloudFront metrics live in us-east-1; dashboard widgets may be cross-region.
    const cloudFront = (metricName: string, statistic: string, label: string): cloudwatch.Metric =>
      new cloudwatch.Metric({
        namespace: 'AWS/CloudFront',
        metricName,
        dimensionsMap: { DistributionId: props.distribution.distributionId, Region: 'Global' },
        region: 'us-east-1',
        statistic,
        period: oneMinute,
        label,
      });
    const search = (schema: string, metricName: string, statistic: string, label: string): cloudwatch.MathExpression =>
      new cloudwatch.MathExpression({
        expression: `SEARCH('{${METRIC_NAMESPACE},${schema}} MetricName="${metricName}"', '${statistic}', 60)`,
        usingMetrics: {},
        label,
        period: oneMinute,
      });
    const graph = (title: string, left: cloudwatch.IMetric[], extra: Partial<cloudwatch.GraphWidgetProps> = {}): cloudwatch.GraphWidget =>
      new cloudwatch.GraphWidget({ title, left, width: 8, height: 6, liveData: true, ...extra });

    this.dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: stack.stackName,
      defaultInterval: cdk.Duration.hours(3),
      periodOverride: cloudwatch.PeriodOverride.AUTO,
      widgets: [
        [new cloudwatch.AlarmStatusWidget({ title: 'Alarms', alarms: this.alarms, width: 24, height: 3 })],
        [
          graph('Requests', [
            albMetrics.requestCount({ period: oneMinute, statistic: 'Sum', label: 'ALB requests' }),
            cloudFront('Requests', 'Sum', 'CloudFront requests'),
          ]),
          graph('5xx', [
            albMetrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, { period: oneMinute, statistic: 'Sum', label: 'ELB 5xx' }),
            albMetrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, { period: oneMinute, statistic: 'Sum', label: 'target 5xx' }),
            albMetrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_4XX_COUNT, { period: oneMinute, statistic: 'Sum', label: 'target 4xx' }),
          ], {
            right: [cloudFront('5xxErrorRate', 'Average', 'CloudFront 5xx %'), cloudFront('4xxErrorRate', 'Average', 'CloudFront 4xx %')],
            rightYAxis: { min: 0, max: 100, label: '%' },
          }),
          graph('Target latency (s)', [
            tgMetrics.targetResponseTime({ period: oneMinute, statistic: 'p50', label: 'p50' }),
            tgMetrics.targetResponseTime({ period: oneMinute, statistic: 'p95', label: 'p95' }),
            tgMetrics.targetResponseTime({ period: oneMinute, statistic: 'p99', label: 'p99' }),
          ]),
        ],
        [
          graph('ECS CPU / memory (%)', [
            props.service.metricCpuUtilization({ period: oneMinute, statistic: 'Average', label: 'CPU avg' }),
            props.service.metricCpuUtilization({ period: oneMinute, statistic: 'Maximum', label: 'CPU max' }),
            props.service.metricMemoryUtilization({ period: oneMinute, statistic: 'Average', label: 'memory avg' }),
            props.service.metricMemoryUtilization({ period: oneMinute, statistic: 'Maximum', label: 'memory max' }),
          ], { leftYAxis: { min: 0, max: 100 } }),
          graph('Targets', [
            tgMetrics.healthyHostCount({ period: oneMinute, statistic: 'Average', label: 'healthy' }),
            tgMetrics.unhealthyHostCount({ period: oneMinute, statistic: 'Maximum', label: 'unhealthy' }),
          ], { leftYAxis: { min: 0 } }),
          graph('DynamoDB', [
            props.table.metricConsumedReadCapacityUnits({ period: oneMinute, statistic: 'Sum', label: 'consumed RCU' }),
            props.table.metricConsumedWriteCapacityUnits({ period: oneMinute, statistic: 'Sum', label: 'consumed WCU' }),
          ], {
            right: [
              props.table.metric('ReadThrottleEvents', { period: oneMinute, statistic: 'Sum', label: 'read throttles' }),
              props.table.metric('WriteThrottleEvents', { period: oneMinute, statistic: 'Sum', label: 'write throttles' }),
            ],
            rightYAxis: { min: 0 },
          }),
        ],
        [
          graph('Verification (ms)', [
            verifyMs.metric({ period: oneMinute, statistic: 'p50', label: 'p50' }),
            verifyMs.metric({ period: oneMinute, statistic: 'p95', label: 'p95' }),
            verifyMs.metric({ period: oneMinute, statistic: 'p99', label: 'p99' }),
          ], {
            right: [verifyMs.metric({ period: oneMinute, statistic: 'SampleCount', label: 'verifications' })],
            rightYAxis: { min: 0 },
          }),
          graph('Submits', [
            submitAccepted.metric({ period: oneMinute, statistic: 'Sum', label: 'accepted' }),
            submitRejected.metric({ period: oneMinute, statistic: 'Sum', label: 'rejected' }),
          ], { stacked: true, leftYAxis: { min: 0 } }),
          graph('Rejects by reason / JS errors by build', [
            search('build,reason', 'SubmitRejected', 'Sum', ''),
          ], {
            right: [search('build', 'JsErrorCount', 'Sum', '')],
            rightYAxis: { min: 0 },
          }),
        ],
      ],
    });
  }
}
