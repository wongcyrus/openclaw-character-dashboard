import { execFileSync } from "node:child_process";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadCognitoConfig } from "./cognitoConfig";

vi.mock("node:child_process", () => {
  const execFileSync = vi.fn();
  return { execFileSync, default: { execFileSync } };
});

const outputs = [
  { OutputKey: "CognitoRegion", OutputValue: "us-east-1" },
  { OutputKey: "CognitoUserPoolId", OutputValue: "us-east-1_shared" },
  { OutputKey: "CognitoUserPoolClientId", OutputValue: "shared-client" },
];

describe("loadCognitoConfig", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("reads the existing robotics stack in the selected region", () => {
    vi.mocked(execFileSync).mockReturnValue(JSON.stringify(outputs));

    expect(loadCognitoConfig("us-west-2")).toEqual({
      region: "us-east-1",
      userPoolId: "us-east-1_shared",
      clientId: "shared-client",
    });
    expect(execFileSync).toHaveBeenCalledWith(
      "aws",
      expect.arrayContaining([
        "--stack-name",
        "aws-agentic-robotics",
        "--region",
        "us-west-2",
      ]),
      expect.objectContaining({ encoding: "utf8" }),
    );
  });

  it.each(["CognitoRegion", "CognitoUserPoolId", "CognitoUserPoolClientId"])(
    "rejects a missing %s output",
    (key) => {
      vi.mocked(execFileSync).mockReturnValue(
        JSON.stringify(outputs.filter(({ OutputKey }) => OutputKey !== key)),
      );

      expect(() => loadCognitoConfig("us-east-1")).toThrow(
        "Stack aws-agentic-robotics must expose non-empty",
      );
    },
  );

  it("rejects an empty output", () => {
    vi.mocked(execFileSync).mockReturnValue(
      JSON.stringify(outputs.map((output) => ({ ...output, OutputValue: "" }))),
    );

    expect(() => loadCognitoConfig("us-east-1")).toThrow("non-empty");
  });

  it("propagates AWS lookup failures instead of using local IDs", () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("AccessDenied");
    });

    expect(() => loadCognitoConfig("us-east-1")).toThrow("AccessDenied");
  });
});
