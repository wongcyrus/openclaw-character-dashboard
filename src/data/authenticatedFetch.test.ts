import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  authenticatedFetch,
  downloadAuthenticatedFile,
} from "./authenticatedFetch";

describe("authenticatedFetch", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("sends the Cognito ID token as a bearer token", async () => {
    localStorage.setItem("idToken", "signed-id-token");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    await authenticatedFetch("/api/openclaw/snapshot", {
      headers: { Accept: "application/json" },
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("Authorization")).toBe("Bearer signed-id-token");
  });

  it("notifies the login shell when API Gateway rejects the token", async () => {
    const unauthorized = vi.fn();
    window.addEventListener("openclaw:unauthorized", unauthorized, {
      once: true,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 401 }),
    );

    await authenticatedFetch("/api/openclaw/events");

    expect(unauthorized).toHaveBeenCalledOnce();
  });

  it("downloads protected files through an authenticated blob request", async () => {
    const blob = new Blob(["content"], { type: "text/plain" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        blob: async () => blob,
      }),
    );
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:download");
    const revokeObjectURL = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    await downloadAuthenticatedFile("/api/file?path=readme.md", "readme.md");

    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:download");
  });
});
