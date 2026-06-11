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

## Prerequisites

1. **AWS Account**: Configured locally via AWS CLI (`aws configure`).
2. **Node.js**: v22+.
3. **esbuild**: Required for Lambda bundling (`npm install -g esbuild`).

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

# Frontend Authentication (Cognito)
VITE_COGNITO_REGION=us-east-1
VITE_COGNITO_USER_POOL_ID=us-east-1_XXXXX
VITE_COGNITO_CLIENT_ID=xxxxxxxxxxxxxx
```

If you prefer pinning an exact deployment, `AGENTCORE_RUNTIME_ARN` and
`AGENTCORE_RUNTIME_ENDPOINT_ID` remain supported, but the runtime-name path is
safer when your deployed ARN changes frequently.

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

1. **Build**: `npm run build` generates the production bundle in `dist/`.
2. **Synthesis**: CDK reads `.env.local` and `config.json` is generated with the resulting API/WS endpoints.
3. **Deployment**:
   - `dist/` is uploaded to S3.
   - `public_frieren/` and `public_tamon_b_side/` are uploaded to `assets/` prefixes in S3.
   - `shared/` is uploaded to the shared files bucket.
   - Lambda is bundled and deployed.
4. **Invalidation**: CloudFront cache is cleared automatically.

## Accessing the App

After a successful deployment, the `ServiceUrl` will be printed in the terminal (e.g., `https://d12345.cloudfront.net`).
