import { z } from "zod";

const configSchema = z.object({
  icloudAlbumToken: z.string().min(1),
  icloudDownloadMaxRetries: z.coerce.number().default(3),
  amazonCookiesPath: z.string().default("./data/amazon-cookies.json"),
  amazonAlbumName: z.string().default("Echo Show"),
  amazonAutoRefreshCookies: z.coerce.boolean().default(true),
  syncDeletions: z.coerce.boolean().default(true),
  pollIntervalMs: z.coerce
    .number()
    .default(60)
    .transform((s) => s * 1000),
  uploadDelayMs: z.coerce.number().default(0),
  healthPort: z.coerce.number().default(3000),
  alertWebhookUrl: z.string().optional(),
  pushoverToken: z.string().optional(),
  pushoverUser: z.string().optional(),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = z.infer<typeof configSchema>;

function loadConfig(): Config {
  return configSchema.parse({
    icloudAlbumToken: process.env.ICLOUD_ALBUM_TOKEN,
    icloudDownloadMaxRetries: process.env.ICLOUD_DOWNLOAD_MAX_RETRIES,
    amazonCookiesPath: process.env.AMAZON_COOKIES_PATH,
    amazonAlbumName: process.env.AMAZON_ALBUM_NAME,
    amazonAutoRefreshCookies: process.env.AMAZON_AUTO_REFRESH_COOKIES,
    syncDeletions: process.env.SYNC_DELETIONS,
    pollIntervalMs: process.env.POLL_INTERVAL_SECONDS,
    uploadDelayMs: process.env.UPLOAD_DELAY_MS,
    healthPort: process.env.HEALTH_PORT,
    alertWebhookUrl: process.env.ALERT_WEBHOOK_URL,
    pushoverToken: process.env.PUSHOVER_TOKEN,
    pushoverUser: process.env.PUSHOVER_USER,
    logLevel: process.env.LOG_LEVEL,
  });
}

export const config = loadConfig();
