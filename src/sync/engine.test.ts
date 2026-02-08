import { describe, it, expect, vi, beforeEach } from "vitest";
import { ICloudClient, ICloudPhoto } from "../icloud/client.js";
import { AmazonClient } from "../amazon/client.js";
import { SyncEngine } from "./engine.js";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock logger
vi.mock("../lib/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock config
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

// Mock StateStore with in-memory implementation
const mockMappings = new Map<
  string,
  { icloudId: string; icloudChecksum: string; amazonId: string }
>();

vi.mock("../state/store.js", () => ({
  StateStore: class {
    getAllMappings() {
      return [...mockMappings.values()].map((m) => ({
        ...m,
        syncedAt: new Date(),
      }));
    }
    addMapping(m: {
      icloudId: string;
      icloudChecksum: string;
      amazonId: string;
    }) {
      mockMappings.set(m.icloudId, m);
    }
    removeMapping(icloudId: string) {
      mockMappings.delete(icloudId);
    }
    close() {}
  },
}));

// Mock AmazonClient.fromFile
vi.mock("../amazon/client.js", () => {
  const mockCheckAuth = vi.fn().mockResolvedValue(true);
  const mockFindOrCreateAlbum = vi.fn().mockResolvedValue("album-123");
  const mockUploadPhotoToAlbum = vi.fn().mockResolvedValue("amazon-node-id");
  const mockRemoveFromAlbum = vi.fn().mockResolvedValue(undefined);
  const mockDeleteNodes = vi.fn().mockResolvedValue(undefined);
  const mockClose = vi.fn().mockResolvedValue(undefined);

  const mockClient = {
    checkAuth: mockCheckAuth,
    findOrCreateAlbum: mockFindOrCreateAlbum,
    uploadPhotoToAlbum: mockUploadPhotoToAlbum,
    removeFromAlbum: mockRemoveFromAlbum,
    deleteNodes: mockDeleteNodes,
    close: mockClose,
  };

  return {
    AmazonClient: {
      fromFile: vi.fn().mockResolvedValue(mockClient),
      _mock: mockClient,
    },
  };
});

function makePhoto(id: string, checksum = `chk-${id}`): ICloudPhoto {
  return {
    id,
    checksum,
    url: `https://example.com/${id}.jpg`,
    width: 1920,
    height: 1080,
    dateCreated: new Date("2024-01-01"),
  };
}

function getAmazonMock() {
  return (AmazonClient as any)._mock;
}

describe("SyncEngine", () => {
  let icloud: ICloudClient;
  let engine: SyncEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMappings.clear();

    icloud = new ICloudClient("test-token");

    // By default, icloud returns no photos (individual tests override)
    vi.spyOn(icloud, "getPhotos").mockResolvedValue([]);
    vi.spyOn(icloud, "downloadPhoto").mockResolvedValue(
      Buffer.from("fake-jpg-data"),
    );

    engine = new SyncEngine(icloud);
  });

  describe("no-op sync", () => {
    it("does nothing when iCloud is empty and no mappings exist", async () => {
      await engine.run();

      // Amazon client should not even be initialized
      expect(AmazonClient.fromFile).not.toHaveBeenCalled();
    });

    it("does nothing when all photos are already synced", async () => {
      const photo = makePhoto("p1");
      vi.spyOn(icloud, "getPhotos").mockResolvedValue([photo]);
      mockMappings.set("p1", {
        icloudId: "p1",
        icloudChecksum: "chk-p1",
        amazonId: "az-1",
      });

      await engine.run();

      // No work to do → no Amazon client needed
      expect(AmazonClient.fromFile).not.toHaveBeenCalled();
    });
  });

  describe("additions", () => {
    it("uploads new photos from iCloud to Amazon", async () => {
      const photos = [makePhoto("p1"), makePhoto("p2")];
      vi.spyOn(icloud, "getPhotos").mockResolvedValue(photos);

      await engine.run();

      const mock = getAmazonMock();
      expect(icloud.downloadPhoto).toHaveBeenCalledTimes(2);
      expect(mock.uploadPhotoToAlbum).toHaveBeenCalledTimes(2);
      expect(mockMappings.size).toBe(2);
      expect(mockMappings.get("p1")!.amazonId).toBe("amazon-node-id");
    });

    it("saves correct mapping after upload", async () => {
      const photo = makePhoto("p1", "my-checksum");
      vi.spyOn(icloud, "getPhotos").mockResolvedValue([photo]);

      await engine.run();

      const mapping = mockMappings.get("p1");
      expect(mapping).toEqual({
        icloudId: "p1",
        icloudChecksum: "my-checksum",
        amazonId: "amazon-node-id",
      });
    });
  });

  describe("removals", () => {
    it("removes photos that are no longer in iCloud", async () => {
      // Photo was synced but is no longer in iCloud
      mockMappings.set("old-photo", {
        icloudId: "old-photo",
        icloudChecksum: "chk",
        amazonId: "az-old",
      });

      vi.spyOn(icloud, "getPhotos").mockResolvedValue([]);

      await engine.run();

      const mock = getAmazonMock();
      expect(mock.removeFromAlbum).toHaveBeenCalledWith("album-123", [
        "az-old",
      ]);
      expect(mock.deleteNodes).toHaveBeenCalledWith(["az-old"]);
      expect(mockMappings.size).toBe(0);
    });

    it("removes multiple photos in one batch", async () => {
      mockMappings.set("old-1", {
        icloudId: "old-1",
        icloudChecksum: "a",
        amazonId: "az-1",
      });
      mockMappings.set("old-2", {
        icloudId: "old-2",
        icloudChecksum: "b",
        amazonId: "az-2",
      });

      vi.spyOn(icloud, "getPhotos").mockResolvedValue([]);

      await engine.run();

      const mock = getAmazonMock();
      const removedIds = mock.deleteNodes.mock.calls[0][0].sort();
      expect(removedIds).toEqual(["az-1", "az-2"]);
      expect(mockMappings.size).toBe(0);
    });

    it("skips deletions when syncDeletions is false", async () => {
      // Temporarily override config
      const configModule = await import("../lib/config.js");
      const originalSyncDeletions = configModule.config.syncDeletions;
      (configModule.config as any).syncDeletions = false;

      try {
        mockMappings.set("old-photo", {
          icloudId: "old-photo",
          icloudChecksum: "chk",
          amazonId: "az-old",
        });

        vi.spyOn(icloud, "getPhotos").mockResolvedValue([]);

        await engine.run();

        // Mapping should still exist (not deleted)
        expect(mockMappings.has("old-photo")).toBe(true);

        // Amazon client should not be initialized (no work to do)
        expect(AmazonClient.fromFile).not.toHaveBeenCalled();
      } finally {
        // Restore original value
        (configModule.config as any).syncDeletions = originalSyncDeletions;
      }
    });
  });

  describe("mixed additions and removals", () => {
    it("adds new and removes old in the same run", async () => {
      // old-photo was synced, new-photo is new
      mockMappings.set("old-photo", {
        icloudId: "old-photo",
        icloudChecksum: "old-chk",
        amazonId: "az-old",
      });

      const newPhoto = makePhoto("new-photo");
      vi.spyOn(icloud, "getPhotos").mockResolvedValue([newPhoto]);

      await engine.run();

      const mock = getAmazonMock();
      // Added
      expect(mock.uploadPhotoToAlbum).toHaveBeenCalledTimes(1);
      expect(mockMappings.has("new-photo")).toBe(true);

      // Removed
      expect(mock.deleteNodes).toHaveBeenCalledWith(["az-old"]);
      expect(mockMappings.has("old-photo")).toBe(false);
    });
  });

  describe("concurrency guard", () => {
    it("skips if sync is already running", async () => {
      // Make getPhotos hang
      let resolvePhotos: (v: ICloudPhoto[]) => void;
      vi.spyOn(icloud, "getPhotos").mockReturnValue(
        new Promise((r) => {
          resolvePhotos = r;
        }),
      );

      // Start first sync (will block on getPhotos)
      const first = engine.run();

      // Start second sync while first is running
      await engine.run(); // Should skip immediately

      // Let first finish
      resolvePhotos!([]);
      await first;

      // getPhotos only called once (second run was skipped)
      expect(icloud.getPhotos).toHaveBeenCalledTimes(1);
    });
  });

  describe("lazy initialization", () => {
    it("initializes Amazon client only when there is work", async () => {
      const photo = makePhoto("p1");
      vi.spyOn(icloud, "getPhotos").mockResolvedValue([photo]);

      await engine.run();

      expect(AmazonClient.fromFile).toHaveBeenCalledTimes(1);
      const mock = getAmazonMock();
      expect(mock.checkAuth).toHaveBeenCalledTimes(1);
      expect(mock.findOrCreateAlbum).toHaveBeenCalledWith("Echo Show");
    });

    it("throws if Amazon auth fails", async () => {
      const mock = getAmazonMock();
      mock.checkAuth.mockResolvedValueOnce(false);

      const photo = makePhoto("p1");
      vi.spyOn(icloud, "getPhotos").mockResolvedValue([photo]);

      await expect(engine.run()).rejects.toThrow(
        "Amazon Photos authentication failed",
      );
    });
  });

  describe("error handling", () => {
    it("continues to next photo if one upload fails", async () => {
      const photos = [makePhoto("p1"), makePhoto("p2")];
      vi.spyOn(icloud, "getPhotos").mockResolvedValue(photos);

      // First download fails, second succeeds
      vi.spyOn(icloud, "downloadPhoto")
        .mockRejectedValueOnce(new Error("download failed"))
        .mockResolvedValueOnce(Buffer.from("jpg-data"));

      await engine.run();

      // p1 failed, p2 succeeded
      expect(mockMappings.has("p1")).toBe(false);
      expect(mockMappings.has("p2")).toBe(true);
    });
  });

  describe("close", () => {
    it("can be called without error when no Amazon client exists", async () => {
      await expect(engine.close()).resolves.not.toThrow();
    });
  });
});
