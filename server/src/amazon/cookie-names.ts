/**
 * Recognising Amazon auth cookies by name.
 *
 * Cookies are now minted from a device registration rather than pasted by
 * hand, so nothing here parses user input any more. What remains is what the
 * transport needs: deciding which cookie names carry auth, pulling those out
 * of a Set-Cookie header when Amazon rotates them mid-session, and sanity
 * checking which marketplace a set belongs to.
 */

const TRACKED_PREFIXES = ["ubid", "at", "x", "sess-at", "sst"] as const;

/** Does this cookie name carry authentication state worth persisting? */
export function isTrackedAuthCookieName(name: string): boolean {
  if (name === "session-id") return true;
  if (name === "session-token") return true;
  if (name === "session-id-time") return true;

  return new RegExp(
    `^(${TRACKED_PREFIXES.join("|")})(-|_)(main|acb.+)$`,
    "i",
  ).test(name);
}

/**
 * Is this the access-token cookie?
 *
 * Used to confirm a refresh actually produced one. A response carrying
 * cookies but no access token would otherwise pass and fail on the next
 * request.
 */
export function isAccessTokenCookieName(name: string): boolean {
  return /^at(-|_)(main|acb.+)$/i.test(name);
}

function parseSetCookieHeader(setCookie: string): {
  name?: string;
  value?: string;
} {
  const [cookiePart] = setCookie.split(";");
  const idx = cookiePart.indexOf("=");
  if (idx === -1) return {};

  const name = cookiePart.slice(0, idx).trim();
  const value = cookiePart.slice(idx + 1).trim();

  if (!name || !value) return {};
  return { name, value };
}

/**
 * Pull tracked auth cookies out of a response's Set-Cookie headers.
 *
 * Amazon rotates these mid-session regardless of how the session was
 * obtained, so every response is a chance to pick up newer values.
 */
export function extractTrackedSetCookies(
  headers?: Pick<Headers, "getSetCookie"> | null,
): Record<string, string> {
  if (!headers || typeof headers.getSetCookie !== "function") {
    return {};
  }

  const cookies: Record<string, string> = {};

  for (const setCookie of headers.getSetCookie()) {
    const { name, value } = parseSetCookieHeader(setCookie);
    if (!name || !value || !isTrackedAuthCookieName(name)) {
      continue;
    }
    cookies[name] = value;
  }

  return cookies;
}

/**
 * Infer the marketplace from cookie names, e.g. "com" or "co.uk".
 *
 * No longer the source of truth: the registration record carries the
 * marketplace. This is kept as a mismatch check, which is what catches a
 * registration made against the wrong Amazon site.
 */
export function detectTld(
  cookies: Record<string, string | undefined>,
): string | null {
  for (const [key, value] of Object.entries(cookies)) {
    // Skip empty entries: the jar allows undefined values, and a stale key
    // with no value would otherwise produce a wrong marketplace warning.
    if (!value) continue;
    if (key === "at-main" || key === "at_main") return "com";
    if (key.startsWith("at-acb")) return key.slice("at-acb".length);
  }
  return null;
}
