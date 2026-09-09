import * as fs from "fs/promises";
import * as path from "path";
import { logger as rootLogger } from "../lib/logger.js";
import type { AlexaRegistrationResult } from "./registration-proxy.js";

const logger = rootLogger.child({ component: "amazon-auth" });

/**
 * Persistence for device-registration credentials.
 *
 * Split across two files on purpose. Cookie rotation writes on any request
 * whose response rotates a tracked cookie, potentially many times per sync. If
 * the refresh token shared that file, an interrupted write could destroy the
 * one artifact that needs a human with a browser to recreate.
 *
 *   amazon-auth.json     durable. Registration blob and marketplace. Mode 0600.
 *   amazon-session.json  volatile. Current cookie map and timestamps.
 */

export const AUTH_FILE_VERSION = 1;

export interface AmazonMarketplaceRecord {
  /** e.g. "amazon.com" */
  amazonPage: string;
  /** e.g. "com". Drives the Drive API host and the upload region. */
  tld: string;
  acceptLanguage: string;
  proxyLanguage: string;
  deviceAppName: string;
}

export interface AmazonAuthRecord {
  version: number;
  registeredAt: string;
  marketplace: AmazonMarketplaceRecord;
  /**
   * The library's result, stored whole. It carries device-context fields
   * (frc, map-md, deviceId) that must be replayed verbatim on every refresh,
   * or Amazon registers a new device each time.
   */
  registration: AlexaRegistrationResult;
}

export interface AmazonSessionRecord {
  version: number;
  cookiesUpdatedAt: string;
  lastRefreshAt: string | null;
  cookies: Record<string, string>;
}

/** Derive the marketplace TLD, e.g. "amazon.co.uk" -> "co.uk". */
export function tldFromAmazonPage(amazonPage: string): string {
  return amazonPage.replace(/^(www\.)?amazon\./i, "");
}

/** The session file sits beside the auth file, whatever the auth path is. */
export function sessionPathFor(authPath: string): string {
  const dir = path.dirname(authPath);
  const base = path.basename(authPath).replace(/\.json$/i, "");
  return path.join(dir, `${base.replace(/-auth$/, "")}-session.json`);
}

/** Parse a raw `Cookie:` header string into a map. */
export function parseCookieHeader(
  raw: string | undefined,
): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!raw) return cookies;
  for (const pair of raw.split(";")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key) cookies[key] = value;
  }
  return cookies;
}

/**
 * Write through a temp file in the same directory, then rename.
 *
 * Rename is atomic on the same filesystem, so a partial write is never
 * observable and an interrupted write cannot destroy the refresh token.
 */
async function writeAtomic(
  filePath: string,
  data: unknown,
  mode: number,
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode });
  try {
    await fs.rename(tmp, filePath);
  } catch (error) {
    await fs.unlink(tmp).catch(() => undefined);
    throw error;
  }
  await fs.chmod(filePath, mode).catch(() => undefined);
}

/**
 * Read the durable auth record.
 *
 * A missing file throws the raw error with `code === "ENOENT"` intact.
 * Callers in index.ts and the sync engine test that property to decide the
 * service is merely unconfigured rather than broken. Wrapping the error in a
 * custom class or a schema parse would lose `code` and turn a first run into
 * a crash loop.
 */
export async function readAmazonAuth(
  authPath: string,
): Promise<AmazonAuthRecord> {
  const raw = await fs.readFile(authPath, "utf-8");
  const parsed = JSON.parse(raw) as AmazonAuthRecord;

  if (!parsed?.registration?.refreshToken) {
    throw new Error(
      `Amazon auth file at ${authPath} has no refresh token; re-register the device`,
    );
  }
  return parsed;
}

export async function writeAmazonAuth(
  authPath: string,
  record: AmazonAuthRecord,
): Promise<void> {
  await writeAtomic(authPath, record, 0o600);
  logger.debug({ path: authPath }, "Amazon auth record written");
}

/** Build a durable record from a fresh registration result. */
export function buildAuthRecord(
  registration: AlexaRegistrationResult,
  fallback: Omit<AmazonMarketplaceRecord, "tld" | "amazonPage"> & {
    amazonPage: string;
  },
): AmazonAuthRecord {
  const amazonPage = registration.amazonPage || fallback.amazonPage;
  return {
    version: AUTH_FILE_VERSION,
    registeredAt: new Date().toISOString(),
    marketplace: {
      amazonPage,
      tld: tldFromAmazonPage(amazonPage),
      acceptLanguage: fallback.acceptLanguage,
      proxyLanguage: fallback.proxyLanguage,
      deviceAppName: registration.deviceAppName || fallback.deviceAppName,
    },
    registration,
  };
}

/**
 * Read the volatile session record.
 *
 * A missing session file is NOT "not configured". It means cookies have never
 * been minted, or were cleared, and the client should mint them. Returns null
 * rather than throwing so that state never reaches the ENOENT branches above.
 */
export async function readAmazonSession(
  authPath: string,
): Promise<AmazonSessionRecord | null> {
  const sessionPath = sessionPathFor(authPath);
  try {
    const raw = await fs.readFile(sessionPath, "utf-8");
    const parsed = JSON.parse(raw) as AmazonSessionRecord;
    if (!parsed?.cookies || typeof parsed.cookies !== "object") return null;
    return parsed;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      logger.warn(
        { error, path: sessionPath },
        "Amazon session file unreadable; treating as empty and re-minting cookies",
      );
    }
    return null;
  }
}

export async function writeAmazonSession(
  authPath: string,
  record: AmazonSessionRecord,
): Promise<void> {
  await writeAtomic(sessionPathFor(authPath), record, 0o600);
}

/** Age of the stored cookies in days, or null when there are none. */
export function cookieAgeDays(
  session: AmazonSessionRecord | null,
): number | null {
  if (!session?.cookiesUpdatedAt) return null;
  const updated = Date.parse(session.cookiesUpdatedAt);
  if (Number.isNaN(updated)) return null;
  return (Date.now() - updated) / (24 * 60 * 60 * 1000);
}

/** Remove both files. Used by "remove registration" in the admin UI. */
export async function clearAmazonCredentials(authPath: string): Promise<void> {
  for (const target of [authPath, sessionPathFor(authPath)]) {
    await fs.unlink(target).catch((error: NodeJS.ErrnoException) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  logger.info("Amazon credentials cleared");
}
