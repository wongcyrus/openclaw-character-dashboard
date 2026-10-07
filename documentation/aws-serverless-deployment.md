# AWS Serverless Deployment Guide

This document describes how to deploy the OpenClaw Character Dashboard as a fully serverless solution on AWS.

## Architecture Overview

- **Frontend**: React + Phaser SPA hosted on **Amazon S3** and served via **Amazon CloudFront**.
- **REST API**: **Amazon API Gateway** (REST) backed by **AWS Lambda** (Node.js).
- **Real-time Events**: **Amazon API Gateway** (WebSocket) using **Amazon DynamoDB** for connection management.
- **Storage**: **Amazon S3** for shared resource wall files and character asset packs.

## Infrastructure (CDK)

The project uses **AWS CDK** for infrastructure as code. The stack is defined in `infra/dashboard-stack.ts`.

### Key Components:
- `WebsiteBucket`: S3 bucket for frontend assets.
- `SharedFilesBucket`: S3 bucket for the resource wall.
- `ConnectionsTable`: DynamoDB table for WebSocket connection IDs.
- `BackendLambda`: Monolithic Node.js function handling REST and WebSocket routes.
- `Distribution`: CloudFront CDN for global distribution.
- **Shared Cognito**: Uses the existing user pool and client from the
  `aws-agentic-robotics` stack. This dashboard does not create or delete Cognito pools.

## Prerequisites

1. **AWS Account**: Configured locally via AWS CLI (`aws configure`).
2. **Node.js**: v22+.
3. **esbuild**: Required for Lambda bundling (`npm install -g esbuild`).
4. **Shared authentication stack**: `aws-agentic-robotics` must already be deployed
   in the dashboard's target AWS account and region. The deploying identity needs
   `cloudformation:DescribeStacks` permission on that stack.

## Environment Configuration

The deployment process reads from `.env.local` or `.env`. **For security, always use `.env.local` for real credentials** to ensure they are not tracked by Git (see `.gitignore`). 

Ensure the following variables are set if using AgentCore mode:

```env
OPENCLAW_BACKEND_MODE=agentcore
AGENTCORE_REGION=us-east-1
AGENTCORE_RUNTIME_NAME=openclaw_agent_dev
AGENTCORE_RUNTIME_ENDPOINT_NAME=DEFAULT
AGENTCORE_ACTOR_ID=telegram:123456
AGENTCORE_CHANNEL=telegram

```

Do not copy Cognito IDs into deployment environment files. `npm run deploy` reads
`CognitoRegion`, `CognitoUserPoolId`, and `CognitoUserPoolClientId` directly from
the `aws-agentic-robotics` CloudFormation outputs before building the frontend.
These values override any stale `VITE_COGNITO_*` values in local environment
files. Missing outputs or an inaccessible stack stop deployment rather than
falling back to a different pool.

The lookup uses the AWS CLI's current credentials/profile and the target region
(`CDK_DEFAULT_REGION`, then `AWS_REGION`, then `AWS_DEFAULT_REGION`, defaulting
to `us-east-1`). To use a named profile, set `AWS_PROFILE` for the whole command.
Deploy `aws-agentic-robotics` first, and redeploy the dashboard after replacing
its pool or client: values are resolved at deployment time, not via
CloudFormation exports.

If you prefer pinning an exact deployment, `AGENTCORE_RUNTIME_ARN` and
`AGENTCORE_RUNTIME_ENDPOINT_ID` remain supported, but the runtime-name path is
safer when your deployed ARN changes frequently.
AgentCore invocation qualifiers must be endpoint names (for example `DEFAULT`),
not endpoint ARNs. The shared runtime resolver normalizes legacy endpoint ARN
configuration to the corresponding name.

After a new AgentCore session starts, OpenClaw gateway initialization can exceed
the API Gateway/Lambda request timeout. Initial snapshot requests may return
HTTP 504 until the gateway is ready; the dashboard retries every 20 seconds.

## Deployment Commands

```bash
# 1. Install dependencies
npm install

# 2. Bootstrap CDK (first time only)
npm run cdk bootstrap

# 3. Build and Deploy
npm run deploy
```

## How it Works

1. **Resolve and build**: `npm run deploy` reads the shared Cognito stack outputs,
   then runs `npm run build` with the resolved frontend environment values.
2. **Synthesis**: CDK also resolves the shared Cognito outputs (including for
   standalone `npm run cdk synth` / `diff`). `config.json` contains the resulting
   API/WS endpoints and `cognito: { region, userPoolId, clientId }`. These identifiers
   configure the existing login screen. Sessions from a different pool or app
   client are discarded. This frontend login does not enforce API authentication.
3. **Deployment**:
   - `dist/` is uploaded to S3.
   - `public_frieren/` and `public_tamon_b_side/` are uploaded to `assets/` prefixes in S3.
   - `shared/` is uploaded to the shared files bucket.
   - Lambda is bundled and deployed.
4. **Invalidation**: CloudFront cache is cleared automatically.

## Accessing the App

After a successful deployment, the `ServiceUrl` will be printed in the terminal (e.g., `https://d12345.cloudfront.net`).
