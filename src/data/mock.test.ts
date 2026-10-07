import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MockDataSource } from "./mock";

describe("MockDataSource", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("cycles agents between working and idle and supports unsubscribe", () => {
    const source = new MockDataSource(["main"]);
    const handler = vi.fn();
    source.on("stateChange", handler);
    source.start();

    vi.advanceTimersByTime(30_000);
    expect(handler).toHaveBeenLastCalledWith({
      agentId: "main",
      state: "working",
    });

    vi.advanceTimersByTime(30_000);
    expect(handler).toHaveBeenLastCalledWith({
      agentId: "main",
      state: "idle",
    });

    source.off("stateChange", handler);
    vi.advanceTimersByTime(30_000);
    expect(handler).toHaveBeenCalledTimes(2);
    source.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
