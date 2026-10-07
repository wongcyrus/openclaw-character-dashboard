import { execFileSync } from "node:child_process";

import * as dotenv from "dotenv";

import { loadCognitoConfig } from "./cognitoConfig";

dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

const region =
  process.env.CDK_DEFAULT_REGION ||
  process.env.AWS_REGION ||
  process.env.AWS_DEFAULT_REGION ||
  "us-east-1";
const cognito = loadCognitoConfig(region);
const env = {
  ...process.env,
  CDK_DEFAULT_REGION: region,
  VITE_COGNITO_REGION: cognito.region,
  VITE_COGNITO_USER_POOL_ID: cognito.userPoolId,
  VITE_COGNITO_CLIENT_ID: cognito.clientId,
};

execFileSync("npm", ["run", "build"], { env, stdio: "inherit" });
execFileSync("npm", ["run", "cdk", "--", "deploy", ...process.argv.slice(2)], {
  env,
  stdio: "inherit",
});
