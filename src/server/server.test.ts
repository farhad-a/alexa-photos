import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "http";
import { AppServer } from "./index.js";
import { StateStore } from "../state/store.js";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

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

class MockResponse {
  statusCode = 200;
  headersSent = false;
  body = Buffer.alloc(0);
  private headers = new Map<string, string>();

  setHeader(name: string, value: string): void {
    this.headers.set(name.toLowerCase(), value);
  }

  writeHead(statusCode: number, headers?: Record<string, string>): this {
    this.statusCode = statusCode;
    this.headersSent = true;
    for (const [name, value] of Object.entries(headers ?? {})) {
      this.setHeader(name, value);
    }
    return this;
  }

  end(chunk?: string | Buffer): this {
    this.headersSent = true;
    if (chunk) {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      this.body = Buffer.concat([this.body, buffer]);
    }
    return this;
  }

  text(): string {
    return this.body.toString("utf-8");
  }

  json(): unknown {
    return JSON.parse(this.text());
  }

  getHeader(name: string): string | undefined {
    return this.headers.get(name.toLowerCase());
  }
}

function createMockRequest(options: {
  method: string;
  url: string;
  body?: string;
}): IncomingMessage {
  const chunks = options.body ? [Buffer.from(options.body)] : [];

  return {
    method: options.method,
    url: options.url,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  } as IncomingMessage;
}

async function request(
  server: AppServer,
  options: {
    method?: string;
    url: string;
    body?: string;
  },
): Promise<MockResponse> {
  const req = createMockRequest({
    method: options.method ?? "GET",
    url: options.url,
    body: options.body,
  });
  const res = new MockResponse();

  await (
    server as unknown as {
      handleRequest: (
        req: IncomingMessage,
        res: ServerResponse,
      ) => Promise<void>;
    }
  ).handleRequest(req, res as unknown as ServerResponse);

  return res;
}

describe("static file serving", () => {
  let server: AppServer;
  let staticDir: string;

  beforeEach(async () => {
    staticDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "alexa-photos-static-"),
    );
    await fs.writeFile(path.join(staticDir, "index.html"), "<html>spa</html>");
    await fs.mkdir(path.join(staticDir, "assets"));
    await fs.writeFile(
      path.join(staticDir, "assets", "app.js"),
      "console.log('ok');",
    );

    server = new AppServer({ port: 0, staticDir });
  });

  afterEach(async () => {
    await fs.rm(staticDir, { recursive: true, force: true });
  });

  it("serves existing asset files", async () => {
    const res = await request(server, { url: "/assets/app.js" });
    expect(res.statusCode).toBe(200);
    expect(res.getHeader("content-type")).toContain("application/javascript");
  });

  it("returns 404 for missing asset files instead of SPA fallback", async () => {
    const res = await request(server, { url: "/assets/missing.js" });
    expect(res.statusCode).toBe(404);
  });

  it("falls back to index.html for SPA routes", async () => {
    const res = await request(server, { url: "/mappings" });
    expect(res.statusCode).toBe(200);
    expect(res.text()).toContain("<html>spa</html>");
  });

  it("does not serve dotfiles", async () => {
    await fs.writeFile(path.join(staticDir, ".env"), "SECRET=1");
    const res = await request(server, { url: "/.env" });
    expect(res.statusCode).toBe(404);
  });
});

describe("AppServer", () => {
  describe("without state store", () => {
    let server: AppServer;

    beforeEach(() => {
      server = new AppServer({ port: 0, staticDir: "/nonexistent" });
    });

    it("GET /health returns health status", async () => {
      const res = await request(server, { url: "/health" });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({
        status: "starting",
        uptime: expect.any(Number),
        timestamp: expect.any(String),
      });
    });

    it("GET /metrics returns metrics", async () => {
      const res = await request(server, { url: "/metrics" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        totalSyncs: expect.any(Number),
        totalErrors: expect.any(Number),
      });
    });

    it("GET /api/mappings returns 404 without state store", async () => {
      const res = await request(server, { url: "/api/mappings" });
      expect(res.statusCode).toBe(404);
    });

    it("GET /api/cookies returns empty state when cookies file is missing", async () => {
      const res = await request(server, { url: "/api/cookies" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        exists: false,
        cookies: {},
        tld: null,
        region: null,
        presentKeys: [],
        missingKeys: [],
      });
    });

    it("POST /api/cookies/test reports missing cookies file", async () => {
      const onAmazonAuthChecked = vi.fn();
      server = new AppServer({
        port: 0,
        staticDir: "/nonexistent",
        cookiesPath: "/tmp/does-not-exist.json",
        onAmazonAuthChecked,
      });

      const res = await request(server, {
        method: "POST",
        url: "/api/cookies/test",
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        authenticated: false,
        error: "No cookies file found",
      });
      expect(onAmazonAuthChecked).toHaveBeenCalledWith(false);
    });
  });

  describe("with state store", () => {
    let server: AppServer;
    let store: StateStore;

    beforeEach(() => {
      store = new StateStore();
      server = new AppServer({
        port: 0,
        state: store,
        staticDir: "/nonexistent",
      });
    });

    afterEach(() => {
      store.close();
    });

    it("GET /health still works", async () => {
      server.updateMetrics({ status: "healthy" });
      const res = await request(server, { url: "/health" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: "healthy" });
    });

    describe("GET /api/mappings", () => {
      it("returns empty data when no mappings", async () => {
        const res = await request(server, { url: "/api/mappings" });
        const json = res.json() as {
          data: unknown[];
          pagination: { totalItems: number; totalPages: number };
        };
        expect(res.statusCode).toBe(200);
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

        const res = await request(server, {
          url: "/api/mappings?page=1&pageSize=3",
        });
        const json = res.json() as {
          data: unknown[];
          pagination: {
            totalItems: number;
            totalPages: number;
            page: number;
            pageSize: number;
          };
        };
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

        const res = await request(server, {
          url: "/api/mappings?page=2&pageSize=3",
        });
        const json = res.json() as { data: unknown[] };
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

        const res = await request(server, { url: "/api/mappings?search=abc" });
        const json = res.json() as {
          data: Array<{ icloudId: string }>;
          pagination: { totalItems: number };
        };
        expect(json.data).toHaveLength(1);
        expect(json.data[0].icloudId).toBe("photo-abc");
        expect(json.pagination.totalItems).toBe(1);
      });

      it("caps pageSize at 200", async () => {
        const res = await request(server, {
          url: "/api/mappings?pageSize=999",
        });
        const json = res.json() as { pagination: { pageSize: number } };
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

        const res = await request(server, {
          method: "DELETE",
          url: "/api/mappings/ic-1",
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ deleted: 1 });
        expect(store.getMapping("ic-1")).toBeNull();
      });

      it("returns deleted 0 for non-existent mapping", async () => {
        const res = await request(server, {
          method: "DELETE",
          url: "/api/mappings/no-such-id",
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ deleted: 0 });
      });

      it("handles URL-encoded icloudId", async () => {
        store.addMapping({
          icloudId: "id with spaces",
          icloudChecksum: "a",
          amazonId: "az-1",
        });

        const res = await request(server, {
          method: "DELETE",
          url: "/api/mappings/" + encodeURIComponent("id with spaces"),
        });
        expect(res.json()).toEqual({ deleted: 1 });
      });

      it("returns 400 for an empty icloudId", async () => {
        const res = await request(server, {
          method: "DELETE",
          url: "/api/mappings/",
        });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: "Invalid request" });
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

        const res = await request(server, {
          method: "POST",
          url: "/api/mappings/bulk-delete",
          body: JSON.stringify({ icloudIds: ["ic-1", "ic-2"] }),
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ deleted: 2 });
        expect(store.getMapping("ic-1")).toBeNull();
        expect(store.getMapping("ic-2")).toBeNull();
        expect(store.getMapping("ic-3")).not.toBeNull();
      });

      it("returns 400 for invalid JSON", async () => {
        const res = await request(server, {
          method: "POST",
          url: "/api/mappings/bulk-delete",
          body: "not json",
        });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: "Invalid JSON" });
      });

      it("returns 400 when icloudIds is missing", async () => {
        const res = await request(server, {
          method: "POST",
          url: "/api/mappings/bulk-delete",
          body: JSON.stringify({}),
        });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: "icloudIds must be an array" });
      });
    });

    it("returns 404 for unknown paths", async () => {
      const res = await request(server, { url: "/unknown" });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("cookies API", () => {
    let server: AppServer;
    let tempDir: string;
    let cookiesPath: string;
    let onCookiesSaved: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "alexa-photos-cookies-"),
      );
      cookiesPath = path.join(tempDir, "amazon-cookies.json");
      onCookiesSaved = vi.fn();
      server = new AppServer({
        port: 0,
        staticDir: "/nonexistent",
        cookiesPath,
        onCookiesSaved,
      });
    });

    afterEach(async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it("POST /api/cookies saves cookies from the body", async () => {
      const res = await request(server, {
        method: "POST",
        url: "/api/cookies",
        body: JSON.stringify({
          cookies: {
            "session-id": "123456789",
            "ubid-main": "ubid-main-value",
            "at-main": "at-main-value",
          },
        }),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        saved: true,
        exists: true,
        tld: "com",
        region: "US",
        presentKeys: ["session-id", "ubid-main", "at-main"],
        missingKeys: ["x-main", "sess-at-main", "sst-main"],
      });
      expect(onCookiesSaved).toHaveBeenCalledTimes(1);

      const raw = await fs.readFile(cookiesPath, "utf-8");
      expect(JSON.parse(raw)).toEqual({
        "session-id": "123456789",
        "ubid-main": "ubid-main-value",
        "at-main": "at-main-value",
      });
    });

    it("POST /api/cookies returns 400 for a missing payload", async () => {
      const res = await request(server, {
        method: "POST",
        url: "/api/cookies",
        body: JSON.stringify({}),
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'Provide either "cookieString" or "cookies" in the body',
      });
    });

    it("POST /api/cookies validates cookieString content", async () => {
      const res = await request(server, {
        method: "POST",
        url: "/api/cookies",
        body: JSON.stringify({
          cookieString: "session-id=123; ubid-main=456",
        }),
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error:
          "Could not detect region from cookies. Expected at-main (US) or at-acb{tld} (international).",
      });
    });
  });
});
