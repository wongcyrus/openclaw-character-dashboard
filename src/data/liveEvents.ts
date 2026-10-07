import { useCharacterStore } from "@/store/characterStore";
import { useWorldStore } from "@/store/worldStore";
import { getAppConfig } from "./appConfig";
import { authenticatedFetch } from "./authenticatedFetch";

const DEFAULT_DASHBOARD_AGENT_ID = "main";
const INITIAL_EVENT_POLL_DELAY_MS = 5_000;
const EVENT_POLL_INTERVAL_MS = 2_000;
const NO_EVENT_WARNING_MS = 30_000;

export class LiveEventSource {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private nextSeq = 0;
  private lastEventAt = 0;
  private lastNoEventWarningAt = 0;
  private isStarted = false;

  constructor() {
    this.handleVisibilityChange = this.handleVisibilityChange.bind(this);
  }

  start(): void {
    if (this.isStarted) return;
    this.isStarted = true;
    this.lastEventAt = Date.now();

    window.addEventListener("visibilitychange", this.handleVisibilityChange);
    const config = getAppConfig();
    if (config.eventPollUrl) {
      console.log("[LiveEventSource] Using AgentCore event polling", {
        eventPollUrl: config.eventPollUrl,
        initialDelayMs: INITIAL_EVENT_POLL_DELAY_MS,
        intervalMs: EVENT_POLL_INTERVAL_MS,
      });
      this.pollTimer = setTimeout(
        () => void this.pollEvents(),
        INITIAL_EVENT_POLL_DELAY_MS,
      );
    } else {
      this.connect();
    }
  }

  private connect(): void {
    if (this.ws || !this.isStarted || document.hidden) return;

    const config = getAppConfig();
    const wsUrl = config.webSocketUrl || "";

    console.log(`[LiveEventSource] Connecting to ${wsUrl}`);
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log("[LiveEventSource] Connected");
    };

    this.ws.onmessage = (event) => {
      console.log(
        "[LiveEventSource] Raw WebSocket message received:",
        event.data,
      );
      try {
        const data = JSON.parse(event.data);
        console.log("[LiveEventSource] Parsed WebSocket message:", data);
        console.log("[LiveEventSource] Event received", {
          type: data?.type,
          agentId: data?.agentId,
          runId: data?.runId,
        });
        this.handleEvent(data);
      } catch (err) {
        console.error("[LiveEventSource] Failed to parse event", err);
      }
    };

    this.ws.onclose = (event) => {
      this.ws = null;
      // Only auto-reconnect if it wasn't a clean close and we are still "started"
      if (this.isStarted && !document.hidden && event.code !== 1000) {
        console.warn("[LiveEventSource] Disconnected, reconnecting in 5s...");
        this.reconnectTimer = setTimeout(() => this.connect(), 5000);
      } else {
        console.log("[LiveEventSource] Connection closed", {
          isStarted: this.isStarted,
          hidden: document.hidden,
        });
      }
    };

    this.ws.onerror = (err) => {
      console.error("[LiveEventSource] WebSocket error", err);
    };
  }

  private disconnect(): void {
    if (this.ws) {
      console.log("[LiveEventSource] Disconnecting...");
      this.ws.onclose = null; // Prevent onclose from triggering reconnect
      this.ws.close(1000, "Intentional disconnect");
      this.ws = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  stop(): void {
    this.isStarted = false;
    window.removeEventListener("visibilitychange", this.handleVisibilityChange);

    this.disconnect();
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private handleVisibilityChange(): void {
    if (document.hidden) {
      this.disconnect();
      if (this.pollTimer) {
        clearTimeout(this.pollTimer);
        this.pollTimer = null;
      }
    } else if (this.isStarted) {
      const config = getAppConfig();
      if (config.eventPollUrl) {
        void this.pollEvents();
      } else {
        this.connect();
      }
    }
  }

  private async pollEvents(): Promise<void> {
    if (!this.isStarted || document.hidden) return;

    const eventPollUrl = getAppConfig().eventPollUrl;
    if (!eventPollUrl) return;

    try {
      const response = await authenticatedFetch(
        `${eventPollUrl}?since=${encodeURIComponent(String(this.nextSeq))}`,
        {
          headers: { Accept: "application/json" },
          cache: "no-store",
        },
      );
      const payload = (await response.json()) as {
        error?: string;
        events?: unknown[];
        nextSeq?: number;
        streamStatus?: Record<string, unknown>;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? `HTTP ${response.status}`);
      }

      const events = payload.events ?? [];
      if (events.length > 0) {
        console.log("[LiveEventSource] Event poll received", {
          count: events.length,
          since: this.nextSeq,
          nextSeq: payload.nextSeq,
          streamStatus: payload.streamStatus,
        });
        this.lastEventAt = Date.now();
        for (const event of events) {
          this.handleEvent(event);
        }
      } else if (
        Date.now() - this.lastEventAt >= NO_EVENT_WARNING_MS &&
        Date.now() - this.lastNoEventWarningAt >= NO_EVENT_WARNING_MS
      ) {
        this.lastNoEventWarningAt = Date.now();
        console.warn("[LiveEventSource] No messages received", {
          since: this.nextSeq,
          idleMs: Date.now() - this.lastEventAt,
          streamStatus: payload.streamStatus,
        });
      }

      if (
        typeof payload.nextSeq === "number" &&
        Number.isSafeInteger(payload.nextSeq) &&
        payload.nextSeq >= this.nextSeq
      ) {
        this.nextSeq = payload.nextSeq;
      }
    } catch (error) {
      console.error("[LiveEventSource] Event poll failed", {
        since: this.nextSeq,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (this.isStarted && !document.hidden) {
        this.pollTimer = setTimeout(
          () => void this.pollEvents(),
          EVENT_POLL_INTERVAL_MS,
        );
      }
    }
  }

  private handleEvent(data: unknown): void {
    if (!data || typeof data !== "object" || !("type" in data)) {
      console.error("[LiveEventSource] Invalid dashboard event", data);
      return;
    }
    const event = data as Record<string, unknown>;
    if (
      event.type !== "agent-message" &&
      event.type !== "agent-stream" &&
      event.type !== "agent-message-final" &&
      event.type !== "agent-lifecycle"
    )
      return;
    const worldConfig = useWorldStore.getState().worldConfig;
    const normalizedAgentId =
      typeof event.agentId === "string" && event.agentId.trim()
        ? event.agentId
        : (worldConfig?.characters.find(
            (c) => c.agentId === DEFAULT_DASHBOARD_AGENT_ID,
          )?.agentId ??
          worldConfig?.characters[0]?.agentId ??
          DEFAULT_DASHBOARD_AGENT_ID);
    const character = worldConfig?.characters.find(
      (c) => c.agentId === normalizedAgentId,
    );
    if (!character) {
      console.warn("[LiveEventSource] No character mapping for event", {
        agentId: normalizedAgentId,
      });
      return;
    }
    const characterId = character.id;
    const currentMessage =
      useCharacterStore.getState().characterMessages[characterId];
    const runId = typeof event.runId === "string" ? event.runId : undefined;
    if (event.type === "agent-message" || event.type === "agent-stream") {
      const text = event.type === "agent-stream" ? event.chunk : event.content;
      if (typeof text !== "string") {
        console.error("[LiveEventSource] Message event is missing text", event);
        return;
      }
      const sameRun = currentMessage && currentMessage.runId === runId;
      const role = typeof event.role === "string" ? event.role : "assistant";
      const newText =
        event.type === "agent-stream"
          ? (sameRun && currentMessage.role === role
              ? currentMessage.text
              : "") + text
          : text;

      useCharacterStore.getState().setCharacterMessage(characterId, {
        text: newText,
        role,
        timestamp: Date.now(),
        runId,
        complete: role === "user",
      });
    } else if (
      event.type === "agent-message-final" ||
      (event.type === "agent-lifecycle" &&
        (event.phase === "end" ||
          event.phase === "error" ||
          event.phase === "aborted"))
    ) {
      if (currentMessage && (!runId || currentMessage.runId === runId)) {
        useCharacterStore.getState().setCharacterMessage(characterId, {
          ...currentMessage,
          complete: true,
        });
      }
    }
  }
}
