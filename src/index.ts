import { logger } from "./lib/logger.js";
import { config } from "./lib/config.js";
import { ICloudClient } from "./icloud/client.js";
import { SyncEngine } from "./sync/engine.js";

async function main() {
  logger.info({ pollInterval: config.pollIntervalMs }, "Starting sync service");

  const icloud = new ICloudClient(config.icloudAlbumToken);
  const sync = new SyncEngine(icloud);

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
