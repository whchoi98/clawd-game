import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { Construct } from 'constructs';
import { Data } from './constructs/data.js';
import { Edge } from './constructs/edge.js';
import { Network } from './constructs/network.js';
import { Observability } from './constructs/observability.js';
import { ORIGIN_VERIFY_HEADER, Service } from './constructs/service.js';

export interface ClawdEchoTowerStackProps extends cdk.StackProps {
  /** Existing VPC to import (`cc-on-bedrock-vpc`); the stack creates no VPC, NAT or endpoints. */
  readonly vpcId: string;
  /** `com.amazonaws.global.cloudfront.origin-facing` prefix list id in the target region. */
  readonly cloudfrontPrefixListId: string;
  /** Initial Fargate task count (autoscaling then keeps it between 2 and 6). */
  readonly desiredCount: number;
  /**
   * Custom viewer domain, e.g. `clawd-game.whchoi.net`. DNS (a CNAME to the
   * distribution) is managed outside this stack. Requires `certificateArn`.
   */
  readonly domainName?: string;
  /** us-east-1 ACM certificate covering `domainName` (an existing wildcard is fine). */
  readonly certificateArn?: string;
  /**
   * E-mail subscribed to the alarm SNS topic (context `alarmEmail`, no
   * default). The address gets a confirmation mail on first deploy; without
   * it the topic exists and alarms still flip state, nobody is paged.
   */
  readonly alarmEmail?: string;
}

/**
 * CLAWD JUMP: ECHO TOWER — CloudFront → (prefix-list SG) ALB → ECS Fargate → DynamoDB,
 * with alarms, a dashboard and ALB access logs alongside.
 */
export class ClawdEchoTowerStack extends cdk.Stack {
  readonly network: Network;
  readonly data: Data;
  readonly service: Service;
  readonly edge: Edge;
  readonly observability: Observability;

  constructor(scope: Construct, id: string, props: ClawdEchoTowerStackProps) {
    super(scope, id, {
      description: 'CLAWD JUMP: ECHO TOWER - CloudFront, prefix-list ALB, Fargate (Graviton), DynamoDB',
      ...props,
    });
    cdk.Tags.of(this).add('Project', 'clawd-echo-tower');

    this.network = new Network(this, 'Network', { vpcId: props.vpcId });
    this.data = new Data(this, 'Data');

    this.service = new Service(this, 'Service', {
      vpc: this.network.vpc,
      albSubnets: this.network.albSubnets,
      serviceSubnets: this.network.serviceSubnets,
      assignPublicIp: false,
      cloudfrontPrefixListId: props.cloudfrontPrefixListId,
      desiredCount: props.desiredCount,
      table: this.data.table,
    });

    if (!!props.domainName !== !!props.certificateArn) {
      throw new Error('domainName and certificateArn must be set together (cdk.json context)');
    }
    this.edge = new Edge(this, 'Edge', {
      loadBalancer: this.service.loadBalancer,
      originVerifyHeader: ORIGIN_VERIFY_HEADER,
      originVerifyValue: this.service.originTokenValue,
      domainName: props.domainName,
      certificate: props.certificateArn
        ? acm.Certificate.fromCertificateArn(this, 'ViewerCertificate', props.certificateArn)
        : undefined,
    });

    this.observability = new Observability(this, 'Observability', {
      loadBalancer: this.service.loadBalancer,
      targetGroup: this.service.targetGroup,
      service: this.service.service,
      table: this.data.table,
      distribution: this.edge.distribution,
      logGroup: this.service.logGroup,
      alarmEmail: props.alarmEmail,
    });

    new cdk.CfnOutput(this, 'SiteUrl', {
      value: props.domainName ? `https://${props.domainName}/` : `https://${this.edge.distribution.distributionDomainName}/`,
      description: 'Play CLAWD JUMP: ECHO TOWER here',
    });
    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: this.edge.distribution.distributionDomainName,
      description: 'Point the custom domain CNAME here',
    });
    new cdk.CfnOutput(this, 'DistributionId', { value: this.edge.distribution.distributionId });
    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: this.service.loadBalancer.loadBalancerDnsName,
      description: 'Direct requests must be refused (SG prefix list + 403 default)',
    });
    new cdk.CfnOutput(this, 'TableName', { value: this.data.table.tableName });
    new cdk.CfnOutput(this, 'ClusterName', { value: this.service.cluster.clusterName });
    new cdk.CfnOutput(this, 'ServiceName', { value: this.service.service.serviceName });
    new cdk.CfnOutput(this, 'AlarmTopicArn', {
      value: this.observability.topic.topicArn,
      description: 'SNS topic every alarm notifies (subscribe with -c alarmEmail=... or by hand)',
    });
    new cdk.CfnOutput(this, 'DashboardName', { value: this.observability.dashboard.dashboardName });
    new cdk.CfnOutput(this, 'AccessLogBucketName', {
      value: this.observability.accessLogBucket.bucketName,
      description: 'ALB access logs (30-day lifecycle)',
    });
  }
}
