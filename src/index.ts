import "dotenv/config";
import { logger } from "./lib/logger.js";
import { config } from "./lib/config.js";
import { ICloudClient } from "./icloud/client.js";
import { SyncEngine } from "./sync/engine.js";
import { HealthServer } from "./lib/health.js";

async function main() {
  logger.info(
    {
      pollIntervalSeconds: config.pollIntervalMs / 1000,
      albumName: config.amazonAlbumName,
      healthPort: config.healthPort,
    },
    "Starting sync service",
  );

  const icloud = new ICloudClient(config.icloudAlbumToken);
  const sync = new SyncEngine(icloud);

  // Start health server
  const health = new HealthServer(config.healthPort);
  await health.start();

  // Update health status to healthy initially
  health.updateMetrics({ status: "healthy" });

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...");
    await health.stop();
    await sync.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Run sync and update health metrics
  const runSyncWithMetrics = async () => {
    try {
      await sync.run();
      const metrics = sync.getMetrics();
      health.updateMetrics({
        status: "healthy",
        ...metrics,
      });
    } catch (error) {
      logger.error({ error }, "Sync failed");
      const metrics = sync.getMetrics();
      health.updateMetrics({
        status: "unhealthy",
        ...metrics,
      });
    }
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
