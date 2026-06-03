import { z } from "zod";

const AppConfigSchema = z.object({
  apiBaseUrl: z.string().optional(),
  webSocketUrl: z.string().optional(),
  availableAssetPacks: z.array(z.string()).optional(),
  defaultAssetPack: z.string().optional(),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

let cachedConfig: AppConfig | null = null;

export async function loadAppConfig(): Promise<AppConfig> {
  if (cachedConfig) return cachedConfig;

  try {
    const response = await fetch(`/config.json?t=${Date.now()}`);
    if (!response.ok) {
      // Fallback for local development if config.json is missing
      return {
        apiBaseUrl: "/api",
        webSocketUrl: `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/api/ws`,
      };
    }
    const raw = await response.json();
    cachedConfig = AppConfigSchema.parse(raw);
    return cachedConfig;
  } catch (err) {
    console.warn("Failed to load config.json, using defaults:", err);
    return {
      apiBaseUrl: "/api",
      webSocketUrl: `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/api/ws`,
    };
  }
}

export function getAppConfig(): AppConfig {
  if (!cachedConfig) {
    throw new Error("App config not loaded yet. Call loadAppConfig() first.");
  }
  return cachedConfig;
}
