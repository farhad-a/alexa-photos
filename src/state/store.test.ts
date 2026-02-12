import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { StateStore, PhotoMapping } from "./store.js";

// Mock the logger
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

// Override DB_PATH to use in-memory database
vi.mock("better-sqlite3", async (importOriginal) => {
  const mod = await importOriginal<typeof import("better-sqlite3")>();
  return {
    default: class extends mod.default {
      constructor() {
        super(":memory:");
      }
    },
  };
});

describe("StateStore", () => {
  let store: StateStore;

  beforeEach(() => {
    store = new StateStore();
  });

  afterEach(() => {
    store.close();
  });

  describe("addMapping", () => {
    it("adds a new photo mapping", () => {
      store.addMapping({
        icloudId: "icloud-1",
        icloudChecksum: "abc123",
        amazonId: "amazon-1",
      });

      const mapping = store.getMapping("icloud-1");
      expect(mapping).not.toBeNull();
      expect(mapping!.icloudId).toBe("icloud-1");
      expect(mapping!.icloudChecksum).toBe("abc123");
      expect(mapping!.amazonId).toBe("amazon-1");
      expect(mapping!.syncedAt).toBeInstanceOf(Date);
    });

    it("overwrites existing mapping with same icloudId (upsert)", () => {
      store.addMapping({
        icloudId: "icloud-1",
        icloudChecksum: "abc",
        amazonId: "amazon-old",
      });

      store.addMapping({
        icloudId: "icloud-1",
        icloudChecksum: "def",
        amazonId: "amazon-new",
      });

      const mapping = store.getMapping("icloud-1");
      expect(mapping!.amazonId).toBe("amazon-new");
      expect(mapping!.icloudChecksum).toBe("def");
    });
  });

  describe("getMapping", () => {
    it("returns null for non-existent mapping", () => {
      expect(store.getMapping("no-such-id")).toBeNull();
    });

    it("returns mapping with correct types", () => {
      store.addMapping({
        icloudId: "ic-1",
        icloudChecksum: "chk",
        amazonId: "az-1",
      });

      const m = store.getMapping("ic-1")!;
      expect(typeof m.icloudId).toBe("string");
      expect(typeof m.icloudChecksum).toBe("string");
      expect(typeof m.amazonId).toBe("string");
      expect(m.syncedAt).toBeInstanceOf(Date);
    });
  });

  describe("getMappingByChecksum", () => {
    it("finds mapping by iCloud checksum", () => {
      store.addMapping({
        icloudId: "ic-1",
        icloudChecksum: "unique-checksum",
        amazonId: "az-1",
      });

      const mapping = store.getMappingByChecksum("unique-checksum");
      expect(mapping).not.toBeNull();
      expect(mapping!.icloudId).toBe("ic-1");
    });

    it("returns null for non-existent checksum", () => {
      expect(store.getMappingByChecksum("no-such-checksum")).toBeNull();
    });
  });

  describe("getAllMappings", () => {
    it("returns empty array when no mappings", () => {
      expect(store.getAllMappings()).toEqual([]);
    });

    it("returns all stored mappings", () => {
      store.addMapping({
        icloudId: "ic-1",
        icloudChecksum: "a",
        amazonId: "az-1",
      });
      store.addMapping({
        icloudId: "ic-2",
        icloudChecksum: "b",
        amazonId: "az-2",
      });
      store.addMapping({
        icloudId: "ic-3",
        icloudChecksum: "c",
        amazonId: "az-3",
      });

      const mappings = store.getAllMappings();
      expect(mappings).toHaveLength(3);
      expect(mappings.map((m) => m.icloudId).sort()).toEqual([
        "ic-1",
        "ic-2",
        "ic-3",
      ]);
    });
  });

  describe("removeMapping", () => {
    it("removes mapping by icloudId", () => {
      store.addMapping({
        icloudId: "ic-1",
        icloudChecksum: "a",
        amazonId: "az-1",
      });
      store.addMapping({
        icloudId: "ic-2",
        icloudChecksum: "b",
        amazonId: "az-2",
      });

      store.removeMapping("ic-1");

      expect(store.getMapping("ic-1")).toBeNull();
      expect(store.getMapping("ic-2")).not.toBeNull();
    });

    it("does not throw when removing non-existent mapping", () => {
      expect(() => store.removeMapping("no-such-id")).not.toThrow();
    });
  });

  describe("removeMappingByAmazonId", () => {
    it("removes mapping by amazonId", () => {
      store.addMapping({
        icloudId: "ic-1",
        icloudChecksum: "a",
        amazonId: "az-1",
      });

      store.removeMappingByAmazonId("az-1");
      expect(store.getMapping("ic-1")).toBeNull();
    });
  });

  describe("close", () => {
    it("can be called without error", () => {
      expect(() => store.close()).not.toThrow();
    });
  });
});
