import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useWorldStore } from "@/store/worldStore";

import { ResourceWallOverlay } from "./ResourceWallOverlay";

vi.mock("./FilePreview", () => ({
  FilePreview: ({ filePath }: { filePath: string }) => (
    <div>preview:{filePath}</div>
  ),
}));

describe("ResourceWallOverlay", () => {
  beforeEach(() => {
    useWorldStore.setState({ inspectorSelection: { type: "resource-wall" } });
    vi.unstubAllGlobals();
  });

  it("loads, navigates, previews, resizes, and closes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          path: "",
          entries: [
            { name: "docs", type: "dir" },
            { name: "readme.md", type: "file" },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          path: "docs",
          entries: [{ name: "guide.txt", type: "file" }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ path: "", entries: [] }),
      });
    vi.stubGlobal("fetch", fetchMock);

    render(<ResourceWallOverlay />);
    await screen.findByRole("button", { name: /docs/ });

    const readmeButton = screen.getByText("readme.md").closest("button");
    if (!readmeButton) throw new Error("readme button missing");
    fireEvent.click(readmeButton);
    expect(screen.getByText("preview:readme.md")).toBeVisible();
    expect(screen.getByLabelText("Download readme.md")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /docs/ }));
    await screen.findByText("guide.txt");
    expect(screen.getByRole("button", { name: "docs" })).toBeVisible();

    fireEvent.click(screen.getByLabelText("Increase font size"));
    expect(screen.getByLabelText(/Font size: 14px/)).toBeVisible();
    fireEvent.click(screen.getByLabelText("Decrease font size"));
    fireEvent.click(screen.getByLabelText(/Font size: 13px/));

    const handle = document.querySelector(
      ".resource-wall-overlay__resize-handle",
    );
    if (!handle) throw new Error("resize handle missing");
    Object.defineProperty(handle, "setPointerCapture", {
      value: vi.fn(),
    });
    fireEvent(
      handle,
      Object.assign(new Event("pointerdown", { bubbles: true }), {
        clientX: 100,
        clientY: 100,
        pointerId: 1,
      }),
    );
    fireEvent(
      window,
      Object.assign(new Event("pointermove"), {
        clientX: -1000,
        clientY: -1000,
      }),
    );
    fireEvent.pointerUp(window);
    const panel = document.querySelector(
      ".resource-wall-overlay__panel",
    ) as HTMLElement;
    await waitFor(() => expect(panel.style.width).toBe("480px"));
    expect(panel.style.height).toBe("320px");

    fireEvent.click(screen.getByRole("button", { name: "shared" }));
    await screen.findByText("Empty directory");

    fireEvent.click(screen.getByLabelText("Close"));
    expect(useWorldStore.getState().inspectorSelection).toBeNull();
  });

  it("displays API errors and closes from the backdrop", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ error: "cannot list files" }),
      }),
    );
    render(<ResourceWallOverlay />);
    await screen.findByText("cannot list files");

    const backdrop = document.querySelector(".resource-wall-overlay__backdrop");
    if (!backdrop) throw new Error("backdrop missing");
    fireEvent.click(backdrop);
    expect(useWorldStore.getState().inspectorSelection).toBeNull();
  });

  it("renders nothing while closed", async () => {
    useWorldStore.setState({ inspectorSelection: null });
    vi.stubGlobal("fetch", vi.fn());
    const { container } = render(<ResourceWallOverlay />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(fetch).not.toHaveBeenCalled();
  });
});
