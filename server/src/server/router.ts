import { IncomingMessage, ServerResponse } from "http";
import { ZodError } from "zod";
import { logger as rootLogger } from "../lib/logger.js";
import { handleHealth, handleMetrics } from "./controllers/health.js";
import {
  handleBulkDelete,
  handleDeleteMapping,
  handleListMappings,
} from "./controllers/mappings.js";
import {
  handleAmazonStatus,
  handleCancelRegistration,
  handleRefreshAmazonCookies,
  handleRegistrationStatus,
  handleRemoveRegistration,
  handleStartRegistration,
  handleTestAmazonAuth,
} from "./controllers/amazon.js";
import { handleAppLinks } from "./controllers/links.js";
import { handleTriggerSync } from "./controllers/sync.js";
import { PayloadTooLargeError, sendJson } from "./http.js";
import {
  CSRF_HEADER,
  hasCsrfHeader,
  isAllowedHost,
  isSafeMethod,
} from "./security.js";
import { serveStaticFile } from "./static.js";
import { AppRequestContext } from "./types.js";

const logger = rootLogger.child({ component: "server" });

export async function handleAppRequest(
  context: AppRequestContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // No Access-Control-* headers anywhere, deliberately. The admin UI is
  // same-origin in production (this server serves web/dist) and in dev (the
  // Vite proxy forwards server-side), so nothing legitimate needs CORS — and
  // the wildcard that used to be here made every endpoint, including the
  // mutating ones, drivable and readable by any page the admin visited.

  // Rebinding check first: it is the cheapest, and it gates everything.
  if (!isAllowedHost(req.headers?.host, context.allowedHosts ?? [])) {
    const rejected = req.headers?.host ?? "";
    logger.warn({ host: rejected }, "Rejected request with unrecognised Host");
    sendJson(res, 403, {
      error: `Host '${rejected}' is not allowed. Set ADMIN_ALLOWED_HOSTS=${rejected.split(":")[0]}`,
    });
    return;
  }

  // Kept as an explicit branch: serveStaticFile ignores the method, so falling
  // through would answer OPTIONS with index.html.
  if (req.method === "OPTIONS") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  if (!isSafeMethod(req.method) && !hasCsrfHeader(req)) {
    logger.warn(
      { method: req.method, path: req.url },
      "Rejected state-changing request without the CSRF header",
    );
    sendJson(res, 403, {
      error: `Missing ${CSRF_HEADER} header`,
    });
    return;
  }

  const url = new URL(req.url ?? "/", `http://localhost:${context.port}`);
  const urlPath = url.pathname;

  try {
    if (urlPath === "/health" && req.method === "GET") {
      handleHealth(context, res);
      return;
    }
    if (urlPath === "/metrics" && req.method === "GET") {
      handleMetrics(context, res);
      return;
    }

    if (context.state) {
      if (urlPath === "/api/mappings" && req.method === "GET") {
        handleListMappings(context, url, res);
        return;
      }
      if (urlPath === "/api/mappings/bulk-delete" && req.method === "POST") {
        await handleBulkDelete(context, req, res);
        return;
      }
      if (urlPath.startsWith("/api/mappings/") && req.method === "DELETE") {
        handleDeleteMapping(context, urlPath, res);
        return;
      }
    }

    if (urlPath === "/api/sync" && req.method === "POST") {
      handleTriggerSync(context, res);
      return;
    }

    if (urlPath === "/api/links" && req.method === "GET") {
      await handleAppLinks(context, res);
      return;
    }

    if (urlPath === "/api/amazon/status" && req.method === "GET") {
      await handleAmazonStatus(context, res);
      return;
    }
    if (urlPath === "/api/amazon/registration/start" && req.method === "POST") {
      handleStartRegistration(context, res);
      return;
    }
    if (urlPath === "/api/amazon/registration/status" && req.method === "GET") {
      handleRegistrationStatus(res);
      return;
    }
    if (
      urlPath === "/api/amazon/registration/cancel" &&
      req.method === "POST"
    ) {
      await handleCancelRegistration(res);
      return;
    }
    if (urlPath === "/api/amazon/registration" && req.method === "DELETE") {
      await handleRemoveRegistration(context, res);
      return;
    }
    if (urlPath === "/api/amazon/auth/test" && req.method === "POST") {
      await handleTestAmazonAuth(context, res);
      return;
    }
    if (urlPath === "/api/amazon/auth/refresh" && req.method === "POST") {
      await handleRefreshAmazonCookies(context, res);
      return;
    }

    const served = await serveStaticFile(context.staticDir, urlPath, res);
    if (served) {
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  } catch (err) {
    if (err instanceof ZodError) {
      sendInvalidRequest(res);
      return;
    }

    if (err instanceof PayloadTooLargeError) {
      sendJson(res, 413, { error: "Request body too large" });
      return;
    }

    logger.error({ error: err }, "Unhandled request error");
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  }
}

function sendInvalidRequest(res: ServerResponse): void {
  res.writeHead(400, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Invalid request" }));
}
