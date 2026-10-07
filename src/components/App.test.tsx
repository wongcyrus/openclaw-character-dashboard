import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useWorldStore } from "@/store/worldStore";
import type { WorldConfig } from "@/types/world";

import { App } from "./App";

const mocks = vi.hoisted(() => ({
  loadAppConfig: vi.fn(),
  loadWorldConfig: vi.fn(),
}));

vi.mock("@/data/appConfig", () => ({
  loadAppConfig: mocks.loadAppConfig,
}));
vi.mock("@/data/worldConfig", () => ({
  loadWorldConfig: mocks.loadWorldConfig,
}));
vi.mock("@/game/PhaserGame", () => ({
  PhaserGame: () => <div>game canvas</div>,
}));
vi.mock("./InspectorPanel", () => ({
  InspectorPanel: () => <div>inspector</div>,
}));
vi.mock("./MockModeToggle", () => ({
  MockModeToggle: () => <div>mode toggle</div>,
}));
vi.mock("./ResourceWallOverlay", () => ({
  ResourceWallOverlay: () => <div>resource overlay</div>,
}));

const world: WorldConfig = {
  canvasWidth: 100,
  canvasHeight: 100,
  rooms: [],
  characters: [],
};

describe("App", () => {
  beforeEach(() => {
    useWorldStore.setState({ worldConfig: null });
    mocks.loadAppConfig.mockReset();
    mocks.loadWorldConfig.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("loads runtime and world configuration before rendering the dashboard", async () => {
    mocks.loadAppConfig.mockResolvedValue({
      apiBaseUrl: "/api",
      availableAssetPacks: ["frieren"],
      defaultAssetPack: "frieren",
    });
    mocks.loadWorldConfig.mockResolvedValue(world);
    const resizeHandler = vi.fn();
    window.addEventListener("resize", resizeHandler);

    render(<App />);
    expect(screen.getByText("Loading world...")).toBeVisible();
    await screen.findByText("game canvas");

    expect(mocks.loadWorldConfig).toHaveBeenCalledWith("frieren");
    fireEvent.click(screen.getByTitle("Split View"));
    expect(document.querySelector(".view-mode-split")).not.toBeNull();
    fireEvent.click(screen.getByTitle("Panel Only"));
    expect(document.querySelector(".view-mode-panel-only")).not.toBeNull();
    fireEvent.click(screen.getByTitle("Game Only"));
    expect(document.querySelector(".view-mode-game-only")).not.toBeNull();
    expect(resizeHandler).toHaveBeenCalled();

    window.removeEventListener("resize", resizeHandler);
  });

  it("uses the first asset pack and surfaces initialization failures", async () => {
    mocks.loadAppConfig.mockResolvedValueOnce({
      apiBaseUrl: "/api",
      availableAssetPacks: ["fallback"],
    });
    mocks.loadWorldConfig.mockRejectedValueOnce("broken");

    render(<App />);
    await waitFor(() =>
      expect(screen.getByText(/Fatal error loading world.json/)).toBeVisible(),
    );
    expect(screen.getByText(/broken/)).toBeVisible();
    expect(mocks.loadWorldConfig).toHaveBeenCalledWith("fallback");
  });

  it("renders immediately when world configuration already exists", () => {
    useWorldStore.setState({ worldConfig: world });
    render(<App />);
    expect(screen.getByText("game canvas")).toBeVisible();
    expect(mocks.loadAppConfig).not.toHaveBeenCalled();
  });
});
