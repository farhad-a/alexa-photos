import "dotenv/config";
import * as fs from "fs";
import { logger as rootLogger } from "./lib/logger.js";

const logger = rootLogger.child({ component: "main" });
import { config } from "./lib/config.js";
import { ICloudClient } from "./icloud/client.js";
import { AmazonClient } from "./amazon/client.js";
import { setCredentialsChangedHandler } from "./amazon/registration.js";
import { SyncEngine } from "./sync/engine.js";
import { StateStore } from "./state/store.js";
import { AppServer } from "./server/index.js";
import { NotificationService } from "./lib/notifications.js";
import { createSyncScheduler } from "./lifecycle/scheduler.js";
import { registerShutdownHandlers } from "./lifecycle/shutdown.js";
import { runStartupSequence } from "./lifecycle/startup.js";

/**
 * Tell anyone upgrading that their old credentials are inert.
 *
 * Aliasing the old setting would be worse than ignoring it: every cookie file
 * predates device registration, so pointing the loader at one only produces a
 * confusing failure instead of a clear instruction.
 */
function warnAboutLegacyCookieSetup(): void {
  const legacyPath =
    process.env.AMAZON_COOKIES_PATH ?? "./data/amazon-cookies.json";
  const envSet = Boolean(process.env.AMAZON_COOKIES_PATH);

  let fileExists: boolean;
  try {
    fileExists = fs.existsSync(legacyPath);
  } catch {
    fileExists = false;
  }

  if (!envSet && !fileExists) return;

  logger.warn(
    { path: legacyPath, envSet, fileExists },
    "Found a manual Amazon cookie file or AMAZON_COOKIES_PATH. Both are ignored now: register a device at /amazon. The old file can be deleted.",
  );
}

async function main() {
  warnAboutLegacyCookieSetup();

  logger.info(
    {
      pollIntervalSeconds: config.pollIntervalMs / 1000,
      cookieRefreshIntervalHours:
        config.cookieRefreshIntervalMs / (60 * 60 * 1000),
      albumName: config.amazonAlbumName,
      serverPort: config.serverPort,
    },
    "Starting sync service",
  );

  const icloud = new ICloudClient(config.icloudAlbumToken);

  const state = new StateStore();

  const notifications = new NotificationService(config);

  let amazon: AmazonClient | undefined;
  try {
    amazon = await AmazonClient.load({
      authPath: config.amazonAuthPath,
      autoRefresh: config.amazonAutoRefreshCookies,
      notificationService: notifications,
      cookieMaxAgeDays: config.amazonCookieMaxAgeDays,
    });
  } catch (error) {
    const isMissingCredentials =
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT";

    if (!isMissingCredentials) {
      throw error;
    }

    logger.warn(
      {
        authPath: config.amazonAuthPath,
      },
      "No Amazon credentials found at startup; start continues and syncing begins once a device is registered",
    );
  }

  const sync = new SyncEngine(icloud, state, amazon);

  // Start app server (health, API, admin UI)
  const health = new AppServer({
    port: config.serverPort,
    state,
    amazonAuthPath: config.amazonAuthPath,
    registrationSettings: {
      authPath: config.amazonAuthPath,
      amazonPage: config.amazonMarketplace,
      acceptLanguage: config.amazonAcceptLanguage,
      proxyLanguage: config.amazonProxyLanguage,
      deviceAppName: config.amazonDeviceAppName,
      proxyOwnIp: config.amazonProxyOwnIp,
      proxyPort: config.amazonProxyPort,
      proxyListenBind: config.amazonProxyListenBind,
      timeoutMs: config.amazonRegistrationTimeoutMs,
      adminPort: config.serverPort,
    },
    onAmazonAuthChecked: (authenticated) => {
      sync.setAmazonAuthenticated(authenticated);
      health.updateMetrics({
        status: authenticated ? "healthy" : "unhealthy",
        amazonAuthenticated: authenticated,
      });
    },
    isSyncRunning: () => sync.isSyncRunning(),
  });

  await runStartupSequence({
    icloud,
    amazon,
    sync,
    health,
    cookieRefreshIntervalMs: config.cookieRefreshIntervalMs,
    amazonAuthPath: config.amazonAuthPath,
  });

  // Re-registering replaces the credentials under the running client, so the
  // engine has to drop the one it holds.
  setCredentialsChangedHandler(async () => {
    await sync.reloadAmazonClient();
    health.updateMetrics({ status: "unhealthy", amazonAuthenticated: false });
  });

  registerShutdownHandlers({ health, sync, state });

  const scheduler = createSyncScheduler({
    sync,
    health,
    pollIntervalMs: config.pollIntervalMs,
  });
  health.setSyncControls({
    onSyncRequested: () => scheduler.runManualSyncWithMetrics(),
    isSyncRunning: () => sync.isSyncRunning(),
  });
  await scheduler.start();
}

main().catch((error) => {
  logger.fatal({ error }, "Fatal error");
  process.exit(1);
});
