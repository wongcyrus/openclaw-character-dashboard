import * as cdk from "aws-cdk-lib";
import { DashboardServerlessStack } from "./dashboard-stack";

const app = new cdk.App();
new DashboardServerlessStack(app, "OpenClawDashboardStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || "us-east-1",
  },
});
