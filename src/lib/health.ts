import { createServer, IncomingMessage, ServerResponse } from "http";
import { logger } from "./logger.js";

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

  constructor(port: number) {
    this.port = port;
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
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    if (req.url === "/health" && req.method === "GET") {
      this.handleHealth(res);
    } else if (req.url === "/metrics" && req.method === "GET") {
      this.handleMetrics(res);
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    }
  }

  private handleHealth(res: ServerResponse): void {
    // Update uptime
    this.metrics.uptime = Date.now() - this.startTime.getTime();

    const statusCode = this.metrics.status === "healthy" ? 200 : 503;

    res.writeHead(statusCode, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        {
          status: this.metrics.status,
          uptime: Math.floor(this.metrics.uptime / 1000), // seconds
          timestamp: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  }

  private handleMetrics(res: ServerResponse): void {
    // Update uptime
    this.metrics.uptime = Date.now() - this.startTime.getTime();

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(this.metrics, null, 2));
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
