import { createServer, IncomingMessage, ServerResponse } from "http";
import * as fs from "fs/promises";
import * as path from "path";
import { logger as rootLogger } from "../lib/logger.js";
import { StateStore } from "../state/store.js";
import { SyncMetrics } from "../sync/engine.js";
import { AmazonClient, AmazonCookies } from "../amazon/client.js";
import {
  parseCookieString,
  detectTld,
  extractRequiredCookies,
} from "../amazon/login.js";
import { serveStaticFile } from "./static.js";

const logger = rootLogger.child({ component: "server" });

export interface HealthMetrics extends SyncMetrics {
  status: "healthy" | "unhealthy" | "starting";
  uptime: number;
}

export interface AppServerOptions {
  port: number;
  state?: StateStore;
  cookiesPath?: string;
  staticDir?: string;
  onAmazonAuthChecked?: (authenticated: boolean) => void;
}

export class AppServer {
  private server: ReturnType<typeof createServer>;
  private port: number;
  private startTime: Date;
  private metrics: HealthMetrics;
  private state: StateStore | null;
  private cookiesPath: string;
  private staticDir: string;
  private onAmazonAuthChecked?: (authenticated: boolean) => void;

  constructor(options: AppServerOptions) {
    this.port = options.port;
    this.state = options.state ?? null;
    this.cookiesPath = options.cookiesPath ?? "./data/amazon-cookies.json";
    this.startTime = new Date();
    this.onAmazonAuthChecked = options.onAmazonAuthChecked;
    this.staticDir =
      options.staticDir ??
      path.resolve(
        path.dirname(new URL(import.meta.url).pathname),
        "../../web/dist",
      );
    this.metrics = {
      status: "starting",
      uptime: 0,
      totalSyncs: 0,
      totalErrors: 0,
      amazonAuthenticated: false,
    };

    this.server = createServer((req, res) => this.handleRequest(req, res));
  }

  // ---------------------------------------------------------------------------
  // Request routing
  // ---------------------------------------------------------------------------

  private async handleRequest(
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

    const url = new URL(req.url ?? "/", `http://localhost:${this.port}`);
    const p = url.pathname;

    try {
      // Health & metrics
      if (p === "/health" && req.method === "GET")
        return this.handleHealth(res);
      if (p === "/metrics" && req.method === "GET")
        return this.handleMetrics(res);

      // Mappings API (requires state store)
      if (this.state) {
        if (p === "/api/mappings" && req.method === "GET")
          return this.handleListMappings(url, res);
        if (p === "/api/mappings/bulk-delete" && req.method === "POST")
          return await this.handleBulkDelete(req, res);
        if (p.startsWith("/api/mappings/") && req.method === "DELETE")
          return this.handleDeleteMapping(p, res);
      }

      // Cookies API
      if (p === "/api/cookies" && req.method === "GET")
        return await this.handleGetCookies(res);
      if (p === "/api/cookies" && req.method === "POST")
        return await this.handleSaveCookies(req, res);
      if (p === "/api/cookies/test" && req.method === "POST")
        return await this.handleTestCookies(res);

      // Static files (React SPA)
      const served = await serveStaticFile(this.staticDir, p, res);
      if (served) return;

      // 404
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    } catch (err) {
      logger.error({ error: err }, "Unhandled request error");
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Health routes
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Mappings routes
  // ---------------------------------------------------------------------------

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
    const effectivePage = Math.min(page, totalPages);
    const data = this.state!.getMappingsPaginated({
      page: effectivePage,
      pageSize,
      search,
      sortBy,
      sortOrder,
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        data,
        pagination: {
          page: effectivePage,
          pageSize,
          totalItems,
          totalPages,
        },
      }),
    );
  }

  private handleDeleteMapping(urlPath: string, res: ServerResponse): void {
    const icloudId = decodeURIComponent(urlPath.replace("/api/mappings/", ""));
    const mapping = this.state!.getMapping(icloudId);
    if (mapping) {
      this.state!.removeMapping(icloudId);
      logger.info({ icloudId }, "Mapping deleted via UI");
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ deleted: mapping ? 1 : 0 }));
  }

  private async handleBulkDelete(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const body = await this.readBody(req);
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
  }

  // ---------------------------------------------------------------------------
  // Cookies routes
  // ---------------------------------------------------------------------------

  private async handleGetCookies(res: ServerResponse): Promise<void> {
    try {
      const raw = await fs.readFile(this.cookiesPath, "utf-8");
      const cookies = JSON.parse(raw) as Record<string, string>;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(this.buildCookieResponse(cookies)));
    } catch (err) {
      const isNotFound =
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT";
      if (isNotFound) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            exists: false,
            cookies: {},
            tld: null,
            region: null,
            presentKeys: [],
            missingKeys: [],
          }),
        );
        return;
      }
      logger.error({ error: err }, "Failed to read cookies file");
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to read cookies" }));
    }
  }

  private async handleSaveCookies(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const body = await this.readBody(req);
    let parsed: { cookieString?: string; cookies?: Record<string, string> };
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    let cookies: Record<string, string>;

    if (parsed.cookieString) {
      // Parse from full cookie header string
      const all = parseCookieString(parsed.cookieString);
      const tld = detectTld(all);
      if (!tld) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error:
              "Could not detect region from cookies. Expected at-main (US) or at-acb{tld} (international).",
          }),
        );
        return;
      }
      const { cookies: extracted, missing } = extractRequiredCookies(all, tld);
      if (missing.length > 0) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: `Missing required cookies: ${missing.join(", ")}`,
            missingKeys: missing,
          }),
        );
        return;
      }
      cookies = extracted;
    } else if (parsed.cookies) {
      cookies = parsed.cookies;
    } else {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: 'Provide either "cookieString" or "cookies" in the body',
        }),
      );
      return;
    }

    // Save to file
    const dir = path.dirname(this.cookiesPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      this.cookiesPath,
      JSON.stringify(cookies, null, 2) + "\n",
    );
    logger.info("Cookies saved via UI");

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ saved: true, ...this.buildCookieResponse(cookies) }),
    );
  }

  private async handleTestCookies(res: ServerResponse): Promise<void> {
    try {
      const raw = await fs.readFile(this.cookiesPath, "utf-8");
      const cookies = JSON.parse(raw) as AmazonCookies;
      const client = new AmazonClient(cookies, { autoRefresh: false });
      const authenticated = await client.checkAuth();
      this.onAmazonAuthChecked?.(authenticated);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ authenticated }));
    } catch (err) {
      const isNotFound =
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT";
      if (isNotFound) {
        this.onAmazonAuthChecked?.(false);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            authenticated: false,
            error: "No cookies file found",
          }),
        );
        return;
      }
      logger.error({ error: err }, "Cookie test failed");
      this.onAmazonAuthChecked?.(false);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          authenticated: false,
          error: err instanceof Error ? err.message : "Unknown error",
        }),
      );
    }
  }

  private buildCookieResponse(cookies: Record<string, string>) {
    const tld = detectTld(cookies);
    const masked: Record<string, string> = {};
    for (const [key, value] of Object.entries(cookies)) {
      masked[key] =
        value.length > 8 ? value.slice(0, 4) + "…" + value.slice(-4) : "••••";
    }
    const presentKeys = Object.keys(cookies);

    // Determine which keys are expected
    const usRequired = ["session-id", "ubid-main", "at-main"];
    const usOptional = ["x-main", "sess-at-main", "sst-main"];
    const allExpected =
      tld === "com"
        ? [...usRequired, ...usOptional]
        : ["session-id", `ubid-acb${tld}`, `at-acb${tld}`];

    const missingKeys = allExpected.filter((k) => !cookies[k]);

    return {
      exists: true,
      cookies: masked,
      tld,
      region: tld === "com" ? "US" : tld ? `amazon.${tld}` : null,
      presentKeys,
      missingKeys,
    };
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

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
        logger.info({ port: this.port }, "App server listening");
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((err) => {
        if (err) reject(err);
        else {
          logger.info("App server stopped");
          resolve();
        }
      });
    });
  }
}
