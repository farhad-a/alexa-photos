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

  const syncHealthMetrics = (status: "healthy" | "unhealthy") => {
    const metrics = sync.getMetrics();
    health.updateMetrics({
      status,
      ...metrics,
    });
  };

  const logNextSync = () => {
    logger.info(
      { nextSyncInSeconds: pollIntervalSeconds },
      "Next sync scheduled",
    );
  };

  const runSyncAndUpdateMetrics = async (): Promise<
    "healthy" | "unhealthy"
  > => {
    try {
      await sync.run();
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

      syncHealthMetrics(status);
      return status;
    } catch {
      syncHealthMetrics("unhealthy");
      return "unhealthy";
    }
  };

  const runScheduledSyncWithMetrics = async () => {
    sync.setNextSync(new Date(Date.now() + pollIntervalMs));
    await runSyncAndUpdateMetrics();
    logNextSync();
  };

  const runManualSyncWithMetrics = async () => {
    await runSyncAndUpdateMetrics();
  };

  return {
    async start(): Promise<void> {
      const status = await runSyncAndUpdateMetrics();
      sync.setNextSync(new Date(Date.now() + pollIntervalMs));
      syncHealthMetrics(status);
      logNextSync();
      intervalId = schedule(runScheduledSyncWithMetrics, pollIntervalMs);
    },
    stop(): void {
      if (intervalId) {
        clearSchedule(intervalId);
        intervalId = undefined;
      }
    },
    runManualSyncWithMetrics,
    runScheduledSyncWithMetrics,
  };
}
