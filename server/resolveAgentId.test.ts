import { describe, expect, it } from "vitest";

import {
  resolveAgentId,
  extractChannel,
  extractRunId,
  extractMessageContent,
  type GatewayBinding,
} from "./index";

describe("resolveAgentId", () => {
  const bindings: GatewayBinding[] = [
    {
      agentId: "main",
      channel: "telegram",
      accountId: "default",
    },
    {
      agentId: "robot_1",
      channel: "telegram",
      accountId: "robot_1",
    },
    {
      agentId: "communication-manager",
      channel: "telegram",
      accountId: "communication_manager",
    },
    {
      agentId: "domain-commentator",
      channel: "telegram",
      accountId: "bot_ubel",
    },
  ];

  it("returns explicitAgentId when provided", () => {
    expect(resolveAgentId("telegram:direct:123", "robot_1", bindings)).toBe("robot_1");
    expect(resolveAgentId(undefined, "robot_2", bindings)).toBe("robot_2");
  });

  it("maps explicit 'default' agentId to 'main'", () => {
    expect(resolveAgentId(undefined, "default", bindings)).toBe("main");
  });

  it("maps explicit agentId matching binding accountId", () => {
    expect(
      resolveAgentId(undefined, "communication_manager", bindings),
    ).toBe("communication-manager");
  });

  it("extracts agentId from agent: prefixed session keys", () => {
    expect(
      resolveAgentId("agent:robot_1:telegram:direct:123456", undefined, bindings),
    ).toBe("robot_1");
    expect(
      resolveAgentId("agent:communication_manager:telegram:direct:123", undefined, bindings),
    ).toBe("communication_manager");
    expect(
      resolveAgentId("agent:main:telegram:direct:123", undefined, bindings),
    ).toBe("main");
    expect(
      resolveAgentId("agent:default:telegram:direct:123", undefined, bindings),
    ).toBe("main");
  });

  it("resolves channel session keys with accountId via bindings", () => {
    expect(
      resolveAgentId("telegram:communication_manager:direct:123", undefined, bindings),
    ).toBe("communication-manager");
    expect(
      resolveAgentId("telegram:bot_ubel:direct:999", undefined, bindings),
    ).toBe("domain-commentator");
  });

  it("resolves channel session keys with accountId directly when not in bindings", () => {
    expect(
      resolveAgentId("telegram:robot_5:direct:123", undefined, bindings),
    ).toBe("robot_5");
  });

  it("maps channel direct/dm/group/channel/main keys without accountId to default binding or main", () => {
    expect(
      resolveAgentId("telegram:direct:123456", undefined, bindings),
    ).toBe("main");
    expect(
      resolveAgentId("telegram:dm:123456", undefined, bindings),
    ).toBe("main");
    expect(
      resolveAgentId("telegram:group:123456", undefined, bindings),
    ).toBe("main");
    expect(
      resolveAgentId("telegram:main:direct:123456", undefined, bindings),
    ).toBe("main");
  });

  it("resolves single token session keys", () => {
    expect(resolveAgentId("robot_1", undefined, bindings)).toBe("robot_1");
    expect(resolveAgentId("default", undefined, bindings)).toBe("main");
    expect(
      resolveAgentId("communication_manager", undefined, bindings),
    ).toBe("communication-manager");
  });

  it("returns empty string for empty or undefined keys without explicit agentId", () => {
    expect(resolveAgentId(undefined, undefined, bindings)).toBe("");
    expect(resolveAgentId("", undefined, bindings)).toBe("");
    expect(resolveAgentId("   ", undefined, bindings)).toBe("");
  });
});

describe("extractRunId", () => {
  it("extracts runId from top-level payload", () => {
    expect(extractRunId({ runId: "run-abc-123" })).toBe("run-abc-123");
    expect(extractRunId({ clientRunId: "run-xyz-789" })).toBe("run-xyz-789");
  });

  it("extracts runId from nested __openclaw metadata", () => {
    expect(
      extractRunId({
        message: {
          __openclaw: { runId: "run-nested-456" },
        },
      }),
    ).toBe("run-nested-456");
  });

  it("extracts runId from idempotencyKey in message", () => {
    expect(
      extractRunId({
        message: {
          idempotencyKey: "8820e5ce-d1da-43f6-82d4-9a7f808140cb:user",
        },
      }),
    ).toBe("8820e5ce-d1da-43f6-82d4-9a7f808140cb");
  });

  it("returns empty string if no valid runId is found", () => {
    expect(extractRunId({})).toBe("");
    expect(extractRunId({ message: {} })).toBe("");
  });
});

describe("extractMessageContent", () => {
  it("extracts string message content", () => {
    expect(
      extractMessageContent({
        message: { content: "Hello world" },
      }),
    ).toBe("Hello world");
  });

  it("extracts text from array message content and skips thinking blocks", () => {
    expect(
      extractMessageContent({
        message: {
          content: [
            { type: "thinking", thinking: "Internal reasoning..." },
            { type: "text", text: "Visible answer" },
          ],
        },
      }),
    ).toBe("Visible answer");
  });

  it("extracts deltaText or fallback text", () => {
    expect(extractMessageContent({ deltaText: "Streaming delta" })).toBe(
      "Streaming delta",
    );
    expect(extractMessageContent({ text: "Fallback text" })).toBe(
      "Fallback text",
    );
  });
});

describe("extractChannel", () => {
  const bindings: GatewayBinding[] = [
    {
      agentId: "main",
      channel: "telegram",
      accountId: "default",
    },
    {
      agentId: "communication-manager",
      channel: "telegram",
      accountId: "communication_manager",
    },
  ];

  it("extracts channel from explicit payload fields", () => {
    expect(extractChannel("main", { channel: "telegram" }, bindings)).toBe(
      "telegram",
    );
    expect(
      extractChannel("main", { message: { channel: "discord" } }, bindings),
    ).toBe("discord");
    expect(extractChannel("main", { source: "web" }, bindings)).toBe("webui");
    expect(extractChannel("main", { source: "webui" }, bindings)).toBe("webui");
    expect(extractChannel("main", { data: { channel: "slack" } }, bindings)).toBe(
      "slack",
    );
    expect(extractChannel("main", { channel: "tg" }, bindings)).toBe(
      "telegram",
    );
  });

  it("extracts channel from sessionKey prefix or tokens", () => {
    expect(
      extractChannel(
        "agent:robot_1:telegram:direct:123456",
        undefined,
        bindings,
      ),
    ).toBe("telegram");
    expect(
      extractChannel("telegram:direct:123456", undefined, bindings),
    ).toBe("telegram");
    expect(
      extractChannel("discord:channel:987654", undefined, bindings),
    ).toBe("discord");
    expect(
      extractChannel("agent:main:cron:job-uuid-123", undefined, bindings),
    ).toBe("cron");
    expect(
      extractChannel("agent:main:subagent:task-456", undefined, bindings),
    ).toBe("subagent");
    expect(
      extractChannel("agent:frieren:main", undefined, bindings),
    ).toBe("webui");
    expect(extractChannel("main", undefined, bindings)).toBe("webui");
    expect(extractChannel("global", undefined, bindings)).toBe("webui");
  });

  it("extracts channel via bindings when sessionKey contains accountId", () => {
    expect(
      extractChannel(
        "communication_manager",
        undefined,
        bindings,
      ),
    ).toBe("telegram");
  });

  it("defaults to webui for unknown or empty sessionKey", () => {
    expect(extractChannel(undefined, undefined, bindings)).toBe("webui");
    expect(extractChannel("", undefined, bindings)).toBe("webui");
    expect(extractChannel("unknown-session", undefined, bindings)).toBe("webui");
  });
});

