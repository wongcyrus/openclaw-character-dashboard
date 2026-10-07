import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useCharacterStore } from "@/store/characterStore";
import { useWorldStore } from "@/store/worldStore";
import type { WorldConfig } from "@/types/world";

import { InspectorPanel } from "./InspectorPanel";
import { MockModeToggle } from "./MockModeToggle";

const world: WorldConfig = {
  canvasWidth: 800,
  canvasHeight: 600,
  rooms: [
    {
      id: "office",
      label: "Office",
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      objects: [],
    },
    {
      id: "private-alice",
      label: "Alice Room",
      x: 400,
      y: 0,
      width: 400,
      height: 300,
      objects: [],
    },
  ],
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
      id: "bob",
      agentId: "secondary",
      name: "Bob",
      privateRoomId: "office",
      spriteSheet: {
        inside: "inside.png",
        outside: "outside.png",
        frameWidth: 64,
        frameHeight: 64,
      },
    },
  ],
};

describe("dashboard controls", () => {
  beforeEach(() => {
    useWorldStore.setState({
      worldConfig: world,
      isMockMode: false,
      liveDataStatus: "ok",
      inspectorSelection: null,
    });
    useCharacterStore.setState({
      characterStates: {
        alice: {
          characterId: "alice",
          mainState: "working",
          subState: "working",
          currentRoomId: "office",
        },
        bob: {
          characterId: "bob",
          mainState: "idle",
          subState: "standing",
          currentRoomId: "office",
        },
      },
      characterMessages: {},
      occupiedPoints: {},
      pendingForce: null,
    });
  });

  it("switches data modes and applies a forced mock state", async () => {
    render(<MockModeToggle />);
    expect(screen.getByLabelText("Live data status: connected")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Mock" }));
    expect(screen.getByText("Mock state control")).toBeVisible();
    await waitFor(() =>
      expect(screen.getByLabelText("Character")).toHaveValue("alice"),
    );

    fireEvent.change(screen.getByLabelText("Character"), {
      target: { value: "bob" },
    });
    fireEvent.change(screen.getByLabelText("State"), {
      target: { value: "working" },
    });
    expect(screen.getByLabelText("Sub-state")).toHaveValue("walking-to-work");
    fireEvent.change(screen.getByLabelText("Sub-state"), {
      target: { value: "working" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(useCharacterStore.getState().pendingForce).toEqual({
      characterId: "bob",
      mainState: "working",
      subState: "working",
    });

    fireEvent.click(screen.getByRole("button", { name: "Live" }));
    expect(useWorldStore.getState().isMockMode).toBe(false);
  });

  it("disables mock state application when no characters exist", () => {
    useWorldStore.setState({
      worldConfig: { ...world, characters: [] },
      isMockMode: true,
    });
    render(<MockModeToggle />);

    expect(screen.getByLabelText("Character")).toBeDisabled();
    expect(screen.getByText("No characters available")).toBeVisible();
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  });

  it("renders empty, character, room, and resource-wall inspector states", () => {
    const { rerender } = render(<InspectorPanel />);
    expect(screen.getByText(/Click a character/)).toBeVisible();

    useWorldStore.setState({
      inspectorSelection: { type: "character", characterId: "alice" },
    });
    rerender(<InspectorPanel />);
    expect(screen.getByRole("heading", { name: "Alice" })).toBeVisible();
    expect(screen.getByText("Alice Room")).toBeVisible();
    expect(screen.getAllByText("working")).toHaveLength(2);

    useWorldStore.setState({
      inspectorSelection: { type: "room", roomId: "office" },
    });
    rerender(<InspectorPanel />);
    expect(screen.getByRole("heading", { name: "Office" })).toBeVisible();
    expect(screen.getByText("alice, bob")).toBeVisible();
    expect(screen.getByText("400 × 300 px")).toBeVisible();

    useWorldStore.setState({
      inspectorSelection: { type: "resource-wall" },
    });
    rerender(<InspectorPanel />);
    expect(
      screen.getByRole("heading", { name: "Resource Wall" }),
    ).toBeVisible();
  });

  it("uses fallback inspector values for missing configuration", () => {
    useWorldStore.setState({
      worldConfig: null,
      inspectorSelection: { type: "character", characterId: "unknown" },
    });
    useCharacterStore.setState({ characterStates: {} });
    const { rerender } = render(<InspectorPanel />);
    expect(screen.getByRole("heading", { name: "unknown" })).toBeVisible();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);

    useWorldStore.setState({
      inspectorSelection: { type: "room", roomId: "missing" },
    });
    rerender(<InspectorPanel />);
    expect(screen.getByRole("heading", { name: "missing" })).toBeVisible();
    expect(screen.getByText("Empty")).toBeVisible();
  });
});
