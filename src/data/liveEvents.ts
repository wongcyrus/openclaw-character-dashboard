import { useCharacterStore } from "@/store/characterStore";
import { useWorldStore } from "@/store/worldStore";

const MESSAGE_TIMEOUT_MS = 10_000;
const DEFAULT_DASHBOARD_AGENT_ID = "main";

export class LiveEventSource {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private messageTimers = new Map<string, ReturnType<typeof setTimeout>>();

  start(): void {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/api/ws`;

    console.log(`[LiveEventSource] Connecting to ${wsUrl}`);
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log("[LiveEventSource] Connected");
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
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

    this.ws.onclose = () => {
      console.warn("[LiveEventSource] Disconnected, reconnecting in 5s...");
      this.ws = null;
      this.reconnectTimer = setTimeout(() => this.start(), 5000);
    };

    this.ws.onerror = (err) => {
      console.error("[LiveEventSource] WebSocket error", err);
    };
  }

  stop(): void {
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const timer of this.messageTimers.values()) {
      clearTimeout(timer);
    }
    this.messageTimers.clear();
  }

  private handleEvent(data: any): void {
    if (data.type === "agent-message" || data.type === "agent-stream") {
      const worldConfig = useWorldStore.getState().worldConfig;
      const normalizedAgentId =
        typeof data.agentId === "string" && data.agentId.trim()
          ? data.agentId
          : worldConfig?.characters.find((c) => c.agentId === DEFAULT_DASHBOARD_AGENT_ID)
              ?.agentId ??
            worldConfig?.characters[0]?.agentId ??
            DEFAULT_DASHBOARD_AGENT_ID;
      const { content, role } = data;

      const character = worldConfig?.characters.find(
        (c) => c.agentId === normalizedAgentId,
      );
      if (!character) {
        console.warn("[LiveEventSource] No character mapping for event", {
          agentId: normalizedAgentId,
          knownAgentIds: worldConfig?.characters.map((c) => c.agentId) ?? [],
        });
        return;
      }

      const characterId = character.id;
      
      // Update store
      const currentMessage = useCharacterStore.getState().characterMessages[characterId];
      const newText = data.type === "agent-stream" 
        ? (currentMessage?.text || "") + data.chunk
        : content;

      useCharacterStore.getState().setCharacterMessage(characterId, {
        text: newText,
        role: role || currentMessage?.role || "assistant",
        timestamp: Date.now()
      });
      console.log("[LiveEventSource] Updated character message", {
        characterId,
        agentId: normalizedAgentId,
        type: data.type,
      });

      // Reset timer
      if (this.messageTimers.has(characterId)) {
        clearTimeout(this.messageTimers.get(characterId));
      }

      const timer = setTimeout(() => {
        useCharacterStore.getState().setCharacterMessage(characterId, null);
        this.messageTimers.delete(characterId);
      }, MESSAGE_TIMEOUT_MS);

      this.messageTimers.set(characterId, timer);
    }
  }
}
