import * as fs from "fs/promises";
import { AmazonClient } from "./client.js";
import { isTrackedAuthCookieName } from "./cookies.js";

function getCookiesPath(): string {
  return process.env.AMAZON_COOKIES_PATH || "./data/amazon-cookies.json";
}

async function readTrackedCookies(
  cookiesPath: string,
): Promise<Record<string, string>> {
  const raw = await fs.readFile(cookiesPath, "utf-8");
  const cookies = JSON.parse(raw) as Record<string, string>;
  return Object.fromEntries(
    Object.entries(cookies).filter(([key]) => isTrackedAuthCookieName(key)),
  );
}

function diffTrackedCookieKeys(
  before: Record<string, string>,
  after: Record<string, string>,
): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys]
    .filter((key) => before[key] !== after[key])
    .sort((a, b) => a.localeCompare(b));
}

async function main(): Promise<void> {
  const cookiesPath = getCookiesPath();
  const beforeStat = await fs.stat(cookiesPath);
  const beforeCookies = await readTrackedCookies(cookiesPath);

  const client = await AmazonClient.fromFile(cookiesPath, true);
  const auth = await client.checkAuthStatus();

  let exercisedRequest = false;
  let requestError: string | undefined;

  if (auth.ok) {
    try {
      await client.getRoot();
      exercisedRequest = true;
    } catch (error) {
      requestError = error instanceof Error ? error.message : String(error);
    }
  }

  const afterStat = await fs.stat(cookiesPath);
  const afterCookies = await readTrackedCookies(cookiesPath);
  const changedTrackedKeys = diffTrackedCookieKeys(beforeCookies, afterCookies);
  const updated = afterStat.mtimeMs !== beforeStat.mtimeMs;

  const summary = {
    cookiesPath,
    authState: auth.state,
    authOk: auth.ok,
    authStatusCode: auth.statusCode ?? null,
    exercisedRequest,
    requestError: requestError ?? null,
    cookiesFileUpdated: updated,
    changedTrackedKeys,
    beforeUpdatedAt: beforeStat.mtime.toISOString(),
    afterUpdatedAt: afterStat.mtime.toISOString(),
  };

  console.log(JSON.stringify(summary, null, 2));

  if (!auth.ok || requestError) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        error: error instanceof Error ? error.message : String(error),
        cookiesPath: getCookiesPath(),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
});
