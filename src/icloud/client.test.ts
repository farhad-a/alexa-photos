import { describe, it, expect, vi, beforeEach } from "vitest";
import { ICloudClient, ICloudPhoto } from "./client.js";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Suppress pino logging in tests
vi.mock("../lib/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe("ICloudClient", () => {
  const ALBUM_TOKEN = "test-token-123";
  let client: ICloudClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new ICloudClient(ALBUM_TOKEN);
  });

  describe("constructor", () => {
    it("builds the correct initial base URL", () => {
      // We can verify by checking what URL discoverPartition fetches
      mockFetch.mockResolvedValueOnce({
        status: 200,
        headers: new Headers(),
      });

      // Trigger a call that uses baseUrl
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ photos: [] }),
      });

      // getPhotos calls discoverPartition then webstream
      client.getPhotos();

      expect(mockFetch).toHaveBeenCalledWith(
        `https://p01-sharedstreams.icloud.com/${ALBUM_TOKEN}/sharedstreams/webstream`,
        expect.objectContaining({ method: "POST", redirect: "manual" }),
      );
    });
  });

  describe("partition discovery", () => {
    it("updates base URL when 330 redirect is returned", async () => {
      const newHost = "p42-sharedstreams.icloud.com";

      // First call (discoverPartition) → 330 redirect
      mockFetch.mockResolvedValueOnce({
        status: 330,
        headers: new Headers({ "X-Apple-MMe-Host": newHost }),
      });

      // Second call (webstream on new host) → empty album
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ photos: [] }),
      });

      const photos = await client.getPhotos();
      expect(photos).toEqual([]);

      // Second fetch should use the new host
      expect(mockFetch.mock.calls[1][0]).toBe(
        `https://${newHost}/${ALBUM_TOKEN}/sharedstreams/webstream`,
      );
    });

    it("keeps original URL when no redirect", async () => {
      // discoverPartition → 200 (no redirect)
      mockFetch.mockResolvedValueOnce({
        status: 200,
        headers: new Headers(),
      });

      // webstream → empty album
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ photos: [] }),
      });

      await client.getPhotos();

      expect(mockFetch.mock.calls[1][0]).toBe(
        `https://p01-sharedstreams.icloud.com/${ALBUM_TOKEN}/sharedstreams/webstream`,
      );
    });
  });

  describe("getPhotos", () => {
    function setupPartitionOk() {
      // discoverPartition → no redirect
      mockFetch.mockResolvedValueOnce({
        status: 200,
        headers: new Headers(),
      });
    }

    it("returns empty array when no photos in album", async () => {
      setupPartitionOk();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ photos: [] }),
      });

      const photos = await client.getPhotos();
      expect(photos).toEqual([]);
    });

    it("maps photos with correct fields and best derivative", async () => {
      setupPartitionOk();

      const webstreamData = {
        photos: [
          {
            photoGuid: "photo-1",
            caption: "Sunset",
            dateCreated: "2024-06-15T10:30:00Z",
            derivatives: {
              thumb: {
                checksum: "chk-thumb",
                fileSize: 1000,
                width: 200,
                height: 150,
              },
              full: {
                checksum: "chk-full",
                fileSize: 5000,
                width: 1920,
                height: 1080,
              },
              medium: {
                checksum: "chk-med",
                fileSize: 3000,
                width: 800,
                height: 600,
              },
            },
          },
        ],
      };

      // webstream
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => webstreamData,
      });

      // webasseturls
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: {
            "chk-full": {
              url_location: "images.example.com",
              url_path: "/path/to/photo.jpg",
            },
          },
        }),
      });

      const photos = await client.getPhotos();
      expect(photos).toHaveLength(1);
      expect(photos[0]).toEqual({
        id: "photo-1",
        checksum: "chk-full",
        url: "https://images.example.com/path/to/photo.jpg",
        width: 1920,
        height: 1080,
        caption: "Sunset",
        dateCreated: new Date("2024-06-15T10:30:00Z"),
      });
    });

    it("filters out photos without valid URLs", async () => {
      setupPartitionOk();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          photos: [
            {
              photoGuid: "photo-good",
              dateCreated: "2024-01-01T00:00:00Z",
              derivatives: {
                full: {
                  checksum: "chk-good",
                  fileSize: 5000,
                  width: 1920,
                  height: 1080,
                },
              },
            },
            {
              photoGuid: "photo-bad",
              dateCreated: "2024-01-02T00:00:00Z",
              derivatives: {
                full: {
                  checksum: "chk-missing",
                  fileSize: 5000,
                  width: 800,
                  height: 600,
                },
              },
            },
          ],
        }),
      });

      // Only chk-good has a URL, chk-missing does not
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: {
            "chk-good": {
              url_location: "images.example.com",
              url_path: "/photo.jpg",
            },
          },
        }),
      });

      const photos = await client.getPhotos();
      expect(photos).toHaveLength(1);
      expect(photos[0].id).toBe("photo-good");
    });

    it("throws on webstream fetch failure", async () => {
      setupPartitionOk();
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      await expect(client.getPhotos()).rejects.toThrow(
        "Failed to fetch webstream: 500",
      );
    });

    it("throws on webasseturls fetch failure", async () => {
      setupPartitionOk();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          photos: [
            {
              photoGuid: "p1",
              dateCreated: "2024-01-01T00:00:00Z",
              derivatives: {
                full: {
                  checksum: "chk",
                  fileSize: 100,
                  width: 100,
                  height: 100,
                },
              },
            },
          ],
        }),
      });
      mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });

      await expect(client.getPhotos()).rejects.toThrow(
        "Failed to fetch asset URLs: 403",
      );
    });
  });

  describe("parseAppleDate (via getPhotos)", () => {
    function setupForDateTest(dateCreated: string | number) {
      // discoverPartition → no redirect
      mockFetch.mockResolvedValueOnce({
        status: 200,
        headers: new Headers(),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          photos: [
            {
              photoGuid: "date-test",
              dateCreated,
              derivatives: {
                full: {
                  checksum: "chk",
                  fileSize: 100,
                  width: 100,
                  height: 100,
                },
              },
            },
          ],
        }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: {
            chk: { url_location: "img.example.com", url_path: "/pic.jpg" },
          },
        }),
      });
    }

    it("parses ISO date strings", async () => {
      setupForDateTest("2017-06-18T21:02:44Z");
      const photos = await client.getPhotos();
      expect(photos[0].dateCreated).toEqual(new Date("2017-06-18T21:02:44Z"));
    });

    it("parses Apple epoch timestamps (as string)", async () => {
      // 2020-01-01T00:00:00Z = 1577836800 unix = 1577836800 - 978307200 = 599529600 apple
      setupForDateTest("599529600");
      const photos = await client.getPhotos();
      expect(photos[0].dateCreated).toEqual(new Date("2020-01-01T00:00:00Z"));
    });
  });

  describe("downloadPhoto", () => {
    it("returns buffer of downloaded photo", async () => {
      const fakeData = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]); // JPEG magic bytes
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => fakeData.buffer,
      });

      const photo: ICloudPhoto = {
        id: "p1",
        checksum: "abc",
        url: "https://images.example.com/photo.jpg",
        width: 1920,
        height: 1080,
        dateCreated: new Date(),
      };

      const buffer = await client.downloadPhoto(photo);
      expect(Buffer.isBuffer(buffer)).toBe(true);
      expect(buffer.length).toBe(4);
      expect(buffer[0]).toBe(0xff);
    });

    it("throws on download failure", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

      const photo: ICloudPhoto = {
        id: "p1",
        checksum: "abc",
        url: "https://images.example.com/missing.jpg",
        width: 100,
        height: 100,
        dateCreated: new Date(),
      };

      await expect(client.downloadPhoto(photo)).rejects.toThrow(
        "Failed to download photo: 404",
      );
    });
  });
});
