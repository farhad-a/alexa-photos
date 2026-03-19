import "dotenv/config";
import { logger as rootLogger } from "./lib/logger.js";

const logger = rootLogger.child({ component: "main" });
import { config } from "./lib/config.js";
import { ICloudClient } from "./icloud/client.js";
import { validateIcloudStartupAccess } from "./icloud/startup-validation.js";
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
      (message, level) => notifications.sendAlert(message, level),
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
  await health.start();

  const icloudValidation = await validateIcloudStartupAccess(icloud);
  if (icloudValidation.validated) {
    logger.info("iCloud startup validation succeeded");
  } else {
    logger.warn(
      { details: icloudValidation.details },
      "iCloud startup validation inconclusive; continuing and retrying on sync loop",
    );
  }

  if (amazon) {
    // Refresh cookies immediately at startup — manually-provided cookies may be
    // hours old, so we reset the expiry clock before arming the interval.
    // Fall back to classified auth verification if refresh fails
    // (e.g. session token expired).
    const startupRefreshed = await amazon.refreshNow({
      notifyOnNonAuthFailure: false,
    });
    const startupAuthStatus = startupRefreshed
      ? { ok: true, state: "ok" as const, statusCode: 200 }
      : await amazon.checkAuthStatus();

    logger.info(
      {
        startupRefreshed,
        authState: startupAuthStatus.state,
        authStatusCode: startupAuthStatus.statusCode,
      },
      "Startup Amazon auth verification result",
    );

    const authOk = startupAuthStatus.ok;
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
  } else {
    sync.setAmazonAuthenticated(false);
    health.updateMetrics({
      status: "unhealthy",
      amazonAuthenticated: false,
      amazonAuthStatus: "not_configured",
    });
    logger.info(
      { path: config.amazonCookiesPath },
      "Startup Amazon auth verification skipped until cookies are configured",
    );
  }

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
        metrics.amazonAuthStatus === "not_configured"
          ? "unhealthy"
          : metrics.amazonAuthenticated || consecutiveAuthFailures < 2
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
