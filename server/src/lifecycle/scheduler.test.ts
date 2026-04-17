import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSyncScheduler } from "./scheduler.js";
import type { SyncMetrics } from "../sync/engine.js";

const mockLogger = vi.hoisted(() => {
  const m = {
    info: vi.fn(),
    child: vi.fn(),
  };
  m.child.mockReturnValue(m);
  return m;
});

vi.mock("../lib/logger.js", () => ({ logger: mockLogger }));

function createMetrics(): SyncMetrics {
  return {
    totalSyncs: 0,
    totalErrors: 0,
    totalPhotosAdded: 0,
    totalPhotosRemoved: 0,
    amazonAuthenticated: true,
    amazonAuth401Count: 0,
    amazonRateLimit429Count: 0,
    amazonBotDetection503Count: 0,
    amazonNetworkErrorCount: 0,
  };
}

describe("createSyncScheduler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("scheduled runs set nextSync and update health metrics", async () => {
    const metrics = createMetrics();
    const sync = {
      run: vi.fn(async () => {
        metrics.totalSyncs += 1;
      }),
      getMetrics: vi.fn(() => ({ ...metrics })),
      setNextSync: vi.fn((date: Date) => {
        metrics.nextSync = date;
      }),
    };
    const health = {
      updateMetrics: vi.fn(),
    };

    const scheduler = createSyncScheduler({
      sync: sync as never,
      health: health as never,
      pollIntervalMs: 60_000,
    });

    await scheduler.runScheduledSyncWithMetrics();

    expect(sync.setNextSync).toHaveBeenCalledTimes(1);
    expect(health.updateMetrics).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "healthy",
        totalSyncs: 1,
        nextSync: expect.any(Date),
      }),
    );
  });

  it("manual runs keep the existing nextSync and do not reschedule", async () => {
    const metrics = createMetrics();

    const sync = {
      run: vi.fn(async () => {
        metrics.totalSyncs += 1;
      }),
      getMetrics: vi.fn(() => ({ ...metrics })),
      setNextSync: vi.fn((date: Date) => {
        metrics.nextSync = date;
      }),
    };
    const health = {
      updateMetrics: vi.fn(),
    };
    const schedule = vi.fn(() => ({}) as ReturnType<typeof setInterval>);

    const scheduler = createSyncScheduler({
      sync: sync as never,
      health: health as never,
      pollIntervalMs: 60_000,
      schedule,
    });

    await scheduler.start();
    const existingNextSync = metrics.nextSync;
    vi.clearAllMocks();

    await scheduler.runManualSyncWithMetrics();

    expect(sync.setNextSync).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
    expect(metrics.nextSync).toBe(existingNextSync);
    expect(health.updateMetrics).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "healthy",
        nextSync: existingNextSync,
      }),
    );
  });

  it("manual run failures keep nextSync and mark health unhealthy", async () => {
    const metrics = createMetrics();
    metrics.amazonAuthenticated = false;
    metrics.totalErrors = 1;

    const sync = {
      run: vi.fn(async () => {
        throw new Error("sync failed");
      }),
      getMetrics: vi.fn(() => ({ ...metrics })),
      setNextSync: vi.fn((date: Date) => {
        metrics.nextSync = date;
      }),
    };
    const health = {
      updateMetrics: vi.fn(),
    };
    const schedule = vi.fn(() => ({}) as ReturnType<typeof setInterval>);

    const scheduler = createSyncScheduler({
      sync: sync as never,
      health: health as never,
      pollIntervalMs: 60_000,
      schedule,
    });

    await scheduler.start();
    const existingNextSync = metrics.nextSync;
    vi.clearAllMocks();

    await expect(scheduler.runManualSyncWithMetrics()).resolves.toBeUndefined();

    expect(sync.setNextSync).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
    expect(metrics.nextSync).toBe(existingNextSync);
    expect(health.updateMetrics).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "unhealthy",
        totalErrors: 1,
        nextSync: existingNextSync,
      }),
    );
  });
});
