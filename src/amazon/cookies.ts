/**
 * Helpers for parsing and validating Amazon Photos auth cookies.
 *
 * Shared by the web UI/API and tests.
 */

// US cookies we need (in order of importance)
const US_REQUIRED = ["session-id", "ubid-main", "at-main"] as const;
const US_OPTIONAL = [
  "x-main",
  "sess-at-main",
  "sst-main",
  "session-token",
  "session-id-time",
] as const;

function intlRequired(tld: string): [string, string, string] {
  return ["session-id", `ubid-acb${tld}`, `at-acb${tld}`];
}

function intlOptional(tld: string): [string, string, string, string, string] {
  return [
    `x-acb${tld}`,
    `sess-at-acb${tld}`,
    `sst-acb${tld}`,
    "session-token",
    "session-id-time",
  ];
}

/**
 * Parse a raw cookie header string into a key→value map.
 * Handles `key=value; key2=value2` format.
 */
export function parseCookieString(raw: string): Record<string, string> {
  const cookies: Record<string, string> = {};

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
 * Detect region from a parsed cookie map.
 * Returns the TLD (e.g. "com", "co.uk", "de") or null if undetectable.
 */
export function detectTld(cookies: Record<string, string>): string | null {
  for (const key of Object.keys(cookies)) {
    if (key === "at-main" || key === "at_main") return "com";
    if (key.startsWith("at-acb")) return key.slice("at-acb".length);
  }
  return null;
}

/**
 * Extract only the cookies we need from a full cookie map.
 */
export function extractRequiredCookies(
  all: Record<string, string>,
  tld: string,
): { cookies: Record<string, string>; missing: string[] } {
  const required: string[] =
    tld === "com" ? [...US_REQUIRED] : intlRequired(tld);
  const optional: string[] =
    tld === "com" ? [...US_OPTIONAL] : intlOptional(tld);
  const needed = [...required, ...optional];

  const cookies: Record<string, string> = {};
  const missing: string[] = [];

  for (const key of needed) {
    if (all[key]) {
      cookies[key] = all[key];
    } else if (required.includes(key)) {
      missing.push(key);
    }
  }

  return { cookies, missing };
}
