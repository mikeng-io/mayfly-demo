import { Stack, StackProps, RemovalPolicy, Duration, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'node:path';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';

export interface DemoStackProps extends StackProps {
  ghOwner: string;
  ghRepo: string;
  allowOrigin?: string;
}

const API_ROOT = path.join(__dirname, '..', '..'); // mayfly-demo/api

/** mayfly-demo API: DynamoDB (receipts + cooldown) + a Lambda Function URL. */
export class DemoStack extends Stack {
  constructor(scope: Construct, id: string, props: DemoStackProps) {
    super(scope, id, props);

    const table = new dynamodb.Table(this, 'RunsTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const ghToken = new ssm.StringParameter(this, 'GhToken', {
      parameterName: '/mayfly-demo/ghToken',
      stringValue: 'REPLACE_ME', // fine-grained PAT: actions:write on the demo repo
      description: 'GitHub token to workflow_dispatch the showcase — set out-of-band.',
    });
    const receiptToken = new ssm.StringParameter(this, 'ReceiptToken', {
      parameterName: '/mayfly-demo/receiptToken',
      stringValue: 'REPLACE_ME', // shared secret the workflow sends on /receipt
      description: 'Shared secret the showcase workflow sends when posting a receipt.',
    });

    const fn = new NodejsFunction(this, 'ApiFn', {
      entry: path.join(API_ROOT, 'src', 'handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(10),
      projectRoot: API_ROOT,
      depsLockFilePath: path.join(API_ROOT, 'package-lock.json'),
      bundling: { minify: true, sourceMap: true, target: 'node20', bundleAwsSDK: true },
      environment: {
        DEMO_TABLE: table.tableName,
        GH_OWNER: props.ghOwner,
        GH_REPO: props.ghRepo,
        GH_WORKFLOW: 'showcase.yml',
        GH_TOKEN_PARAM: ghToken.parameterName,
        RECEIPT_TOKEN_PARAM: receiptToken.parameterName,
        COOLDOWN_SECONDS: '15',
        ALLOW_ORIGIN: props.allowOrigin ?? '*',
      },
    });
    table.grantReadWriteData(fn);
    ghToken.grantRead(fn);
    receiptToken.grantRead(fn);

    const url = fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });

    new CfnOutput(this, 'ApiUrl', { value: url.url });
    new CfnOutput(this, 'RunsTableName', { value: table.tableName });
  }
}
