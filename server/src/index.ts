import "dotenv/config";
import { logger as rootLogger } from "./lib/logger.js";

const logger = rootLogger.child({ component: "main" });
import { config } from "./lib/config.js";
import { ICloudClient } from "./icloud/client.js";
import { AmazonClient } from "./amazon/client.js";
import { SyncEngine } from "./sync/engine.js";
import { StateStore } from "./state/store.js";
import { AppServer } from "./server/index.js";
import { NotificationService } from "./lib/notifications.js";
import { createSyncScheduler } from "./lifecycle/scheduler.js";
import { registerShutdownHandlers } from "./lifecycle/shutdown.js";
import { runStartupSequence } from "./lifecycle/startup.js";

async function main() {
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
    amazon = await AmazonClient.fromFile(
      config.amazonCookiesPath,
      config.amazonAutoRefreshCookies,
      notifications,
    );
  } catch (error) {
    const isMissingCookiesFile =
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT";

    if (!isMissingCookiesFile) {
      throw error;
    }

    logger.warn(
      { path: config.amazonCookiesPath },
      "Amazon cookies file not found at startup; start continues and auth checks will retry after cookies are saved",
    );
  }

  const sync = new SyncEngine(icloud, state, amazon);

  // Start app server (health, API, admin UI)
  const health = new AppServer({
    port: config.serverPort,
    state,
    cookiesPath: config.amazonCookiesPath,
    onAmazonAuthChecked: (authenticated) => {
      sync.setAmazonAuthenticated(authenticated);
      health.updateMetrics({
        status: authenticated ? "healthy" : "unhealthy",
        amazonAuthenticated: authenticated,
      });
    },
    onCookiesSaved: async () => {
      await sync.reloadAmazonClient();
      health.updateMetrics({
        status: "unhealthy",
        amazonAuthenticated: false,
      });
    },
  });

  await runStartupSequence({
    icloud,
    amazon,
    sync,
    health,
    cookieRefreshIntervalMs: config.cookieRefreshIntervalMs,
    amazonCookiesPath: config.amazonCookiesPath,
  });

  registerShutdownHandlers({ health, sync, state });

  const scheduler = createSyncScheduler({
    sync,
    health,
    pollIntervalMs: config.pollIntervalMs,
  });
  await scheduler.start();
}

main().catch((error) => {
  logger.fatal({ error }, "Fatal error");
  process.exit(1);
});
