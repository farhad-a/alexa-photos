import { logger as rootLogger } from "../lib/logger.js";
import type { AppServer } from "../server/index.js";
import type { StateStore } from "../state/store.js";
import type { SyncEngine } from "../sync/engine.js";

const logger = rootLogger.child({ component: "main" });

export function registerShutdownHandlers(options: {
  health: AppServer;
  sync: SyncEngine;
  state: StateStore;
  processObject?: Pick<typeof process, "on" | "exit">;
}) {
  const { health, sync, state, processObject = process } = options;

  const shutdown = async () => {
    logger.info("Shutting down...");
    await health.stop();
    await sync.close();
    state.close();
    processObject.exit(0);
  };

  processObject.on("SIGINT", shutdown);
  processObject.on("SIGTERM", shutdown);

  return shutdown;
}
