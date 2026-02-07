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
        "Sync analysis complete"
      );

      // Initialize Amazon client only if we have work to do
      if (toAdd.length > 0 || toRemove.length > 0) {
        await this.ensureAmazonClient();
      }

      // Process additions
      for (const photo of toAdd) {
        await this.addPhoto(photo);
      }

      // Process removals
      for (const mapping of toRemove) {
        await this.removePhoto(mapping);
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
      this.amazon = new AmazonClient();
      await this.amazon.init();
    }
  }

  private async addPhoto(photo: ICloudPhoto): Promise<void> {
    logger.info({ photoId: photo.id }, "Adding photo");

    try {
      // Download from iCloud
      const buffer = await this.icloud.downloadPhoto(photo);

      // Generate filename
      const filename = `${photo.id}.jpg`;

      // Upload to Amazon
      const amazonId = await this.amazon!.uploadPhoto(
        buffer,
        filename,
        config.amazonAlbumName
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

  private async removePhoto(mapping: PhotoMapping): Promise<void> {
    logger.info({ icloudId: mapping.icloudId }, "Removing photo");

    try {
      // Delete from Amazon
      await this.amazon!.deletePhoto(mapping.amazonId);

      // Remove mapping
      this.state.removeMapping(mapping.icloudId);

      logger.info(
        { icloudId: mapping.icloudId, amazonId: mapping.amazonId },
        "Photo removed successfully"
      );
    } catch (error) {
      logger.error(
        { icloudId: mapping.icloudId, error },
        "Failed to remove photo"
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
