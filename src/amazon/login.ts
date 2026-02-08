/**
 * Cookie setup helper for Amazon Photos
 * Run with: npm run amazon:setup
 *
 * Supports two modes:
 *   1. Paste full cookie string from browser DevTools (fast)
 *   2. Enter individual cookie values one by one (guided)
 *
 * Saves cookies to ./data/amazon-cookies.json for the sync service.
 */

import "dotenv/config";
import * as fs from "fs/promises";
import * as readline from "readline/promises";
import { AmazonClient } from "./client.js";

const COOKIES_PATH = "./data/amazon-cookies.json";

// US cookies we need (in order of importance)
const US_REQUIRED = ["session-id", "ubid-main", "at-main"] as const;
const US_OPTIONAL = ["x-main", "sess-at-main", "sst-main"] as const;
const US_ALL = [...US_REQUIRED, ...US_OPTIONAL];

async function ask(rl: readline.Interface, question: string): Promise<string> {
  const answer = await rl.question(question);
  return answer.trim();
}

/**
 * Parse a raw cookie header string into a key→value map.
 * Handles `key=value; key2=value2` format (from DevTools "Copy as cURL"
 * or the Cookie request header).
 */
function parseCookieString(raw: string): Record<string, string> {
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
function detectTld(cookies: Record<string, string>): string | null {
  for (const key of Object.keys(cookies)) {
    if (key === "at-main" || key === "at_main") return "com";
    if (key.startsWith("at-acb")) return key.slice("at-acb".length);
  }
  return null;
}

/**
 * Extract only the cookies we need from a full cookie map.
 */
function extractRequiredCookies(
  all: Record<string, string>,
  tld: string,
): { cookies: Record<string, string>; missing: string[] } {
  const needed =
    tld === "com" ? US_ALL : ["session-id", `ubid-acb${tld}`, `at-acb${tld}`];

  const cookies: Record<string, string> = {};
  const missing: string[] = [];

  for (const key of needed) {
    if (all[key]) {
      cookies[key] = all[key];
    } else if (US_REQUIRED.includes(key as any) || !tld.startsWith("com")) {
      // Only flag truly required keys as missing
      missing.push(key);
    }
  }

  // Also grab optional US cookies if present (don't flag as missing)
  if (tld === "com") {
    for (const key of US_OPTIONAL) {
      if (all[key] && !cookies[key]) cookies[key] = all[key];
    }
  }

  return { cookies, missing };
}

/** Mode 1: Paste full cookie string */
async function pasteMode(
  rl: readline.Interface,
): Promise<Record<string, string>> {
  console.log("\nHow to get the cookie string:");
  console.log("  1. Open https://www.amazon.com/photos in your browser");
  console.log("  2. Open DevTools (F12) → Network tab");
  console.log("  3. Reload the page, click any request to amazon.com");
  console.log("  4. In the Headers tab, find the Cookie request header");
  console.log('  5. Right-click the value → "Copy value"\n');

  const raw = await ask(rl, "Paste cookie string: ");
  if (!raw) {
    console.error("No cookie string provided");
    process.exit(1);
  }

  const all = parseCookieString(raw);
  const tld = detectTld(all);

  if (!tld) {
    console.error(
      "Could not detect region from cookies. " +
        "Expected at-main (US) or at-acb{tld} (international).",
    );
    process.exit(1);
  }

  console.log(`\nDetected region: amazon.${tld}`);

  const { cookies, missing } = extractRequiredCookies(all, tld);

  if (missing.length > 0) {
    console.error(`\n✗ Missing required cookies: ${missing.join(", ")}`);
    console.error("  Make sure you copied the full cookie string.");
    process.exit(1);
  }

  const found = Object.keys(cookies);
  console.log(`Extracted ${found.length} cookies: ${found.join(", ")}`);

  return cookies;
}

/** Mode 2: Enter individual cookie values */
async function manualMode(
  rl: readline.Interface,
): Promise<Record<string, string>> {
  console.log("\nHow to get cookie values:");
  console.log("  1. Open https://www.amazon.com/photos in your browser");
  console.log("  2. Log in (complete any 2FA)");
  console.log(
    "  3. Open DevTools (F12) → Application → Cookies → www.amazon.com",
  );
  console.log("  4. Copy the values for the cookies listed below\n");

  const sessionId = await ask(rl, "session-id: ");
  if (!sessionId) {
    console.error("session-id is required");
    process.exit(1);
  }

  const region = await ask(rl, "Region — (U)S or (I)nternational? [U]: ");
  const isInternational = region.toLowerCase().startsWith("i");

  if (isInternational) {
    const tld = await ask(rl, "TLD (e.g. ca, co.uk, de, fr, it, es): ");
    const ubid = await ask(rl, `ubid-acb${tld}: `);
    const at = await ask(rl, `at-acb${tld}: `);
    return {
      "session-id": sessionId,
      [`ubid-acb${tld}`]: ubid,
      [`at-acb${tld}`]: at,
    };
  }

  const ubid = await ask(rl, "ubid-main: ");
  const at = await ask(rl, "at-main: ");
  const xMain = await ask(rl, "x-main: ");
  const sessAt = await ask(rl, "sess-at-main: ");
  const sst = await ask(rl, "sst-main: ");
  return {
    "session-id": sessionId,
    "ubid-main": ubid,
    "at-main": at,
    "x-main": xMain,
    "sess-at-main": sessAt,
    "sst-main": sst,
  };
}

async function main() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║   Amazon Photos — Cookie Setup              ║");
  console.log("╚══════════════════════════════════════════════╝\n");

  console.log("This script saves the cookies needed to access the");
  console.log("Amazon Photos REST API.\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const mode = await ask(
      rl,
      "  (P)aste full cookie string  or  (M)anual entry?  [P]: ",
    );

    const cookies = mode.toLowerCase().startsWith("m")
      ? await manualMode(rl)
      : await pasteMode(rl);

    // Save to disk
    await fs.mkdir("./data", { recursive: true });
    await fs.writeFile(COOKIES_PATH, JSON.stringify(cookies, null, 2) + "\n");
    console.log(`\n✓ Cookies saved to ${COOKIES_PATH}`);

    // Verify
    console.log("\nVerifying authentication...");
    const client = new AmazonClient(cookies as any);
    const ok = await client.checkAuth();

    if (ok) {
      console.log("✓ Authentication successful!\n");
    } else {
      console.warn(
        "⚠  Could not verify auth — cookies may be invalid or expired.",
      );
      console.warn(
        "   The file was still saved. You can re-run this script anytime.\n",
      );
    }
  } finally {
    rl.close();
  }
}

main().catch(console.error);
