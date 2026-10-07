import { useCharacterStore } from "@/store/characterStore";
import { useWorldStore } from "@/store/worldStore";

const DEFAULT_DASHBOARD_AGENT_ID = "main";
const RECONNECT_DELAY_MS = 5_000;

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

  stop(): void {
    this.isStarted = false;
    window.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.disconnect();
  }

  private connect(): void {
    if (this.ws || !this.isStarted || document.hidden) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/api/ws`;

    console.log(`[LiveEventSource] Connecting to ${wsUrl}`);
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log("[LiveEventSource] Connected");
    };

    this.ws.onmessage = (event) => {
      try {
        this.handleEvent(JSON.parse(String(event.data)));
      } catch (error) {
        console.error("[LiveEventSource] Failed to parse event", error);
      }
    };

    this.ws.onclose = (event) => {
      this.ws = null;
      if (this.isStarted && !document.hidden && event.code !== 1000) {
        console.warn(
          `[LiveEventSource] Disconnected, reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`,
        );
        this.reconnectTimer = setTimeout(
          () => this.connect(),
          RECONNECT_DELAY_MS,
        );
      }
    };

    this.ws.onerror = (error) => {
      console.error("[LiveEventSource] WebSocket error", error);
    };
  }

  private disconnect(): void {
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close(1000, "Intentional disconnect");
      this.ws = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
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
    ) {
      return;
    }

    const worldConfig = useWorldStore.getState().worldConfig;
    const agentId =
      typeof event.agentId === "string" && event.agentId.trim()
        ? event.agentId
        : DEFAULT_DASHBOARD_AGENT_ID;
    const character =
      worldConfig?.characters.find((item) => item.agentId === agentId) ??
      worldConfig?.characters.find(
        (item) => item.agentId === DEFAULT_DASHBOARD_AGENT_ID,
      );
    if (!character) {
      console.warn("[LiveEventSource] No character mapping for event", {
        agentId,
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

      const role = typeof event.role === "string" ? event.role : "assistant";
      const sameRun = currentMessage?.runId === runId;
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
      return;
    }

    const isComplete =
      event.type === "agent-message-final" ||
      (event.type === "agent-lifecycle" &&
        (event.phase === "end" ||
          event.phase === "error" ||
          event.phase === "aborted"));
    if (
      isComplete &&
      currentMessage &&
      (!runId || currentMessage.runId === runId)
    ) {
      useCharacterStore.getState().setCharacterMessage(characterId, {
        ...currentMessage,
        complete: true,
      });
    }
  }
}
