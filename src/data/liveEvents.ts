import { useCharacterStore } from "@/store/characterStore";
import { useWorldStore } from "@/store/worldStore";

export const DEFAULT_DASHBOARD_AGENT_ID = "main";
const RECONNECT_DELAY_MS = 5_000;

export function normalizeId(id: string): string {
  return id.toLowerCase().replace(/[-_\s]/g, "");
}

export function findMatchingCharacter(
  characters: Array<{ id: string; agentId: string; name: string }> | undefined,
  agentId: string | undefined,
): { id: string; agentId: string; name: string } | undefined {
  if (!characters || characters.length === 0) return undefined;

  const raw = agentId?.trim() ?? "";
  if (!raw || raw.toLowerCase() === "default" || raw.toLowerCase() === "main") {
    return (
      characters.find((c) => c.agentId === DEFAULT_DASHBOARD_AGENT_ID) ??
      characters.find((c) => c.id === DEFAULT_DASHBOARD_AGENT_ID) ??
      characters.find((c) => c.agentId.toLowerCase() === "default") ??
      characters[0]
    );
  }

  // 1. Direct match on agentId
  const directAgentMatch = characters.find((c) => c.agentId === raw);
  if (directAgentMatch) return directAgentMatch;

  // 2. Direct match on character.id
  const directIdMatch = characters.find((c) => c.id === raw);
  if (directIdMatch) return directIdMatch;

  // 3. Direct match on character.name (case-insensitive)
  const directNameMatch = characters.find(
    (c) => c.name.toLowerCase() === raw.toLowerCase(),
  );
  if (directNameMatch) return directNameMatch;

  // 4. Normalized match (ignoring case, hyphens, underscores, whitespace)
  const norm = normalizeId(raw);
  const normMatch = characters.find(
    (c) =>
      normalizeId(c.agentId) === norm ||
      normalizeId(c.id) === norm ||
      normalizeId(c.name) === norm,
  );
  if (normMatch) return normMatch;

  return undefined;
}

export class LiveEventSource {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isStarted = false;

  start(): void {
    if (this.isStarted) return;
    this.isStarted = true;
    this.connect();
  }

  stop(): void {
    this.isStarted = false;
    this.disconnect();
  }

  private connect(): void {
    if (this.ws || !this.isStarted) return;

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
      if (this.isStarted && event.code !== 1000) {
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
    const rawAgentId =
      typeof event.agentId === "string" && event.agentId.trim()
        ? event.agentId
        : undefined;
    const character = findMatchingCharacter(worldConfig?.characters, rawAgentId);
    if (!character) {
      console.warn("[LiveEventSource] No character mapping for event", {
        agentId: rawAgentId,
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
      const channel =
        typeof event.channel === "string" && event.channel.trim()
          ? event.channel.trim()
          : undefined;
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
        channel: channel ?? (sameRun ? currentMessage?.channel : undefined),
        complete:
          role === "user" ||
          event.type === "agent-message" ||
          event.complete === true,
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
      (!runId ||
        !currentMessage.runId ||
        currentMessage.runId === "unknown" ||
        currentMessage.runId === runId ||
        (currentMessage.runId && runId.includes(currentMessage.runId)) ||
        (runId && currentMessage.runId.includes(runId)))
    ) {
      useCharacterStore.getState().setCharacterMessage(characterId, {
        ...currentMessage,
        complete: true,
      });
    }
  }
}
