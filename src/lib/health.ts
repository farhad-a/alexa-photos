import { createServer, IncomingMessage, ServerResponse } from "http";
import { logger as rootLogger } from "./logger.js";
import { StateStore } from "../state/store.js";
import { renderUI } from "./ui.js";

const logger = rootLogger.child({ component: "health" });

export interface HealthMetrics {
  status: "healthy" | "unhealthy" | "starting";
  uptime: number;
  lastSync?: {
    timestamp: Date;
    durationMs: number;
    photosAdded: number;
    photosRemoved: number;
    success: boolean;
    error?: string;
  };
  totalSyncs: number;
  totalErrors: number;
  amazonAuthenticated: boolean;
}

export class HealthServer {
  private server: ReturnType<typeof createServer>;
  private port: number;
  private startTime: Date;
  private metrics: HealthMetrics;
  private state: StateStore | null;

  constructor(port: number, state?: StateStore) {
    this.port = port;
    this.state = state ?? null;
    this.startTime = new Date();
    this.metrics = {
      status: "starting",
      uptime: 0,
      totalSyncs: 0,
      totalErrors: 0,
      amazonAuthenticated: false,
    };

    this.server = createServer((req, res) => this.handleRequest(req, res));
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://localhost:${this.port}`);
    const path = url.pathname;

    // Existing routes
    if (path === "/health" && req.method === "GET") {
      return this.handleHealth(res);
    }
    if (path === "/metrics" && req.method === "GET") {
      return this.handleMetrics(res);
    }

    // UI and API routes (require state store)
    if (this.state) {
      if (path === "/" && req.method === "GET") {
        return this.handleUI(res);
      }
      if (path === "/api/mappings" && req.method === "GET") {
        return this.handleListMappings(url, res);
      }
      if (path === "/api/mappings/bulk-delete" && req.method === "POST") {
        this.handleBulkDelete(req, res);
        return;
      }
      if (path.startsWith("/api/mappings/") && req.method === "DELETE") {
        return this.handleDeleteMapping(path, res);
      }
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  private handleHealth(res: ServerResponse): void {
    this.metrics.uptime = Date.now() - this.startTime.getTime();
    const statusCode = this.metrics.status === "healthy" ? 200 : 503;

    res.writeHead(statusCode, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        {
          status: this.metrics.status,
          uptime: Math.floor(this.metrics.uptime / 1000),
          timestamp: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  }

  private handleMetrics(res: ServerResponse): void {
    this.metrics.uptime = Date.now() - this.startTime.getTime();

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(this.metrics, null, 2));
  }

  private handleUI(res: ServerResponse): void {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderUI());
  }

  private handleListMappings(url: URL, res: ServerResponse): void {
    const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10));
    const pageSize = Math.min(
      200,
      Math.max(1, parseInt(url.searchParams.get("pageSize") ?? "50", 10)),
    );
    const search = url.searchParams.get("search") || undefined;
    const sortByParam = url.searchParams.get("sortBy");
    const sortBy =
      sortByParam === "icloud_id"
        ? ("icloud_id" as const)
        : ("synced_at" as const);
    const sortOrderParam = url.searchParams.get("sortOrder");
    const sortOrder =
      sortOrderParam === "asc" ? ("asc" as const) : ("desc" as const);

    const totalItems = this.state!.getCount(search);
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
    const data = this.state!.getMappingsPaginated({
      page,
      pageSize,
      search,
      sortBy,
      sortOrder,
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        data,
        pagination: { page, pageSize, totalItems, totalPages },
      }),
    );
  }

  private handleDeleteMapping(path: string, res: ServerResponse): void {
    const icloudId = decodeURIComponent(path.replace("/api/mappings/", ""));
    const mapping = this.state!.getMapping(icloudId);
    if (mapping) {
      this.state!.removeMapping(icloudId);
      logger.info({ icloudId }, "Mapping deleted via UI");
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ deleted: mapping ? 1 : 0 }));
  }

  private handleBulkDelete(req: IncomingMessage, res: ServerResponse): void {
    this.readBody(req)
      .then((body) => {
        let parsed: { icloudIds?: string[] };
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON" }));
          return;
        }

        if (!Array.isArray(parsed.icloudIds)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "icloudIds must be an array" }));
          return;
        }

        const deleted = this.state!.removeMappings(parsed.icloudIds);
        logger.info(
          { count: deleted, requested: parsed.icloudIds.length },
          "Bulk delete via UI",
        );

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ deleted }));
      })
      .catch(() => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to read request body" }));
      });
  }

  private async readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(
        typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer),
      );
    }
    return Buffer.concat(chunks).toString("utf-8");
  }

  updateMetrics(metrics: Partial<HealthMetrics>): void {
    this.metrics = { ...this.metrics, ...metrics };
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.port, () => {
        logger.info({ port: this.port }, "Health server listening");
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((err) => {
        if (err) reject(err);
        else {
          logger.info("Health server stopped");
          resolve();
        }
      });
    });
  }
}
