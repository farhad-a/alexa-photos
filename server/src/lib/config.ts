import { z } from "zod";

const configSchema = z.object({
  icloudAlbumToken: z.string().min(1),
  icloudDownloadMaxRetries: z.coerce.number().default(3),
  amazonAlbumName: z.string().default("Echo Show"),
  amazonAutoRefreshCookies: z.coerce.boolean().default(true),

  // Device-registration auth. The marketplace fields must be set explicitly:
  // alexa-cookie2 defaults to amazon.de, and a registration made against the
  // wrong marketplace cannot be fixed by config, only redone in a browser.
  amazonAuthPath: z.string().default("./data/amazon-auth.json"),
  amazonMarketplace: z.string().default("amazon.com"),
  amazonAcceptLanguage: z.string().default("en-US"),
  amazonProxyLanguage: z.string().default("en_US"),
  amazonDeviceAppName: z.string().default("alexa-photos"),
  // Must be an IP literal the browser can reach. Auto-detection inside Docker
  // returns the bridge address, which fails silently, so require it there.
  amazonProxyOwnIp: z.string().optional(),
  amazonProxyPort: z.coerce.number().default(3456),
  amazonProxyListenBind: z.string().default("0.0.0.0"),
  amazonRegistrationTimeoutMs: z.coerce
    .number()
    .default(10)
    .transform((m) => m * 60 * 1000),
  // Refresh only when cookies are older than this. They live about 14 days.
  amazonCookieMaxAgeDays: z.coerce.number().default(7),
  syncDeletions: z.coerce.boolean().default(true),
  pollIntervalMs: z.coerce
    .number()
    .default(60)
    .transform((s) => s * 1000),
  uploadDelayMs: z.coerce.number().default(0),
  serverPort: z.coerce.number().default(3000),
  // Hostnames allowed in the Host header, beyond loopback and IP literals.
  // Required to reach the admin UI by name — see parseAllowedHosts.
  adminAllowedHosts: z
    .string()
    .default("")
    .transform((raw) => raw.split(",").filter((entry) => entry.trim() !== "")),
  // Shown in the admin sidebar. Override it on a fork.
  githubUrl: z.url().default("https://github.com/farhad-a/alexa-photos"),
  alertWebhookUrl: z.string().optional(),
  pushoverToken: z.string().optional(),
  pushoverUser: z.string().optional(),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  cookieRefreshIntervalMs: z.coerce
    .number()
    .default(12)
    .transform((h) => h * 60 * 60 * 1000),
  notificationThrottleMs: z.coerce
    .number()
    .default(60)
    .transform((m) => (m === -1 ? -1 : m * 60 * 1000)),
});

export type Config = z.infer<typeof configSchema>;

function loadConfig(): Config {
  return configSchema.parse({
    icloudAlbumToken: process.env.ICLOUD_ALBUM_TOKEN,
    icloudDownloadMaxRetries: process.env.ICLOUD_DOWNLOAD_MAX_RETRIES,
    amazonAlbumName: process.env.AMAZON_ALBUM_NAME,
    amazonAutoRefreshCookies: process.env.AMAZON_AUTO_REFRESH_COOKIES,
    amazonAuthPath: process.env.AMAZON_AUTH_PATH,
    amazonMarketplace: process.env.AMAZON_MARKETPLACE,
    amazonAcceptLanguage: process.env.AMAZON_ACCEPT_LANGUAGE,
    amazonProxyLanguage: process.env.AMAZON_PROXY_LANGUAGE,
    amazonDeviceAppName: process.env.AMAZON_DEVICE_APP_NAME,
    amazonProxyOwnIp: process.env.AMAZON_PROXY_OWN_IP,
    amazonProxyPort: process.env.AMAZON_PROXY_PORT,
    amazonProxyListenBind: process.env.AMAZON_PROXY_LISTEN_BIND,
    amazonRegistrationTimeoutMs:
      process.env.AMAZON_REGISTRATION_TIMEOUT_MINUTES,
    amazonCookieMaxAgeDays: process.env.AMAZON_COOKIE_MAX_AGE_DAYS,
    syncDeletions: process.env.SYNC_DELETIONS,
    pollIntervalMs: process.env.POLL_INTERVAL_SECONDS,
    uploadDelayMs: process.env.UPLOAD_DELAY_MS,
    serverPort: process.env.SERVER_PORT,
    adminAllowedHosts: process.env.ADMIN_ALLOWED_HOSTS,
    githubUrl: process.env.GITHUB_URL,
    alertWebhookUrl: process.env.ALERT_WEBHOOK_URL,
    pushoverToken: process.env.PUSHOVER_TOKEN,
    pushoverUser: process.env.PUSHOVER_USER,
    logLevel: process.env.LOG_LEVEL,
    cookieRefreshIntervalMs: process.env.COOKIE_REFRESH_INTERVAL_HOURS,
    notificationThrottleMs: process.env.NOTIFICATION_THROTTLE_MINUTES,
  });
}

export const config = loadConfig();
