/**
 * Interactive login script for Amazon Photos
 * Run with: npm run amazon:login
 *
 * This will open a browser window for you to complete login (including 2FA)
 * and save the session for future use.
 */

import { chromium } from "playwright";
import * as fs from "fs/promises";

const SESSION_DIR = "./data/amazon-session";

async function main() {
  console.log("Opening browser for Amazon Photos login...\n");
  console.log("Please complete the login process in the browser window.");
  console.log("This includes any 2FA verification.\n");

  const browser = await chromium.launch({
    headless: false, // Show the browser
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });

  const page = await context.newPage();

  await page.goto("https://www.amazon.com/photos");

  console.log("Waiting for you to complete login...");
  console.log('Once you see the Amazon Photos dashboard, press Enter here.\n');

  // Wait for user to complete login
  await new Promise<void>((resolve) => {
    process.stdin.once("data", () => resolve());
  });

  // Verify we're logged in
  const url = page.url();
  if (url.includes("signin")) {
    console.error("❌ Still on login page. Please complete login first.");
    await browser.close();
    process.exit(1);
  }

  // Save session
  await fs.mkdir(SESSION_DIR, { recursive: true });
  await context.storageState({ path: `${SESSION_DIR}/state.json` });

  console.log("✓ Session saved successfully!");
  console.log(`  Session stored in: ${SESSION_DIR}/state.json`);

  await browser.close();
}

main().catch(console.error);
