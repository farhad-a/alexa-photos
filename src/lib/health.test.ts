import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HealthServer } from "./health.js";
import { StateStore } from "../state/store.js";

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
vi.mock("./logger.js", () => ({ logger: mockLogger }));

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

const TEST_PORT = 19876;

function url(path: string): string {
  return `http://localhost:${TEST_PORT}${path}`;
}

describe("HealthServer", () => {
  describe("without state store", () => {
    let server: HealthServer;

    beforeEach(async () => {
      server = new HealthServer(TEST_PORT);
      await server.start();
    });

    afterEach(async () => {
      await server.stop();
    });

    it("GET /health returns health status", async () => {
      const res = await fetch(url("/health"));
      expect(res.status).toBe(503); // starts as "starting"
      const json = await res.json();
      expect(json).toHaveProperty("status");
      expect(json).toHaveProperty("uptime");
      expect(json).toHaveProperty("timestamp");
    });

    it("GET /metrics returns metrics", async () => {
      const res = await fetch(url("/metrics"));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toHaveProperty("totalSyncs");
      expect(json).toHaveProperty("totalErrors");
    });

    it("GET / returns 404 without state store", async () => {
      const res = await fetch(url("/"));
      expect(res.status).toBe(404);
    });

    it("GET /api/mappings returns 404 without state store", async () => {
      const res = await fetch(url("/api/mappings"));
      expect(res.status).toBe(404);
    });
  });

  describe("with state store", () => {
    let server: HealthServer;
    let store: StateStore;

    beforeEach(async () => {
      store = new StateStore();
      server = new HealthServer(TEST_PORT, store);
      await server.start();
    });

    afterEach(async () => {
      await server.stop();
      store.close();
    });

    it("GET / returns HTML", async () => {
      const res = await fetch(url("/"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const body = await res.text();
      expect(body).toContain("Photo Mappings");
    });

    it("GET /health still works", async () => {
      server.updateMetrics({ status: "healthy" });
      const res = await fetch(url("/health"));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.status).toBe("healthy");
    });

    describe("GET /api/mappings", () => {
      it("returns empty data when no mappings", async () => {
        const res = await fetch(url("/api/mappings"));
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.data).toEqual([]);
        expect(json.pagination.totalItems).toBe(0);
        expect(json.pagination.totalPages).toBe(1);
      });

      it("returns paginated results", async () => {
        for (let i = 1; i <= 5; i++) {
          store.addMapping({
            icloudId: `ic-${i}`,
            icloudChecksum: `chk-${i}`,
            amazonId: `az-${i}`,
          });
        }

        const res = await fetch(url("/api/mappings?page=1&pageSize=3"));
        const json = await res.json();
        expect(json.data).toHaveLength(3);
        expect(json.pagination.totalItems).toBe(5);
        expect(json.pagination.totalPages).toBe(2);
        expect(json.pagination.page).toBe(1);
        expect(json.pagination.pageSize).toBe(3);
      });

      it("returns second page", async () => {
        for (let i = 1; i <= 5; i++) {
          store.addMapping({
            icloudId: `ic-${i}`,
            icloudChecksum: `chk-${i}`,
            amazonId: `az-${i}`,
          });
        }

        const res = await fetch(url("/api/mappings?page=2&pageSize=3"));
        const json = await res.json();
        expect(json.data).toHaveLength(2);
      });

      it("filters results with search param", async () => {
        store.addMapping({
          icloudId: "photo-abc",
          icloudChecksum: "x",
          amazonId: "az-1",
        });
        store.addMapping({
          icloudId: "photo-def",
          icloudChecksum: "y",
          amazonId: "az-2",
        });

        const res = await fetch(url("/api/mappings?search=abc"));
        const json = await res.json();
        expect(json.data).toHaveLength(1);
        expect(json.data[0].icloudId).toBe("photo-abc");
        expect(json.pagination.totalItems).toBe(1);
      });

      it("caps pageSize at 200", async () => {
        const res = await fetch(url("/api/mappings?pageSize=999"));
        const json = await res.json();
        expect(json.pagination.pageSize).toBe(200);
      });
    });

    describe("DELETE /api/mappings/:icloudId", () => {
      it("deletes an existing mapping", async () => {
        store.addMapping({
          icloudId: "ic-1",
          icloudChecksum: "a",
          amazonId: "az-1",
        });

        const res = await fetch(url("/api/mappings/ic-1"), {
          method: "DELETE",
        });
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.deleted).toBe(1);
        expect(store.getMapping("ic-1")).toBeNull();
      });

      it("returns deleted 0 for non-existent mapping", async () => {
        const res = await fetch(url("/api/mappings/no-such-id"), {
          method: "DELETE",
        });
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.deleted).toBe(0);
      });

      it("handles URL-encoded icloudId", async () => {
        store.addMapping({
          icloudId: "id with spaces",
          icloudChecksum: "a",
          amazonId: "az-1",
        });

        const res = await fetch(
          url("/api/mappings/" + encodeURIComponent("id with spaces")),
          { method: "DELETE" },
        );
        const json = await res.json();
        expect(json.deleted).toBe(1);
      });
    });

    describe("POST /api/mappings/bulk-delete", () => {
      it("deletes multiple mappings", async () => {
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

        const res = await fetch(url("/api/mappings/bulk-delete"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ icloudIds: ["ic-1", "ic-2"] }),
        });
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.deleted).toBe(2);
        expect(store.getMapping("ic-1")).toBeNull();
        expect(store.getMapping("ic-2")).toBeNull();
        expect(store.getMapping("ic-3")).not.toBeNull();
      });

      it("returns 400 for invalid JSON", async () => {
        const res = await fetch(url("/api/mappings/bulk-delete"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "not json",
        });
        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.error).toContain("Invalid JSON");
      });

      it("returns 400 when icloudIds is missing", async () => {
        const res = await fetch(url("/api/mappings/bulk-delete"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.error).toContain("icloudIds must be an array");
      });
    });

    it("returns 404 for unknown paths", async () => {
      const res = await fetch(url("/unknown"));
      expect(res.status).toBe(404);
    });
  });
});
