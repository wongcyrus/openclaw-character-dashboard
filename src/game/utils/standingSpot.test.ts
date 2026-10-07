import { describe, expect, it } from "vitest";

import { hasStandingColumnConflict } from "./standingSpot";

describe("hasStandingColumnConflict", () => {
  const occupants = [
    { characterId: "alice", gx: 4, gy: 5 },
    { characterId: "bob", gx: 8, gy: 8 },
  ];

  it("detects nearby characters in the same column", () => {
    expect(
      hasStandingColumnConflict({ gx: 4, gy: 6 }, occupants, "charlie"),
    ).toBe(true);
  });

  it("ignores the same character and sufficiently distant positions", () => {
    expect(
      hasStandingColumnConflict({ gx: 4, gy: 5 }, occupants, "alice"),
    ).toBe(false);
    expect(
      hasStandingColumnConflict({ gx: 4, gy: 7 }, occupants, "charlie"),
    ).toBe(false);
    expect(
      hasStandingColumnConflict({ gx: 5, gy: 5 }, occupants, "charlie"),
    ).toBe(false);
  });
});
