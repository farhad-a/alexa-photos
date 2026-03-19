import * as fs from "fs/promises";
import * as path from "path";
import { AmazonClient, AmazonCookies } from "../../amazon/client.js";
import {
  detectTld,
  extractRequiredCookies,
  parseCookieString,
} from "../../amazon/login.js";

export function buildCookieResponse(cookies: Record<string, string>) {
  const tld = detectTld(cookies);
  const masked: Record<string, string> = {};
  for (const [key, value] of Object.entries(cookies)) {
    masked[key] =
      value.length > 8 ? value.slice(0, 4) + "…" + value.slice(-4) : "••••";
  }
  const presentKeys = Object.keys(cookies);
  const usRequired = ["session-id", "ubid-main", "at-main"];
  const usOptional = ["x-main", "sess-at-main", "sst-main"];
  const allExpected =
    tld === "com"
      ? [...usRequired, ...usOptional]
      : ["session-id", `ubid-acb${tld}`, `at-acb${tld}`];

  return {
    exists: true,
    cookies: masked,
    tld,
    region: tld === "com" ? "US" : tld ? `amazon.${tld}` : null,
    presentKeys,
    missingKeys: allExpected.filter((key) => !cookies[key]),
  };
}

export async function readCookiesFile(cookiesPath: string) {
  const raw = await fs.readFile(cookiesPath, "utf-8");
  return JSON.parse(raw) as Record<string, string>;
}

export async function saveCookiesFile(
  cookiesPath: string,
  cookies: Record<string, string>,
): Promise<void> {
  await fs.mkdir(path.dirname(cookiesPath), { recursive: true });
  await fs.writeFile(cookiesPath, JSON.stringify(cookies, null, 2) + "\n");
}

export function resolveCookies(payload: {
  cookieString?: string;
  cookies?: Record<string, string>;
}): { cookies?: Record<string, string>; error?: Record<string, unknown> } {
  if (payload.cookieString) {
    const all = parseCookieString(payload.cookieString);
    const tld = detectTld(all);
    if (!tld) {
      return {
        error: {
          error:
            "Could not detect region from cookies. Expected at-main (US) or at-acb{tld} (international).",
        },
      };
    }

    const { cookies, missing } = extractRequiredCookies(all, tld);
    if (missing.length > 0) {
      return {
        error: {
          error: `Missing required cookies: ${missing.join(", ")}`,
          missingKeys: missing,
        },
      };
    }

    return { cookies };
  }

  if (payload.cookies) {
    return { cookies: payload.cookies };
  }

  return {
    error: {
      error: 'Provide either "cookieString" or "cookies" in the body',
    },
  };
}

export async function testCookiesFile(
  cookiesPath: string,
): Promise<{ authenticated: boolean }> {
  const cookies = (await readCookiesFile(cookiesPath)) as AmazonCookies;
  const client = new AmazonClient(cookies, { autoRefresh: false });
  const authenticated = await client.checkAuth();
  return { authenticated };
}
