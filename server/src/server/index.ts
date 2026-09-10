import { createServer, IncomingMessage, ServerResponse } from "http";
import * as path from "path";
import { fileURLToPath } from "url";
import { logger as rootLogger } from "../lib/logger.js";
import { handleAppRequest } from "./router.js";
import {
  AppRequestContext,
  AppServerOptions,
  HealthMetrics,
  SyncControls,
} from "./types.js";

const logger = rootLogger.child({ component: "server" });

export class AppServer {
  private server: ReturnType<typeof createServer>;
  private context: AppRequestContext;

  constructor(options: AppServerOptions) {
    this.context = {
      port: options.port,
      state: options.state ?? null,
      amazonAuthPath: options.amazonAuthPath ?? "./data/amazon-auth.json",
      registrationSettings: options.registrationSettings,
      startTime: new Date(),
      onAmazonAuthChecked: options.onAmazonAuthChecked,
      onSyncRequested: options.onSyncRequested,
      isSyncRunning: options.isSyncRunning,
      staticDir:
        options.staticDir ??
        path.resolve(
          // fileURLToPath, not URL.pathname: the latter percent-encodes, so a
          // path containing spaces resolves to a directory that does not exist
          // and every SPA route 404s.
          path.dirname(fileURLToPath(import.meta.url)),
          "../../../web/dist",
        ),
      metrics: {
        status: "starting",
        uptime: 0,
        totalSyncs: 0,
        totalErrors: 0,
        totalPhotosAdded: 0,
        totalPhotosRemoved: 0,
        amazonAuthenticated: false,
        amazonAuth401Count: 0,
        amazonRateLimit429Count: 0,
        amazonBotDetection503Count: 0,
        amazonNetworkErrorCount: 0,
      },
    };

    this.server = createServer((req, res) =>
      handleAppRequest(this.context, req, res),
    );
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    await handleAppRequest(this.context, req, res);
  }

  updateMetrics(metrics: Partial<HealthMetrics>): void {
    this.context.metrics = { ...this.context.metrics, ...metrics };
  }

  setSyncControls(controls: SyncControls): void {
    this.context.onSyncRequested = controls.onSyncRequested;
    this.context.isSyncRunning = controls.isSyncRunning;
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.context.port, () => {
        logger.info({ port: this.context.port }, "App server listening");
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
