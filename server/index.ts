import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { lookup as mimeLookup } from "mime-types";
import { WebSocketServer, WebSocket } from "ws";
import type { RawData } from "ws";

type GatewayConfig = {
  httpUrl: string;
  wsUrl: string;
  token: string;
};

const dashboardWss = new WebSocketServer({ noServer: true });
const connectedClients = new Set<WebSocket>();

export type GatewayBinding = {
  agentId: string;
  channel?: string;
  accountId?: string;
};

let gatewayBindings: GatewayBinding[] = [];

export function setGatewayBindings(bindings: GatewayBinding[]): void {
  gatewayBindings = bindings;
}

export function resolveAgentId(
  sessionKey: string | undefined,
  explicitAgentId: string | undefined,
  bindings: GatewayBinding[] = gatewayBindings,
): string {
  const explicit = explicitAgentId?.trim();
  if (explicit) {
    if (explicit.toLowerCase() === "default") return "main";
    const matched = bindings.find(
      (b) => b.accountId?.toLowerCase() === explicit.toLowerCase(),
    );
    if (matched?.agentId) return matched.agentId;
    return explicit;
  }

  if (!sessionKey || typeof sessionKey !== "string") {
    return "";
  }

  const trimmed = sessionKey.trim();
  if (!trimmed) return "";

  // 1. Check for standard agent prefix: "agent:<agentId>:..."
  if (trimmed.toLowerCase().startsWith("agent:")) {
    const parts = trimmed.split(":");
    const agentIdx = parts.findIndex((p) => p.toLowerCase() === "agent");
    if (agentIdx !== -1 && parts[agentIdx + 1]) {
      const candidate = parts[agentIdx + 1].trim();
      if (candidate) {
        if (candidate.toLowerCase() === "default") return "main";
        return candidate;
      }
    }
  }

  // 2. Check for channel session keys: "<channel>:<accountId>:..." or "telegram:<accountId>:direct:..."
  const parts = trimmed.split(":");
  if (parts.length >= 2) {
    const channel = parts[0].toLowerCase();
    const secondPart = parts[1].trim();
    const secondPartLower = secondPart.toLowerCase();

    if (
      secondPart &&
      secondPartLower !== "direct" &&
      secondPartLower !== "dm" &&
      secondPartLower !== "group" &&
      secondPartLower !== "channel" &&
      secondPartLower !== "thread" &&
      secondPartLower !== "main"
    ) {
      // Check if secondPart matches a binding accountId
      const matched = bindings.find(
        (b) =>
          (!b.channel || b.channel.toLowerCase() === channel) &&
          b.accountId?.toLowerCase() === secondPartLower,
      );
      if (matched?.agentId) {
        return matched.agentId;
      }

      if (secondPartLower === "default") {
        return "main";
      }

      return secondPart;
    }

    // If secondPart is direct/group/dm/channel/main, accountId was omitted; map to default channel binding or main
    if (
      secondPartLower === "direct" ||
      secondPartLower === "dm" ||
      secondPartLower === "group" ||
      secondPartLower === "channel" ||
      secondPartLower === "main"
    ) {
      const defaultBinding = bindings.find(
        (b) =>
          (!b.channel || b.channel.toLowerCase() === channel) &&
          (b.accountId === "default" || !b.accountId),
      );
      if (defaultBinding?.agentId) {
        return defaultBinding.agentId;
      }
      return "main";
    }
  }

  // 3. Fallback for single token session keys (e.g. "robot_1" or "default")
  if (!trimmed.includes(":")) {
    if (trimmed.toLowerCase() === "default") return "main";
    const matched = bindings.find(
      (b) => b.accountId?.toLowerCase() === trimmed.toLowerCase(),
    );
    if (matched?.agentId) return matched.agentId;
    return trimmed;
  }

  return "";
}

export function extractChannel(
  sessionKey: string | undefined,
  payload?: any,
  bindings: GatewayBinding[] = gatewayBindings,
): string {
  const candidate =
    payload?.channel ||
    payload?.message?.channel ||
    payload?.source ||
    payload?.data?.channel ||
    payload?.message?.source;

  if (typeof candidate === "string" && candidate.trim()) {
    const norm = candidate.trim().toLowerCase();
    if (
      norm === "web" ||
      norm === "webui" ||
      norm === "ui" ||
      norm === "dashboard" ||
      norm === "main"
    ) {
      return "webui";
    }
    if (norm === "tg") return "telegram";
    return norm;
  }

  if (!sessionKey || typeof sessionKey !== "string") {
    return "webui";
  }

  const trimmed = sessionKey.trim().toLowerCase();
  if (!trimmed) return "webui";

  // Check known channel keywords in session key tokens
  const tokens = trimmed.split(":");
  if (tokens.includes("telegram") || tokens.includes("tg")) {
    return "telegram";
  }
  if (tokens.includes("discord")) {
    return "discord";
  }
  if (tokens.includes("slack")) {
    return "slack";
  }
  if (tokens.includes("whatsapp")) {
    return "whatsapp";
  }
  if (tokens.includes("signal")) {
    return "signal";
  }
  if (tokens.includes("cron")) {
    return "cron";
  }
  if (tokens.includes("subagent")) {
    return "subagent";
  }
  if (
    tokens.includes("web") ||
    tokens.includes("webui") ||
    tokens.includes("ui")
  ) {
    return "webui";
  }
  if (
    trimmed === "main" ||
    trimmed === "global" ||
    tokens.includes("main") ||
    tokens.includes("global")
  ) {
    return "webui";
  }

  // If there's a binding matching accountId or channel, check bindings
  for (const b of bindings) {
    if (b.channel && b.accountId && tokens.includes(b.accountId.toLowerCase())) {
      return b.channel.toLowerCase();
    }
  }

  return "webui";
}

export function extractRunId(payload: any): string {
  if (typeof payload?.runId === "string" && payload.runId.trim()) {
    return payload.runId.trim();
  }
  if (typeof payload?.clientRunId === "string" && payload.clientRunId.trim()) {
    return payload.clientRunId.trim();
  }
  if (
    typeof payload?.message?.__openclaw?.runId === "string" &&
    payload.message.__openclaw.runId.trim()
  ) {
    return payload.message.__openclaw.runId.trim();
  }
  if (
    typeof payload?.message?.runId === "string" &&
    payload.message.runId.trim()
  ) {
    return payload.message.runId.trim();
  }
  const idemKey =
    payload?.message?.idempotencyKey ||
    payload?.message?.__openclaw?.idempotencyKey;
  if (typeof idemKey === "string" && idemKey.trim()) {
    const prefix = idemKey.trim().split(":")[0];
    if (prefix && prefix !== "user" && prefix !== "assistant") {
      return prefix;
    }
  }
  return "";
}

export function extractMessageContent(payload: any): string {
  const messageData = payload?.message || {};
  if (typeof messageData.content === "string") {
    return messageData.content;
  }
  if (Array.isArray(messageData.content)) {
    return messageData.content
      .map((p: any) => {
        if (typeof p === "string") return p;
        if (p?.type === "text" && typeof p.text === "string") return p.text;
        if (typeof p?.text === "string" && p?.type !== "thinking") return p.text;
        return "";
      })
      .join("")
      .trim();
  }
  if (typeof messageData.text === "string") return messageData.text;
  if (typeof payload?.deltaText === "string") return payload.deltaText;
  if (typeof payload?.text === "string") return payload.text;
  return "";
}

interface RecentEvent {
  data: unknown;
  timestamp: number;
}
const recentAgentEvents = new Map<string, RecentEvent>();

dashboardWss.on("connection", (ws: WebSocket) => {
  connectedClients.add(ws);
  console.log(
    `[dashboard-ws] Client connected (total: ${connectedClients.size})`,
  );

  // Replay recent messages (within 45 seconds) so newly connected or refreshed tabs display current speech
  const now = Date.now();
  for (const [, recent] of recentAgentEvents.entries()) {
    if (now - recent.timestamp < 45_000 && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(recent.data));
    }
  }

  ws.on("close", () => {
    connectedClients.delete(ws);
    console.log(
      `[dashboard-ws] Client disconnected (total: ${connectedClients.size})`,
    );
  });
});

function broadcastToDashboard(data: Record<string, unknown>) {
  if (data["type"] === "agent-message") {
    const key =
      (typeof data["agentId"] === "string" && data["agentId"]) || "main";
    recentAgentEvents.set(key, { data, timestamp: Date.now() });
  }
  const payload = JSON.stringify(data);
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
  console.warn(
    `[resource-wall server] Serving static files from: ${DIST_PATH}`,
  );
  app.use(express.static(DIST_PATH));
}

// ---------------------------------------------------------------------------
// GET /api/openclaw/snapshot
// Proxies a live OpenClaw gateway snapshot over HTTP for the frontend.
// ---------------------------------------------------------------------------

app.get(
  "/api/openclaw/snapshot",
  async (_req: Request, res: Response): Promise<void> => {
    try {
      const payload = await fetchGatewaySnapshot(gatewayConfigPromise);
      res.status(200).json(payload);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

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
  app.get("{*splat}", (req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith("/api")) {
      return next();
    }
    res.sendFile(path.join(DIST_PATH, "index.html"));
  });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

if (process.env["NODE_ENV"] !== "test" && !process.env["VITEST"]) {
  startServer(DEFAULT_PORT);
}

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
  const gatewayHost = process.env["GATEWAY_HOST"] ?? "127.0.0.1";
  const server = app.listen(port, "0.0.0.0", () => {
    console.warn(`[resource-wall server] Listening on http://0.0.0.0:${port}`);
    console.warn(`[resource-wall server] CWD: ${process.cwd()}`);
    console.warn(`[resource-wall server] Serving files from: ${SHARED_ROOT}`);
    console.warn(
      `[resource-wall server] Targeting OpenClaw Gateway at: ${gatewayHost}`,
    );
    console.warn(
      `[resource-wall server] OpenClaw Home is set to: ${OPENCLAW_HOME}`,
    );

    void gatewayConfigPromise.then((config) => {
      const monitor = new GatewayEventMonitor(config);
      monitor.start();
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

type PendingSubRequest = {
  sessionKey: string;
  agentId?: string;
  retries: number;
};

type InFlightRequest = {
  id: string;
  sessionKey: string;
  agentId?: string;
  retries: number;
  timestamp: number;
};

class GatewayEventMonitor {
  private ws: WebSocket | null = null;
  private config: GatewayConfig;
  private shouldReconnect = true;
  private runRoles = new Map<string, string>();
  private runChannels = new Map<string, string>();
  private subscribedSessionKeys = new Set<string>();
  private pendingSubscriptions = new Map<string, PendingSubRequest>();
  private inFlightRequests = new Map<string, InFlightRequest>();
  private pollInterval: NodeJS.Timeout | null = null;
  private readonly maxInFlight = 2;
  private requestSeq = 1;

  constructor(config: GatewayConfig) {
    this.config = config;
  }

  private subscribeToSession(
    sessionKey: string | undefined,
    agentId?: string,
  ): void {
    if (!sessionKey || typeof sessionKey !== "string") return;
    const trimmed = sessionKey.trim();
    if (!trimmed) return;
    if (this.subscribedSessionKeys.has(trimmed)) return;
    if (this.pendingSubscriptions.has(trimmed)) return;

    for (const inFlight of this.inFlightRequests.values()) {
      if (inFlight.sessionKey === trimmed) return;
    }

    this.pendingSubscriptions.set(trimmed, {
      sessionKey: trimmed,
      agentId,
      retries: 0,
    });
    this.drainQueue();
  }

  private drainQueue(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // Clean up any stale in-flight requests (> 15s without gateway response)
    const now = Date.now();
    for (const [id, req] of this.inFlightRequests.entries()) {
      if (now - req.timestamp > 15_000) {
        this.inFlightRequests.delete(id);
        if (req.retries < 5 && !this.subscribedSessionKeys.has(req.sessionKey)) {
          this.pendingSubscriptions.set(req.sessionKey, {
            sessionKey: req.sessionKey,
            agentId: req.agentId,
            retries: req.retries + 1,
          });
        }
      }
    }

    while (
      this.inFlightRequests.size < this.maxInFlight &&
      this.pendingSubscriptions.size > 0
    ) {
      const nextKey = this.pendingSubscriptions.keys().next().value;
      if (!nextKey) break;

      const sub = this.pendingSubscriptions.get(nextKey)!;
      this.pendingSubscriptions.delete(nextKey);

      if (this.subscribedSessionKeys.has(sub.sessionKey)) continue;

      const id = `sub-msg-${this.requestSeq++}-${Date.now()}`;
      this.inFlightRequests.set(id, {
        id,
        sessionKey: sub.sessionKey,
        agentId: sub.agentId,
        retries: sub.retries,
        timestamp: Date.now(),
      });

      console.log(
        `[monitor] Subscribing to session messages for: ${sub.sessionKey} (req ${id})`,
      );
      this.ws.send(
        JSON.stringify({
          type: "req",
          id,
          method: "sessions.messages.subscribe",
          params: {
            key: sub.sessionKey,
            ...(sub.agentId ? { agentId: sub.agentId } : {}),
          },
        }),
      );
    }
  }

  private requestSessionList(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: "req",
          id: `sessions-list-${Date.now()}`,
          method: "sessions.list",
          params: {
            includeGlobal: true,
            includeUnknown: true,
            limit: 100,
          },
        }),
      );
    }
  }

  private handleSessionList(payload: any): void {
    if (!payload || typeof payload !== "object") return;
    const sessions = Array.isArray(payload.sessions)
      ? payload.sessions
      : Array.isArray(payload)
        ? payload
        : [];

    for (const session of sessions) {
      const key =
        typeof session?.key === "string"
          ? session.key
          : typeof session?.sessionKey === "string"
            ? session.sessionKey
            : "";
      const agentId =
        typeof session?.agentId === "string" ? session.agentId : undefined;
      if (key) {
        this.subscribeToSession(key, agentId);
      }
    }
  }

  start() {
    if (!this.shouldReconnect) return;
    console.log(
      `[monitor] Connecting to ${this.config.wsUrl} (token length: ${this.config.token.length})...`,
    );
    this.ws = new WebSocket(this.config.wsUrl);

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
                minProtocol: 4,
                maxProtocol: 4,
                client: {
                  id: "gateway-client",
                  version: "openclaw-character-dashboard-monitor",
                  platform: "node",
                  mode: "backend",
                  instanceId: "openclaw-character-dashboard-monitor",
                },
                role: "operator",
                scopes: [
                  "operator.admin",
                  "operator.read",
                  "operator.write",
                  "operator.approvals",
                  "operator.pairing",
                  "operator.sessions.read",
                  "operator.sessions.write",
                ],
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

        if (message.event === "sessions.changed") {
          const sessionKey = payload.sessionKey || payload.key;
          const channel = extractChannel(sessionKey, payload);
          const agentId = resolveAgentId(
            sessionKey,
            payload.agentId || payload.data?.agentId,
          );
          if (sessionKey) {
            this.subscribeToSession(sessionKey, agentId);
          }

          if (payload.phase) {
            const runId = extractRunId(payload) || "none";
            console.log(
              `[AGENT LIFECYCLE (SESSION)] [${runId}] [${agentId || "unknown"}] PHASE: ${payload.phase}`,
            );
            broadcastToDashboard({
              type: "agent-lifecycle",
              runId,
              phase: payload.phase,
              agentId,
            });
            if (
              payload.phase === "end" ||
              payload.phase === "error" ||
              payload.phase === "aborted"
            ) {
              if (runId !== "none") {
                this.runRoles.delete(runId);
                this.runChannels.delete(runId);
              }
            }
          }

          if (
            typeof payload.lastMessagePreview === "string" &&
            payload.lastMessagePreview.trim()
          ) {
            const preview = payload.lastMessagePreview.trim();
            const runId = extractRunId(payload) || "session-preview";
            console.log(
              `[SESSION PREVIEW] [${runId}] [${agentId || "unknown"}] [${channel}]: ${preview}`,
            );
            broadcastToDashboard({
              type: "agent-message",
              runId,
              role: "assistant",
              content: preview,
              sessionKey,
              agentId,
              channel,
            });
          }
        } else if (
          message.event === "session.message" ||
          message.event === "chat"
        ) {
          const runId = extractRunId(payload) || "unknown";
          const messageData = payload.message || {};
          const sessionKey = payload.sessionKey;
          const channel = extractChannel(sessionKey, payload);

          if (runId && runId !== "unknown") {
            this.runChannels.set(runId, channel);
          }

          // Auto-subscribe session key if present
          if (payload.sessionKey) {
            this.subscribeToSession(payload.sessionKey, payload.agentId);
          }

          // Capture role if present, otherwise fallback to cached role for this run
          let role = (
            typeof messageData.role === "string" ? messageData.role : ""
          ).toLowerCase();
          if (role) {
            this.runRoles.set(runId, role);
          } else {
            role = this.runRoles.get(runId) || "assistant";
          }

          const content = extractMessageContent(payload);

          const agentId = resolveAgentId(
            payload.sessionKey,
            payload.agentId || payload.data?.agentId || messageData.agentId,
          );

          if (content) {
            console.log(
              `[AGENT MESSAGE] [${runId}] [${agentId || "unknown"}] [${channel}] ${role.toUpperCase()}: ${content}`,
            );
            broadcastToDashboard({
              type: "agent-message",
              runId,
              role,
              content,
              sessionKey: payload.sessionKey,
              agentId,
              channel,
            });
          }

          // Cleanup role cache on final/error states
          if (
            payload.state === "final" ||
            payload.state === "error" ||
            payload.state === "aborted"
          ) {
            this.runRoles.delete(runId);
            this.runChannels.delete(runId);
            broadcastToDashboard({
              type: "agent-message-final",
              runId,
              state: payload.state,
              agentId,
            });
          }
        } else if (message.event === "agent") {
          const stream = payload.stream || "unknown";
          const runId = extractRunId(payload) || "none";
          const agentId = resolveAgentId(
            payload.sessionKey,
            payload.agentId || payload.data?.agentId,
          );
          const channel =
            extractChannel(payload.sessionKey, payload) ||
            (runId !== "none" ? this.runChannels.get(runId) : undefined) ||
            "webui";

          if (payload.sessionKey) {
            this.subscribeToSession(payload.sessionKey, agentId || payload.agentId);
          }

          // Ignore "thinking" stream so LLM internal scratchpad is not spoken in bubbles
          if (stream === "thinking") {
            return;
          }

          const deltaChunk =
            typeof payload.data?.delta === "string"
              ? payload.data.delta
              : typeof payload.data?.chunk === "string"
                ? payload.data.chunk
                : typeof payload.data?.text === "string"
                  ? payload.data.text
                  : typeof payload.data?.progressText === "string"
                    ? payload.data.progressText
                    : "";

          if (
            deltaChunk &&
            (stream === "assistant" ||
              stream === "text" ||
              stream === "delta" ||
              stream === "output")
          ) {
            console.log(
              `[AGENT STREAM] [${runId}] [${agentId || "unknown"}] [${channel}] ${stream.toUpperCase()}: ${deltaChunk}`,
            );
            broadcastToDashboard({
              type: "agent-stream",
              runId,
              stream,
              chunk: deltaChunk,
              agentId,
              channel,
            });
          } else if (payload.data && payload.data.phase) {
            console.log(
              `[AGENT LIFECYCLE] [${runId}] [${agentId || "unknown"}] PHASE: ${payload.data.phase}`,
            );
            broadcastToDashboard({
              type: "agent-lifecycle",
              runId,
              phase: payload.data.phase,
              agentId,
            });
            if (
              payload.data.phase === "end" ||
              payload.data.phase === "error" ||
              payload.data.phase === "aborted"
            ) {
              this.runRoles.delete(runId);
              this.runChannels.delete(runId);
            }
          }
        }
      } else if (message.type === "res") {
        if (message.id === "connect") {
          if (message.ok) {
            console.log(`[monitor] Successfully connected to gateway`);
            this.subscribedSessionKeys.clear();
            this.inFlightRequests.clear();
            this.pendingSubscriptions.clear();

            // 1. Subscribe to general session events
            this.ws?.send(
              JSON.stringify({
                type: "req",
                id: "sub-sessions",
                method: "sessions.subscribe",
                params: {},
              }),
            );

            // 2. Fetch active sessions list
            this.requestSessionList();

            // 3. Pre-subscribe to standard default sessions and known bindings
            this.subscribeToSession("main", "main");
            this.subscribeToSession("global", "main");
            for (const binding of gatewayBindings) {
              if (binding.agentId) {
                this.subscribeToSession(
                  `agent:${binding.agentId}:main`,
                  binding.agentId,
                );
                this.subscribeToSession(binding.agentId, binding.agentId);
                this.subscribeToSession(
                  `agent:${binding.agentId}:global`,
                  binding.agentId,
                );
                if (binding.accountId) {
                  this.subscribeToSession(
                    `agent:${binding.agentId}:telegram:direct`,
                    binding.agentId,
                  );
                  this.subscribeToSession(
                    `telegram:${binding.accountId}:direct`,
                    binding.agentId,
                  );
                }
              }
            }

            // 4. Start periodic polling for sessions list
            if (this.pollInterval) clearInterval(this.pollInterval);
            this.pollInterval = setInterval(() => {
              this.requestSessionList();
            }, 10_000);
          } else {
            console.error(
              `[monitor] Gateway connect failed: ${message.error?.message}`,
            );
          }
        } else if (message.id.startsWith("sessions-list")) {
          if (message.ok && message.payload) {
            this.handleSessionList(message.payload);
          }
        } else if (message.id === "sub-sessions") {
          if (message.ok) {
            console.log(`[monitor] Subscribed to session events`);
          }
        } else if (this.inFlightRequests.has(message.id)) {
          const inFlight = this.inFlightRequests.get(message.id)!;
          this.inFlightRequests.delete(message.id);

          if (message.ok) {
            this.subscribedSessionKeys.add(inFlight.sessionKey);
            console.log(
              `[monitor] Successfully subscribed to session: ${inFlight.sessionKey}`,
            );
          } else {
            console.warn(
              `[monitor] Failed to subscribe to session ${inFlight.sessionKey}: ${message.error?.message || "unknown error"}`,
            );
            if (inFlight.retries < 5) {
              const retryDelay = Math.min(
                1000 * Math.pow(2, inFlight.retries),
                10_000,
              );
              setTimeout(() => {
                if (!this.subscribedSessionKeys.has(inFlight.sessionKey)) {
                  this.pendingSubscriptions.set(inFlight.sessionKey, {
                    sessionKey: inFlight.sessionKey,
                    agentId: inFlight.agentId,
                    retries: inFlight.retries + 1,
                  });
                  this.drainQueue();
                }
              }, retryDelay);
            }
          }
          this.drainQueue();
        }
      }
    });

    this.ws.on("close", () => {
      console.warn(`[monitor] WebSocket closed`);
      if (this.pollInterval) {
        clearInterval(this.pollInterval);
        this.pollInterval = null;
      }
      this.inFlightRequests.clear();
      this.pendingSubscriptions.clear();
      this.subscribedSessionKeys.clear();
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
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.inFlightRequests.clear();
    this.pendingSubscriptions.clear();
    this.subscribedSessionKeys.clear();
    this.ws?.close();
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
  const gatewayHost = process.env["GATEWAY_HOST"] ?? "127.0.0.1";
  const configPath = path.join(OPENCLAW_HOME, "openclaw.json");
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as {
      gateway?: { port?: number; auth?: { token?: string } };
      bindings?: Array<{
        agentId?: string;
        match?: { channel?: string; accountId?: string };
      }>;
    };
    const port = parsed.gateway?.port ?? 18789;
    const token = parsed.gateway?.auth?.token ?? "";

    if (Array.isArray(parsed.bindings)) {
      gatewayBindings = parsed.bindings
        .map((b) => ({
          agentId: typeof b.agentId === "string" ? b.agentId : "",
          channel:
            typeof b.match?.channel === "string" ? b.match.channel : undefined,
          accountId:
            typeof b.match?.accountId === "string"
              ? b.match.accountId
              : undefined,
        }))
        .filter((b) => Boolean(b.agentId));
      console.log(
        `[gateway] Loaded ${gatewayBindings.length} bindings from ${configPath}`,
      );
    }

    if (token) {
      console.log(`[gateway] Loaded auth token from ${configPath}`);
    } else {
      console.warn(`[gateway] No auth token found in ${configPath}`);
    }

    return {
      httpUrl: `http://${gatewayHost}:${port}`,
      wsUrl: `ws://${gatewayHost}:${port}`,
      token,
    };
  } catch (err) {
    const port = 18789;
    console.warn(
      `[gateway] Could not read config at ${configPath}, using defaults. Error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
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

  console.log(`[gateway] Attempting connection to ${gatewayConfig.wsUrl}...`);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(gatewayConfig.wsUrl);

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
        console.log(
          `[gateway] Successfully fetched snapshot from ${gatewayConfig.httpUrl}`,
        );
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
              minProtocol: 4,
              maxProtocol: 4,
              client: {
                id: "gateway-client",
                version: "openclaw-character-dashboard-dev-server",
                platform: "node",
                mode: "backend",
                instanceId: "openclaw-character-dashboard-dev-server",
              },
              role: "operator",
              scopes: [
                "operator.admin",
                "operator.read",
                "operator.write",
                "operator.approvals",
                "operator.pairing",
                "operator.sessions.read",
                "operator.sessions.write",
              ],
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
