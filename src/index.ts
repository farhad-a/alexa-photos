import "dotenv/config";
import { logger } from "./lib/logger.js";
import { config } from "./lib/config.js";
import { ICloudClient } from "./icloud/client.js";
import { SyncEngine } from "./sync/engine.js";

async function main() {
  logger.info(
    {
      pollIntervalSeconds: config.pollIntervalMs / 1000,
      albumName: config.amazonAlbumName,
    },
    "Starting sync service",
  );

  const icloud = new ICloudClient(config.icloudAlbumToken);
  const sync = new SyncEngine(icloud);

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...");
    await sync.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Initial sync
  await sync.run();

  // Poll for changes
  setInterval(async () => {
    try {
      await sync.run();
    } catch (error) {
      logger.error({ error }, "Sync failed");
    }
  }, config.pollIntervalMs);
}

main().catch((error) => {
  logger.fatal({ error }, "Fatal error");
  process.exit(1);
});
