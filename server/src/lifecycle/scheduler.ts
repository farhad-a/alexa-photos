import { logger as rootLogger } from "../lib/logger.js";
import type { AppServer } from "../server/index.js";
import type { SyncEngine } from "../sync/engine.js";

const logger = rootLogger.child({ component: "main" });

/**
 * The timer seam, narrowed to the single way the scheduler uses it.
 *
 * `typeof setInterval` would drag in the whole overload set, including a DOM
 * one returning `number`, which no test double can satisfy without casting.
 * The real timers still satisfy these, so they remain the defaults.
 */
type TimerHandle = ReturnType<typeof setInterval>;
type ScheduleFn = (callback: () => void, ms: number) => TimerHandle;
type ClearScheduleFn = (id: TimerHandle) => void;

export function createSyncScheduler(options: {
  sync: SyncEngine;
  health: AppServer;
  pollIntervalMs: number;
  schedule?: ScheduleFn;
  clearSchedule?: ClearScheduleFn;
}) {
  const { sync, health, pollIntervalMs } = options;

  // Annotated rather than destructured with a default: a `= setInterval`
  // default widens the binding into a union with the overloaded global, and
  // calling that union yields `number | Timeout` again.
  const schedule: ScheduleFn = options.schedule ?? setInterval;
  const clearSchedule: ClearScheduleFn = options.clearSchedule ?? clearInterval;

  const pollIntervalSeconds = pollIntervalMs / 1000;
  let consecutiveAuthFailures = 0;
  let intervalId: TimerHandle | undefined;

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
