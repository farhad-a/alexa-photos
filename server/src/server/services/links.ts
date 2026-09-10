import { logger as rootLogger } from "../../lib/logger.js";
import { AmazonClient } from "../../amazon/client.js";
import { readAmazonStatus } from "./amazon.js";

/**
 * Server-side helpers for the sidebar's external links.
 *
 * The browser knows neither the iCloud album token nor the Amazon album node
 * id, so both URLs have to be assembled here.
 */

/** The album token is the fragment of the shared-album URL. */
const ICLOUD_ALBUM_URL = (token: string) =>
  `https://www.icloud.com/sharedalbum/#${token}`;

// Kept as single templates: the deep-link shape is not documented by Amazon, so
// if it turns out wrong this is the one line to change.
const AMAZON_ALBUM_URL = (marketplace: string, nodeId: string) =>
  `https://www.${marketplace}/photos/album/${nodeId}`;
const AMAZON_ALBUMS_URL = (marketplace: string) =>
  `https://www.${marketplace}/photos/albums`;

const logger = rootLogger.child({ component: "server" });

export interface LinkSettings {
  githubUrl: string;
  icloudAlbumToken: string;
  amazonAlbumName: string;
  /** Fallback for when no registration record exists yet. */
  amazonMarketplace: string;
}

export interface AppLinks {
  githubUrl: string;
  icloudAlbumUrl: string;
  amazonAlbumUrl: string;
  amazonAlbumName: string;
}

// The node id is never persisted (see SyncEngine.albumId, which is resolved
// lazily and only when a sync has work to do), so resolve it once per process
// and hold it here. A miss is not an error — the caller falls back to the
// albums list.
let cachedAlbumId: string | null = null;

/** Drop the cached node id. Called when the credentials change. */
export function resetAppLinksCache(): void {
  cachedAlbumId = null;
}

/**
 * Look up the album's node id.
 *
 * Returns null rather than throwing for every failure mode — no registration,
 * expired cookies, bot detection, album not yet created. The sidebar must
 * render regardless.
 */
async function resolveAlbumId(
  authPath: string,
  albumName: string,
): Promise<string | null> {
  if (cachedAlbumId) return cachedAlbumId;

  try {
    // autoRefresh off for the same reason testAmazonAuth() turns it off:
    // rendering the sidebar must not mint cookies as a side effect.
    const client = await AmazonClient.fromCredentials(authPath, {
      autoRefresh: false,
    });
    try {
      // findAlbum, not findOrCreateAlbum — viewing a link must never create one.
      const album = await client.findAlbum(albumName);
      cachedAlbumId = album?.id ?? null;
      return cachedAlbumId;
    } finally {
      await client.close();
    }
  } catch (error) {
    logger.debug({ error, albumName }, "Could not resolve Amazon album id");
    return null;
  }
}

export async function buildAppLinks(
  settings: LinkSettings,
  authPath: string,
): Promise<AppLinks> {
  // The marketplace comes from the registration record; config is only the
  // fallback, since a registration made against another site wins over it.
  let marketplace = settings.amazonMarketplace;
  try {
    const summary = await readAmazonStatus(authPath);
    marketplace = summary.marketplace ?? marketplace;
  } catch (error) {
    logger.debug({ error }, "Could not read marketplace for links");
  }

  const albumId = await resolveAlbumId(authPath, settings.amazonAlbumName);

  return {
    githubUrl: settings.githubUrl,
    icloudAlbumUrl: ICLOUD_ALBUM_URL(settings.icloudAlbumToken),
    amazonAlbumUrl: albumId
      ? AMAZON_ALBUM_URL(marketplace, albumId)
      : AMAZON_ALBUMS_URL(marketplace),
    amazonAlbumName: settings.amazonAlbumName,
  };
}
