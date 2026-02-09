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

  constructor(config: NotificationConfig) {
    this.config = config;
  }

  async sendAlert(
    message: string,
    level: "error" | "warning" | "info" = "error",
    details?: Record<string, unknown>,
  ): Promise<void> {
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
