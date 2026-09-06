import * as cdk from 'aws-cdk-lib';
import * as backup from 'aws-cdk-lib/aws-backup';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

/** Days a daily AWS Backup recovery point of the table is kept. */
export const BACKUP_RETENTION_DAYS = 35;

/**
 * The single DynamoDB table (spec §2.4): `pk`/`sk` string keys, on-demand
 * billing, point-in-time recovery, TTL on `ttl` for daily runs.
 *
 * The table outlives the stack: RemovalPolicy RETAIN and deletion protection
 * (a `cdk destroy` leaves it in place; disable protection by hand first to
 * really drop it), plus an AWS Backup plan taking a daily snapshot kept for
 * 35 days on top of PITR's 35-day window.
 */
export class Data extends Construct {
  readonly table: dynamodb.TableV2;
  readonly backupPlan: backup.BackupPlan;
  readonly backupSelection: backup.BackupSelection;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.table = new dynamodb.TableV2(this, 'Table', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'ttl',
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Daily at 05:00 UTC (14:00 KST), recovery points deleted after 35 days;
    // the plan creates its own vault.
    this.backupPlan = backup.BackupPlan.daily35DayRetention(this, 'Backup');
    this.backupSelection = this.backupPlan.addSelection('Table', {
      resources: [backup.BackupResource.fromDynamoDbTable(this.table)],
    });
  }
}
