import { beforeEach, describe, expect, it, vi } from "vitest";
import { ICloudClient, ICloudPhoto } from "../icloud/client.js";
import { SyncEngine } from "./engine.js";
import { StateStore } from "../state/store.js";

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

vi.mock("../lib/logger.js", () => ({ logger: mockLogger }));
vi.mock("../lib/config.js", () => ({
  config: {
    icloudAlbumToken: "test-token",
    icloudDownloadMaxRetries: 3,
    amazonCookiesPath: "./data/amazon-cookies.json",
    amazonAlbumName: "Echo Show",
    syncDeletions: true,
    pollIntervalMs: 60000,
    logLevel: "info",
  },
}));
vi.mock("../state/store.js", () => ({
  StateStore: class {
    getAllMappings() {
      return [];
    }
    close() {}
  },
}));
vi.mock("../amazon/client.js", () => ({
  AmazonClient: {
    fromFile: vi.fn().mockResolvedValue({
      checkAuthStatus: vi.fn().mockResolvedValue({
        ok: true,
        state: "ok",
        statusCode: 200,
        retriable: false,
        provider: "amazon",
        kind: "ok",
        actionable: false,
      }),
      startRefreshInterval: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));

describe("SyncEngine overlap guard", () => {
  let icloud: ICloudClient;
  let engine: SyncEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    icloud = new ICloudClient("test-token");
    engine = new SyncEngine(icloud, new StateStore());
  });

  it("logs and skips when a sync is already running", async () => {
    let resolvePhotos: (photos: ICloudPhoto[]) => void;
    vi.spyOn(icloud, "getPhotos").mockReturnValue(
      new Promise((resolve) => {
        resolvePhotos = resolve;
      }),
    );

    const firstRun = engine.run();
    await engine.run();

    resolvePhotos!([]);
    await firstRun;

    expect(icloud.getPhotos).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Sync already in progress, skipping",
    );
  });
});
