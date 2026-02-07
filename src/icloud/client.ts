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
    })
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

  constructor(albumToken: string) {
    // iCloud shared album API endpoint
    this.baseUrl = `https://p${this.getPartition(albumToken)}-sharedstreams.icloud.com/${albumToken}/sharedstreams`;
  }

  private getPartition(token: string): string {
    // Apple partitions shared albums across servers based on token
    // This is a simplified version - may need adjustment
    const firstChar = token.charAt(0).toUpperCase();
    if (firstChar >= "A" && firstChar <= "M") return "01";
    return "02";
  }

  async getPhotos(): Promise<ICloudPhoto[]> {
    logger.debug("Fetching photos from iCloud shared album");

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
        null
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
        dateCreated: new Date(parseInt(photo.dateCreated)),
      };
    });

    logger.info({ count: photos.length }, "Fetched photos from iCloud");
    return photos.filter((p) => p.url); // Only return photos with valid URLs
  }

  async downloadPhoto(photo: ICloudPhoto): Promise<Buffer> {
    logger.debug({ photoId: photo.id }, "Downloading photo");

    const response = await fetch(photo.url);
    if (!response.ok) {
      throw new Error(`Failed to download photo: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}
