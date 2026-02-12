import { ICloudClient, ICloudPhoto } from "../icloud/client.js";
import { AmazonClient } from "../amazon/client.js";
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
  amazonAuthenticated: boolean;
}

export class SyncEngine {
  private icloud: ICloudClient;
  private amazon: AmazonClient | null = null;
  private state: StateStore;
  private isRunning = false;
  private albumId: string | null = null;
  private notifications: NotificationService;
  private metrics: SyncMetrics = {
    totalSyncs: 0,
    totalErrors: 0,
    amazonAuthenticated: false,
  };

  constructor(icloud: ICloudClient) {
    this.icloud = icloud;
    this.state = new StateStore();
    this.notifications = new NotificationService(config);
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

      // Initialize Amazon client only if we have work to do
      const needsAmazon =
        toAdd.length > 0 || (toRemove.length > 0 && config.syncDeletions);
      if (needsAmazon) {
        await this.ensureAmazonClient();
      }

      // Process additions
      let photosFailed = 0;
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

      throw error;
    } finally {
      this.isRunning = false;
    }
  }

  private async ensureAmazonClient(): Promise<void> {
    if (!this.amazon) {
      this.amazon = await AmazonClient.fromFile(
        config.amazonCookiesPath,
        config.amazonAutoRefreshCookies,
        (message, level) => this.notifications.sendAlert(message, level),
        this.notifications,
      );

      // Verify auth on first use
      const ok = await this.amazon.checkAuth();
      if (!ok) {
        throw new Error(
          "Amazon Photos authentication failed — run `npm run amazon:setup` to update cookies",
        );
      }
      logger.debug("Amazon Photos client authenticated");
      this.metrics.amazonAuthenticated = true;
    }

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
    this.state.close();
  }
}
