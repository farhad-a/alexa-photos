import { logger as rootLogger } from "../lib/logger.js";
import { validateIcloudStartupAccess } from "../icloud/startup-validation.js";
import type { ICloudClient } from "../icloud/client.js";
import type { AmazonClient } from "../amazon/client.js";
import type { AppServer } from "../server/index.js";
import type { SyncEngine } from "../sync/engine.js";

const logger = rootLogger.child({ component: "main" });

export async function runStartupSequence(options: {
  icloud: ICloudClient;
  amazon?: AmazonClient;
  sync: SyncEngine;
  health: AppServer;
  cookieRefreshIntervalMs: number;
  amazonCookiesPath: string;
}): Promise<void> {
  const {
    icloud,
    amazon,
    sync,
    health,
    cookieRefreshIntervalMs,
    amazonCookiesPath,
  } = options;

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
    const startupRefreshed = await amazon.refreshNow({
      notifyOnNonAuthFailure: false,
    });
    const startupAuthStatus = startupRefreshed
      ? {
          ok: true,
          state: "ok" as const,
          statusCode: 200,
          retriable: false,
          provider: "amazon" as const,
          kind: "ok" as const,
          actionable: false,
        }
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

    amazon.startRefreshInterval(cookieRefreshIntervalMs, () => {
      logger.warn(
        "Cookie refresh failed; deferring health-state changes to sync auth checks",
      );
    });
    return;
  }

  sync.setAmazonAuthenticated(false);
  health.updateMetrics({
    status: "unhealthy",
    amazonAuthenticated: false,
    amazonAuthStatus: "not_configured",
  });
  logger.info(
    { path: amazonCookiesPath },
    "Startup Amazon auth verification skipped until cookies are configured",
  );
}
