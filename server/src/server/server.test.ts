import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "http";
import { AppServer } from "./index.js";
import { resetAppLinksCache } from "./services/links.js";
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

// Override DB_PATH to use in-memory database.
//
// better-sqlite3 is `export = Database`, so `typeof import("better-sqlite3")`
// is the constructor itself and has no `.default`. ESM interop does supply one
// at runtime, so describe what interop actually hands back rather than casting.
vi.mock("better-sqlite3", async (importOriginal) => {
  const mod = await importOriginal<{
    default: typeof import("better-sqlite3");
  }>();
  return {
    default: class extends mod.default {
      constructor() {
        super(":memory:");
      }
    },
  };
});

// The Amazon routes are thin. Mock the layers beneath them so no test starts
// a login proxy or touches the network.
const amazonSvc = vi.hoisted(() => ({
  readAmazonStatus: vi.fn(),
  testAmazonAuth: vi.fn(),
  refreshAmazonCookies: vi.fn(),
}));
vi.mock("./services/amazon.js", () => amazonSvc);

const amazonReg = vi.hoisted(() => ({
  beginRegistration: vi.fn(),
  cancelRegistration: vi.fn(async () => undefined),
  // Typed from the real export. Inferring from a `{ state: "idle" }` default
  // would pin the return type to that shape and reject the optional fields.
  getRegistrationStatus: vi.fn<
    (typeof import("../amazon/registration.js"))["getRegistrationStatus"]
  >(() => ({ state: "idle" })),
  removeRegistration: vi.fn(async () => undefined),
}));
vi.mock("../amazon/registration.js", () => amazonReg);

// The links service resolves the album node id through a real client. Mock the
// constructor-side helper so no test reaches Amazon.
const amazonClient = vi.hoisted(() => ({
  findAlbum: vi.fn(),
  close: vi.fn(async () => undefined),
  fromCredentials: vi.fn(),
}));
vi.mock("../amazon/client.js", () => ({
  AmazonClient: { fromCredentials: amazonClient.fromCredentials },
}));

class MockResponse {
  statusCode = 200;
  headersSent = false;
  body = Buffer.alloc(0);
  private headers = new Map<string, string>();

  setHeader(name: string, value: string): void {
    this.headers.set(name.toLowerCase(), value);
  }

  removeHeader(name: string): void {
    this.headers.delete(name.toLowerCase());
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

const REGISTRATION_SETTINGS = {
  authPath: "./data/amazon-auth.json",
  amazonPage: "amazon.com",
  acceptLanguage: "en-US",
  proxyLanguage: "en_US",
  deviceAppName: "alexa-photos",
  proxyOwnIp: "192.168.1.50",
  proxyPort: 3456,
  proxyListenBind: "0.0.0.0",
  timeoutMs: 1000,
  adminPort: 3000,
};

describe("Amazon account API", () => {
  let server: AppServer;

  beforeEach(() => {
    vi.clearAllMocks();
    amazonReg.getRegistrationStatus.mockReturnValue({ state: "idle" });
    server = new AppServer({
      port: 0,
      amazonAuthPath: "./data/amazon-auth.json",
      registrationSettings: REGISTRATION_SETTINGS,
    });
  });

  it("reports an unregistered device with 200, not 404", async () => {
    // Missing credentials are a state the UI renders, not an error.
    amazonSvc.readAmazonStatus.mockResolvedValue({
      registered: false,
      state: "idle",
    });

    const res = await request(server, { url: "/api/amazon/status" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ registered: false });
  });

  it("returns the proxy URL when registration starts", async () => {
    amazonReg.beginRegistration.mockReturnValue({
      state: "awaiting_login",
      proxyUrl: "http://192.168.1.50:3456/",
      expiresAt: "2026-09-09T01:00:00.000Z",
    });

    const res = await request(server, {
      method: "POST",
      url: "/api/amazon/registration/start",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ proxyUrl: "http://192.168.1.50:3456/" });
    expect(amazonReg.beginRegistration).toHaveBeenCalledWith(
      REGISTRATION_SETTINGS,
    );
  });

  it("conflicts when a registration is already running", async () => {
    amazonReg.beginRegistration.mockImplementation(() => {
      throw Object.assign(new Error("A registration is already in progress"), {
        code: "REGISTRATION_IN_PROGRESS",
      });
    });

    const res = await request(server, {
      method: "POST",
      url: "/api/amazon/registration/start",
    });

    expect(res.statusCode).toBe(409);
  });

  it("explains an unusable proxy address rather than failing silently", async () => {
    amazonReg.beginRegistration.mockImplementation(() => {
      throw new Error(
        "Set AMAZON_PROXY_OWN_IP to an IP your browser can reach",
      );
    });

    const res = await request(server, {
      method: "POST",
      url: "/api/amazon/registration/start",
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain(
      "AMAZON_PROXY_OWN_IP",
    );
  });

  it("refuses to start when registration is not configured", async () => {
    const bare = new AppServer({ port: 0 });

    const res = await request(bare, {
      method: "POST",
      url: "/api/amazon/registration/start",
    });

    expect(res.statusCode).toBe(503);
  });

  it("exposes registration progress for polling", async () => {
    amazonReg.getRegistrationStatus.mockReturnValue({
      state: "awaiting_login",
      proxyUrl: "http://192.168.1.50:3456/",
    });

    const res = await request(server, {
      url: "/api/amazon/registration/status",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ state: "awaiting_login" });
  });

  it("cancels an in-flight registration", async () => {
    const res = await request(server, {
      method: "POST",
      url: "/api/amazon/registration/cancel",
    });

    expect(res.statusCode).toBe(200);
    expect(amazonReg.cancelRegistration).toHaveBeenCalled();
  });

  it("removes a stored registration", async () => {
    const res = await request(server, {
      method: "DELETE",
      url: "/api/amazon/registration",
    });

    expect(res.statusCode).toBe(200);
    expect(amazonReg.removeRegistration).toHaveBeenCalledWith(
      "./data/amazon-auth.json",
    );
  });

  it("feeds an auth test back into the health metrics", async () => {
    const onAmazonAuthChecked = vi.fn();
    const wired = new AppServer({
      port: 0,
      amazonAuthPath: "./data/amazon-auth.json",
      onAmazonAuthChecked,
    });
    amazonSvc.testAmazonAuth.mockResolvedValue({
      authenticated: true,
      state: "ok",
      actionable: false,
    });

    const res = await request(wired, {
      method: "POST",
      url: "/api/amazon/auth/test",
    });

    expect(res.statusCode).toBe(200);
    expect(onAmazonAuthChecked).toHaveBeenCalledWith(true);
  });

  it("forces a refresh and reports the new cookie timestamp", async () => {
    amazonSvc.refreshAmazonCookies.mockResolvedValue({
      refreshed: true,
      cookiesUpdatedAt: "2026-09-09T00:00:00.000Z",
    });

    const res = await request(server, {
      method: "POST",
      url: "/api/amazon/auth/refresh",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ refreshed: true });
  });

  it("conflicts on refresh when no device is registered", async () => {
    amazonSvc.refreshAmazonCookies.mockRejectedValue(
      Object.assign(new Error("missing"), { code: "ENOENT" }),
    );

    const res = await request(server, {
      method: "POST",
      url: "/api/amazon/auth/refresh",
    });

    expect(res.statusCode).toBe(409);
  });
});

describe("GET /api/links", () => {
  const LINK_SETTINGS = {
    githubUrl: "https://github.com/farhad-a/alexa-photos",
    icloudAlbumToken: "B0Xabc123",
    amazonAlbumName: "Echo Show",
    amazonMarketplace: "amazon.com",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // The node id is cached for the process lifetime, so each test starts clean.
    resetAppLinksCache();
    amazonSvc.readAmazonStatus.mockResolvedValue({
      registered: true,
      state: "registered",
    });
    amazonClient.fromCredentials.mockResolvedValue(amazonClient);
  });

  function serverWithLinks(): AppServer {
    return new AppServer({
      port: 0,
      staticDir: "/nonexistent",
      amazonAuthPath: "./data/amazon-auth.json",
      linkSettings: LINK_SETTINGS,
    });
  }

  it("deep-links to the album and builds the iCloud URL from the token", async () => {
    amazonClient.findAlbum.mockResolvedValue({
      id: "node-42",
      name: "Echo Show",
    });

    const res = await request(serverWithLinks(), { url: "/api/links" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      githubUrl: "https://github.com/farhad-a/alexa-photos",
      icloudAlbumUrl: "https://www.icloud.com/sharedalbum/#B0Xabc123",
      amazonAlbumUrl: "https://www.amazon.com/photos/album/node-42",
      amazonAlbumName: "Echo Show",
    });
  });

  it("falls back to the albums list when no device is registered", async () => {
    // The sidebar still has to render, so a missing credential file is a
    // degraded link, not a 500.
    const enoent: NodeJS.ErrnoException = new Error("no such file");
    enoent.code = "ENOENT";
    amazonClient.fromCredentials.mockRejectedValue(enoent);

    const res = await request(serverWithLinks(), { url: "/api/links" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      amazonAlbumUrl: "https://www.amazon.com/photos/albums",
    });
  });

  it("falls back to the albums list when the album does not exist yet", async () => {
    amazonClient.findAlbum.mockResolvedValue(null);

    const res = await request(serverWithLinks(), { url: "/api/links" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      amazonAlbumUrl: "https://www.amazon.com/photos/albums",
    });
  });

  it("prefers the registration record's marketplace over the configured one", async () => {
    amazonSvc.readAmazonStatus.mockResolvedValue({
      registered: true,
      state: "registered",
      marketplace: "amazon.co.uk",
    });
    amazonClient.findAlbum.mockResolvedValue({
      id: "node-42",
      name: "Echo Show",
    });

    const res = await request(serverWithLinks(), { url: "/api/links" });

    expect(res.json()).toMatchObject({
      amazonAlbumUrl: "https://www.amazon.co.uk/photos/album/node-42",
    });
  });

  it("returns 503 when links are not configured", async () => {
    const server = new AppServer({ port: 0, staticDir: "/nonexistent" });

    const res = await request(server, { url: "/api/links" });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "Links are not configured" });
  });

  it("is not readable cross-origin", async () => {
    // The response carries the iCloud album token, a capability URL. The
    // router's blanket wildcard would hand it to any site the admin visits.
    amazonClient.findAlbum.mockResolvedValue({
      id: "node-42",
      name: "Echo Show",
    });

    const res = await request(serverWithLinks(), { url: "/api/links" });
    const mappings = await request(serverWithLinks(), { url: "/metrics" });

    expect(res.getHeader("Access-Control-Allow-Origin")).toBeUndefined();
    // Still set for the routes that carry nothing sensitive.
    expect(mappings.getHeader("Access-Control-Allow-Origin")).toBe("*");
  });

  it("caches a hit so repeat requests do not re-query Amazon", async () => {
    amazonClient.findAlbum.mockResolvedValue({
      id: "node-42",
      name: "Echo Show",
    });
    const server = serverWithLinks();

    await request(server, { url: "/api/links" });
    await request(server, { url: "/api/links" });

    expect(amazonClient.findAlbum).toHaveBeenCalledTimes(1);
  });

  it("caches a miss, so the pre-first-sync state does not refetch every render", async () => {
    amazonClient.findAlbum.mockResolvedValue(null);
    const server = serverWithLinks();

    await request(server, { url: "/api/links" });
    await request(server, { url: "/api/links" });

    expect(amazonClient.findAlbum).toHaveBeenCalledTimes(1);
  });

  it("retries a miss once the negative entry expires", async () => {
    // The album is created by the first sync, so a miss must not pin the
    // generic link for the life of the process.
    vi.useFakeTimers();
    try {
      amazonClient.findAlbum.mockResolvedValue(null);
      const server = serverWithLinks();

      await request(server, { url: "/api/links" });
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);

      amazonClient.findAlbum.mockResolvedValue({
        id: "node-42",
        name: "Echo Show",
      });
      const res = await request(server, { url: "/api/links" });

      expect(amazonClient.findAlbum).toHaveBeenCalledTimes(2);
      expect(res.json()).toMatchObject({
        amazonAlbumUrl: "https://www.amazon.com/photos/album/node-42",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

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
      server = new AppServer({
        port: 0,
        staticDir: "/nonexistent",
      });
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
        totalPhotosAdded: expect.any(Number),
        totalPhotosRemoved: expect.any(Number),
      });
    });

    it("GET /api/mappings returns 404 without state store", async () => {
      const res = await request(server, { url: "/api/mappings" });
      expect(res.statusCode).toBe(404);
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

  describe("POST /api/sync", () => {
    it("returns 503 until sync controls are configured on the same server instance", async () => {
      const onSyncRequested = vi.fn().mockResolvedValue(undefined);
      const isSyncRunning = vi.fn().mockReturnValue(false);
      const server = new AppServer({ port: 0, staticDir: "/nonexistent" });

      const before = await request(server, {
        method: "POST",
        url: "/api/sync",
      });
      expect(before.statusCode).toBe(503);
      expect(before.json()).toEqual({ error: "Sync trigger not configured" });

      server.setSyncControls({ onSyncRequested, isSyncRunning });

      const after = await request(server, { method: "POST", url: "/api/sync" });
      await new Promise((resolve) => setImmediate(resolve));

      expect(after.statusCode).toBe(202);
      expect(after.json()).toEqual({ triggered: true });
      expect(isSyncRunning).toHaveBeenCalledTimes(1);
      expect(onSyncRequested).toHaveBeenCalledTimes(1);
    });

    it("triggers a sync when idle and returns 202", async () => {
      const onSyncRequested = vi.fn().mockResolvedValue(undefined);
      const isSyncRunning = vi.fn().mockReturnValue(false);
      const server = new AppServer({
        port: 0,
        staticDir: "/nonexistent",
        onSyncRequested,
        isSyncRunning,
      });

      const res = await request(server, { method: "POST", url: "/api/sync" });
      await new Promise((resolve) => setImmediate(resolve));

      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ triggered: true });
      expect(isSyncRunning).toHaveBeenCalledTimes(1);
      expect(onSyncRequested).toHaveBeenCalledTimes(1);
    });

    it("returns 409 when a sync is already running and does not invoke trigger", async () => {
      const onSyncRequested = vi.fn();
      const isSyncRunning = vi.fn().mockReturnValue(true);
      const server = new AppServer({
        port: 0,
        staticDir: "/nonexistent",
        onSyncRequested,
        isSyncRunning,
      });

      const res = await request(server, { method: "POST", url: "/api/sync" });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: "Sync already in progress" });
      expect(onSyncRequested).not.toHaveBeenCalled();
    });

    it("returns 503 when no trigger is configured", async () => {
      const server = new AppServer({ port: 0, staticDir: "/nonexistent" });

      const res = await request(server, { method: "POST", url: "/api/sync" });

      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: "Sync trigger not configured" });
    });
  });
});
