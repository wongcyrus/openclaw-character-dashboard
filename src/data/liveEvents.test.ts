import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCharacterStore } from "@/store/characterStore";
import { useWorldStore } from "@/store/worldStore";
import type { WorldConfig } from "@/types/world";

import {
  findMatchingCharacter,
  LiveEventSource,
  normalizeId,
} from "./liveEvents";

class TestWebSocket {
  static latest: TestWebSocket | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;

  constructor(public readonly url: string) {
    TestWebSocket.latest = this;
  }

  close(): void {}

  emit(data: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

const world: WorldConfig = {
  canvasWidth: 500,
  canvasHeight: 500,
  rooms: [],
  characters: [
    {
      id: "alice",
      agentId: "main",
      name: "Alice",
      privateRoomId: "private-alice",
      spriteSheet: {
        inside: "inside.png",
        outside: "outside.png",
        frameWidth: 64,
        frameHeight: 64,
      },
    },
    {
      id: "himmel",
      agentId: "robot_1",
      name: "Himmel",
      privateRoomId: "private-himmel",
      spriteSheet: {
        inside: "inside.png",
        outside: "outside.png",
        frameWidth: 64,
        frameHeight: 64,
      },
    },
    {
      id: "land",
      agentId: "communication_manager",
      name: "Land",
      privateRoomId: "private-land",
      spriteSheet: {
        inside: "inside.png",
        outside: "outside.png",
        frameWidth: 64,
        frameHeight: 64,
      },
    },
    {
      id: "ubel",
      agentId: "domain-commentator",
      name: "Übel",
      privateRoomId: "private-ubel",
      spriteSheet: {
        inside: "inside.png",
        outside: "outside.png",
        frameWidth: 64,
        frameHeight: 64,
      },
    },
  ],
};

describe("normalizeId and findMatchingCharacter", () => {
  it("normalizes underscores, hyphens, and whitespace", () => {
    expect(normalizeId("communication_manager")).toBe("communicationmanager");
    expect(normalizeId("communication-manager")).toBe("communicationmanager");
    expect(normalizeId("Robot_1")).toBe("robot1");
    expect(normalizeId("robot-1")).toBe("robot1");
  });

  it("finds character by direct agentId match", () => {
    expect(findMatchingCharacter(world.characters, "robot_1")?.id).toBe("himmel");
    expect(findMatchingCharacter(world.characters, "main")?.id).toBe("alice");
  });

  it("finds character by character id", () => {
    expect(findMatchingCharacter(world.characters, "himmel")?.id).toBe("himmel");
    expect(findMatchingCharacter(world.characters, "land")?.id).toBe("land");
    expect(findMatchingCharacter(world.characters, "ubel")?.id).toBe("ubel");
  });

  it("finds character by character name", () => {
    expect(findMatchingCharacter(world.characters, "Himmel")?.id).toBe("himmel");
    expect(findMatchingCharacter(world.characters, "Übel")?.id).toBe("ubel");
  });

  it("finds character by normalized variations (hyphen vs underscore)", () => {
    expect(
      findMatchingCharacter(world.characters, "communication-manager")?.id,
    ).toBe("land");
    expect(
      findMatchingCharacter(world.characters, "domain_commentator")?.id,
    ).toBe("ubel");
    expect(findMatchingCharacter(world.characters, "robot-1")?.id).toBe("himmel");
  });

  it("falls back to default/main for empty or default agentId", () => {
    expect(findMatchingCharacter(world.characters, undefined)?.id).toBe("alice");
    expect(findMatchingCharacter(world.characters, "")?.id).toBe("alice");
    expect(findMatchingCharacter(world.characters, "default")?.id).toBe("alice");
  });

  it("returns undefined for unknown agent with no match", () => {
    expect(findMatchingCharacter(world.characters, "unknown-agent-xyz")).toBeUndefined();
  });
});

describe("LiveEventSource", () => {
  let source: LiveEventSource;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", TestWebSocket);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    useWorldStore.setState({ worldConfig: world });
    useCharacterStore.setState({ characterMessages: {} });
    source = new LiveEventSource();
    source.start();
  });

  afterEach(() => {
    source.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function emit(event: Record<string, unknown>): void {
    if (!TestWebSocket.latest) throw new Error("WebSocket was not connected");
    TestWebSocket.latest.emit({ agentId: "main", runId: "run-1", ...event });
  }

  it("connects to the local dashboard WebSocket", () => {
    expect(TestWebSocket.latest?.url).toMatch(/\/api\/ws$/);
  });

  it("keeps streamed text until playback removes it", () => {
    emit({ type: "agent-stream", chunk: "Hello" });
    vi.advanceTimersByTime(60_000);
    expect(useCharacterStore.getState().characterMessages.alice).toMatchObject({
      text: "Hello",
      complete: false,
    });
  });

  it.each([
    { type: "agent-message-final", state: "final" },
    { type: "agent-lifecycle", phase: "end" },
    { type: "agent-lifecycle", phase: "error" },
    { type: "agent-lifecycle", phase: "aborted" },
  ])("marks completion without clearing final text: %j", (event) => {
    emit({ type: "agent-message", content: "Final answer", role: "assistant" });
    emit(event);
    expect(useCharacterStore.getState().characterMessages.alice).toMatchObject({
      text: "Final answer",
      complete: true,
    });
  });

  it("does not append a new run to the previous conversation", () => {
    emit({ type: "agent-stream", chunk: "Old answer" });
    emit({ type: "agent-stream", chunk: "New answer", runId: "run-2" });
    emit({ type: "agent-lifecycle", phase: "end", runId: "run-1" });
    expect(useCharacterStore.getState().characterMessages.alice).toMatchObject({
      text: "New answer",
      runId: "run-2",
      complete: false,
    });
  });

  it("marks assistant agent-message as complete immediately", () => {
    emit({
      type: "agent-message",
      content: "Hello from Telegram",
      role: "assistant",
    });
    expect(useCharacterStore.getState().characterMessages.alice).toMatchObject({
      text: "Hello from Telegram",
      complete: true,
    });
  });

  it("handles lifecycle end arriving before assistant message", () => {
    emit({ type: "agent-lifecycle", phase: "end", runId: "run-tg" });
    emit({
      type: "agent-message",
      content: "Final reply from OpenClaw Telegram",
      role: "assistant",
      runId: "run-tg",
    });
    expect(useCharacterStore.getState().characterMessages.alice).toMatchObject({
      text: "Final reply from OpenClaw Telegram",
      complete: true,
    });
  });

  it("uses main for events without an agent ID", () => {
    emit({
      type: "agent-message",
      content: "Question",
      role: "user",
      agentId: undefined,
    });
    expect(useCharacterStore.getState().characterMessages.alice).toMatchObject({
      text: "Question",
      complete: true,
    });
  });

  it("routes Telegram bot events to matching characters accurately", () => {
    emit({
      type: "agent-message",
      content: "Hello from Himmel bot",
      role: "assistant",
      agentId: "robot_1",
    });
    expect(useCharacterStore.getState().characterMessages.himmel).toMatchObject({
      text: "Hello from Himmel bot",
      complete: true,
    });

    emit({
      type: "agent-message",
      content: "Hello from Land bot",
      role: "assistant",
      agentId: "communication-manager",
    });
    expect(useCharacterStore.getState().characterMessages.land).toMatchObject({
      text: "Hello from Land bot",
      complete: true,
    });
  });

  it("stores channel on characterMessages and characterHistory", () => {
    emit({
      type: "agent-message",
      content: "User message from WebUI",
      role: "user",
      channel: "webui",
      agentId: "main",
    });
    expect(useCharacterStore.getState().characterMessages.alice).toMatchObject({
      text: "User message from WebUI",
      role: "user",
      channel: "webui",
      complete: true,
    });
    const history = useCharacterStore.getState().characterHistory.alice;
    expect(history?.[history.length - 1]).toMatchObject({
      text: "User message from WebUI",
      role: "user",
      channel: "webui",
    });
  });
});
