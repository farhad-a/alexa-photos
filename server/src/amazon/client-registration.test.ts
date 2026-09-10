import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { NotificationService } from "../lib/notifications.js";
import type { AmazonAuthRecord } from "./credentials.js";

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

// Mock the wrapper, never the library, so no test loads Express.
const proxy = vi.hoisted(() => ({ refreshRegistration: vi.fn() }));
vi.mock("./registration-proxy.js", () => proxy);

// Keep the pure credential helpers real; stub only the disk writes.
//
// Typed from the real exports so `mock.calls` carries the actual argument
// types. An untyped vi.fn() infers zero arity, which makes calls[0][1] both
// untypeable and unable to notice if the signature ever changes.
const writes = vi.hoisted(() => ({
  writeAmazonSession: vi.fn<
    (typeof import("./credentials.js"))["writeAmazonSession"]
  >(async () => undefined),
  writeAmazonAuth: vi.fn<
    (typeof import("./credentials.js"))["writeAmazonAuth"]
  >(async () => undefined),
}));
vi.mock("./credentials.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./credentials.js")>()),
  ...writes,
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const { AmazonClient } = await import("./client.js");

function authRecord(over: Partial<AmazonAuthRecord> = {}): AmazonAuthRecord {
  return {
    version: 1,
    registeredAt: new Date().toISOString(),
    marketplace: {
      amazonPage: "amazon.com",
      tld: "com",
      acceptLanguage: "en-US",
      proxyLanguage: "en_US",
      deviceAppName: "alexa-photos",
    },
    registration: { refreshToken: "Atnr|original", deviceSerial: "SERIAL" },
    ...over,
  };
}

function notifications() {
  const sendAlert = vi.fn();
  const clearAlertThrottle = vi.fn();
  return {
    service: {
      sendAlert,
      clearAlertThrottle,
    } as unknown as NotificationService,
    sendAlert,
    clearAlertThrottle,
  };
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function makeClient(
  opts: {
    auth?: AmazonAuthRecord;
    cookiesUpdatedAt?: string | null;
    cookies?: Record<string, string>;
    notificationService?: NotificationService;
  } = {},
) {
  return new AmazonClient(opts.cookies ?? { "session-id": "sess-1" }, {
    auth: opts.auth ?? authRecord(),
    authPath: "./data/amazon-auth.json",
    cookieMaxAgeDays: 7,
    cookiesUpdatedAt: opts.cookiesUpdatedAt ?? null,
    notificationService: opts.notificationService,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockReset();
  proxy.refreshRegistration.mockResolvedValue({
    refreshToken: "Atnr|original",
    localCookie: "at-main=fresh; ubid-main=u; session-id=sess-2",
  });
});

describe("age gate", () => {
  it("skips the refresh entirely when cookies are young", async () => {
    const client = makeClient({ cookiesUpdatedAt: daysAgo(2) });

    await expect(client.refreshNow()).resolves.toBe(true);
    // Cookies live about 14 days. Refreshing a 2-day-old set is pure waste.
    expect(proxy.refreshRegistration).not.toHaveBeenCalled();
  });

  it("refreshes once cookies pass the max age", async () => {
    const client = makeClient({ cookiesUpdatedAt: daysAgo(9) });

    await expect(client.refreshNow()).resolves.toBe(true);
    expect(proxy.refreshRegistration).toHaveBeenCalledTimes(1);
  });

  it("refreshes when there is no session yet", async () => {
    const client = makeClient({ cookiesUpdatedAt: null });

    await expect(client.refreshNow()).resolves.toBe(true);
    expect(proxy.refreshRegistration).toHaveBeenCalledTimes(1);
  });

  it("force bypasses the gate, which is what 401 recovery relies on", async () => {
    const client = makeClient({ cookiesUpdatedAt: daysAgo(1) });

    await expect(client.refreshNow({ force: true })).resolves.toBe(true);
    expect(proxy.refreshRegistration).toHaveBeenCalledTimes(1);
  });
});

describe("throttle", () => {
  it("refuses a second forced refresh inside a minute", async () => {
    const client = makeClient({ cookiesUpdatedAt: daysAgo(9) });

    await expect(client.refreshNow({ force: true })).resolves.toBe(true);
    // Without this, a failing sync's 401s would hammer the token endpoint and
    // earn a bot-detection block.
    await expect(client.refreshNow({ force: true })).resolves.toBe(false);
    expect(proxy.refreshRegistration).toHaveBeenCalledTimes(1);
  });
});

describe("minted cookies", () => {
  it("replaces the jar and persists the session", async () => {
    const client = makeClient({ cookiesUpdatedAt: daysAgo(9) });

    await client.refreshNow();

    expect(writes.writeAmazonSession).toHaveBeenCalledTimes(1);
    const record = writes.writeAmazonSession.mock.calls[0][1];
    expect(record.cookies["at-main"]).toBe("fresh");
    expect(record.cookies["session-id"]).toBe("sess-2");
  });

  it("carries the previous session-id forward when the refresh omits one", async () => {
    proxy.refreshRegistration.mockResolvedValue({
      refreshToken: "Atnr|original",
      localCookie: "at-main=fresh; ubid-main=u",
    });
    const client = makeClient({ cookiesUpdatedAt: daysAgo(9) });

    await client.refreshNow();

    const record = writes.writeAmazonSession.mock.calls[0][1];
    expect(record.cookies["session-id"]).toBe("sess-1");
  });

  it("fails rather than wiping the jar when no cookies come back", async () => {
    proxy.refreshRegistration.mockResolvedValue({ refreshToken: "Atnr|x" });
    const client = makeClient({ cookiesUpdatedAt: daysAgo(9) });

    await expect(client.refreshNow()).resolves.toBe(false);
    expect(writes.writeAmazonSession).not.toHaveBeenCalled();
  });

  it("rejects a refresh that returns cookies but no access token", async () => {
    // The legacy exchange checked this. Without it a response like this would
    // pass here and then fail on the very next request.
    proxy.refreshRegistration.mockResolvedValue({
      refreshToken: "Atnr|original",
      localCookie: "session-id=s; ubid-main=u",
    });
    const client = makeClient({ cookiesUpdatedAt: daysAgo(9) });

    await expect(client.refreshNow()).resolves.toBe(false);
    expect(writes.writeAmazonSession).not.toHaveBeenCalled();
  });

  it("persists a rotated refresh token so the registration is not stranded", async () => {
    proxy.refreshRegistration.mockResolvedValue({
      refreshToken: "Atnr|rotated",
      localCookie: "at-main=fresh; session-id=s",
    });
    const client = makeClient({ cookiesUpdatedAt: daysAgo(9) });

    await client.refreshNow();

    expect(writes.writeAmazonAuth).toHaveBeenCalledTimes(1);
    const saved = writes.writeAmazonAuth.mock.calls[0][1];
    expect(saved.registration.refreshToken).toBe("Atnr|rotated");
  });

  it("does not rewrite the auth file when the token is unchanged", async () => {
    const client = makeClient({ cookiesUpdatedAt: daysAgo(9) });
    await client.refreshNow();
    expect(writes.writeAmazonAuth).not.toHaveBeenCalled();
  });

  it("warns when refreshed cookies belong to another marketplace", async () => {
    proxy.refreshRegistration.mockResolvedValue({
      refreshToken: "Atnr|original",
      localCookie: "at-acbde=x; session-id=s",
    });
    const client = makeClient({ cookiesUpdatedAt: daysAgo(9) });

    await client.refreshNow();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ expected: "com", detected: "de" }),
      expect.stringContaining("different marketplace"),
    );
  });
});

describe("invalid registration", () => {
  it("marks itself invalid and alerts once when Amazon rejects the token", async () => {
    proxy.refreshRegistration.mockRejectedValue(
      new Error("400 invalid_grant: Invalid Refresh Token"),
    );
    const notify = notifications();
    const client = makeClient({
      cookiesUpdatedAt: daysAgo(9),
      notificationService: notify.service,
    });

    await expect(client.refreshNow()).resolves.toBe(false);

    expect(client.needsReregistration).toBe(true);
    expect(notify.sendAlert).toHaveBeenCalledTimes(1);
    expect(notify.sendAlert).toHaveBeenCalledWith(
      expect.stringContaining("Re-register"),
      "error",
    );
  });

  it("stops trying once invalid, since only a human can fix it", async () => {
    proxy.refreshRegistration.mockRejectedValue(new Error("invalid_grant"));
    const client = makeClient({ cookiesUpdatedAt: daysAgo(9) });

    await client.refreshNow();
    proxy.refreshRegistration.mockClear();

    await expect(client.refreshNow({ force: true })).resolves.toBe(false);
    expect(proxy.refreshRegistration).not.toHaveBeenCalled();
  });

  it("treats an ordinary failure as transient, not as a revoked registration", async () => {
    proxy.refreshRegistration.mockRejectedValue(new Error("socket hang up"));
    const notify = notifications();
    const client = makeClient({
      cookiesUpdatedAt: daysAgo(9),
      notificationService: notify.service,
    });

    await expect(client.refreshNow()).resolves.toBe(false);

    expect(client.needsReregistration).toBe(false);
    expect(notify.sendAlert).toHaveBeenCalledWith(
      expect.stringContaining("retry automatically"),
      "warning",
    );
  });
});

describe("request headers", () => {
  it("omits the session header when no session-id is known", async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      headers: { getSetCookie: () => [] },
      json: async () => ({}),
    });
    const client = makeClient({ cookies: { "at-main": "a" } });

    await client.checkAuthStatus();

    const headers = mockFetch.mock.calls[0][1].headers as Record<
      string,
      string
    >;
    // Sending the literal string "undefined" is worse than sending nothing.
    expect(headers).not.toHaveProperty("x-amzn-sessionid");
    expect(headers.Cookie).toBe("at-main=a");
  });

  it("sends the session header when one is known", async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      headers: { getSetCookie: () => [] },
      json: async () => ({}),
    });
    const client = makeClient();

    await client.checkAuthStatus();

    const headers = mockFetch.mock.calls[0][1].headers as Record<
      string,
      string
    >;
    expect(headers["x-amzn-sessionid"]).toBe("sess-1");
  });
});

describe("marketplace", () => {
  it("takes the Drive host from the registration, not from cookie names", async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      headers: { getSetCookie: () => [] },
      json: async () => ({}),
    });
    const client = makeClient({
      auth: authRecord({
        marketplace: {
          amazonPage: "amazon.de",
          tld: "de",
          acceptLanguage: "de-DE",
          proxyLanguage: "de_DE",
          deviceAppName: "alexa-photos",
        },
      }),
    });

    await client.checkAuthStatus();

    expect(mockFetch.mock.calls[0][0]).toContain(
      "https://www.amazon.de/drive/v1",
    );
  });

  it("reports registration state", () => {
    expect(makeClient().isRegistered).toBe(true);
  });
});

// Regression: every load site used the legacy cookie file, so a machine with
// only a device registration reported "not configured" and never synced. The
// whole feature was inert end to end.
describe("AmazonClient.load", () => {
  let dir: string;
  let authPath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "amazon-load-"));
    authPath = path.join(dir, "amazon-auth.json");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function writeAuthFile() {
    await fs.writeFile(
      authPath,
      JSON.stringify({
        version: 1,
        registeredAt: new Date().toISOString(),
        marketplace: {
          amazonPage: "amazon.com",
          tld: "com",
          acceptLanguage: "en-US",
          proxyLanguage: "en_US",
          deviceAppName: "alexa-photos",
        },
        registration: { refreshToken: "Atnr|t", deviceSerial: "SERIAL" },
      }),
    );
  }

  it("uses the registration when one exists", async () => {
    await writeAuthFile();
    const client = await AmazonClient.load({ authPath });
    expect(client.isRegistered).toBe(true);
  });

  it("reports ENOENT when nothing is registered", async () => {
    // There is no fallback of any kind now, so an install without a
    // registration is unconfigured and must register.
    await expect(AmazonClient.load({ authPath })).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reports a corrupt registration as unconfigured rather than bricking", async () => {
    await fs.writeFile(authPath, "{ not json");

    // A home server that will not boot is worse than one asking to be
    // re-registered, so this must not throw a raw parse error.
    await expect(AmazonClient.load({ authPath })).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ path: authPath }),
      expect.stringContaining("not configured"),
    );
  });

  it("reports ENOENT when nothing is configured, which startup reads as not configured", async () => {
    await expect(AmazonClient.load({ authPath })).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
