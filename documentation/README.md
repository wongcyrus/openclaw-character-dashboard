# Documentation Index

All developer, deployment, integration, and architecture documentation lives in
this directory.

## Core Guides

| Document | Purpose |
| --- | --- |
| [Adding an agent](adding-an-agent.md) | Add character assets, rooms, and `world.json` mappings. |
| [World JSON reference](world-json-reference.md) | Complete `world.json` and `clip-defs.json` schema reference. |
| [Project structure](project-structure.md) | Repository layout, ownership boundaries, and data flow. |
| [Pathfinding](pathfinding.md) | Collision grid and pathfinder design. |

## AWS and OpenClaw

| Document | Purpose |
| --- | --- |
| [AWS serverless deployment](aws-serverless-deployment.md) | CDK deployment, Cognito login/API authorization, and runtime configuration. |
| [OpenClaw dashboard integration](openclaw-dashboard-integration.md) | Local gateway and AgentCore snapshot/event flows. |

## System Design

| Document | Purpose |
| --- | --- |
| [Architecture overview](system-design/overview.md) | High-level AWS topology and infrastructure components. |
| [Frontend asset deployment](system-design/assets-deployment.md) | Vite, S3 asset packs, runtime configuration, and CloudFront invalidation. |
| [WebSocket lifecycle](system-design/websocket-flow.md) | Legacy API Gateway WebSocket connection lifecycle and its current limitations. |

Diagram source files and the regeneration script are under
[`system-design/`](system-design/).
