import { ServerResponse } from "http";
import { AppRequestContext } from "../types.js";

export function handleHealth(
  context: AppRequestContext,
  res: ServerResponse,
): void {
  context.metrics.uptime = Date.now() - context.startTime.getTime();
  const statusCode = context.metrics.status === "healthy" ? 200 : 503;

  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify(
      {
        status: context.metrics.status,
        uptime: Math.floor(context.metrics.uptime / 1000),
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

export function handleMetrics(
  context: AppRequestContext,
  res: ServerResponse,
): void {
  context.metrics.uptime = Date.now() - context.startTime.getTime();

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(context.metrics, null, 2));
}
