import { describe, expect, it } from "vitest";

import type {
  AgentRuntimeEndpointSummary,
  AgentRuntimeSummary,
} from "./agentcoreRuntime";
import {
  selectAgentRuntime,
  selectAgentRuntimeEndpoint,
} from "./agentcoreRuntime";

function createRuntime(
  overrides: Partial<AgentRuntimeSummary> = {},
): AgentRuntimeSummary {
  return {
    agentRuntimeArn:
      "arn:aws:bedrock-agentcore:us-east-1:123456789012:agent/uuid:1",
    agentRuntimeId: "openclaw_agent_dev-abcdefghij",
    agentRuntimeName: "openclaw_agent_dev",
    agentRuntimeVersion: "1",
    description: "runtime",
    lastUpdatedAt: new Date("2026-06-01T00:00:00.000Z"),
    status: "READY",
    ...overrides,
  };
}

function createEndpoint(
  overrides: Partial<AgentRuntimeEndpointSummary> = {},
): AgentRuntimeEndpointSummary {
  return {
    name: "DEFAULT",
    agentRuntimeEndpointArn:
      "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/openclaw_agent_dev/runtime-endpoint/DEFAULT",
    agentRuntimeArn:
      "arn:aws:bedrock-agentcore:us-east-1:123456789012:agent/uuid:2",
    status: "READY",
    id: "endpoint-123",
    description: "endpoint",
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    lastUpdatedAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("selectAgentRuntime", () => {
  it("prefers the highest READY runtime version for a stable name", () => {
    const selectedRuntime = selectAgentRuntime(
      [
        createRuntime({
          agentRuntimeVersion: "2",
          agentRuntimeArn:
            "arn:aws:bedrock-agentcore:us-east-1:123456789012:agent/uuid:2",
        }),
        createRuntime({
          agentRuntimeVersion: "5",
          agentRuntimeArn:
            "arn:aws:bedrock-agentcore:us-east-1:123456789012:agent/uuid:5",
        }),
        createRuntime({
          agentRuntimeVersion: "6",
          status: "UPDATING",
          agentRuntimeArn:
            "arn:aws:bedrock-agentcore:us-east-1:123456789012:agent/uuid:6",
        }),
      ],
      "openclaw_agent_dev",
    );

    expect(selectedRuntime.agentRuntimeVersion).toBe("5");
  });

  it("throws when only non-ready runtimes exist", () => {
    expect(() =>
      selectAgentRuntime(
        [
          createRuntime({
            status: "UPDATING",
          }),
        ],
        "openclaw_agent_dev",
      ),
    ).toThrow("none are READY");
  });
});

describe("selectAgentRuntimeEndpoint", () => {
  it("prefers the newest READY endpoint with the requested name", () => {
    const selectedEndpoint = selectAgentRuntimeEndpoint(
      [
        createEndpoint({
          lastUpdatedAt: new Date("2026-06-01T00:00:00.000Z"),
        }),
        createEndpoint({
          lastUpdatedAt: new Date("2026-06-03T00:00:00.000Z"),
        }),
        createEndpoint({
          name: "BLUE",
        }),
      ],
      "DEFAULT",
    );

    expect(selectedEndpoint.lastUpdatedAt?.toISOString()).toBe(
      "2026-06-03T00:00:00.000Z",
    );
  });

  it("throws when the named endpoint is not ready", () => {
    expect(() =>
      selectAgentRuntimeEndpoint(
        [
          createEndpoint({
            status: "UPDATING",
          }),
        ],
        "DEFAULT",
      ),
    ).toThrow("none are READY");
  });
});
