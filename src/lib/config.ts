import { z } from "zod";

const configSchema = z.object({
  icloudAlbumToken: z.string().min(1),
  icloudDownloadMaxRetries: z.coerce.number().default(3),
  amazonCookiesPath: z.string().default("./data/amazon-cookies.json"),
  amazonAlbumName: z.string().default("Echo Show"),
  syncDeletions: z.coerce.boolean().default(true),
  pollIntervalMs: z.coerce
    .number()
    .default(60)
    .transform((s) => s * 1000),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = z.infer<typeof configSchema>;

function loadConfig(): Config {
  return configSchema.parse({
    icloudAlbumToken: process.env.ICLOUD_ALBUM_TOKEN,
    icloudDownloadMaxRetries: process.env.ICLOUD_DOWNLOAD_MAX_RETRIES,
    amazonCookiesPath: process.env.AMAZON_COOKIES_PATH,
    amazonAlbumName: process.env.AMAZON_ALBUM_NAME,
    syncDeletions: process.env.SYNC_DELETIONS,
    pollIntervalMs: process.env.POLL_INTERVAL_SECONDS,
    logLevel: process.env.LOG_LEVEL,
  });
}

export const config = loadConfig();
