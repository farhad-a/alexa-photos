import { z } from "zod";
import { logger } from "../lib/logger.js";

// iCloud shared album API response schema
const photoAssetSchema = z.object({
  photoGuid: z.string(),
  derivatives: z.record(
    z.object({
      checksum: z.string(),
      fileSize: z.number(),
      width: z.number(),
      height: z.number(),
    }),
  ),
  caption: z.string().optional(),
  dateCreated: z.string(),
});

const albumResponseSchema = z.object({
  photos: z.array(photoAssetSchema),
});

export interface ICloudPhoto {
  id: string;
  checksum: string;
  url: string;
  width: number;
  height: number;
  caption?: string;
  dateCreated: Date;
}

export class ICloudClient {
  private baseUrl: string;
  private albumToken: string;

  constructor(albumToken: string) {
    this.albumToken = albumToken;
    // Initial base URL - will be updated after partition discovery
    this.baseUrl = `https://p01-sharedstreams.icloud.com/${albumToken}/sharedstreams`;
  }

  private async discoverPartition(): Promise<void> {
    // Apple returns 330 with X-Apple-MMe-Host header indicating correct partition
    const res = await fetch(`${this.baseUrl}/webstream`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ streamCtag: null }),
      redirect: "manual",
    });

    if (res.status === 330) {
      const host = res.headers.get("X-Apple-MMe-Host");
      if (host) {
        this.baseUrl = `https://${host}/${this.albumToken}/sharedstreams`;
        logger.debug({ host }, "Discovered iCloud partition");
      }
    }
  }

  async getPhotos(): Promise<ICloudPhoto[]> {
    logger.debug("Fetching photos from iCloud shared album");

    // Discover correct partition first
    await this.discoverPartition();

    // First, get the webstream metadata
    const webstreamRes = await fetch(`${this.baseUrl}/webstream`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ streamCtag: null }),
    });

    if (!webstreamRes.ok) {
      throw new Error(`Failed to fetch webstream: ${webstreamRes.status}`);
    }

    const webstream = await webstreamRes.json();
    const photoGuids = webstream.photos?.map((p: any) => p.photoGuid) || [];

    if (photoGuids.length === 0) {
      logger.info("No photos found in album");
      return [];
    }

    // Get asset URLs
    const assetsRes = await fetch(`${this.baseUrl}/webasseturls`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ photoGuids }),
    });

    if (!assetsRes.ok) {
      throw new Error(`Failed to fetch asset URLs: ${assetsRes.status}`);
    }

    const assetsData = await assetsRes.json();
    const items = assetsData.items || {};

    // Map photos with their download URLs
    const photos: ICloudPhoto[] = webstream.photos.map((photo: any) => {
      // Find the best quality derivative
      const derivatives = Object.entries(photo.derivatives || {});
      const best = derivatives.reduce(
        (prev: any, [key, val]: [string, any]) => {
          if (!prev || val.width > prev[1].width) return [key, val];
          return prev;
        },
        null,
      );

      const [derivativeKey, derivative] = best || [null, null];
      const assetUrl = items[derivative?.checksum]?.url_location;
      const urlPath = items[derivative?.checksum]?.url_path;

      return {
        id: photo.photoGuid,
        checksum: derivative?.checksum || "",
        url: assetUrl && urlPath ? `https://${assetUrl}${urlPath}` : "",
        width: derivative?.width || 0,
        height: derivative?.height || 0,
        caption: photo.caption,
        dateCreated: this.parseAppleDate(photo.dateCreated),
      };
    });

    logger.info({ count: photos.length }, "Fetched photos from iCloud");
    return photos.filter((p) => p.url); // Only return photos with valid URLs
  }

  /**
   * Parse date from iCloud API - can be ISO string or Apple timestamp
   */
  private parseAppleDate(dateValue: string | number): Date {
    if (typeof dateValue === "string") {
      // ISO date string like "2017-06-18T21:02:44Z"
      const parsed = new Date(dateValue);
      if (!isNaN(parsed.getTime())) {
        return parsed;
      }
    }
    // Fallback: Apple epoch (seconds since 2001-01-01)
    const ts =
      typeof dateValue === "string" ? parseFloat(dateValue) : dateValue;
    const appleEpochOffset = 978307200;
    return new Date((ts + appleEpochOffset) * 1000);
  }

  async downloadPhoto(
    photo: ICloudPhoto,
    maxRetries = 3,
  ): Promise<Buffer> {
    logger.debug({ photoId: photo.id }, "Downloading photo");

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(photo.url);
        if (!response.ok) {
          throw new Error(
            `HTTP ${response.status}: ${response.statusText}`,
          );
        }

        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
      } catch (error) {
        const isLastAttempt = attempt === maxRetries;

        if (isLastAttempt) {
          logger.error(
            { photoId: photo.id, attempt: attempt + 1, error },
            "Failed to download photo after all retries",
          );
          throw new Error(
            `Failed to download photo after ${maxRetries + 1} attempts: ${error}`,
          );
        }

        // Exponential backoff with jitter: 1s, 2s, 4s (capped at 10s)
        const delay = Math.min(
          Math.random() * 2 ** attempt * 1000,
          10_000,
        );
        logger.warn(
          {
            photoId: photo.id,
            attempt: attempt + 1,
            delay: Math.round(delay),
            error: String(error),
          },
          "Download failed, retrying",
        );

        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    // TypeScript needs this, but we'll never reach here
    throw new Error("Unreachable");
  }
}
