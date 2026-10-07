import { execFileSync } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadCognitoConfig } from "./cognitoConfig";

vi.mock("node:child_process", () => {
  const execFileSync = vi.fn();
  return { execFileSync, default: { execFileSync } };
});
vi.mock("dotenv", () => ({ config: vi.fn() }));
vi.mock("./cognitoConfig", () => ({ loadCognitoConfig: vi.fn() }));

describe("deployment", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.stubEnv("CDK_DEFAULT_REGION", "us-west-2");
    vi.stubEnv("VITE_COGNITO_USER_POOL_ID", "deleted-pool");
    vi.stubEnv("VITE_COGNITO_CLIENT_ID", "deleted-client");
    vi.mocked(loadCognitoConfig).mockReturnValue({
      region: "us-east-1",
      userPoolId: "us-east-1_shared",
      clientId: "shared-client",
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("overrides stale environment IDs for both build and CDK", async () => {
    await import("./deploy");

    expect(loadCognitoConfig).toHaveBeenCalledWith("us-west-2");
    const options = expect.objectContaining({
      env: expect.objectContaining({
        VITE_COGNITO_REGION: "us-east-1",
        VITE_COGNITO_USER_POOL_ID: "us-east-1_shared",
        VITE_COGNITO_CLIENT_ID: "shared-client",
      }),
    });
    expect(execFileSync).toHaveBeenNthCalledWith(
      1,
      "npm",
      ["run", "build"],
      options,
    );
    expect(execFileSync).toHaveBeenNthCalledWith(
      2,
      "npm",
      ["run", "cdk", "--", "deploy", ...process.argv.slice(2)],
      options,
    );
  });

  it("does not build or deploy when the shared stack cannot be resolved", async () => {
    vi.mocked(loadCognitoConfig).mockImplementation(() => {
      throw new Error("Missing shared stack");
    });

    await expect(import("./deploy")).rejects.toThrow("Missing shared stack");
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("does not deploy when the build fails", async () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("Build failed");
    });

    await expect(import("./deploy")).rejects.toThrow("Build failed");
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });
});
