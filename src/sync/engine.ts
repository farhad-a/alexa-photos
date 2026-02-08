import { ICloudClient, ICloudPhoto } from "../icloud/client.js";
import { AmazonClient } from "../amazon/client.js";
import { StateStore, PhotoMapping } from "../state/store.js";
import { config } from "../lib/config.js";
import { logger } from "../lib/logger.js";

export class SyncEngine {
  private icloud: ICloudClient;
  private amazon: AmazonClient | null = null;
  private state: StateStore;
  private isRunning = false;
  private albumId: string | null = null;

  constructor(icloud: ICloudClient) {
    this.icloud = icloud;
    this.state = new StateStore();
  }

  async run(): Promise<void> {
    if (this.isRunning) {
      logger.warn("Sync already in progress, skipping");
      return;
    }

    this.isRunning = true;

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
      for (const photo of toAdd) {
        await this.addPhoto(photo);
      }

      // Process removals (if enabled)
      if (toRemove.length > 0) {
        if (config.syncDeletions) {
          await this.removePhotos(toRemove);
        } else {
          logger.info(
            { count: toRemove.length },
            "Skipping deletions (SYNC_DELETIONS=false)",
          );
        }
      }

      logger.info("Sync complete");
    } catch (error) {
      logger.error({ error }, "Sync failed");
      throw error;
    } finally {
      this.isRunning = false;
    }
  }

  private async ensureAmazonClient(): Promise<void> {
    if (!this.amazon) {
      this.amazon = await AmazonClient.fromFile(config.amazonCookiesPath);

      // Verify auth on first use
      const ok = await this.amazon.checkAuth();
      if (!ok) {
        throw new Error(
          "Amazon Photos authentication failed — run `npm run amazon:setup` to update cookies",
        );
      }
      logger.debug("Amazon Photos client authenticated");
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

    try {
      // Download from iCloud with retry
      const buffer = await this.icloud.downloadPhoto(
        photo,
        config.icloudDownloadMaxRetries,
      );

      // Generate a descriptive filename
      const ext = "jpg"; // iCloud shared albums serve JPEG
      const filename = `${photo.id}.${ext}`;

      // Upload to Amazon and add to album
      const amazonId = await this.amazon!.uploadPhotoToAlbum(
        buffer,
        filename,
        this.albumId!,
      );

      // Save mapping
      this.state.addMapping({
        icloudId: photo.id,
        icloudChecksum: photo.checksum,
        amazonId,
      });

      logger.info({ icloudId: photo.id, amazonId }, "Photo added successfully");
    } catch (error) {
      logger.error({ photoId: photo.id, error }, "Failed to add photo");
    }
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
