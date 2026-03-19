import { ICloudClient } from "./client.js";

export type IcloudStartupErrorKind = "invalid_token" | "transient";

export interface IcloudStartupValidationResult {
  validated: boolean;
  transient: boolean;
  details?: string;
}

function extractHttpStatus(message: string): number | undefined {
  const m = message.match(/:\s*(\d{3})\b/);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

function classifyIcloudStartupError(error: unknown): IcloudStartupErrorKind {
  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase();
  const status = extractHttpStatus(message);

  if (status !== undefined) {
    if (status === 429 || status === 408 || status >= 500) {
      return "transient";
    }

    // Only treat high-confidence auth/config statuses as invalid token.
    // Note: 404 can be transient when partition discovery falls back.
    if (status === 401 || status === 403) {
      return "invalid_token";
    }

    if (status >= 400 && status < 500) {
      return "transient";
    }
  }

  const transientNeedles = [
    "fetch failed",
    "network",
    "enotfound",
    "econnreset",
    "econnrefused",
    "etimedout",
    "timeout",
    "dns",
    "tls",
    "socket",
  ];

  if (transientNeedles.some((needle) => message.includes(needle))) {
    return "transient";
  }

  // Safe default: avoid crash loops on uncertain startup failures.
  return "transient";
}

export async function validateIcloudStartupAccess(
  icloud: Pick<ICloudClient, "getPhotos">,
): Promise<IcloudStartupValidationResult> {
  try {
    await icloud.getPhotos();
    return { validated: true, transient: false };
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    const kind = classifyIcloudStartupError(error);

    if (kind === "invalid_token") {
      throw new Error(
        `ICLOUD_ALBUM_TOKEN validation failed. Verify ICLOUD_ALBUM_TOKEN points to a valid public shared album and restart. (${details})`,
        { cause: error },
      );
    }

    return {
      validated: false,
      transient: true,
      details,
    };
  }
}

export const _test = {
  extractHttpStatus,
  classifyIcloudStartupError,
};
