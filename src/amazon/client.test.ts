import { describe, it, expect, vi, beforeEach } from "vitest";
import { AmazonClient, AmazonCookies } from "./client.js";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock fs for cookie persistence
vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

// Suppress pino logging in tests
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

function makeUsCookies(): AmazonCookies {
  return {
    "session-id": "133-1234567-8901234",
    "ubid-main": "131-1234567-8901234",
    "at-main": "Atza|fake-token",
    "x-main": "abc123",
    "sess-at-main": "sess-token",
    "sst-main": "sst-token",
  };
}

function makeIntlCookies(tld: string): AmazonCookies {
  return {
    "session-id": "133-9999999-0000000",
    [`ubid-acb${tld}`]: "131-9999999-0000000",
    [`at-acb${tld}`]: "Atza|intl-token",
  };
}

describe("AmazonClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("TLD detection", () => {
    it("detects US from at-main (hyphen)", () => {
      const client = new AmazonClient(makeUsCookies());
      // Verify by checking the drive URL used in requests
      expect(client["driveUrl"]).toBe("https://www.amazon.com/drive/v1");
    });

    it("detects US from at_main (underscore)", () => {
      const cookies: AmazonCookies = {
        "session-id": "123",
        at_main: "Atza|token",
        ubid_main: "131-xxx",
      };
      const client = new AmazonClient(cookies);
      expect(client["driveUrl"]).toBe("https://www.amazon.com/drive/v1");
    });

    it("detects international TLD from at-acb{tld}", () => {
      const client = new AmazonClient(makeIntlCookies("co.uk"));
      expect(client["driveUrl"]).toBe("https://www.amazon.co.uk/drive/v1");
    });

    it("detects German TLD", () => {
      const client = new AmazonClient(makeIntlCookies("de"));
      expect(client["driveUrl"]).toBe("https://www.amazon.de/drive/v1");
    });

    it("defaults to com when no recognizable keys", () => {
      const cookies: AmazonCookies = {
        "session-id": "123",
        "some-other-cookie": "value",
      };
      const client = new AmazonClient(cookies);
      expect(client["driveUrl"]).toBe("https://www.amazon.com/drive/v1");
    });
  });

  describe("CDProxy URL selection", () => {
    it("uses NA endpoint for US", () => {
      const client = new AmazonClient(makeUsCookies());
      expect(client["cdproxyUrl"]).toBe(
        "https://content-na.drive.amazonaws.com/cdproxy/nodes",
      );
    });

    it("uses NA endpoint for Canada", () => {
      const client = new AmazonClient(makeIntlCookies("ca"));
      // ca matches at-acbca → tld = "ca" which is in NORTH_AMERICA_TLDS
      expect(client["cdproxyUrl"]).toBe(
        "https://content-na.drive.amazonaws.com/cdproxy/nodes",
      );
    });

    it("uses EU endpoint for international", () => {
      const client = new AmazonClient(makeIntlCookies("de"));
      expect(client["cdproxyUrl"]).toBe(
        "https://content-eu.drive.amazonaws.com/cdproxy/nodes",
      );
    });
  });

  describe("cookie header", () => {
    it("formats cookies as semicolon-separated key=value pairs", () => {
      const cookies: AmazonCookies = {
        "session-id": "123",
        "at-main": "token",
      };
      const client = new AmazonClient(cookies);
      const header = client["cookieHeader"];
      expect(header).toContain("session-id=123");
      expect(header).toContain("at-main=token");
      expect(header).toContain("; ");
    });
  });

  describe("headers", () => {
    it("includes Cookie, User-Agent, and x-amzn-sessionid", () => {
      const client = new AmazonClient(makeUsCookies());
      const h = client["headers"];
      expect(h["Cookie"]).toBeDefined();
      expect(h["User-Agent"]).toContain("Mozilla");
      expect(h["x-amzn-sessionid"]).toBe("133-1234567-8901234");
    });
  });

  describe("buildUrl", () => {
    it("includes base params on every request", () => {
      const client = new AmazonClient(makeUsCookies());
      const url = client["buildUrl"]("https://www.amazon.com/drive/v1/nodes");
      const parsed = new URL(url);
      expect(parsed.searchParams.get("asset")).toBe("ALL");
      expect(parsed.searchParams.get("tempLink")).toBe("false");
      expect(parsed.searchParams.get("resourceVersion")).toBe("V2");
      expect(parsed.searchParams.get("ContentType")).toBe("JSON");
    });

    it("merges additional params", () => {
      const client = new AmazonClient(makeUsCookies());
      const url = client["buildUrl"]("https://www.amazon.com/drive/v1/nodes", {
        filters: "isRoot:true",
        limit: "10",
      });
      const parsed = new URL(url);
      expect(parsed.searchParams.get("filters")).toBe("isRoot:true");
      expect(parsed.searchParams.get("limit")).toBe("10");
      expect(parsed.searchParams.get("asset")).toBe("ALL");
    });
  });

  describe("checkAuth", () => {
    it("returns true on 200 OK", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });
      const client = new AmazonClient(makeUsCookies());
      const ok = await client.checkAuth();
      expect(ok).toBe(true);
    });

    it("returns false on 401", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
      const client = new AmazonClient(makeUsCookies());
      const ok = await client.checkAuth();
      expect(ok).toBe(false);
    });

    it("returns false on 503 (bot detection)", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
      const client = new AmazonClient(makeUsCookies());
      const ok = await client.checkAuth();
      expect(ok).toBe(false);
    });

    it("returns false on network error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("network error"));
      const client = new AmazonClient(makeUsCookies());
      const ok = await client.checkAuth();
      expect(ok).toBe(false);
    });
  });

  describe("getRoot", () => {
    it("returns root node and caches rootNodeId", async () => {
      const rootNode = {
        id: "root-123",
        name: "root",
        kind: "FOLDER",
        status: "AVAILABLE",
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [rootNode] }),
        text: async () => "",
      });

      const client = new AmazonClient(makeUsCookies());
      const root = await client.getRoot();
      expect(root.id).toBe("root-123");
      expect(client["rootNodeId"]).toBe("root-123");
    });

    it("throws when no root node found", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
        text: async () => "",
      });

      const client = new AmazonClient(makeUsCookies());
      await expect(client.getRoot()).rejects.toThrow("Failed to get root node");
    });
  });

  describe("findAlbum", () => {
    it("finds album by exact name", async () => {
      const albums = [
        {
          id: "a1",
          name: "Vacation",
          kind: "VISUAL_COLLECTION",
          status: "AVAILABLE",
        },
        {
          id: "a2",
          name: "Echo Show",
          kind: "VISUAL_COLLECTION",
          status: "AVAILABLE",
        },
      ];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: albums }),
        text: async () => "",
      });

      const client = new AmazonClient(makeUsCookies());
      const album = await client.findAlbum("Echo Show");
      expect(album?.id).toBe("a2");
      expect(album?.name).toBe("Echo Show");
    });

    it("returns null when album not found", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
        text: async () => "",
      });

      const client = new AmazonClient(makeUsCookies());
      const album = await client.findAlbum("Nonexistent");
      expect(album).toBeNull();
    });
  });

  describe("findOrCreateAlbum", () => {
    it("returns existing album ID if found", async () => {
      const albums = [
        {
          id: "existing-id",
          name: "Echo Show",
          kind: "VISUAL_COLLECTION",
          status: "AVAILABLE",
        },
      ];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: albums }),
        text: async () => "",
      });

      const client = new AmazonClient(makeUsCookies());
      const id = await client.findOrCreateAlbum("Echo Show");
      expect(id).toBe("existing-id");
    });

    it("creates album if not found", async () => {
      // findAlbum → no match
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
        text: async () => "",
      });
      // createAlbum → new album
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          id: "new-album-id",
          name: "Echo Show",
          kind: "VISUAL_COLLECTION",
          status: "AVAILABLE",
        }),
        text: async () => "",
      });

      const client = new AmazonClient(makeUsCookies());
      const id = await client.findOrCreateAlbum("Echo Show");
      expect(id).toBe("new-album-id");
    });
  });

  describe("deleteNodes", () => {
    it("calls trash then purge", async () => {
      // trash
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => "",
      });
      // purge
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => "",
      });

      const client = new AmazonClient(makeUsCookies());
      await client.deleteNodes(["node-1", "node-2"]);

      // Verify trash was called with PATCH
      expect(mockFetch.mock.calls[0][1].method).toBe("PATCH");
      const trashBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(trashBody.value).toEqual(["node-1", "node-2"]);

      // Verify purge was called with POST
      expect(mockFetch.mock.calls[1][1].method).toBe("POST");
      const purgeBody = JSON.parse(mockFetch.mock.calls[1][1].body as string);
      expect(purgeBody.nodeIds).toEqual(["node-1", "node-2"]);
    });
  });

  describe("md5", () => {
    it("computes correct MD5 hash", () => {
      const buffer = Buffer.from("hello world");
      const hash = AmazonClient.md5(buffer);
      expect(hash).toBe("5eb63bbbe01eeed093cb22bb8f5acdc3");
    });
  });

  describe("request retry logic", () => {
    it("throws immediately on 401 when autoRefresh is disabled", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => "Unauthorized",
      });

      const client = new AmazonClient(makeUsCookies(), { autoRefresh: false });
      await expect(
        client["request"]("GET", "https://www.amazon.com/drive/v1/nodes"),
      ).rejects.toThrow("auth failed");

      // Should only have been called once (no retries on 401 when autoRefresh is off)
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("returns 409 without retrying", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({ id: "dup-node" }),
      });

      const client = new AmazonClient(makeUsCookies());
      const res = await client["request"](
        "POST",
        "https://www.amazon.com/drive/v1/nodes",
      );
      expect(res.status).toBe(409);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("cookie refresh", () => {
    it("attempts to refresh on 401 when autoRefresh is enabled", async () => {
      // First call: 401 error
      // Second call: refresh endpoint (will also fail in this test)
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          text: async () => "Unauthorized",
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          text: async () => "Refresh failed",
        });

      const client = new AmazonClient(makeUsCookies(), { autoRefresh: true });
      await expect(
        client["request"]("GET", "https://www.amazon.com/drive/v1/nodes"),
      ).rejects.toThrow("auth failed");

      // Should have been called twice: original request + refresh attempt
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Second call should be to the refresh endpoint
      const refreshCall = mockFetch.mock.calls[1];
      expect(refreshCall[0]).toContain("/ap/exchangetoken/refresh");
    });

    it("skips refresh when sess-at-main is missing", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => "Unauthorized",
      });

      const cookies: AmazonCookies = {
        "session-id": "123",
        "ubid-main": "456",
        "at-main": "Atza|token",
        // Missing sess-at-main and sst-main
      };

      const client = new AmazonClient(cookies, { autoRefresh: true });
      await expect(
        client["request"]("GET", "https://www.amazon.com/drive/v1/nodes"),
      ).rejects.toThrow("auth failed");

      // Should only call once (original request, no refresh attempt)
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("retries request after successful token refresh", async () => {
      // First call: 401 error
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => "Unauthorized",
      });

      // Second call: successful refresh
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: {
            tokens: {
              cookies: [{ Name: "at-main", Value: "Atza|new-token" }],
            },
          },
        }),
      });

      // Third call: retry original request with new token
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      const client = new AmazonClient(makeUsCookies(), {
        autoRefresh: true,
        cookiesPath: "/tmp/test-cookies.json",
      });

      const result = await client["request"](
        "GET",
        "https://www.amazon.com/drive/v1/nodes",
      );

      expect(result.ok).toBe(true);
      // Should have been called 3 times: original + refresh + retry
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });

  describe("addToAlbumIfNotPresent", () => {
    it("adds nodes that are not already in the album", async () => {
      const client = new AmazonClient(makeUsCookies());

      // Mock getAlbumNodeIds - album already contains node-1 and node-2
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ id: "node-1" }, { id: "node-2" }],
        }),
      });

      // Mock addToAlbum (PATCH request) - should only add node-3
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      const result = await client.addToAlbumIfNotPresent("album-123", [
        "node-1",
        "node-2",
        "node-3",
      ]);

      expect(result).toEqual({ added: 1, skipped: 2 });
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Verify the PATCH was called with only node-3
      const patchCall = mockFetch.mock.calls[1];
      const body = JSON.parse(patchCall[1]?.body as string);
      expect(body.value).toEqual(["node-3"]);
    });

    it("skips all nodes if they're already in the album", async () => {
      const client = new AmazonClient(makeUsCookies());

      // Mock getAlbumNodeIds - album already contains all nodes
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ id: "node-1" }, { id: "node-2" }],
        }),
      });

      const result = await client.addToAlbumIfNotPresent("album-123", [
        "node-1",
        "node-2",
      ]);

      expect(result).toEqual({ added: 0, skipped: 2 });
      // Should only call getAlbumNodeIds, not addToAlbum
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("adds all nodes if album is empty", async () => {
      const client = new AmazonClient(makeUsCookies());

      // Mock getAlbumNodeIds - empty album
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [] }),
      });

      // Mock addToAlbum
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      const result = await client.addToAlbumIfNotPresent("album-123", [
        "node-1",
        "node-2",
      ]);

      expect(result).toEqual({ added: 2, skipped: 0 });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("handles empty nodeIds array", async () => {
      const client = new AmazonClient(makeUsCookies());

      const result = await client.addToAlbumIfNotPresent("album-123", []);

      expect(result).toEqual({ added: 0, skipped: 0 });
      expect(mockFetch).toHaveBeenCalledTimes(0);
    });
  });
});
