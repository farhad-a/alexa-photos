import { logger as rootLogger } from "../lib/logger.js";
import type { AppServer } from "../server/index.js";
import type { SyncEngine } from "../sync/engine.js";

const logger = rootLogger.child({ component: "main" });

export function createSyncScheduler(options: {
  sync: SyncEngine;
  health: AppServer;
  pollIntervalMs: number;
  schedule?: typeof setInterval;
  clearSchedule?: typeof clearInterval;
}) {
  const {
    sync,
    health,
    pollIntervalMs,
    schedule = setInterval,
    clearSchedule = clearInterval,
  } = options;

  const pollIntervalSeconds = pollIntervalMs / 1000;
  let consecutiveAuthFailures = 0;
  let intervalId: ReturnType<typeof setInterval> | undefined;

  const runSyncWithMetrics = async () => {
    const nextSync = new Date(Date.now() + pollIntervalMs);
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

  return {
    async start(): Promise<void> {
      await runSyncWithMetrics();
      intervalId = schedule(runSyncWithMetrics, pollIntervalMs);
    },
    stop(): void {
      if (intervalId) {
        clearSchedule(intervalId);
        intervalId = undefined;
      }
    },
    runSyncWithMetrics,
  };
}
