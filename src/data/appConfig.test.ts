import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("loadAppConfig", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves shared Cognito identifiers from deployed runtime config", async () => {
    const config = {
      apiBaseUrl: "/api",
      eventPollUrl: "/api/openclaw/events",
      cognito: {
        region: "us-east-1",
        userPoolId: "us-east-1_shared",
        clientId: "shared-client",
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => config,
      }),
    );
    const { loadAppConfig, getAppConfig } = await import("./appConfig");

    expect(await loadAppConfig()).toEqual(config);
    expect(getAppConfig()).toEqual(config);
  });

  it("still supports local configuration without Cognito", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ apiBaseUrl: "/api" }),
      }),
    );
    const { loadAppConfig } = await import("./appConfig");

    expect(await loadAppConfig()).toEqual({ apiBaseUrl: "/api" });
  });
});
