// @vitest-environment node
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { beforeEach, describe, expect, it, vi } from "vitest";

type AuthScript = {
  loadCognitoConfig: () => Promise<void>;
  checkExistingAuth: () => boolean;
};

const config = {
  region: "us-east-1",
  userPoolId: "us-east-1_shared",
  clientId: "shared-client",
};
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
if (!script) throw new Error("Login module script not found in index.html");

describe("login configuration", () => {
  const storage = new Map<string, string>();
  const fetch = vi.fn();
  const addEventListener = vi.fn();
  let auth: AuthScript;

  beforeEach(() => {
    storage.clear();
    fetch.mockReset();
    addEventListener.mockReset();
    fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ cognito: config }),
    });
    auth = runInNewContext(
      `${script}; ({ loadCognitoConfig, checkExistingAuth });`,
      {
        fetch,
        console,
        atob,
        window: { addEventListener },
        localStorage: {
          getItem: (key: string) => storage.get(key),
          clear: () => storage.clear(),
        },
      },
    );
  });

  function setToken(issuer: string, clientId: string): void {
    storage.set(
      "accessToken",
      `header.${btoa(
        JSON.stringify({
          exp: Math.floor(Date.now() / 1000) + 3600,
          iss: issuer,
          client_id: clientId,
        }),
      )}.signature`,
    );
  }

  it("uses the shared pool and client from nested runtime configuration", async () => {
    await auth.loadCognitoConfig();
    setToken(
      `https://cognito-idp.${config.region}.amazonaws.com/${config.userPoolId}`,
      config.clientId,
    );

    expect(auth.checkExistingAuth()).toBe(true);
  });

  it("retains support for older flat configuration", async () => {
    fetch.mockResolvedValue({ ok: true, json: async () => config });
    await auth.loadCognitoConfig();
    setToken(
      `https://cognito-idp.${config.region}.amazonaws.com/${config.userPoolId}`,
      config.clientId,
    );

    expect(auth.checkExistingAuth()).toBe(true);
  });

  it.each([
    [
      "https://cognito-idp.us-east-1.amazonaws.com/deleted-pool",
      config.clientId,
    ],
    [
      `https://cognito-idp.${config.region}.amazonaws.com/${config.userPoolId}`,
      "old-client",
    ],
  ])(
    "clears sessions for a different pool or client",
    async (issuer, clientId) => {
      await auth.loadCognitoConfig();
      setToken(issuer, clientId);

      expect(auth.checkExistingAuth()).toBe(false);
      expect(storage.has("accessToken")).toBe(false);
    },
  );

  it("keeps login controls inside the card", () => {
    expect(html).toMatch(
      /\.login-wrapper,\s*\.login-wrapper \* \{\s*box-sizing: border-box;/,
    );
    expect(html).toContain("max-width: 100%;");
    expect(html).toContain("min-width: 0;");
  });

  it("logs out when an authenticated API request is rejected", () => {
    expect(addEventListener).toHaveBeenCalledWith(
      "openclaw:unauthorized",
      expect.any(Function),
    );
  });
});
