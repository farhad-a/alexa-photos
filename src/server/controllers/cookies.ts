import { IncomingMessage, ServerResponse } from "http";
import { z } from "zod";
import { logger as rootLogger } from "../../lib/logger.js";
import { readBody, sendJson } from "../http.js";
import {
  buildCookieResponse,
  readCookiesFile,
  readCookiesFileUpdatedAt,
  resolveCookies,
  saveCookiesFile,
  testCookiesFile,
} from "../services/cookies.js";
import { AppRequestContext } from "../types.js";

const logger = rootLogger.child({ component: "server" });

const saveCookiesSchema = z
  .object({
    cookieString: z.string().optional(),
    cookies: z.record(z.string(), z.string()).optional(),
  })
  .refine((value) => value.cookieString || value.cookies, {
    message: 'Provide either "cookieString" or "cookies" in the body',
  });

export async function handleGetCookies(
  context: AppRequestContext,
  res: ServerResponse,
): Promise<void> {
  try {
    const cookies = await readCookiesFile(context.cookiesPath);
    const updatedAt = await readCookiesFileUpdatedAt(context.cookiesPath);
    sendJson(res, 200, buildCookieResponse(cookies, { updatedAt }));
  } catch (err) {
    const isNotFound =
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT";
    if (isNotFound) {
      sendJson(res, 200, {
        exists: false,
        updatedAt: null,
        cookies: {},
        tld: null,
        region: null,
        presentKeys: [],
        trackedPresentCount: 0,
        trackedExpectedCount: 0,
        missingKeys: [],
      });
      return;
    }

    logger.error({ error: err }, "Failed to read cookies file");
    sendJson(res, 500, { error: "Failed to read cookies" });
  }
}

export async function handleSaveCookies(
  context: AppRequestContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readBody(req);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(body);
  } catch {
    sendJson(res, 400, { error: "Invalid JSON" });
    return;
  }

  const parsed = saveCookiesSchema.safeParse(parsedJson);
  if (!parsed.success) {
    sendJson(res, 400, {
      error: 'Provide either "cookieString" or "cookies" in the body',
    });
    return;
  }

  const resolved = resolveCookies(parsed.data);
  if (resolved.error) {
    sendJson(res, 400, resolved.error);
    return;
  }

  await saveCookiesFile(context.cookiesPath, resolved.cookies!);
  logger.info("Cookies saved via UI");

  try {
    await context.onCookiesSaved?.();
  } catch (error) {
    logger.warn({ error }, "Failed to process post-save cookie hook");
  }

  sendJson(res, 200, {
    saved: true,
    ...buildCookieResponse(resolved.cookies!, {
      updatedAt: new Date().toISOString(),
    }),
  });
}

export async function handleTestCookies(
  context: AppRequestContext,
  res: ServerResponse,
): Promise<void> {
  try {
    const result = await testCookiesFile(context.cookiesPath);
    context.onAmazonAuthChecked?.(result.authenticated);
    sendJson(res, 200, result);
  } catch (err) {
    const isNotFound =
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT";
    context.onAmazonAuthChecked?.(false);
    if (isNotFound) {
      sendJson(res, 200, {
        authenticated: false,
        error: "No cookies file found",
      });
      return;
    }

    logger.error({ error: err }, "Cookie test failed");
    sendJson(res, 200, {
      authenticated: false,
      error: err instanceof Error ? err.message : "Unknown error",
    });
  }
}
