import { ServerResponse } from "http";
import { logger as rootLogger } from "../../lib/logger.js";
import { sendJson } from "../http.js";
import { AppRequestContext } from "../types.js";

const logger = rootLogger.child({ component: "server" });

export function handleTriggerSync(
  context: AppRequestContext,
  res: ServerResponse,
): void {
  if (!context.onSyncRequested) {
    sendJson(res, 503, { error: "Sync trigger not configured" });
    return;
  }

  if (context.isSyncRunning?.()) {
    sendJson(res, 409, { error: "Sync already in progress" });
    return;
  }

  void Promise.resolve()
    .then(() => context.onSyncRequested?.())
    .catch((error) => {
      logger.error({ error }, "Manual sync failed");
    });

  logger.info("Manual sync triggered");
  sendJson(res, 202, { triggered: true });
}
