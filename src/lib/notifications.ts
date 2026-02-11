import { logger } from "./logger.js";

export interface NotificationConfig {
  webhookUrl?: string;
  pushoverToken?: string;
  pushoverUser?: string;
}

export interface AlertPayload {
  service: string;
  level: "error" | "warning" | "info";
  message: string;
  timestamp: string;
  details?: Record<string, unknown>;
}

export class NotificationService {
  private config: NotificationConfig;
  private sentAlerts: Map<string, number> = new Map();
  private throttleMs: number;

  constructor(config: NotificationConfig, throttleMs = 3600000) {
    this.config = config;
    this.throttleMs = throttleMs; // Default: 1 hour
  }

  /**
   * Get a unique key for an alert to track duplicates
   */
  private getAlertKey(message: string, level: string): string {
    return `${level}:${message}`;
  }

  /**
   * Check if we should send this alert based on throttling rules
   */
  private shouldSendAlert(message: string, level: string): boolean {
    const key = this.getAlertKey(message, level);
    const lastSent = this.sentAlerts.get(key);

    if (!lastSent) {
      return true; // Never sent before
    }

    const timeSinceLastSent = Date.now() - lastSent;
    return timeSinceLastSent >= this.throttleMs;
  }

  /**
   * Mark an alert as sent
   */
  private markAlertSent(message: string, level: string): void {
    const key = this.getAlertKey(message, level);
    this.sentAlerts.set(key, Date.now());
  }

  /**
   * Clear throttle state for a specific alert (useful when error is resolved)
   */
  clearAlertThrottle(message: string, level: string): void {
    const key = this.getAlertKey(message, level);
    this.sentAlerts.delete(key);
  }

  async sendAlert(
    message: string,
    level: "error" | "warning" | "info" = "error",
    details?: Record<string, unknown>,
  ): Promise<void> {
    // Check if we should throttle this alert
    if (!this.shouldSendAlert(message, level)) {
      logger.debug(
        { message, level },
        "Alert throttled (already sent recently)",
      );
      return;
    }

    const payload: AlertPayload = {
      service: "alexa-photos",
      level,
      message,
      timestamp: new Date().toISOString(),
      details,
    };

    const promises: Promise<void>[] = [];

    // Send to generic webhook if configured
    if (this.config.webhookUrl) {
      promises.push(this.sendWebhook(payload));
    }

    // Send to Pushover if configured
    if (this.config.pushoverToken && this.config.pushoverUser) {
      promises.push(this.sendPushover(message, level));
    }

    if (promises.length === 0) {
      logger.debug("No notification channels configured");
      return;
    }

    // Send all notifications in parallel
    await Promise.allSettled(promises);

    // Mark as sent after successful send
    this.markAlertSent(message, level);
  }

  private async sendWebhook(payload: AlertPayload): Promise<void> {
    try {
      const response = await fetch(this.config.webhookUrl!, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        logger.warn(
          { status: response.status, url: this.config.webhookUrl },
          "Webhook notification failed",
        );
      } else {
        logger.debug("Webhook notification sent");
      }
    } catch (error) {
      logger.error({ error, url: this.config.webhookUrl }, "Webhook error");
    }
  }

  private async sendPushover(
    message: string,
    level: "error" | "warning" | "info",
  ): Promise<void> {
    try {
      const priority = level === "error" ? "1" : "0"; // 1 = high, 0 = normal

      // Set icon based on level
      let icon = "ℹ️";
      if (level === "error") icon = "⛔️";
      else if (level === "warning") icon = "⚠️";

      const title = `Alexa Photos ${icon}`;

      const formData = new URLSearchParams({
        token: this.config.pushoverToken!,
        user: this.config.pushoverUser!,
        message,
        title,
        priority,
      });

      const response = await fetch("https://api.pushover.net/1/messages.json", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: formData.toString(),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        logger.warn(
          { status: response.status, response: text },
          "Pushover notification failed",
        );
      } else {
        logger.debug("Pushover notification sent");
      }
    } catch (error) {
      logger.error({ error }, "Pushover error");
    }
  }
}
