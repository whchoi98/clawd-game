import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export interface NetworkProps {
  /**
   * Existing VPC to import — the user's `cc-on-bedrock-vpc`
   * (vpc-0dfa5610180dfa628). Its subnets carry `aws-cdk:subnet-type` tags, so
   * PUBLIC / PRIVATE_WITH_EGRESS selections resolve without configuration and
   * egress goes through the VPC's existing NAT gateways.
   */
  readonly vpcId: string;
}

/**
 * Network placement for the stack. Nothing network-level is created: the VPC,
 * its NAT gateways and its S3/DynamoDB gateway endpoints already exist. The
 * only network resources this stack owns are the two security groups, which
 * live with the constructs that own them.
 */
export class Network extends Construct {
  readonly vpc: ec2.IVpc;
  /** Where the internet-facing ALB lives. */
  readonly albSubnets: ec2.SubnetSelection = { subnetType: ec2.SubnetType.PUBLIC };
  /** Where the Fargate tasks live (egress via the VPC's NAT gateways). */
  readonly serviceSubnets: ec2.SubnetSelection = { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS };

  constructor(scope: Construct, id: string, props: NetworkProps) {
    super(scope, id);
    if (!props.vpcId) throw new Error('Network: vpcId is required (set context "vpcId" in cdk.json)');
    this.vpc = ec2.Vpc.fromLookup(this, 'Vpc', { vpcId: props.vpcId });
  }
}
