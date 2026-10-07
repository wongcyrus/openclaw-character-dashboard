# Documentation

This directory documents the local OpenClaw Character Dashboard. The dashboard runs on the same
machine as OpenClaw: Vite serves the development frontend, Express provides local APIs and the
dashboard WebSocket, and the Express process connects to the local OpenClaw Gateway.

| Document                                                  | Purpose                                                  |
| --------------------------------------------------------- | -------------------------------------------------------- |
| [Project structure](project-structure.md)                 | Repository layout, data flow, and rendering ownership    |
| [OpenClaw integration](openclaw-dashboard-integration.md) | Local gateway snapshot and live-message architecture     |
| [World JSON reference](world-json-reference.md)           | Complete `world.json` and `clip-defs.json` configuration |
| [Adding an agent](adding-an-agent.md)                     | Add character assets, configuration, and a private room  |
| [Pathfinding](pathfinding.md)                             | Collision grid and character navigation design           |

## Local development

```bash
npm install
npm run dev:all
```

Open `http://localhost:5173`. The Vite server proxies `/api` requests and `/api/ws` upgrades to the
local Express server on `VITE_API_PORT` (default `3001`).

This local architecture does not require AWS, CDK, Cognito, Lambda, or an AgentCore deployment.
