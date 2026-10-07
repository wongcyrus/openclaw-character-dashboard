import * as cdk from "aws-cdk-lib";
import * as dotenv from "dotenv";

import { loadCognitoConfig } from "./cognitoConfig";
import { DashboardServerlessStack } from "./dashboard-stack";

dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

const region =
  process.env.CDK_DEFAULT_REGION ||
  process.env.AWS_REGION ||
  process.env.AWS_DEFAULT_REGION ||
  "us-east-1";
const app = new cdk.App();
new DashboardServerlessStack(app, "OpenClawDashboardStack", {
  cognito: loadCognitoConfig(region),
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region,
  },
});
