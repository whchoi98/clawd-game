import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Data } from './constructs/data.js';
import { Edge } from './constructs/edge.js';
import { Network } from './constructs/network.js';
import { ORIGIN_VERIFY_HEADER, Service } from './constructs/service.js';

export interface ClawdEchoTowerStackProps extends cdk.StackProps {
  /** Existing VPC to import (`cc-on-bedrock-vpc`); the stack creates no VPC, NAT or endpoints. */
  readonly vpcId: string;
  /** `com.amazonaws.global.cloudfront.origin-facing` prefix list id in the target region. */
  readonly cloudfrontPrefixListId: string;
  /** Initial Fargate task count (autoscaling then keeps it between 2 and 6). */
  readonly desiredCount: number;
}

/**
 * CLAWD JUMP: ECHO TOWER — CloudFront → (prefix-list SG) ALB → ECS Fargate → DynamoDB.
 */
export class ClawdEchoTowerStack extends cdk.Stack {
  readonly network: Network;
  readonly data: Data;
  readonly service: Service;
  readonly edge: Edge;

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

    this.edge = new Edge(this, 'Edge', {
      loadBalancer: this.service.loadBalancer,
      originVerifyHeader: ORIGIN_VERIFY_HEADER,
      originVerifyValue: this.service.originTokenValue,
    });

    new cdk.CfnOutput(this, 'SiteUrl', {
      value: `https://${this.edge.distribution.distributionDomainName}/`,
      description: 'Play CLAWD JUMP: ECHO TOWER here',
    });
    new cdk.CfnOutput(this, 'DistributionId', { value: this.edge.distribution.distributionId });
    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: this.service.loadBalancer.loadBalancerDnsName,
      description: 'Direct requests must be refused (SG prefix list + 403 default)',
    });
    new cdk.CfnOutput(this, 'TableName', { value: this.data.table.tableName });
    new cdk.CfnOutput(this, 'ClusterName', { value: this.service.cluster.clusterName });
    new cdk.CfnOutput(this, 'ServiceName', { value: this.service.service.serviceName });
  }
}
