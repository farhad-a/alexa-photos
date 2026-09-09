import { AmazonClient } from "../../amazon/client.js";
import {
  getAmazonAuthSummary,
  type AmazonAuthSummary,
} from "../../amazon/registration.js";

/**
 * Server-side helpers for the Amazon account page.
 *
 * Mirrors the shape of the cookie service it replaces so the controller layer
 * stays thin.
 */

export interface AmazonAuthTestResult {
  authenticated: boolean;
  state: string;
  statusCode?: number;
  actionable: boolean;
  error?: string;
}

export async function readAmazonStatus(
  authPath: string,
): Promise<AmazonAuthSummary> {
  return getAmazonAuthSummary(authPath);
}

/**
 * Check the stored credentials against Amazon.
 *
 * Constructed with auto-refresh off so a probe never mints cookies as a side
 * effect; the caller asked whether the current ones work.
 */
export async function testAmazonAuth(
  authPath: string,
): Promise<AmazonAuthTestResult> {
  try {
    const client = await AmazonClient.fromCredentials(authPath, {
      autoRefresh: false,
    });
    const status = await client.checkAuthStatus();
    await client.close();

    return {
      authenticated: status.ok,
      state: status.state,
      statusCode: status.statusCode,
      actionable: status.actionable,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return {
        authenticated: false,
        state: "not_configured",
        actionable: true,
        error: "No device is registered",
      };
    }
    return {
      authenticated: false,
      state: "unknown",
      actionable: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Force a refresh now, bypassing the age gate. */
export async function refreshAmazonCookies(
  authPath: string,
): Promise<{ refreshed: boolean; cookiesUpdatedAt?: string | null }> {
  const client = await AmazonClient.fromCredentials(authPath, {
    autoRefresh: true,
  });
  const refreshed = await client.refreshNow({ force: true });
  await client.close();

  const summary = await getAmazonAuthSummary(authPath);
  return { refreshed, cookiesUpdatedAt: summary.cookiesUpdatedAt };
}
