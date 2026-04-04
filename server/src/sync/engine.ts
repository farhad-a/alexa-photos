import { ICloudClient, ICloudPhoto } from "../icloud/client.js";
import { AmazonAuthStatus, AmazonClient } from "../amazon/client.js";
import { StateStore, PhotoMapping } from "../state/store.js";
import { config } from "../lib/config.js";
import { logger as rootLogger } from "../lib/logger.js";

const logger = rootLogger.child({ component: "sync" });
import { NotificationService } from "../lib/notifications.js";

export interface SyncMetrics {
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
  totalPhotosAdded: number;
  totalPhotosRemoved: number;
  amazonAuthenticated: boolean;
  amazonAuthStatus?: AmazonAuthStatus["state"];
  amazonAuthLastStatusCode?: number;
  amazonAuth401Count: number;
  amazonRateLimit429Count: number;
  amazonBotDetection503Count: number;
  amazonNetworkErrorCount: number;
  nextSync?: Date;
}

export class SyncEngine {
  private icloud: ICloudClient;
  private amazon: AmazonClient | null = null;
  private state: StateStore;
  private isRunning = false;
  private albumId: string | null = null;
  private notifications: NotificationService;
  private lastAuthStatus: AmazonAuthStatus | null = null;
  private refreshIntervalStarted = false;
  private unauthorizedStreak = 0;
  private transientAuthFailureStreak = 0;
  private metrics: SyncMetrics = {
    totalSyncs: 0,
    totalErrors: 0,
    totalPhotosAdded: 0,
    totalPhotosRemoved: 0,
    amazonAuthenticated: false,
    amazonAuth401Count: 0,
    amazonRateLimit429Count: 0,
    amazonBotDetection503Count: 0,
    amazonNetworkErrorCount: 0,
  };

  constructor(icloud: ICloudClient, state: StateStore, amazon?: AmazonClient) {
    this.icloud = icloud;
    this.state = state;
    this.notifications = new NotificationService(config);
    if (amazon) {
      this.amazon = amazon;
    }
  }

  getMetrics(): SyncMetrics {
    return { ...this.metrics };
  }

  async run(): Promise<void> {
    if (this.isRunning) {
      logger.warn("Sync already in progress, skipping");
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();
    let photosAdded = 0;
    let photosRemoved = 0;
    let photosFailed = 0;

    try {
      logger.info("Starting sync");

      // Get current state
      const icloudPhotos = await this.icloud.getPhotos();
      const mappings = this.state.getAllMappings();

      // Build sets for comparison
      const icloudIds = new Set(icloudPhotos.map((p) => p.id));
      const mappedIds = new Set(mappings.map((m) => m.icloudId));

      // Find photos to add (in iCloud but not synced)
      const toAdd = icloudPhotos.filter((p) => !mappedIds.has(p.id));

      // Find photos to remove (synced but no longer in iCloud)
      const toRemove = mappings.filter((m) => !icloudIds.has(m.icloudId));

      logger.info(
        {
          icloudCount: icloudPhotos.length,
          syncedCount: mappings.length,
          toAdd: toAdd.length,
          toRemove: toRemove.length,
        },
        "Sync analysis complete",
      );

      // Keep auth metrics fresh every run, even when there's no add/remove work.
      const authOk = await this.refreshAmazonAuthStatus();

      // Initialize Amazon client only if we have work to do
      const needsAmazon =
        toAdd.length > 0 || (toRemove.length > 0 && config.syncDeletions);
      if (needsAmazon) {
        if (!authOk) {
          throw new Error(this.buildAuthFailureMessage());
        }
        await this.ensureAmazonClient();
      }

      // Process additions
      for (let i = 0; i < toAdd.length; i++) {
        const photo = toAdd[i];
        try {
          await this.addPhoto(photo);
          photosAdded++;
        } catch (error) {
          photosFailed++;
          logger.error({ photoId: photo.id, error }, "Failed to add photo");
        }

        // Rate limiting: add delay between uploads if configured
        if (config.uploadDelayMs > 0 && i < toAdd.length - 1) {
          logger.debug(
            { delayMs: config.uploadDelayMs },
            "Waiting before next upload",
          );
          await new Promise((resolve) =>
            setTimeout(resolve, config.uploadDelayMs),
          );
        }
      }

      // Process removals (if enabled)
      if (toRemove.length > 0) {
        if (config.syncDeletions) {
          await this.removePhotos(toRemove);
          photosRemoved = toRemove.length;
        } else {
          logger.info(
            { count: toRemove.length },
            "Skipping deletions (SYNC_DELETIONS=false)",
          );
        }
      }

      const durationMs = Date.now() - startTime;
      logger.info(
        { durationMs, photosAdded, photosFailed, photosRemoved },
        "Sync complete",
      );

      // Update metrics on success
      this.metrics.lastSync = {
        timestamp: new Date(),
        durationMs,
        photosAdded,
        photosRemoved,
        success: true,
      };
      this.metrics.totalSyncs++;
      this.metrics.totalPhotosAdded += photosAdded;
      this.metrics.totalPhotosRemoved += photosRemoved;

      // Send summary notification when something changed or failed.
      if (photosAdded > 0 || photosRemoved > 0 || photosFailed > 0) {
        const parts: string[] = [];
        if (photosAdded > 0) {
          parts.push(
            `${photosAdded} photo${photosAdded === 1 ? "" : "s"} added`,
          );
        }
        if (photosRemoved > 0) {
          parts.push(
            `${photosRemoved} photo${photosRemoved === 1 ? "" : "s"} removed`,
          );
        }
        if (photosFailed > 0) {
          parts.push(
            `${photosFailed} upload${photosFailed === 1 ? "" : "s"} failed`,
          );
        }

        await this.notifications.sendAlert(
          `Sync complete: ${parts.join(", ")} (${Math.round(durationMs / 1000)}s).`,
          photosFailed > 0 ? "warning" : "info",
          { durationMs, photosAdded, photosRemoved, photosFailed },
        );
      }
    } catch (error) {
      logger.error({ error }, "Sync failed");

      // Update metrics on error
      this.metrics.lastSync = {
        timestamp: new Date(),
        durationMs: Date.now() - startTime,
        photosAdded,
        photosRemoved,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
      this.metrics.totalErrors++;
      this.metrics.totalPhotosAdded += photosAdded;
      this.metrics.totalPhotosRemoved += photosRemoved;

      throw error;
    } finally {
      this.isRunning = false;
    }
  }

  setAmazonAuthenticated(value: boolean): void {
    this.metrics.amazonAuthenticated = value;
  }

  setNextSync(date: Date): void {
    this.metrics.nextSync = date;
  }

  async reloadAmazonClient(): Promise<void> {
    if (this.amazon) {
      try {
        await this.amazon.close();
      } catch (error) {
        logger.warn({ error }, "Failed to close existing Amazon client");
      }
    }

    this.amazon = null;
    this.albumId = null;
    this.refreshIntervalStarted = false;
    this.metrics.amazonAuthenticated = false;
    this.metrics.amazonAuthStatus = undefined;
    this.metrics.amazonAuthLastStatusCode = undefined;
    this.lastAuthStatus = null;
    this.unauthorizedStreak = 0;
    this.transientAuthFailureStreak = 0;

    logger.info("Amazon client reset; will reload cookies on next auth check");
  }

  private startRefreshIntervalIfNeeded(): void {
    if (!this.amazon || this.refreshIntervalStarted) {
      return;
    }

    this.amazon.startRefreshInterval(config.cookieRefreshIntervalMs, () => {
      logger.warn(
        "Cookie refresh failed; deferring health-state changes to sync auth checks",
      );
    });
    this.refreshIntervalStarted = true;
  }

  private async refreshAmazonAuthStatus(): Promise<boolean> {
    try {
      // Create client lazily so auth status can be checked even on no-op syncs.
      if (!this.amazon) {
        this.amazon = await AmazonClient.fromFile(
          config.amazonCookiesPath,
          config.amazonAutoRefreshCookies,
          (message, level) => this.notifications.sendAlert(message, level),
          this.notifications,
        );
        this.startRefreshIntervalIfNeeded();
      }

      let auth = await this.amazon.checkAuthStatus();

      // Preflight 401s can be transient and recover after token exchange.
      // Try one immediate refresh before classifying as hard unauthorized.
      if (auth.state === "unauthorized") {
        logger.info(
          "Auth check returned 401; attempting immediate cookie refresh",
        );
        const refreshed = await this.amazon.refreshNow();
        if (refreshed) {
          auth = await this.amazon.checkAuthStatus();
        }
      }

      this.lastAuthStatus = auth;
      this.metrics.amazonAuthenticated = auth.ok;
      this.metrics.amazonAuthStatus = auth.state;
      this.metrics.amazonAuthLastStatusCode = auth.statusCode;

      if (auth.ok) {
        this.unauthorizedStreak = 0;
        this.transientAuthFailureStreak = 0;
        return true;
      }

      this.albumId = null;

      if (auth.state === "unauthorized") {
        this.metrics.amazonAuth401Count += 1;
        this.unauthorizedStreak += 1;
        this.transientAuthFailureStreak = 0;

        if (this.unauthorizedStreak === 2) {
          await this.notifications.sendAlert(
            "Amazon auth failed with 401 on consecutive checks. Update cookies in the Alexa Photos web UI (Cookies tab).",
            "error",
          );
        }
      } else {
        this.unauthorizedStreak = 0;

        if (auth.state === "rate_limited") {
          this.metrics.amazonRateLimit429Count += 1;
        } else if (auth.state === "bot_detection") {
          this.metrics.amazonBotDetection503Count += 1;
        } else if (auth.state === "network") {
          this.metrics.amazonNetworkErrorCount += 1;
        }

        if (auth.retriable) {
          this.transientAuthFailureStreak += 1;
          if (this.transientAuthFailureStreak === 3) {
            await this.notifications.sendAlert(
              "Amazon auth checks are failing with transient errors (e.g. 429/503/network). Possible bot/risk detection or connectivity issue; backing off and retrying.",
              "warning",
            );
          }
        } else {
          this.transientAuthFailureStreak = 0;
        }
      }

      return false;
    } catch (error) {
      const isCookiesMissing =
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT";

      if (isCookiesMissing) {
        logger.info(
          { path: config.amazonCookiesPath },
          "Amazon cookies are not configured yet",
        );
        this.lastAuthStatus = {
          ok: false,
          state: "not_configured",
          retriable: false,
          provider: "amazon",
          kind: "not_configured",
          actionable: true,
        };
        this.metrics.amazonAuthenticated = false;
        this.metrics.amazonAuthStatus = "not_configured";
        this.metrics.amazonAuthLastStatusCode = undefined;
        this.albumId = null;
        this.unauthorizedStreak = 0;
        this.transientAuthFailureStreak = 0;
        return false;
      }

      logger.warn({ error }, "Failed to refresh Amazon auth status");
      this.lastAuthStatus = {
        ok: false,
        state: "network",
        retriable: true,
        provider: "amazon",
        kind: "network",
        actionable: false,
      };
      this.metrics.amazonAuthenticated = false;
      this.metrics.amazonAuthStatus = "network";
      this.metrics.amazonNetworkErrorCount += 1;
      this.metrics.amazonAuthLastStatusCode = undefined;
      this.albumId = null;
      this.unauthorizedStreak = 0;
      this.transientAuthFailureStreak += 1;
      return false;
    }
  }

  private buildAuthFailureMessage(): string {
    const auth = this.lastAuthStatus;

    if (!auth || auth.state === "unauthorized") {
      return "Amazon Photos authentication failed (401 unauthorized) — update cookies in the Alexa Photos web UI (Cookies tab).";
    }

    if (auth.state === "bot_detection") {
      return "Amazon Photos authentication check failed (503 possible bot/risk detection) — keeping cookies as-is and retrying later.";
    }

    if (auth.state === "rate_limited") {
      return "Amazon Photos authentication check failed (429 rate-limited) — backing off and retrying later.";
    }

    if (auth.state === "network") {
      return "Amazon Photos authentication check failed (network error) — retrying later.";
    }

    if (auth.state === "not_configured") {
      return "Amazon Photos cookies are not configured yet — add cookies in the Alexa Photos web UI (Cookies tab).";
    }

    const suffix = auth.statusCode ? ` (status ${auth.statusCode})` : "";
    return `Amazon Photos authentication failed${suffix} — retrying later.`;
  }

  private async ensureAmazonClient(): Promise<void> {
    // 1. Create client if not pre-injected
    if (!this.amazon) {
      this.amazon = await AmazonClient.fromFile(
        config.amazonCookiesPath,
        config.amazonAutoRefreshCookies,
        (message, level) => this.notifications.sendAlert(message, level),
        this.notifications,
      );
      this.startRefreshIntervalIfNeeded();
    }

    // 2. Verify auth (once per authentication state reset)
    if (!this.metrics.amazonAuthenticated) {
      const ok = await this.refreshAmazonAuthStatus();
      if (!ok) {
        throw new Error(this.buildAuthFailureMessage());
      }
      logger.debug("Amazon Photos client authenticated");
      this.metrics.amazonAuthenticated = true;
    }

    // 3. Find or create album (lazy)
    if (!this.albumId) {
      this.albumId = await this.amazon.findOrCreateAlbum(
        config.amazonAlbumName,
      );
      logger.debug({ albumId: this.albumId }, "Using album");
    }
  }

  private async addPhoto(photo: ICloudPhoto): Promise<void> {
    logger.info({ photoId: photo.id }, "Adding photo");

    // Check if we already have a photo with this checksum (deduplication)
    const existing = this.state.getMappingByChecksum(photo.checksum);

    let amazonId: string;

    if (existing) {
      // Reuse existing Amazon node instead of uploading again
      logger.info(
        {
          photoId: photo.id,
          existingPhotoId: existing.icloudId,
          amazonId: existing.amazonId,
          checksum: photo.checksum,
        },
        "Reusing existing photo (checksum match)",
      );

      amazonId = existing.amazonId;

      // Ensure the existing node is in the album
      await this.amazon!.addToAlbumIfNotPresent(this.albumId!, [amazonId]);
    } else {
      // Download from iCloud with retry
      const buffer = await this.icloud.downloadPhoto(
        photo,
        config.icloudDownloadMaxRetries,
      );

      // Generate a descriptive filename
      const ext = "jpg"; // iCloud shared albums serve JPEG
      const filename = `${photo.id}.${ext}`;

      // Upload to Amazon and add to album
      amazonId = await this.amazon!.uploadPhotoToAlbum(
        buffer,
        filename,
        this.albumId!,
      );
    }

    // Save mapping (creates new mapping or updates existing iCloud ID)
    this.state.addMapping({
      icloudId: photo.id,
      icloudChecksum: photo.checksum,
      amazonId,
    });

    logger.info({ icloudId: photo.id, amazonId }, "Photo added successfully");
  }

  private async removePhotos(mappings: PhotoMapping[]): Promise<void> {
    const amazonIds = mappings.map((m) => m.amazonId);

    logger.info({ count: amazonIds.length }, "Removing photos");

    try {
      // Remove from album first, then delete the nodes
      if (this.albumId) {
        await this.amazon!.removeFromAlbum(this.albumId, amazonIds);
      }
      await this.amazon!.deleteNodes(amazonIds);

      // Remove all mappings
      for (const mapping of mappings) {
        this.state.removeMapping(mapping.icloudId);
      }

      logger.info({ count: amazonIds.length }, "Photos removed successfully");
    } catch (error) {
      logger.error(
        { count: amazonIds.length, error },
        "Failed to remove photos",
      );
    }
  }

  async close(): Promise<void> {
    if (this.amazon) {
      await this.amazon.close();
    }
  }
}
