import { useCharacterStore } from "@/store/characterStore";
import { useWorldStore } from "@/store/worldStore";
import { getAppConfig } from "./appConfig";

const DEFAULT_DASHBOARD_AGENT_ID = "main";

export class LiveEventSource {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isStarted = false;

  constructor() {
    this.handleVisibilityChange = this.handleVisibilityChange.bind(this);
  }

  start(): void {
    if (this.isStarted) return;
    this.isStarted = true;

    window.addEventListener("visibilitychange", this.handleVisibilityChange);
    this.connect();
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
  }

  private handleVisibilityChange(): void {
    if (document.hidden) {
      this.disconnect();
    } else if (this.isStarted) {
      this.connect();
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
