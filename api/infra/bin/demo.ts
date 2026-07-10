#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DemoStack } from '../lib/demo-stack';

const app = new cdk.App();
new DemoStack(app, 'MayflyDemoStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.MAYFLY_REGION ?? 'ap-northeast-1',
  },
  ghOwner: process.env.DEMO_GH_OWNER ?? 'mikeng-io',
  ghRepo: process.env.DEMO_GH_REPO ?? 'mayfly-demo',
  tags: { project: 'mayfly-demo' },
});
