import { beforeEach, describe, expect, it } from "vitest";

import { useCharacterStore } from "./characterStore";
import { useWorldStore } from "./worldStore";

describe("characterStore", () => {
  beforeEach(() => {
    useCharacterStore.setState({
      characterStates: {},
      characterMessages: {},
      characterHistory: {},
      occupiedPoints: {},
      pendingForce: null,
    });
  });

  it("updates character state and message lifecycle and records history", () => {
    const store = useCharacterStore.getState();
    store.setCharacterState({
      characterId: "alice",
      mainState: "working",
      subState: "working",
      currentRoomId: "office",
    });

    // 1. User message arrives
    store.setCharacterMessage("alice", {
      text: "What is the mission?",
      role: "user",
      timestamp: 100,
      runId: "run-1",
    });

    expect(useCharacterStore.getState().characterMessages.alice.text).toBe(
      "What is the mission?",
    );
    expect(useCharacterStore.getState().characterHistory.alice).toHaveLength(1);
    expect(useCharacterStore.getState().characterHistory.alice[0].role).toBe(
      "user",
    );

    // 2. Agent streaming chunk 1
    store.setCharacterMessage("alice", {
      text: "Defeat",
      role: "assistant",
      timestamp: 101,
      runId: "run-1",
      complete: false,
    });
    expect(useCharacterStore.getState().characterHistory.alice).toHaveLength(2);

    // 3. Agent streaming chunk 2 (same runId + role -> updates in place)
    store.setCharacterMessage("alice", {
      text: "Defeat the demon king.",
      role: "assistant",
      timestamp: 102,
      runId: "run-1",
      complete: true,
    });
    expect(useCharacterStore.getState().characterHistory.alice).toHaveLength(2);
    expect(useCharacterStore.getState().characterHistory.alice[1].text).toBe(
      "Defeat the demon king.",
    );

    // 4. Speech bubble closes, history persists
    store.setCharacterMessage("alice", null);
    expect(
      useCharacterStore.getState().characterMessages.alice,
    ).toBeUndefined();
    expect(useCharacterStore.getState().characterHistory.alice).toHaveLength(2);

    // 5. Clear history
    store.clearCharacterHistory("alice");
    expect(useCharacterStore.getState().characterHistory.alice).toBeUndefined();
  });

  it("claims, looks up, and releases interaction points safely", () => {
    const store = useCharacterStore.getState();

    expect(store.claimPoint("desk:0", "alice")).toBe(true);
    expect(store.claimPoint("desk:0", "bob")).toBe(false);
    expect(store.getOccupiedPointKey("alice")).toBe("desk:0");
    expect(store.getOccupiedPointKey("bob")).toBeNull();

    store.releasePoint("desk:0", "bob");
    expect(useCharacterStore.getState().occupiedPoints["desk:0"]).toBe("alice");

    store.releasePoint("desk:0", "alice");
    expect(
      useCharacterStore.getState().occupiedPoints["desk:0"],
    ).toBeUndefined();
  });

  it("records and clears forced state transitions", () => {
    const store = useCharacterStore.getState();
    store.forceCharacterState("alice", "idle", "sleeping");
    expect(useCharacterStore.getState().pendingForce).toEqual({
      characterId: "alice",
      mainState: "idle",
      subState: "sleeping",
    });

    store.clearPendingForce();
    expect(useCharacterStore.getState().pendingForce).toBeNull();
  });
});

describe("worldStore", () => {
  beforeEach(() => {
    useWorldStore.setState({
      worldConfig: null,
      isMockMode: false,
      liveDataStatus: "ok",
      inspectorSelection: null,
    });
  });

  it("updates world, mode, status, and selection", () => {
    const store = useWorldStore.getState();
    const world = {
      canvasWidth: 100,
      canvasHeight: 100,
      rooms: [],
      characters: [],
    };

    store.setWorldConfig(world);
    store.setLiveDataStatus("error");
    store.setInspectorSelection({ type: "room", roomId: "office" });
    store.setMockMode(true);

    expect(useWorldStore.getState()).toMatchObject({
      worldConfig: world,
      isMockMode: true,
      liveDataStatus: "connecting",
      inspectorSelection: { type: "room", roomId: "office" },
    });
  });
});
