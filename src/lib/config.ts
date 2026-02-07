import { z } from "zod";

const configSchema = z.object({
  icloudAlbumToken: z.string().min(1),
  amazonEmail: z.string().email(),
  amazonPassword: z.string().min(1),
  amazonAlbumName: z.string().default("Echo Show"),
  pollIntervalMs: z.coerce.number().default(60).transform((s) => s * 1000),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = z.infer<typeof configSchema>;

function loadConfig(): Config {
  return configSchema.parse({
    icloudAlbumToken: process.env.ICLOUD_ALBUM_TOKEN,
    amazonEmail: process.env.AMAZON_EMAIL,
    amazonPassword: process.env.AMAZON_PASSWORD,
    amazonAlbumName: process.env.AMAZON_ALBUM_NAME,
    pollIntervalMs: process.env.POLL_INTERVAL_SECONDS,
    logLevel: process.env.LOG_LEVEL,
  });
}

export const config = loadConfig();
