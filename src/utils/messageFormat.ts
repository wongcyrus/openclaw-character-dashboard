/**
 * Formats user and assistant message sender headers with appropriate
 * icons and channel indicators (e.g. Telegram, WebUI, Discord).
 */
export function formatChannelLabel(channel?: string): string | null {
  const ch = channel?.toLowerCase().trim();
  if (!ch) return null;
  if (ch === "telegram" || ch === "tg") return "Telegram";
  if (
    ch === "web" ||
    ch === "webui" ||
    ch === "main" ||
    ch === "dashboard" ||
    ch === "ui"
  ) {
    return "WebUI";
  }
  if (ch === "discord") return "Discord";
  if (ch === "slack") return "Slack";
  if (ch === "whatsapp") return "WhatsApp";
  if (ch === "signal") return "Signal";
  if (ch === "cron") return "Cron";
  if (ch === "subagent") return "Subagent";
  return ch.charAt(0).toUpperCase() + ch.slice(1);
}

export function formatSenderHeader(
  role: string,
  characterName: string,
  channel?: string,
): string {
  const chLabel = formatChannelLabel(channel);
  if (role === "user") {
    if (chLabel === "WebUI") return "💻 User (WebUI)";
    if (chLabel === "Telegram") return "📨 User (Telegram)";
    if (chLabel === "Discord" || chLabel === "Slack") {
      return `💬 User (${chLabel})`;
    }
    if (chLabel === "WhatsApp") return "📱 User (WhatsApp)";
    if (chLabel === "Signal") return "🔒 User (Signal)";
    if (chLabel === "Cron") return "⏰ Cron Task";
    if (chLabel === "Subagent") return "🤖 Subagent";
    if (chLabel) return `📨 User (${chLabel})`;
    return "📨 User";
  }

  // Assistant / Agent reply
  if (chLabel) {
    return `✨ ${characterName} (${chLabel})`;
  }
  return `✨ ${characterName}`;
}

