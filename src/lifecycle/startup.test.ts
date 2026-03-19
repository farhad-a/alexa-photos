import { beforeEach, describe, expect, it, vi } from "vitest";
import { runStartupSequence } from "./startup.js";

const mockLogger = vi.hoisted(() => {
  const m = {
    info: vi.fn(),
    warn: vi.fn(),
    child: vi.fn(),
  };
  m.child.mockReturnValue(m);
  return m;
});

const validateIcloudStartupAccess = vi.hoisted(() => vi.fn());

vi.mock("../lib/logger.js", () => ({ logger: mockLogger }));
vi.mock("../icloud/startup-validation.js", () => ({
  validateIcloudStartupAccess,
}));

describe("runStartupSequence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts health before blocking startup checks", async () => {
    let resolveValidation: (
      value: Awaited<ReturnType<typeof validateIcloudStartupAccess>>,
    ) => void;
    validateIcloudStartupAccess.mockReturnValue(
      new Promise((resolve) => {
        resolveValidation = resolve;
      }),
    );

    const calls: string[] = [];
    const health = {
      start: vi.fn(async () => {
        calls.push("health.start");
      }),
      updateMetrics: vi.fn(() => {
        calls.push("health.updateMetrics");
      }),
    };
    const sync = {
      setAmazonAuthenticated: vi.fn(),
    };

    const startup = runStartupSequence({
      icloud: {} as never,
      sync: sync as never,
      health: health as never,
      cookieRefreshIntervalMs: 60_000,
      amazonCookiesPath: "./data/amazon-cookies.json",
    });

    await Promise.resolve();

    expect(health.start).toHaveBeenCalledTimes(1);
    expect(validateIcloudStartupAccess).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["health.start"]);
    expect(health.updateMetrics).not.toHaveBeenCalled();

    resolveValidation!({ validated: true });
    await startup;
  });
});
