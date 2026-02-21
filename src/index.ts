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

async function main() {
  logger.info(
    {
      pollIntervalSeconds: config.pollIntervalMs / 1000,
      cookieRefreshIntervalHours:
        config.cookieRefreshIntervalMs / (60 * 60 * 1000),
      albumName: config.amazonAlbumName,
      healthPort: config.healthPort,
    },
    "Starting sync service",
  );

  const icloud = new ICloudClient(config.icloudAlbumToken);
  const state = new StateStore();

  const notifications = new NotificationService(config);

  const amazon = await AmazonClient.fromFile(
    config.amazonCookiesPath,
    config.amazonAutoRefreshCookies,
    (message, level) => notifications.sendAlert(message, level),
    notifications,
  );

  const sync = new SyncEngine(icloud, state, amazon);

  // Start app server (health, API, admin UI)
  const health = new AppServer({
    port: config.healthPort,
    state,
    cookiesPath: config.amazonCookiesPath,
    onAmazonAuthChecked: (authenticated) => {
      sync.setAmazonAuthenticated(authenticated);
      health.updateMetrics({
        status: authenticated ? "healthy" : "unhealthy",
        amazonAuthenticated: authenticated,
      });
    },
  });
  await health.start();

  // Refresh cookies immediately at startup — manually-provided cookies may be
  // hours old, so we reset the expiry clock before arming the interval.
  // Fall back to checkAuth() if refresh fails (e.g. session token expired).
  const startupRefreshed = await amazon.refreshNow();
  const authOk = startupRefreshed || (await amazon.checkAuth());
  sync.setAmazonAuthenticated(authOk);
  health.updateMetrics({
    status: authOk ? "healthy" : "unhealthy",
    amazonAuthenticated: authOk,
  });

  // Start proactive cookie refresh interval.
  // Refresh failures are noisy but not always definitive auth failures,
  // so we alert via logs/notifications and let sync-time auth checks be source of truth.
  amazon.startRefreshInterval(config.cookieRefreshIntervalMs, () => {
    logger.warn(
      "Cookie refresh failed; deferring health-state changes to sync auth checks",
    );
  });

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...");
    await health.stop();
    await sync.close();
    state.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Run sync and update health metrics
  const pollIntervalSeconds = config.pollIntervalMs / 1000;
  let consecutiveAuthFailures = 0;
  const runSyncWithMetrics = async () => {
    const nextSync = new Date(Date.now() + config.pollIntervalMs);
    try {
      await sync.run();
      sync.setNextSync(nextSync);
      const metrics = sync.getMetrics();

      if (metrics.amazonAuthenticated) {
        consecutiveAuthFailures = 0;
      } else {
        consecutiveAuthFailures += 1;
      }

      const status =
        metrics.amazonAuthenticated || consecutiveAuthFailures < 2
          ? "healthy"
          : "unhealthy";

      health.updateMetrics({
        status,
        ...metrics,
      });
    } catch {
      sync.setNextSync(nextSync);
      const metrics = sync.getMetrics();
      health.updateMetrics({ status: "unhealthy", ...metrics });
    }
    logger.info(
      { nextSyncInSeconds: pollIntervalSeconds },
      "Next sync scheduled",
    );
  };

  // Initial sync
  await runSyncWithMetrics();

  // Poll for changes
  setInterval(runSyncWithMetrics, config.pollIntervalMs);
}

main().catch((error) => {
  logger.fatal({ error }, "Fatal error");
  process.exit(1);
});
