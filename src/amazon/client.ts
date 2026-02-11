import { logger } from "../lib/logger.js";
import { createHash } from "crypto";
import * as fs from "fs/promises";
import { NotificationService } from "../lib/notifications.js";

export interface NotificationCallback {
  (message: string, level: "error" | "warning" | "info"): Promise<void>;
}

/**
 * Amazon Photos REST API client
 *
 * Ported from: https://github.com/trevorhobenshield/amazon_photos
 * Uses the undocumented Amazon Drive v1 API with cookie-based authentication.
 */

const COOKIES_PATH = "./data/amazon-cookies.json";

const NORTH_AMERICA_TLDS = new Set(["com", "ca", "com.mx", "com.br"]);

const MAX_TRASH_BATCH = 50;

export interface AmazonNode {
  id: string;
  name: string;
  kind: string;
  status: string;
  contentProperties?: {
    md5: string;
    size: number;
    contentType: string;
    extension: string;
  };
  parents?: string[];
  createdDate?: string;
  modifiedDate?: string;
}

export interface AmazonCookies {
  "session-id": string;
  [key: string]: string;
}

export class AmazonClient {
  private cookies: AmazonCookies;
  private tld: string;
  private driveUrl: string;
  private cdproxyUrl: string;
  private baseParams: Record<string, string>;
  private sessionId: string;
  private rootNodeId: string | null = null;
  private cookiesPath: string;
  private autoRefresh: boolean;
  private notificationCallback?: NotificationCallback;
  private notificationService?: NotificationService;

  constructor(
    cookies: AmazonCookies,
    options: {
      cookiesPath?: string;
      autoRefresh?: boolean;
      notificationCallback?: NotificationCallback;
      notificationService?: NotificationService;
    } = {},
  ) {
    this.cookies = cookies;
    this.tld = this.determineTld(cookies);
    this.driveUrl = `https://www.amazon.${this.tld}/drive/v1`;
    this.cdproxyUrl = this.determineCdproxy();
    this.sessionId = cookies["session-id"];
    this.cookiesPath = options.cookiesPath || COOKIES_PATH;
    this.autoRefresh = options.autoRefresh ?? true;
    this.notificationCallback = options.notificationCallback;
    this.notificationService = options.notificationService;
    this.baseParams = {
      asset: "ALL",
      tempLink: "false",
      resourceVersion: "V2",
      ContentType: "JSON",
    };
  }

  /**
   * Load cookies from JSON file on disk.
   *
   * Expected format (US):
   * ```json
   * {
   *   "session-id": "...",
   *   "ubid-main": "...",
   *   "at-main": "...",
   *   "x-main": "...",
   *   "sess-at-main": "...",
   *   "sst-main": "..."
   * }
   * ```
   */
  static async fromFile(
    cookiePath = COOKIES_PATH,
    autoRefresh = true,
    notificationCallback?: NotificationCallback,
    notificationService?: NotificationService,
  ): Promise<AmazonClient> {
    const raw = await fs.readFile(cookiePath, "utf-8");
    const cookies = JSON.parse(raw) as AmazonCookies;
    return new AmazonClient(cookies, {
      cookiesPath: cookiePath,
      autoRefresh,
      notificationCallback,
      notificationService,
    });
  }

  /**
   * Determine TLD from cookie key names.
   * US cookies: `at-main` or `at_main` (hyphen or underscore).
   * International: `at-acb{tld}`.
   */
  private determineTld(cookies: AmazonCookies): string {
    for (const key of Object.keys(cookies)) {
      if (key.endsWith("-main") || key.endsWith("_main")) return "com";
      if (key.startsWith("at-acb")) return key.slice("at-acb".length);
    }
    return "com";
  }

  private determineCdproxy(): string {
    if (NORTH_AMERICA_TLDS.has(this.tld)) {
      return "https://content-na.drive.amazonaws.com/cdproxy/nodes";
    }
    return "https://content-eu.drive.amazonaws.com/cdproxy/nodes";
  }

  private get cookieHeader(): string {
    return Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  private get headers(): Record<string, string> {
    return {
      Cookie: this.cookieHeader,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "x-amzn-sessionid": this.sessionId,
    };
  }

  private buildUrl(base: string, params: Record<string, string> = {}): string {
    const url = new URL(base);
    const allParams = { ...this.baseParams, ...params };
    for (const [key, value] of Object.entries(allParams)) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  /**
   * Make a request with exponential backoff retry.
   */
  private async request(
    method: string,
    url: string,
    options: {
      body?: BodyInit;
      headers?: Record<string, string>;
      params?: Record<string, string>;
    } = {},
    maxRetries = 3,
  ): Promise<Response> {
    const fullUrl = this.buildUrl(url, options.params);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const res = await fetch(fullUrl, {
        method,
        headers: { ...this.headers, ...options.headers },
        body: options.body,
      });

      if (res.status === 401) {
        // Try to refresh cookies automatically
        if (this.autoRefresh && attempt === 0) {
          logger.info("Token expired, attempting automatic refresh...");
          const refreshed = await this.refreshCookies();
          if (refreshed) {
            logger.info("Cookies refreshed successfully, retrying request");
            continue; // Retry the request with new cookies
          }
        }
        logger.error("Amazon cookies expired — update your cookies file");
        throw new Error(
          `Amazon Photos auth failed — update ${this.cookiesPath} with fresh cookies.`,
        );
      }

      if (res.status === 409) return res; // conflict (duplicate) — not an error

      if (res.ok) return res;

      if (attempt < maxRetries) {
        const delay = Math.min(Math.random() * 2 ** attempt * 1000, 20_000);
        logger.warn(
          { status: res.status, attempt, delay: Math.round(delay) },
          "Request failed, retrying",
        );
        await new Promise((r) => setTimeout(r, delay));
      } else {
        const text = await res.text().catch(() => "");
        throw new Error(`Amazon API ${method} ${url} → ${res.status} ${text}`);
      }
    }
    throw new Error("unreachable");
  }

  /**
   * Attempt to refresh the authentication token using session cookies.
   * Returns true if refresh was successful, false otherwise.
   */
  private async refreshCookies(): Promise<boolean> {
    try {
      // Check if we have the necessary session tokens
      const sessAt = this.cookies["sess-at-main"];
      const sst = this.cookies["sst-main"];
      const xMain = this.cookies["x-main"];

      if (!sessAt || !sst) {
        logger.warn(
          "Cannot auto-refresh: sess-at-main or sst-main not available",
        );
        return false;
      }

      logger.debug("Attempting to exchange session token for new at-main");

      // Amazon's token exchange endpoint
      const exchangeUrl = `https://www.amazon.${this.tld}/ap/exchangetoken/refresh`;

      const formData = new URLSearchParams({
        app_name: "Amazon Drive",
        requested_token_type: "auth_cookies",
        domain: `.amazon.${this.tld}`,
        source_token_type: "refresh_token",
        source_token: sessAt,
      });

      const response = await fetch(exchangeUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `sess-at-main=${sessAt}; sst-main=${sst}${xMain ? `; x-main=${xMain}` : ""}`,
          "User-Agent": this.headers["User-Agent"],
        },
        body: formData.toString(),
      });

      if (!response.ok) {
        logger.warn(
          { status: response.status },
          "Token refresh failed — manual re-authentication required",
        );
        await this.notificationCallback?.(
          "Amazon Photos cookies expired and auto-refresh failed. Please run: npm run amazon:setup",
          "error",
        );
        return false;
      }

      const data = await response.json();

      // Extract new at-main token from response
      if (
        data.response?.tokens?.cookies &&
        Array.isArray(data.response.tokens.cookies)
      ) {
        for (const cookie of data.response.tokens.cookies) {
          if (cookie.Name === "at-main" && cookie.Value) {
            // Update in-memory cookies
            this.cookies["at-main"] = cookie.Value;

            // Persist to disk
            await fs.writeFile(
              this.cookiesPath,
              JSON.stringify(this.cookies, null, 2),
              "utf-8",
            );

            logger.info("Successfully refreshed at-main token");

            // Clear notification throttle so future failures trigger new alerts
            this.notificationService?.clearAlertThrottle(
              "Amazon Photos cookies expired and auto-refresh failed. Please run: npm run amazon:setup",
              "error",
            );

            return true;
          }
        }
      }

      logger.warn("Token refresh response missing at-main cookie");
      return false;
    } catch (error) {
      logger.error({ error }, "Cookie refresh failed");
      return false;
    }
  }

  // ── public API ─────────────────────────────────────────────

  /** Verify that cookies are still valid */
  async checkAuth(): Promise<boolean> {
    try {
      const res = await fetch(this.buildUrl(`${this.driveUrl}/account/info`), {
        headers: this.headers,
      });
      if (res.ok) return true;
      if (res.status === 503) {
        logger.warn(
          "Got 503 from Amazon (bot detection). " +
            "This may happen from cloud/datacenter IPs. " +
            "The service should work from a residential network.",
        );
      }
      return false;
    } catch {
      return false;
    }
  }

  /** Get root node of Amazon Drive */
  async getRoot(): Promise<AmazonNode> {
    const res = await this.request("GET", `${this.driveUrl}/nodes`, {
      params: { filters: "isRoot:true" },
    });
    const data = await res.json();
    const root = data.data?.[0];
    if (!root) throw new Error("Failed to get root node");
    this.rootNodeId = root.id;
    return root;
  }

  /** Search for media using the search endpoint (supports type, things, time, location filters) */
  async search(
    filters: string,
    limit = 200,
    offset = 0,
  ): Promise<{ data: AmazonNode[]; count: number }> {
    const res = await this.request("GET", `${this.driveUrl}/search`, {
      params: {
        filters,
        limit: String(limit),
        offset: String(offset),
        searchContext: "all",
      },
    });
    return res.json();
  }

  /** Query nodes using the nodes endpoint (supports kind, name, isRoot, status, parentIds filters) */
  async getNodes(
    filters: string,
    limit = 200,
    offset = 0,
  ): Promise<{ data: AmazonNode[]; count: number }> {
    const res = await this.request("GET", `${this.driveUrl}/nodes`, {
      params: {
        filters,
        limit: String(limit),
        offset: String(offset),
      },
    });
    return res.json();
  }

  /** List children of a node */
  async listChildren(
    nodeId: string,
    filters = "",
    limit = 200,
    offset = 0,
  ): Promise<{ data: AmazonNode[]; count: number }> {
    const params: Record<string, string> = {
      limit: String(limit),
      offset: String(offset),
    };
    if (filters) params.filters = filters;

    const res = await this.request(
      "GET",
      `${this.driveUrl}/nodes/${nodeId}/children`,
      { params },
    );
    return res.json();
  }

  /**
   * Upload a photo buffer to Amazon Photos.
   * Returns the created node (includes `.id`).
   */
  async uploadPhoto(
    buffer: Buffer,
    filename: string,
    parentNodeId?: string,
  ): Promise<AmazonNode> {
    if (!parentNodeId) {
      if (!this.rootNodeId) await this.getRoot();
      parentNodeId = this.rootNodeId!;
    }

    logger.debug({ filename, parentNodeId }, "Uploading photo");

    const res = await fetch(
      this.buildUrl(this.cdproxyUrl, {
        name: filename,
        kind: "FILE",
        parentNodeId,
      }),
      {
        method: "POST",
        headers: {
          ...this.headers,
          "Content-Type": "application/octet-stream",
          "Content-Length": String(buffer.length),
        },
        body: new Uint8Array(buffer),
      },
    );

    if (res.status === 409) {
      // File with identical MD5 already exists
      const data = await res.json();
      logger.debug({ filename, nodeId: data.id }, "Duplicate — already exists");
      return data;
    }

    if (res.status === 401) {
      // Try to refresh and retry once
      if (this.autoRefresh) {
        logger.info("Upload auth failed, attempting refresh...");
        const refreshed = await this.refreshCookies();
        if (refreshed) {
          logger.info("Retrying upload with refreshed cookies");
          // Retry upload with new cookies
          return this.uploadPhoto(buffer, filename, parentNodeId);
        }
      }
      throw new Error("Amazon Photos auth failed — cookies expired.");
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Upload failed: ${res.status} ${text}`);
    }

    const node: AmazonNode = await res.json();
    logger.info({ filename, nodeId: node.id }, "Photo uploaded");
    return node;
  }

  /** Move nodes to trash (batched) */
  async trash(nodeIds: string[]): Promise<void> {
    for (let i = 0; i < nodeIds.length; i += MAX_TRASH_BATCH) {
      const batch = nodeIds.slice(i, i + MAX_TRASH_BATCH);
      await this.request("PATCH", `${this.driveUrl}/trash`, {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recurse: "true",
          op: "add",
          conflictResolution: "RENAME",
          value: batch,
          resourceVersion: "V2",
          ContentType: "JSON",
        }),
      });
    }
  }

  /** Permanently purge trashed nodes (batched) */
  async purge(nodeIds: string[]): Promise<void> {
    for (let i = 0; i < nodeIds.length; i += MAX_TRASH_BATCH) {
      const batch = nodeIds.slice(i, i + MAX_TRASH_BATCH);
      await this.request("POST", `${this.driveUrl}/bulk/nodes/purge`, {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recurse: "false",
          nodeIds: batch,
          resourceVersion: "V2",
          ContentType: "JSON",
        }),
      });
    }
  }

  /** Delete nodes — trash then purge */
  async deleteNodes(nodeIds: string[]): Promise<void> {
    await this.trash(nodeIds);
    await this.purge(nodeIds);
    logger.info({ count: nodeIds.length }, "Nodes deleted");
  }

  /** Find an album by exact name */
  async findAlbum(name: string): Promise<AmazonNode | null> {
    // Fetch all albums and filter locally — the API's name filter
    // doesn't handle multi-word names reliably
    const res = await this.getNodes(
      "kind:VISUAL_COLLECTION AND status:AVAILABLE",
    );
    const match = res.data?.find((n) => n.name === name);
    return match ?? null;
  }

  /** Create a new album */
  async createAlbum(name: string): Promise<AmazonNode> {
    const res = await this.request("POST", `${this.driveUrl}/nodes`, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "VISUAL_COLLECTION",
        name,
        resourceVersion: "V2",
        ContentType: "JSON",
      }),
    });
    const album: AmazonNode = await res.json();
    logger.info({ albumId: album.id, name }, "Album created");
    return album;
  }

  /** Add nodes to an existing album */
  async addToAlbum(albumId: string, nodeIds: string[]): Promise<void> {
    if (nodeIds.length === 0) return;
    await this.request("PATCH", `${this.driveUrl}/nodes/${albumId}/children`, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        op: "add",
        value: nodeIds,
        resourceVersion: "V2",
        ContentType: "JSON",
      }),
    });
    logger.debug({ albumId, count: nodeIds.length }, "Added to album");
  }

  /** Add nodes to album only if they're not already present (prevents duplicates) */
  async addToAlbumIfNotPresent(
    albumId: string,
    nodeIds: string[],
  ): Promise<{ added: number; skipped: number }> {
    if (nodeIds.length === 0) return { added: 0, skipped: 0 };

    // Fetch current album contents
    const existingIds = new Set(await this.getAlbumNodeIds(albumId));

    // Filter out nodes already in the album
    const toAdd = nodeIds.filter((id) => !existingIds.has(id));
    const skipped = nodeIds.length - toAdd.length;

    if (skipped > 0) {
      logger.info(
        { albumId, skipped, total: nodeIds.length },
        "Skipping nodes already in album",
      );
    }

    if (toAdd.length > 0) {
      await this.addToAlbum(albumId, toAdd);
    }

    return { added: toAdd.length, skipped };
  }

  /** Remove nodes from an album (does not delete them) */
  async removeFromAlbum(albumId: string, nodeIds: string[]): Promise<void> {
    await this.request("PATCH", `${this.driveUrl}/nodes/${albumId}/children`, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        op: "remove",
        value: nodeIds,
        resourceVersion: "V2",
        ContentType: "JSON",
      }),
    });
  }

  /** Find or create an album, returning its node ID */
  async findOrCreateAlbum(name: string): Promise<string> {
    const existing = await this.findAlbum(name);
    if (existing) {
      logger.debug({ albumId: existing.id, name }, "Found existing album");
      return existing.id;
    }
    const created = await this.createAlbum(name);
    return created.id;
  }

  /** Paginate through all node IDs in an album */
  async getAlbumNodeIds(albumId: string): Promise<string[]> {
    const ids: string[] = [];
    let offset = 0;
    const limit = 200;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = await this.listChildren(albumId, "", limit, offset);
      if (!res.data?.length) break;
      ids.push(...res.data.map((n) => n.id));
      if (res.data.length < limit) break;
      offset += limit;
    }

    return ids;
  }

  /** Upload a photo and safely add it to an album (skips if already present). Returns the node ID. */
  async uploadPhotoToAlbum(
    buffer: Buffer,
    filename: string,
    albumId: string,
  ): Promise<string> {
    const node = await this.uploadPhoto(buffer, filename);
    await this.addToAlbumIfNotPresent(albumId, [node.id]);
    return node.id;
  }

  /** MD5 hash helper for dedup */
  static md5(buffer: Buffer): string {
    return createHash("md5").update(buffer).digest("hex");
  }

  /** No-op — REST client has no resources to release */
  async close(): Promise<void> {
    // Nothing to clean up (no browser, no persistent connection)
  }
}
