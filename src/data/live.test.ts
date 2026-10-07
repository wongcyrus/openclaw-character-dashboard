import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LiveDataSource } from "./live";

vi.mock("./appConfig", () => ({
  getAppConfig: () => ({ apiBaseUrl: "/api" }),
}));

describe("LiveDataSource", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("derives working and idle states and emits only changes", async () => {
    const now = Date.now();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessions: {
            sessions: [
              {
                key: "agent:main:telegram",
                channel: "telegram",
                status: "active",
                updatedAt: now,
              },
              {
                key: "agent:secondary:direct",
                chatType: "direct",
                origin: { provider: "web" },
                updatedAt: now - 60_000,
              },
              {
                key: "agent:ignored:heartbeat",
                displayName: "heartbeat",
                status: "active",
              },
              { key: "invalid:key", status: "active" },
              { status: "active" },
            ],
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessions: {
            sessions: [
              {
                key: "agent:main:telegram",
                lastChannel: "telegram",
                updatedAt: now,
              },
            ],
          },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const status = vi.fn();
    const handler = vi.fn();
    const source = new LiveDataSource(["main", "secondary"], status);
    source.on("stateChange", handler);

    source.start();
    await vi.runOnlyPendingTimersAsync();

    expect(handler).toHaveBeenCalledWith({ agentId: "main", state: "working" });
    expect(handler).toHaveBeenCalledWith({
      agentId: "secondary",
      state: "idle",
    });
    expect(status).toHaveBeenCalledWith("ok");

    await vi.advanceTimersByTimeAsync(20_000);
    expect(handler).toHaveBeenLastCalledWith({
      agentId: "main",
      state: "idle",
    });
    expect(handler).toHaveBeenCalledTimes(3);

    source.off("stateChange", handler);
    source.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports HTTP and thrown failures, then continues polling", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          json: async () => ({ error: "offline" }),
        })
        .mockRejectedValueOnce("network down"),
    );
    const status = vi.fn();
    const source = new LiveDataSource(["main"], status);

    source.start();
    await vi.runOnlyPendingTimersAsync();
    expect(status).toHaveBeenLastCalledWith("error");
    expect(console.warn).toHaveBeenCalledWith("[LiveDataSource] offline");

    await vi.advanceTimersByTimeAsync(20_000);
    expect(console.warn).toHaveBeenCalledWith("[LiveDataSource] network down");
    source.stop();
  });

  it("does not poll again after being stopped during a request", async () => {
    let resolveFetch: ((value: unknown) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );
    const source = new LiveDataSource(["main"]);
    source.start();
    source.stop();
    resolveFetch?.({
      ok: true,
      json: async () => ({ sessions: { sessions: [] } }),
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });
});
