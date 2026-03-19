import { ICloudClient } from "./client.js";
import { classifyIcloudProviderError } from "../lib/provider-errors.js";

export type IcloudStartupErrorKind = "invalid_token" | "transient";

export interface IcloudStartupValidationResult {
  validated: boolean;
  transient: boolean;
  details?: string;
}

function classifyIcloudStartupError(error: unknown): IcloudStartupErrorKind {
  const normalized = classifyIcloudProviderError(error);
  return normalized.kind === "invalid_token" ? "invalid_token" : "transient";
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
  classifyIcloudStartupError,
};
