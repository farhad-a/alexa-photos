import { IncomingMessage, ServerResponse } from "http";
import { ZodError } from "zod";
import { logger as rootLogger } from "../lib/logger.js";
import {
  handleHealth,
  handleHello,
  handleMetrics,
} from "./controllers/health.js";
import {
  handleBulkDelete,
  handleDeleteMapping,
  handleListMappings,
} from "./controllers/mappings.js";
import {
  handleGetCookies,
  handleSaveCookies,
  handleTestCookies,
} from "./controllers/cookies.js";
import { serveStaticFile } from "./static.js";
import { AppRequestContext } from "./types.js";

const logger = rootLogger.child({ component: "server" });

export async function handleAppRequest(
  context: AppRequestContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://localhost:${context.port}`);
  const urlPath = url.pathname;

  try {
    if (urlPath === "/health" && req.method === "GET") {
      handleHealth(context, res);
      return;
    }
    if (urlPath === "/hello" && req.method === "GET") {
      handleHello(res);
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

    if (urlPath === "/api/cookies" && req.method === "GET") {
      await handleGetCookies(context, res);
      return;
    }
    if (urlPath === "/api/cookies" && req.method === "POST") {
      await handleSaveCookies(context, req, res);
      return;
    }
    if (urlPath === "/api/cookies/test" && req.method === "POST") {
      await handleTestCookies(context, res);
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
