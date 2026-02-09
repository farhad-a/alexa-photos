#!/usr/bin/env node
/**
 * Manual test script for notification system
 * Usage:
 *   ALERT_WEBHOOK_URL=https://webhook.site/... node --loader ts-node/esm src/lib/test-notifications.ts
 *   PUSHOVER_TOKEN=xxx PUSHOVER_USER=yyy node --loader ts-node/esm src/lib/test-notifications.ts
 */

import { NotificationService } from "./notifications.js";
import { config } from "./config.js";

async function main() {
  console.log("Testing notification system...\n");

  const service = new NotificationService(config);

  // Test different alert levels
  const tests = [
    {
      message: "This is a test error alert from alexa-photos",
      level: "error" as const,
    },
    {
      message: "This is a test warning alert from alexa-photos",
      level: "warning" as const,
    },
    {
      message: "This is a test info alert from alexa-photos",
      level: "info" as const,
    },
  ];

  for (const test of tests) {
    console.log(`Sending ${test.level} notification...`);
    await service.sendAlert(test.message, test.level, {
      testRun: true,
      timestamp: new Date().toISOString(),
    });
    console.log(`✓ ${test.level} notification sent\n`);
    // Small delay between tests
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  console.log("All test notifications sent!");
  console.log("\nConfiguration used:");
  console.log(
    `  Webhook: ${config.alertWebhookUrl ? "configured" : "not configured"}`,
  );
  console.log(
    `  Pushover: ${config.pushoverToken && config.pushoverUser ? "configured" : "not configured"}`,
  );
}

main().catch(console.error);
