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
  // The response embeds the iCloud shared-album token, a capability URL that
  // grants anonymous access to the photos. The router sets a blanket
  // `Access-Control-Allow-Origin: *`, which would let any site the admin
  // happens to visit read that token without ever opening the UI. The admin UI
  // is same-origin — it is served by this server, and the dev proxy forwards
  // server-side — so it needs no CORS grant here.
  res.removeHeader("Access-Control-Allow-Origin");

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
