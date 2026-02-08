/**
 * Cookie setup helper for Amazon Photos
 * Run with: npm run amazon:setup
 *
 * Guides you through extracting cookies from your browser and
 * saves them to ./data/amazon-cookies.json for the sync service.
 */

import "dotenv/config";
import * as fs from "fs/promises";
import * as readline from "readline/promises";
import { AmazonClient } from "./client.js";

const COOKIES_PATH = "./data/amazon-cookies.json";

async function prompt(
  rl: readline.Interface,
  question: string,
): Promise<string> {
  const answer = await rl.question(question);
  return answer.trim();
}

async function main() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║   Amazon Photos — Cookie Setup              ║");
  console.log("╚══════════════════════════════════════════════╝\n");

  console.log("This script saves the cookies needed to access the");
  console.log("Amazon Photos REST API.\n");
  console.log("Steps:");
  console.log("  1. Open https://www.amazon.com/photos in your browser");
  console.log("  2. Log in (complete any 2FA)");
  console.log(
    "  3. Open DevTools (F12) → Application → Cookies → www.amazon.com",
  );
  console.log("  4. Copy the values for the cookies listed below\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const sessionId = await prompt(rl, "session-id: ");
    if (!sessionId) {
      console.error("session-id is required");
      process.exit(1);
    }

    // Determine US vs international
    const region = await prompt(rl, "Region — (U)S or (I)nternational? [U]: ");
    const isInternational = region.toLowerCase().startsWith("i");

    let cookies: Record<string, string>;

    if (isInternational) {
      const tld = await prompt(rl, "TLD (e.g. ca, co.uk, de, fr, it, es): ");
      const ubid = await prompt(rl, `ubid-acb${tld}: `);
      const at = await prompt(rl, `at-acb${tld}: `);
      cookies = {
        "session-id": sessionId,
        [`ubid-acb${tld}`]: ubid,
        [`at-acb${tld}`]: at,
      };
    } else {
      const ubid = await prompt(rl, "ubid-main: ");
      const at = await prompt(rl, "at-main: ");
      const xMain = await prompt(rl, "x-main: ");
      const sessAt = await prompt(rl, "sess-at-main: ");
      const sst = await prompt(rl, "sst-main: ");
      cookies = {
        "session-id": sessionId,
        "ubid-main": ubid,
        "at-main": at,
        "x-main": xMain,
        "sess-at-main": sessAt,
        "sst-main": sst,
      };
    }

    // Save to disk
    await fs.mkdir("./data", { recursive: true });
    await fs.writeFile(COOKIES_PATH, JSON.stringify(cookies, null, 2) + "\n");
    console.log(`\n✓ Cookies saved to ${COOKIES_PATH}`);

    // Verify
    console.log("\nVerifying authentication...");
    const client = new AmazonClient(cookies as any);
    const ok = await client.checkAuth();

    if (ok) {
      console.log("✓ Authentication successful!");
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
