import "dotenv/config";
import { logger as rootLogger } from "./lib/logger.js";

const logger = rootLogger.child({ component: "main" });
import { config } from "./lib/config.js";
import { ICloudClient } from "./icloud/client.js";
import { AmazonClient } from "./amazon/client.js";
import { SyncEngine } from "./sync/engine.js";
import { StateStore } from "./state/store.js";
import { HealthServer } from "./lib/health.js";
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

  // Start health server
  const health = new HealthServer(config.healthPort, state);
  await health.start();

  // Refresh cookies immediately at startup — manually-provided cookies may be
  // hours old, so we reset the expiry clock before arming the interval.
  // Fall back to checkAuth() if refresh fails (e.g. session token expired).
  const startupRefreshed = await amazon.refreshNow();
  const authOk = startupRefreshed || (await amazon.checkAuth());
  sync.setAmazonAuthenticated(authOk);
  health.updateMetrics({ status: authOk ? "healthy" : "unhealthy" });

  // Start proactive cookie refresh interval; on failure mark the service unhealthy
  amazon.startRefreshInterval(config.cookieRefreshIntervalMs, () => {
    sync.setAmazonAuthenticated(false);
    health.updateMetrics({ status: "unhealthy", amazonAuthenticated: false });
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
  const runSyncWithMetrics = async () => {
    try {
      await sync.run();
      const metrics = sync.getMetrics();
      health.updateMetrics({
        status: metrics.amazonAuthenticated ? "healthy" : "unhealthy",
        ...metrics,
      });
    } catch {
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
