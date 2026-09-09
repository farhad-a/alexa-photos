import { ServerResponse } from "http";
import { logger as rootLogger } from "../../lib/logger.js";
import {
  beginRegistration,
  cancelRegistration,
  getRegistrationStatus,
  removeRegistration,
} from "../../amazon/registration.js";
import { sendJson } from "../http.js";
import {
  readAmazonStatus,
  refreshAmazonCookies,
  testAmazonAuth,
} from "../services/amazon.js";
import { AppRequestContext } from "../types.js";

const logger = rootLogger.child({ component: "server" });

/** Current registration and credential state. Never 404s. */
export async function handleAmazonStatus(
  context: AppRequestContext,
  res: ServerResponse,
): Promise<void> {
  try {
    sendJson(res, 200, await readAmazonStatus(context.amazonAuthPath));
  } catch (error) {
    logger.error({ error }, "Failed to read Amazon auth status");
    sendJson(res, 500, { error: "Failed to read Amazon auth status" });
  }
}

export function handleStartRegistration(
  context: AppRequestContext,
  res: ServerResponse,
): void {
  if (!context.registrationSettings) {
    sendJson(res, 503, { error: "Registration is not configured" });
    return;
  }

  try {
    const status = beginRegistration(context.registrationSettings);
    logger.info({ proxyUrl: status.proxyUrl }, "Amazon registration started");
    sendJson(res, 200, status);
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (code === "REGISTRATION_IN_PROGRESS") {
      sendJson(res, 409, {
        error: "A registration is already in progress",
        ...getRegistrationStatus(),
      });
      return;
    }

    // The usual cause is an unresolvable proxy address, which the user fixes
    // by setting AMAZON_PROXY_OWN_IP.
    logger.error({ error }, "Could not start Amazon registration");
    sendJson(res, 400, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function handleRegistrationStatus(res: ServerResponse): void {
  sendJson(res, 200, getRegistrationStatus());
}

export async function handleCancelRegistration(
  res: ServerResponse,
): Promise<void> {
  await cancelRegistration();
  sendJson(res, 200, getRegistrationStatus());
}

export async function handleRemoveRegistration(
  context: AppRequestContext,
  res: ServerResponse,
): Promise<void> {
  try {
    await removeRegistration(context.amazonAuthPath);
    sendJson(res, 200, { removed: true });
  } catch (error) {
    logger.error({ error }, "Failed to remove Amazon registration");
    sendJson(res, 500, { error: "Failed to remove registration" });
  }
}

export async function handleTestAmazonAuth(
  context: AppRequestContext,
  res: ServerResponse,
): Promise<void> {
  const result = await testAmazonAuth(context.amazonAuthPath);
  context.onAmazonAuthChecked?.(result.authenticated);
  sendJson(res, 200, result);
}

export async function handleRefreshAmazonCookies(
  context: AppRequestContext,
  res: ServerResponse,
): Promise<void> {
  try {
    const result = await refreshAmazonCookies(context.amazonAuthPath);
    context.onAmazonAuthChecked?.(result.refreshed);
    sendJson(res, 200, result);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      sendJson(res, 409, { error: "No device is registered" });
      return;
    }
    logger.error({ error }, "Forced Amazon refresh failed");
    sendJson(res, 500, { error: "Refresh failed" });
  }
}
