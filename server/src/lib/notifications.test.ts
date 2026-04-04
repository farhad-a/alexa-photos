import { describe, it, expect, vi, beforeEach } from "vitest";
import { NotificationService } from "./notifications.js";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock logger
const mockLogger = vi.hoisted(() => {
  const m = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  m.child.mockReturnValue(m);
  return m;
});
vi.mock("./logger.js", () => ({ logger: mockLogger }));

describe("NotificationService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("throttling", () => {
    it("sends alert on first occurrence", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
      });

      const service = new NotificationService(
        { webhookUrl: "https://example.com/webhook" },
        1000, // 1 second throttle for testing
      );

      await service.sendAlert("Test error", "error");

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("throttles duplicate alerts within throttle window", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
      });

      const service = new NotificationService(
        { webhookUrl: "https://example.com/webhook" },
        1000, // 1 second throttle
      );

      // First alert
      await service.sendAlert("Test error", "error");
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Second alert with same message/level (should be throttled)
      await service.sendAlert("Test error", "error");
      expect(mockFetch).toHaveBeenCalledTimes(1); // Still 1
    });

    it("sends alert after throttle window expires", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
      });

      const service = new NotificationService(
        { webhookUrl: "https://example.com/webhook" },
        100, // 100ms throttle
      );

      // First alert
      await service.sendAlert("Test error", "error");
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Wait for throttle to expire
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Second alert (should go through)
      await service.sendAlert("Test error", "error");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("treats different messages as separate alerts", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
      });

      const service = new NotificationService(
        { webhookUrl: "https://example.com/webhook" },
        1000,
      );

      await service.sendAlert("Error 1", "error");
      await service.sendAlert("Error 2", "error");

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("treats different levels as separate alerts", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
      });

      const service = new NotificationService(
        { webhookUrl: "https://example.com/webhook" },
        1000,
      );

      await service.sendAlert("Same message", "error");
      await service.sendAlert("Same message", "warning");

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("allows manual throttle clearing", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
      });

      const service = new NotificationService(
        { webhookUrl: "https://example.com/webhook" },
        1000,
      );

      // First alert
      await service.sendAlert("Test error", "error");
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Clear throttle
      service.clearAlertThrottle("Test error", "error");

      // Second alert (should go through because throttle was cleared)
      await service.sendAlert("Test error", "error");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("webhook", () => {
    it("sends to webhook when configured", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
      });

      const service = new NotificationService({
        webhookUrl: "https://example.com/webhook",
      });

      await service.sendAlert("Test", "error");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://example.com/webhook",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: expect.stringContaining("Test"),
        }),
      );
    });

    it("does not send when webhook not configured", async () => {
      const service = new NotificationService({});

      await service.sendAlert("Test", "error");

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("pushover", () => {
    it("sends to pushover when configured", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
      });

      const service = new NotificationService({
        pushoverToken: "test-token",
        pushoverUser: "test-user",
      });

      await service.sendAlert("Test", "error");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.pushover.net/1/messages.json",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        }),
      );
    });
  });

  describe("multiple channels", () => {
    it("sends to all configured channels", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
      });

      const service = new NotificationService({
        webhookUrl: "https://example.com/webhook",
        pushoverToken: "test-token",
        pushoverUser: "test-user",
      });

      await service.sendAlert("Test", "error");

      // Should have called webhook + pushover
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});
