/**
 * Test script to validate iCloud shared album fetching
 * Run with: npm run icloud:test
 */

import "dotenv/config";
import { ICloudClient } from "./client.js";

const albumToken = process.env.ICLOUD_ALBUM_TOKEN;

if (!albumToken) {
  console.error("Set ICLOUD_ALBUM_TOKEN environment variable");
  console.error("Example: ICLOUD_ALBUM_TOKEN=ABC123 npm run icloud:test");
  process.exit(1);
}

async function main() {
  console.log("Testing iCloud shared album fetch...\n");

  const client = new ICloudClient(albumToken!);

  try {
    const photos = await client.getPhotos();

    console.log(`Found ${photos.length} photos:\n`);

    for (const photo of photos.slice(0, 5)) {
      console.log(`  ID: ${photo.id}`);
      console.log(`  Size: ${photo.width}x${photo.height}`);
      console.log(`  Date: ${photo.dateCreated.toISOString()}`);
      console.log(`  URL: ${photo.url.substring(0, 60)}...`);
      console.log("");
    }

    if (photos.length > 5) {
      console.log(`  ... and ${photos.length - 5} more`);
    }

    // Test downloading first photo
    if (photos.length > 0) {
      console.log("\nTesting download of first photo...");
      const buffer = await client.downloadPhoto(photos[0]);
      console.log(`Downloaded ${buffer.length} bytes`);
    }

    console.log("\n✓ iCloud fetch working!");
  } catch (error) {
    console.error("Failed to fetch photos:", error);
    process.exit(1);
  }
}

main();
