import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCharacterStore } from "@/store/characterStore";
import { useWorldStore } from "@/store/worldStore";
import type { WorldConfig } from "@/types/world";

import { LiveEventSource } from "./liveEvents";

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
  ],
};

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
});
