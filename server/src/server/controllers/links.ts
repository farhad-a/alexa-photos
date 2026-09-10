import { ServerResponse } from "http";
import { logger as rootLogger } from "../../lib/logger.js";
import { sendJson } from "../http.js";
import { buildAppLinks } from "../services/links.js";
import { AppRequestContext } from "../types.js";

const logger = rootLogger.child({ component: "server" });

/** External links for the admin sidebar. */
export async function handleAppLinks(
  context: AppRequestContext,
  res: ServerResponse,
): Promise<void> {
  if (!context.linkSettings) {
    sendJson(res, 503, { error: "Links are not configured" });
    return;
  }

  try {
    sendJson(
      res,
      200,
      await buildAppLinks(context.linkSettings, context.amazonAuthPath),
    );
  } catch (error) {
    logger.error({ error }, "Failed to build app links");
    sendJson(res, 500, { error: "Failed to build links" });
  }
}
