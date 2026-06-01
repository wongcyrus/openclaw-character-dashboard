import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { lookup as mimeLookup } from "mime-types";
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";
import { WebSocketServer, WebSocket } from "ws";
import type { RawData } from "ws";

type LocalGatewayConfig = {
  mode: "local";
  httpUrl: string;
  wsUrl: string;
  token: string;
};

type AgentCoreGatewayConfig = {
  mode: "agentcore";
  region: string;
  runtimeArn: string;
  qualifier: string;
  actorId: string;
  channel: string;
  userId: string;
  runtimeSessionId: string;
  liveWsUrl: string | null;
  eventPollIntervalMs: number;
};

type GatewayConfig = LocalGatewayConfig | AgentCoreGatewayConfig;

type DashboardMonitor = {
  start(): void;
  stop(): void;
};

const dashboardWss = new WebSocketServer({ noServer: true });
const connectedClients = new Set<WebSocket>();
const DASHBOARD_EVENT_BACKLOG_LIMIT = 100;
const dashboardEventBacklog: Record<string, unknown>[] = [];
const DEFAULT_DASHBOARD_AGENT_ID = "main";
const dashboardAgentStates = new Map<string, "working" | "idle">();

function agentIdFromSessionKey(key: string | undefined): string {
  if (!key || key === "global") return DEFAULT_DASHBOARD_AGENT_ID;
  const parts = key.split(":");
  return parts[0] === "agent"
    ? (parts[1] ?? DEFAULT_DASHBOARD_AGENT_ID)
    : DEFAULT_DASHBOARD_AGENT_ID;
}

function normalizeDashboardEvent(data: any): any {
  if (!data || typeof data !== "object" || typeof data.type !== "string") {
    return data;
  }

  if (!data.type.startsWith("agent-")) {
    return data;
  }

  const normalizedAgentId =
    typeof data.agentId === "string" && data.agentId.trim()
      ? data.agentId
      : agentIdFromSessionKey(
          typeof data.sessionKey === "string" ? data.sessionKey : undefined,
        );

  return {
    ...data,
    agentId: normalizedAgentId || DEFAULT_DASHBOARD_AGENT_ID,
    state: deriveAgentStateFromEventType(data.type, data),
  };
}

function deriveAgentStateFromEventType(
  type: string,
  data: any,
): "working" | "idle" | undefined {
  if (type === "agent-message" || type === "agent-stream") {
    return "working";
  }

  if (type === "agent-message-final") {
    return "idle";
  }

  if (type === "agent-lifecycle") {
    if (data?.phase === "end" || data?.phase === "error") {
      return "idle";
    }
    return "working";
  }

  return undefined;
}

function pushDashboardEvent(data: any): void {
  if (
    data &&
    typeof data === "object" &&
    typeof data.type === "string"
  ) {
    dashboardEventBacklog.push(data);
    if (dashboardEventBacklog.length > DASHBOARD_EVENT_BACKLOG_LIMIT) {
      dashboardEventBacklog.splice(
        0,
        dashboardEventBacklog.length - DASHBOARD_EVENT_BACKLOG_LIMIT,
      );
    }
  }
}

dashboardWss.on("connection", (ws: WebSocket) => {
  connectedClients.add(ws);
  console.log(`[dashboard-ws] Client connected (total: ${connectedClients.size})`);

  for (const event of dashboardEventBacklog) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(event));
    }
  }

  ws.on("close", () => {
    connectedClients.delete(ws);
    console.log(`[dashboard-ws] Client disconnected (total: ${connectedClients.size})`);
  });
});

function broadcastToDashboard(data: any) {
  const normalizedData = normalizeDashboardEvent(data);

  pushDashboardEvent(normalizedData);

  if (
    normalizedData &&
    typeof normalizedData === "object" &&
    typeof normalizedData.agentId === "string" &&
    (normalizedData.state === "working" || normalizedData.state === "idle")
  ) {
    const previousState = dashboardAgentStates.get(normalizedData.agentId);
    if (previousState !== normalizedData.state) {
      dashboardAgentStates.set(normalizedData.agentId, normalizedData.state);
      const statusEvent = {
        type: "agent-status",
        agentId: normalizedData.agentId,
        state: normalizedData.state,
        runId:
          typeof normalizedData.runId === "string"
            ? normalizedData.runId
            : undefined,
        ts: Date.now(),
      };
      pushDashboardEvent(statusEvent);
      const statusPayload = JSON.stringify(statusEvent);
      for (const client of connectedClients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(statusPayload);
        }
      }
    }
  }

  const payload = JSON.stringify(normalizedData);
  for (const client of connectedClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

type GatewayAgentsPayload = {
  agents?: Array<{ id?: string }>;
};

type GatewaySnapshot = {
  agents: unknown;
  sessions: unknown;
  presence: unknown;
  identities: Record<string, unknown>;
  source: string;
  fetchedAt: number;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type GatewayEventMessage = {
  type: "event";
  event: string;
};

type GatewayResponseMessage = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: any;
  error?: {
    message?: string;
  };
};

type GatewayMessage = GatewayEventMessage | GatewayResponseMessage;

loadServerEnv();

const app = express();
const DEFAULT_PORT = Number(process.env["API_PORT"] ?? 3001);
const OPENCLAW_HOME = process.env["OPENCLAW_HOME"]
  ? resolveConfiguredPath(process.env["OPENCLAW_HOME"])
  : path.join(
      process.env["HOME"] ?? process.env["USERPROFILE"] ?? process.cwd(),
      ".openclaw",
    );

// The shared files root — override with SHARED_ROOT env var, or falls back to
// <OPENCLAW_HOME>/shared.
const SHARED_ROOT = process.env["SHARED_ROOT"]
  ? resolveConfiguredPath(process.env["SHARED_ROOT"])
  : path.join(OPENCLAW_HOME, "shared");

const gatewayConfigPromise = readGatewayConfig();

app.use(cors({ origin: /localhost/ }));
app.use(express.json());

// ---------------------------------------------------------------------------
// Static Files (Production)
// ---------------------------------------------------------------------------

const DIST_PATH = path.join(process.cwd(), "dist");
if (existsSync(DIST_PATH)) {
  console.warn(`[resource-wall server] Serving static files from: ${DIST_PATH}`);
  app.use(express.static(DIST_PATH));
}

// ---------------------------------------------------------------------------
// GET /api/openclaw/snapshot
// Proxies a live OpenClaw gateway snapshot over HTTP for the frontend.
// ---------------------------------------------------------------------------

app.get("/api/openclaw/snapshot", async (_req: Request, res: Response): Promise<void> => {
  try {
    const payload = await fetchGatewaySnapshot(gatewayConfigPromise);
    res.status(200).json(payload);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// ---------------------------------------------------------------------------
// GET /api/files?path=<relative>
// Lists directory entries under SHARED_ROOT/<path>
// ---------------------------------------------------------------------------

app.get("/api/files", async (req: Request, res: Response): Promise<void> => {
  const rel = sanitiseRelPath(req.query["path"]);
  const abs = path.join(SHARED_ROOT, rel);

  try {
    const stat = await fs.stat(abs);
    if (!stat.isDirectory()) {
      res.status(400).json({ error: "Path is not a directory" });
      return;
    }

    const names = await fs.readdir(abs);
    const entries = await Promise.all(
      names.map(async (name) => {
        const childStat = await fs.stat(path.join(abs, name)).catch(() => null);
        return {
          name,
          type: childStat?.isDirectory() ? "dir" : "file",
        };
      }),
    );

    res.json({ path: rel, entries });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      res.status(404).json({ error: `Path not found: ${rel}` });
    } else {
      res.status(500).json({ error: message });
    }
  }
});

// ---------------------------------------------------------------------------
// GET /api/file?path=<relative>
// Streams a file from SHARED_ROOT/<path>
// ---------------------------------------------------------------------------

app.get("/api/file", async (req: Request, res: Response): Promise<void> => {
  const rel = sanitiseRelPath(req.query["path"]);
  const abs = path.join(SHARED_ROOT, rel);

  try {
    const stat = await fs.stat(abs);
    if (!stat.isFile()) {
      res.status(400).json({ error: "Path is not a file" });
      return;
    }

    const mimeType = mimeLookup(abs) || "application/octet-stream";
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Cache-Control", "no-cache");

    createReadStream(abs).pipe(res);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      res.status(404).json({ error: `File not found: ${rel}` });
    } else {
      res.status(500).json({ error: message });
    }
  }
});

// ---------------------------------------------------------------------------
// SPA Fallback (Production)
// ---------------------------------------------------------------------------

if (existsSync(DIST_PATH)) {
  app.get("*", (req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith("/api")) {
      return next();
    }
    res.sendFile(path.join(DIST_PATH, "index.html"));
  });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

startServer(DEFAULT_PORT);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sanitise the `path` query param to a safe relative path.
 * Strips leading slashes and resolves ".." traversal.
 */
function sanitiseRelPath(raw: unknown): string {
  if (typeof raw !== "string") return "";
  // Normalise and strip any traversal outside the root
  const normalised = path.normalize(raw).replace(/^(\.\.(\/|\\|$))+/, "");
  return normalised === "." ? "" : normalised;
}

function startServer(port: number): void {
  const server = app.listen(port, "0.0.0.0", () => {
    console.warn(
      `[resource-wall server] Listening on http://0.0.0.0:${port}`,
    );
    console.warn(`[resource-wall server] CWD: ${process.cwd()}`);
    console.warn(`[resource-wall server] Serving files from: ${SHARED_ROOT}`);
    console.warn(`[resource-wall server] OpenClaw Home is set to: ${OPENCLAW_HOME}`);

    void gatewayConfigPromise.then((config) => {
      if (config.mode === "local") {
        console.warn(
          `[resource-wall server] Targeting local OpenClaw Gateway at: ${config.wsUrl}`,
        );
      } else {
        console.warn(
          `[resource-wall server] Targeting AgentCore runtime: ${config.runtimeArn} (${config.qualifier})`,
        );
        if (config.liveWsUrl) {
          console.warn(
            `[resource-wall server] Targeting AgentCore bridge WS at: ${config.liveWsUrl}`,
          );
        } else {
          console.warn(
            `[resource-wall server] AGENTCORE_BRIDGE_WS_URL not set; using polled AgentCore event relay every ${config.eventPollIntervalMs}ms.`,
          );
        }
      }

      const monitor = createDashboardMonitor(config);
      monitor?.start();
    });
  });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "", `http://${request.headers.host}`);
    if (url.pathname === "/api/ws") {
      dashboardWss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
        dashboardWss.emit("connection", ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      throw new Error(
        `[resource-wall server] Port ${port} is already in use. ` +
          `Update API_PORT/VITE_API_PORT in your env config or stop the process using that port.`,
      );
    }

    throw error;
  });
}

function createDashboardMonitor(config: GatewayConfig): DashboardMonitor | null {
  if (config.mode === "local") {
    return new GatewayEventMonitor(config);
  }

  if (config.liveWsUrl) {
    return new AgentCoreBridgeMonitor(config.liveWsUrl);
  }

  return new AgentCorePollingMonitor(config);
}

class GatewayEventMonitor {
  private ws: WebSocket | null = null;
  private config: LocalGatewayConfig;
  private shouldReconnect = true;
  private runRoles = new Map<string, string>();

  constructor(config: LocalGatewayConfig) {
    this.config = config;
  }

  start() {
    if (!this.shouldReconnect) return;
    console.log(`[monitor] Connecting to ${this.config.wsUrl} (token length: ${this.config.token.length})...`);
    this.ws = new WebSocket(this.config.wsUrl, {
      origin: this.config.httpUrl,
    });

    this.ws.on("message", (data: RawData) => {
      const rawString = String(data);
      const message = parseGatewayMessage(data);
      if (!message) return;

      if (message.type === "event") {
        if (message.event === "connect.challenge") {
          this.ws?.send(
            JSON.stringify({
              type: "req",
              id: "connect",
              method: "connect",
              params: {
                minProtocol: 3,
                maxProtocol: 3,
                client: {
                  id: "openclaw-control-ui",
                  version: "openclaw-character-dashboard-monitor",
                  platform: "node",
                  mode: "webchat",
                  instanceId: "openclaw-character-dashboard-monitor",
                },
                role: "operator",
                scopes: ["operator.read"],
                caps: ["tool-events"],
                auth: this.config.token ? { token: this.config.token } : {},
                userAgent: "node-monitor",
                locale: "en",
              },
            }),
          );
          return;
        }

        const raw = JSON.parse(rawString);
        const payload = raw.payload;
        if (!payload) return;

        if (message.event === "chat") {
          const runId = payload.runId || "unknown";
          const messageData = payload.message || {};
          
          // Capture role if present, otherwise fallback to cached role for this run
          let role = (typeof messageData.role === "string" ? messageData.role : "").toLowerCase();
          if (role) {
            this.runRoles.set(runId, role);
          } else {
            role = this.runRoles.get(runId) || "assistant";
          }

          const content = typeof messageData.content === "string" 
            ? messageData.content 
            : Array.isArray(messageData.content)
              ? messageData.content.map((p: any) => p.text || "").join("")
              : typeof messageData.text === "string"
                ? messageData.text
                : "";

          if (content) {
            console.log(`[AGENT MESSAGE] [${runId}] ${role.toUpperCase()}: ${content}`);
            broadcastToDashboard({
              type: "agent-message",
              runId,
              role,
              content,
              sessionKey: payload.sessionKey,
              agentId: agentIdFromSessionKey(payload.sessionKey),
            });
          }

          // Cleanup role cache on final/error states
          if (payload.state === "final" || payload.state === "error" || payload.state === "aborted") {
            this.runRoles.delete(runId);
            broadcastToDashboard({
              type: "agent-message-final",
              runId,
              state: payload.state,
              agentId: agentIdFromSessionKey(payload.sessionKey),
            });
          }
        } else if (message.event === "agent") {
          const stream = payload.stream || "unknown";
          const runId = payload.runId || "none";
          if (payload.data && payload.data.chunk) {
             console.log(`[AGENT STREAM] [${runId}] ${stream.toUpperCase()}: ${payload.data.chunk}`);
             broadcastToDashboard({
               type: "agent-stream",
               runId,
               stream,
               chunk: payload.data.chunk,
               agentId: agentIdFromSessionKey(payload.sessionKey),
             });
          } else if (payload.data && payload.data.phase) {
             console.log(`[AGENT LIFECYCLE] [${runId}] PHASE: ${payload.data.phase}`);
             broadcastToDashboard({
               type: "agent-lifecycle",
               runId,
               phase: payload.data.phase,
               agentId: agentIdFromSessionKey(payload.sessionKey),
             });
             if (payload.data.phase === "end" || payload.data.phase === "error") {
               this.runRoles.delete(runId);
             }
          }
        }
      } else if (message.type === "res" && message.id === "connect") {
        if (message.ok) {
          console.log(`[monitor] Successfully connected to gateway`);
        } else {
          console.error(`[monitor] Gateway connect failed: ${message.error?.message}`);
        }
      }

    });

    this.ws.on("close", () => {
      console.warn(`[monitor] WebSocket closed`);
      this.ws = null;
      if (this.shouldReconnect) {
        console.log(`[monitor] Reconnecting in 5s...`);
        setTimeout(() => this.start(), 5000);
      }
    });

    this.ws.on("error", (err: Error) => {
      console.error(`[monitor] WebSocket error: ${err.message}`);
    });
  }

  stop() {
    this.shouldReconnect = false;
    this.ws?.close();
  }
}

class AgentCoreBridgeMonitor {
  private ws: WebSocket | null = null;
  private readonly wsUrl: string;
  private shouldReconnect = true;

  constructor(wsUrl: string) {
    this.wsUrl = wsUrl;
  }

  start(): void {
    if (!this.shouldReconnect) return;
    console.log(`[monitor] Connecting to AgentCore bridge ${this.wsUrl}...`);
    this.ws = new WebSocket(this.wsUrl);

    this.ws.on("open", () => {
      console.log("[monitor] Successfully connected to AgentCore bridge");
    });

    this.ws.on("message", (data: RawData) => {
      try {
        broadcastToDashboard(JSON.parse(String(data)));
      } catch (err) {
        console.error(
          `[monitor] Failed to parse AgentCore bridge event: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });

    this.ws.on("close", () => {
      console.warn("[monitor] AgentCore bridge WebSocket closed");
      this.ws = null;
      if (this.shouldReconnect) {
        console.log("[monitor] Reconnecting in 5s...");
        setTimeout(() => this.start(), 5000);
      }
    });

    this.ws.on("error", (err: Error) => {
      console.error(`[monitor] AgentCore bridge WebSocket error: ${err.message}`);
    });
  }

  stop(): void {
    this.shouldReconnect = false;
    this.ws?.close();
  }
}

class AgentCorePollingMonitor {
  private readonly config: AgentCoreGatewayConfig;
  private shouldPoll = true;
  private nextSeq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;

  constructor(config: AgentCoreGatewayConfig) {
    this.config = config;
  }

  start(): void {
    if (!this.shouldPoll) return;
    void this.poll();
  }

  stop(): void {
    this.shouldPoll = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(): void {
    if (!this.shouldPoll) return;
    this.timer = setTimeout(() => {
      void this.poll();
    }, this.config.eventPollIntervalMs);
  }

  private async poll(): Promise<void> {
    if (!this.shouldPoll || this.inFlight) {
      return;
    }

    this.inFlight = true;
    try {
      const payload = await fetchAgentCoreEvents(this.config, this.nextSeq);
      this.nextSeq =
        typeof payload.nextSeq === "number" ? payload.nextSeq : this.nextSeq;
      const events = payload.events ?? [];

      if (events.length > 0) {
        console.log(
          `[monitor] Relaying ${events.length} AgentCore event(s), nextSeq=${this.nextSeq}`,
        );
      }

      for (const event of events) {
        broadcastToDashboard(event);
      }
    } catch (err) {
      console.error(
        `[monitor] AgentCore event poll failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.inFlight = false;
      this.scheduleNext();
    }
  }
}


function loadServerEnv(): void {
  const envDir = process.cwd();
  const loadedValues: Record<string, string> = {};

  for (const fileName of [".env", ".env.local"]) {
    const filePath = path.join(envDir, fileName);
    if (!existsSync(filePath)) {
      continue;
    }

    Object.assign(loadedValues, parseEnvFile(readFileSync(filePath, "utf8")));
  }

  for (const [key, value] of Object.entries(loadedValues)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  if (
    process.env["API_PORT"] === undefined &&
    process.env["VITE_API_PORT"] !== undefined
  ) {
    process.env["API_PORT"] = process.env["VITE_API_PORT"];
  }
}

function parseEnvFile(contents: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const equalsIndex = line.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }

    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    values[key] = value;
  }

  return values;
}

function resolveConfiguredPath(rawPath: string): string {
  if (rawPath === "~") {
    return os.homedir();
  }

  if (rawPath.startsWith("~/")) {
    return path.join(os.homedir(), rawPath.slice(2));
  }

  return path.resolve(rawPath);
}

async function readGatewayConfig(): Promise<GatewayConfig> {
  const mode = (process.env["OPENCLAW_BACKEND_MODE"] ?? "local").toLowerCase();
  if (mode === "agentcore") {
    return readAgentCoreConfig();
  }

  const gatewayHost = process.env["GATEWAY_HOST"] ?? "127.0.0.1";
  const configPath = path.join(OPENCLAW_HOME, "openclaw.json");
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as {
      gateway?: { port?: number; auth?: { token?: string } };
    };
    const port = parsed.gateway?.port ?? 18789;
    const token = parsed.gateway?.auth?.token ?? "";

    if (token) {
      console.log(`[gateway] Loaded auth token from ${configPath}`);
    } else {
      console.warn(`[gateway] No auth token found in ${configPath}`);
    }

    return {
      mode: "local",
      httpUrl: `http://${gatewayHost}:${port}`,
      wsUrl: `ws://${gatewayHost}:${port}`,
      token,
    };
  } catch (err) {
    const port = 18789;
    console.warn(`[gateway] Could not read config at ${configPath}, using defaults. Error: ${err instanceof Error ? err.message : String(err)}`);
    return {
      mode: "local",
      httpUrl: `http://${gatewayHost}:${port}`,
      wsUrl: `ws://${gatewayHost}:${port}`,
      token: "",
    };
  }
}

async function fetchGatewaySnapshot(
  gatewayConfigPromise: GatewayConfig | Promise<GatewayConfig>,
): Promise<GatewaySnapshot> {
  const gatewayConfig = await gatewayConfigPromise;
  if (gatewayConfig.mode === "agentcore") {
    return fetchAgentCoreSnapshot(gatewayConfig);
  }

  return fetchLocalGatewaySnapshot(gatewayConfig);
}

async function fetchLocalGatewaySnapshot(
  gatewayConfig: LocalGatewayConfig,
): Promise<GatewaySnapshot> {
  console.log(`[gateway] Attempting connection to ${gatewayConfig.wsUrl}...`);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(gatewayConfig.wsUrl, {
      origin: gatewayConfig.httpUrl,
    });

    let requestSeq = 1;
    let settled = false;
    const pending = new Map<string, PendingRequest>();

    const rejectAllPending = (error: Error): void => {
      for (const entry of pending.values()) {
        entry.reject(error);
      }
      pending.clear();
    };

    const finish = (
      result:
        | { ok: true; value: GatewaySnapshot }
        | { ok: false; error: Error },
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (
        ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING
      ) {
        ws.close();
      }

      if (!result.ok) {
        const error = (result as { error: Error }).error;
        console.error(`[gateway] Connection failed: ${error.message}`);
        rejectAllPending(error);
        reject(error);
      } else {
        console.log(`[gateway] Successfully fetched snapshot from ${gatewayConfig.httpUrl}`);
        resolve(result.value);
      }
    };

    const request = <T>(
      method: string,
      params: Record<string, unknown>,
    ): Promise<T> =>
      new Promise<T>((resolveRequest, rejectRequest) => {
        const id = String(requestSeq++);
        pending.set(id, {
          resolve: resolveRequest as (value: unknown) => void,
          reject: rejectRequest,
        });

        ws.send(
          JSON.stringify({ type: "req", id, method, params }),
          (error: Error | undefined) => {
            if (!error) {
              return;
            }

            pending.delete(id);
            rejectRequest(
              error instanceof Error ? error : new Error(String(error)),
            );
          },
        );
      });

    const timeout = setTimeout(() => {
      finish({ ok: false, error: new Error("Gateway snapshot timeout") });
    }, 15_000);

    ws.on("message", async (data: RawData) => {
      const message = parseGatewayMessage(data);
      if (!message) {
        return;
      }

      if (message.type === "event" && message.event === "connect.challenge") {
        ws.send(
          JSON.stringify({
            type: "req",
            id: "connect",
            method: "connect",
            params: {
              minProtocol: 3,
              maxProtocol: 3,
              client: {
                id: "openclaw-control-ui",
                version: "openclaw-character-dashboard-dev-server",
                platform: "node",
                mode: "webchat",
                instanceId: "openclaw-character-dashboard-dev-server",
              },
              role: "operator",
              scopes: ["operator.read"],
              caps: ["tool-events"],
              auth: gatewayConfig.token ? { token: gatewayConfig.token } : {},
              userAgent: "vite-dev-server",
              locale: "en",
            },
          }),
        );
        return;
      }

      if (message.type !== "res") {
        return;
      }

      if (message.id === "connect") {
        if (!message.ok) {
          finish({
            ok: false,
            error: new Error(
              message.error?.message ?? "Gateway connect failed",
            ),
          });
          return;
        }

        try {
          const [agents, sessions, presence] = await Promise.all([
            request<unknown>("agents.list", {}),
            request<unknown>("sessions.list", {
              includeGlobal: true,
              includeUnknown: true,
              limit: 100,
            }),
            request<unknown>("system-presence", {}).catch(() => []),
          ]);

          const agentIds = ((agents as GatewayAgentsPayload).agents ?? [])
            .map((agent) => agent.id)
            .filter(
              (agentId): agentId is string => typeof agentId === "string",
            );

          const identityEntries = await Promise.all(
            agentIds.map(async (agentId) => {
              try {
                const identity = await request<unknown>("agent.identity.get", {
                  agentId,
                });
                return [agentId, identity] as const;
              } catch (error) {
                return [
                  agentId,
                  {
                    error:
                      error instanceof Error ? error.message : String(error),
                  },
                ] as const;
              }
            }),
          );

          finish({
            ok: true,
            value: {
              agents,
              sessions,
              presence,
              identities: Object.fromEntries(identityEntries),
              source: gatewayConfig.httpUrl,
              fetchedAt: Date.now(),
            },
          });
        } catch (error) {
          finish({
            ok: false,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
        return;
      }

      const entry = pending.get(message.id);
      if (!entry) {
        return;
      }

      pending.delete(message.id);
      if (message.ok) {
        entry.resolve(message.payload);
      } else {
        entry.reject(
          new Error(message.error?.message ?? "Gateway request failed"),
        );
      }
    });

    ws.on("error", (err: Error) => {
      finish({ ok: false, error: err });
    });

    ws.on("close", () => {
      if (!settled) {
        finish({ ok: false, error: new Error("Gateway websocket closed") });
      }
    });
  });
}

async function readAgentCoreConfig(): Promise<AgentCoreGatewayConfig> {
  const region =
    process.env["AGENTCORE_REGION"] ??
    process.env["AWS_REGION"] ??
    process.env["AWS_DEFAULT_REGION"];
  const runtimeArn = process.env["AGENTCORE_RUNTIME_ARN"] ?? "";
  const qualifier = process.env["AGENTCORE_RUNTIME_ENDPOINT_ID"] ?? "";
  const actorId = process.env["AGENTCORE_ACTOR_ID"] ?? "";
  const channel =
    process.env["AGENTCORE_CHANNEL"] ??
    (actorId.includes(":") ? actorId.split(":", 1)[0] : "test");

  if (!region) {
    throw new Error("AGENTCORE_REGION or AWS_REGION is required for agentcore mode");
  }
  if (!runtimeArn) {
    throw new Error("AGENTCORE_RUNTIME_ARN is required for agentcore mode");
  }
  if (!qualifier) {
    throw new Error("AGENTCORE_RUNTIME_ENDPOINT_ID is required for agentcore mode");
  }
  if (!actorId) {
    throw new Error("AGENTCORE_ACTOR_ID is required for agentcore mode");
  }

  const resolvedIdentity = await resolveAgentCoreIdentity({
    region,
    qualifier,
    actorId,
    explicitUserId: process.env["AGENTCORE_USER_ID"],
    explicitRuntimeSessionId: process.env["AGENTCORE_RUNTIME_SESSION_ID"],
  });
  const eventPollIntervalMs = readPositiveInteger(
    process.env["AGENTCORE_EVENT_POLL_MS"],
    2000,
  );
  const liveWsUrl = process.env["AGENTCORE_BRIDGE_WS_URL"]
    ? buildAgentCoreBridgeWsUrl(
        process.env["AGENTCORE_BRIDGE_WS_URL"],
        resolvedIdentity.userId,
        actorId,
        channel,
      )
    : null;

  return {
    mode: "agentcore",
    region,
    runtimeArn,
    qualifier,
    actorId,
    channel,
    userId: resolvedIdentity.userId,
    runtimeSessionId: resolvedIdentity.runtimeSessionId,
    liveWsUrl,
    eventPollIntervalMs,
  };
}

async function fetchAgentCoreSnapshot(
  config: AgentCoreGatewayConfig,
): Promise<GatewaySnapshot> {
  const payload = (await invokeAgentCoreAction(config, {
    action: "dashboard_snapshot",
    userId: config.userId,
    actorId: config.actorId,
    channel: config.channel,
    sessionId: config.runtimeSessionId,
  })) as {
    status?: string;
    error?: string;
    snapshot?: GatewaySnapshot;
  };

  if (payload.status !== "ready" || !payload.snapshot) {
    throw new Error(
      payload.error ??
        `AgentCore dashboard snapshot failed with status ${payload.status ?? "unknown"}`,
    );
  }

  return payload.snapshot;
}

async function fetchAgentCoreEvents(
  config: AgentCoreGatewayConfig,
  since: number,
): Promise<{
  events?: Record<string, unknown>[];
  nextSeq?: number;
  streamStatus?: Record<string, unknown>;
}> {
  const payload = (await invokeAgentCoreAction(config, {
    action: "dashboard_events",
    userId: config.userId,
    actorId: config.actorId,
    channel: config.channel,
    sessionId: config.runtimeSessionId,
    since,
    limit: 100,
  })) as {
    status?: string;
    error?: string;
    events?: Record<string, unknown>[];
    nextSeq?: number;
    streamStatus?: Record<string, unknown>;
  };

  if (payload.status !== "ready") {
    throw new Error(
      payload.error ??
        `AgentCore dashboard events failed with status ${payload.status ?? "unknown"}`,
    );
  }

  return payload;
}

async function invokeAgentCoreAction(
  config: AgentCoreGatewayConfig,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const client = new BedrockAgentCoreClient({ region: config.region });
  const command = new InvokeAgentRuntimeCommand({
    agentRuntimeArn: config.runtimeArn,
    qualifier: config.qualifier,
    runtimeSessionId: config.runtimeSessionId,
    contentType: "application/json",
    accept: "application/json",
    payload: Buffer.from(JSON.stringify(payload), "utf8"),
  });

  const response = await client.send(command);
  const body = response.response;
  if (!body) {
    throw new Error("AgentCore runtime returned no response body");
  }

  const text =
    typeof body.transformToString === "function"
      ? await body.transformToString()
      : Buffer.from(await body.transformToByteArray()).toString("utf8");
  return JSON.parse(text);
}

function defaultAgentCoreUserId(actorId: string): string {
  return `dashboard-user-${createHash("sha1").update(actorId).digest("hex").slice(0, 12)}`;
}

function defaultAgentCoreRuntimeSessionId(actorId: string): string {
  return `dashboard_session_${createHash("sha1").update(actorId).digest("hex").slice(0, 24)}`;
}

function inferIdentityTableName(qualifier: string): string {
  const explicitTableName = process.env["AGENTCORE_IDENTITY_TABLE_NAME"];
  if (explicitTableName) {
    return explicitTableName;
  }

  const explicitSuffix =
    process.env["AGENTCORE_ENV_SUFFIX"] ?? process.env["OPENCLAW_ENV_SUFFIX"];
  if (explicitSuffix) {
    return explicitSuffix === "prod"
      ? "openclaw-identity-prod"
      : `openclaw-identity-${explicitSuffix}`;
  }

  const qualifierSuffixMatch = qualifier.match(/_([a-z0-9-]+)$/i);
  if (qualifierSuffixMatch) {
    return `openclaw-identity-${qualifierSuffixMatch[1]}`;
  }

  return "openclaw-identity";
}

async function resolveAgentCoreIdentity(params: {
  region: string;
  qualifier: string;
  actorId: string;
  explicitUserId?: string;
  explicitRuntimeSessionId?: string;
}): Promise<{ userId: string; runtimeSessionId: string }> {
  if (params.explicitUserId && params.explicitRuntimeSessionId) {
    return {
      userId: params.explicitUserId,
      runtimeSessionId: params.explicitRuntimeSessionId,
    };
  }

  const identityTableName = inferIdentityTableName(params.qualifier);
  const ddb = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: params.region }),
  );

  const fallbackUserId =
    params.explicitUserId ?? defaultAgentCoreUserId(params.actorId);
  const fallbackRuntimeSessionId =
    params.explicitRuntimeSessionId ??
    defaultAgentCoreRuntimeSessionId(params.actorId);

  let resolvedUserId = params.explicitUserId ?? fallbackUserId;

  if (!params.explicitUserId) {
    const channelProfile = await ddb.send(
      new GetCommand({
        TableName: identityTableName,
        Key: {
          PK: `CHANNEL#${params.actorId}`,
          SK: "PROFILE",
        },
      }),
    );

    const profileUserId =
      typeof channelProfile.Item?.["userId"] === "string"
        ? channelProfile.Item["userId"]
        : null;

    if (!profileUserId) {
      throw new Error(
        `Could not resolve AgentCore userId for actor ${params.actorId}. Set AGENTCORE_IDENTITY_TABLE_NAME correctly or provide AGENTCORE_USER_ID explicitly.`,
      );
    }

    resolvedUserId = profileUserId;
  }

  if (params.explicitRuntimeSessionId) {
    return {
      userId: resolvedUserId,
      runtimeSessionId: params.explicitRuntimeSessionId,
    };
  }

  const sessionRecord = await ddb.send(
    new GetCommand({
      TableName: identityTableName,
      Key: {
        PK: `USER#${resolvedUserId}`,
        SK: "SESSION",
      },
    }),
  );

  const resolvedRuntimeSessionId =
    typeof sessionRecord.Item?.["sessionId"] === "string"
      ? sessionRecord.Item["sessionId"]
      : fallbackRuntimeSessionId;

  console.log(
    `[agentcore] Resolved actor ${params.actorId} -> userId=${resolvedUserId}, sessionId=${resolvedRuntimeSessionId}, table=${identityTableName}`,
  );

  return {
    userId: resolvedUserId,
    runtimeSessionId: resolvedRuntimeSessionId,
  };
}

function buildAgentCoreBridgeWsUrl(
  rawUrl: string,
  userId: string,
  actorId: string,
  channel: string,
): string {
  const url = new URL(rawUrl);
  if (!url.searchParams.has("userId")) {
    url.searchParams.set("userId", userId);
  }
  if (!url.searchParams.has("actorId")) {
    url.searchParams.set("actorId", actorId);
  }
  if (!url.searchParams.has("channel")) {
    url.searchParams.set("channel", channel);
  }
  return url.toString();
}

function readPositiveInteger(rawValue: string | undefined, fallback: number): number {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function parseGatewayMessage(raw: unknown): GatewayMessage | null {
  try {
    const parsed = JSON.parse(String(raw)) as Partial<GatewayMessage>;

    if (parsed.type === "event" && typeof parsed.event === "string") {
      return { type: "event", event: parsed.event };
    }

    if (
      parsed.type === "res" &&
      typeof parsed.id === "string" &&
      typeof parsed.ok === "boolean"
    ) {
      return {
        type: "res",
        id: parsed.id,
        ok: parsed.ok,
        payload: parsed.payload,
        error:
          parsed.error && typeof parsed.error === "object"
            ? {
                message:
                  typeof parsed.error.message === "string"
                    ? parsed.error.message
                    : undefined,
              }
            : undefined,
      };
    }

    return null;
  } catch {
    return null;
  }
}
