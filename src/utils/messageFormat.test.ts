import { describe, expect, it } from "vitest";

import { formatSenderHeader } from "./messageFormat";

describe("formatSenderHeader", () => {
  it("formats assistant messages with sparkles, character name, and target channel when present", () => {
    expect(formatSenderHeader("assistant", "Frieren")).toBe("✨ Frieren");
    expect(formatSenderHeader("assistant", "Himmel", "telegram")).toBe(
      "✨ Himmel (Telegram)",
    );
    expect(formatSenderHeader("assistant", "Frieren", "webui")).toBe(
      "✨ Frieren (WebUI)",
    );
    expect(formatSenderHeader("assistant", "Frieren", "main")).toBe(
      "✨ Frieren (WebUI)",
    );
    expect(formatSenderHeader("assistant", "Land", "discord")).toBe(
      "✨ Land (Discord)",
    );
    expect(formatSenderHeader("assistant", "Übel", "cron")).toBe(
      "✨ Übel (Cron)",
    );
    expect(formatSenderHeader("assistant", "Frieren", "subagent")).toBe(
      "✨ Frieren (Subagent)",
    );
  });

  it("formats user messages with channel-specific icons and labels", () => {
    expect(formatSenderHeader("user", "Frieren", "telegram")).toBe(
      "📨 User (Telegram)",
    );
    expect(formatSenderHeader("user", "Frieren", "tg")).toBe(
      "📨 User (Telegram)",
    );
    expect(formatSenderHeader("user", "Frieren", "web")).toBe(
      "💻 User (WebUI)",
    );
    expect(formatSenderHeader("user", "Frieren", "webui")).toBe(
      "💻 User (WebUI)",
    );
    expect(formatSenderHeader("user", "Frieren", "main")).toBe(
      "💻 User (WebUI)",
    );
    expect(formatSenderHeader("user", "Frieren", "discord")).toBe(
      "💬 User (Discord)",
    );
    expect(formatSenderHeader("user", "Frieren", "slack")).toBe(
      "💬 User (Slack)",
    );
    expect(formatSenderHeader("user", "Frieren", "whatsapp")).toBe(
      "📱 User (WhatsApp)",
    );
    expect(formatSenderHeader("user", "Frieren", "cron")).toBe(
      "⏰ Cron Task",
    );
    expect(formatSenderHeader("user", "Frieren", "subagent")).toBe(
      "🤖 Subagent",
    );
    expect(formatSenderHeader("user", "Frieren", "custom")).toBe(
      "📨 User (Custom)",
    );
    expect(formatSenderHeader("user", "Frieren")).toBe("📨 User");
  });
});
