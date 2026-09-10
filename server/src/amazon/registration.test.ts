import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RegistrationSettings } from "./registration.js";

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

const proxy = vi.hoisted(() => ({
  startRegistration: vi.fn(),
  refreshRegistration: vi.fn(),
  stopProxy: vi.fn(async () => undefined),
}));
vi.mock("./registration-proxy.js", () => proxy);

// Keep the pure helpers real; stub the disk.
//
// The writers are typed from the real exports so `mock.calls` carries the
// actual argument types. An untyped vi.fn() infers zero arity, which makes
// calls[0][1] untypeable and blind to a signature change.
const store = vi.hoisted(() => ({
  readAmazonAuth: vi.fn(),
  readAmazonSession: vi.fn(),
  writeAmazonAuth: vi.fn<
    (typeof import("./credentials.js"))["writeAmazonAuth"]
  >(async () => undefined),
  writeAmazonSession: vi.fn<
    (typeof import("./credentials.js"))["writeAmazonSession"]
  >(async () => undefined),
  clearAmazonCredentials: vi.fn(async () => undefined),
}));
vi.mock("./credentials.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./credentials.js")>()),
  ...store,
}));

const {
  beginRegistration,
  cancelRegistration,
  getAmazonAuthSummary,
  getRegistrationStatus,
  removeRegistration,
  resetRegistrationState,
  resolveProxyOwnIp,
  setCredentialsChangedHandler,
} = await import("./registration.js");

const SETTINGS: RegistrationSettings = {
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

/** Let the background registration promise run to completion. */
async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRegistrationState();
  setCredentialsChangedHandler(undefined);
  proxy.startRegistration.mockResolvedValue({
    refreshToken: "Atnr|token",
    deviceSerial: "ABCDEF123456",
    amazonPage: "amazon.com",
    localCookie: "at-main=signin; session-id=s1",
  });
  proxy.refreshRegistration.mockResolvedValue({
    refreshToken: "Atnr|token",
    localCookie: "at-main=minted; session-id=s2",
  });
});

describe("beginRegistration", () => {
  it("returns the proxy URL immediately, before sign-in completes", () => {
    const status = beginRegistration(SETTINGS);
    expect(status.state).toBe("awaiting_login");
    expect(status.proxyUrl).toBe("http://192.168.1.50:3456/");
    expect(status.expiresAt).toBeTruthy();
  });

  it("conflicts rather than starting a second proxy", () => {
    beginRegistration(SETTINGS);
    // alexa-cookie2 is a singleton; only one proxy can run.
    expect(() => beginRegistration(SETTINGS)).toThrow(/already in progress/);
  });

  it("sends the browser back to the admin UI at the LAN address", () => {
    beginRegistration(SETTINGS);
    const html = proxy.startRegistration.mock.calls[0][0]
      .closeWindowHtml as string;
    // The browser is on another machine, so localhost would point at itself.
    expect(html).toContain("http://192.168.1.50:3000/amazon?registered=1");
    expect(html).not.toContain("localhost");
  });

  it("stores credentials and reaches registered on success", async () => {
    beginRegistration(SETTINGS);
    await settle();

    expect(store.writeAmazonAuth).toHaveBeenCalledTimes(1);
    expect(store.writeAmazonSession).toHaveBeenCalledTimes(1);
    expect(getRegistrationStatus().state).toBe("registered");
  });

  it("mints cookies from the token immediately, proving the durable loop", async () => {
    beginRegistration(SETTINGS);
    await settle();

    // A registration whose refresh does not work is useless, and the user
    // must learn that now rather than in a week.
    expect(proxy.refreshRegistration).toHaveBeenCalledTimes(1);
    const session = store.writeAmazonSession.mock.calls[0][1];
    expect(session.cookies["at-main"]).toBe("minted");
  });

  it("keeps the sign-in cookies and logs loudly when minting fails", async () => {
    proxy.refreshRegistration.mockRejectedValue(new Error("exchange refused"));
    beginRegistration(SETTINGS);
    await settle();

    const session = store.writeAmazonSession.mock.calls[0][1];
    expect(session.cookies["at-main"]).toBe("signin");
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.anything() }),
      expect.stringContaining("minting cookies"),
    );
    expect(getRegistrationStatus().state).toBe("registered");
  });

  it("notifies the app so the running client is replaced", async () => {
    const changed = vi.fn();
    setCredentialsChangedHandler(changed);

    beginRegistration(SETTINGS);
    await settle();

    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("records a timeout distinctly from a failure", async () => {
    proxy.startRegistration.mockRejectedValue(new Error("timed out"));
    beginRegistration(SETTINGS);
    await settle();

    expect(getRegistrationStatus().state).toBe("timed_out");
  });

  it("records a failure with its reason", async () => {
    proxy.startRegistration.mockRejectedValue(new Error("amazon said no"));
    beginRegistration(SETTINGS);
    await settle();

    const status = getRegistrationStatus();
    expect(status.state).toBe("failed");
    expect(status.error).toContain("amazon said no");
  });

  it("always stops the proxy, on success and on failure", async () => {
    beginRegistration(SETTINGS);
    await settle();
    expect(proxy.stopProxy).toHaveBeenCalled();

    proxy.stopProxy.mockClear();
    resetRegistrationState();
    proxy.startRegistration.mockRejectedValue(new Error("boom"));
    beginRegistration(SETTINGS);
    await settle();
    expect(proxy.stopProxy).toHaveBeenCalled();
  });
});

describe("cancelRegistration", () => {
  it("discards a result that arrives after cancelling", async () => {
    let finish: (v: unknown) => void = () => {};
    proxy.startRegistration.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );

    beginRegistration(SETTINGS);
    await cancelRegistration();
    expect(getRegistrationStatus().state).toBe("cancelled");

    finish({ refreshToken: "Atnr|late", localCookie: "at-main=late" });
    await settle();

    expect(store.writeAmazonAuth).not.toHaveBeenCalled();
    expect(getRegistrationStatus().state).toBe("cancelled");
  });

  it("is safe when nothing is running", async () => {
    await expect(cancelRegistration()).resolves.toBeUndefined();
  });
});

describe("resolveProxyOwnIp", () => {
  it("prefers the configured address", () => {
    expect(resolveProxyOwnIp("10.0.0.4")).toBe("10.0.0.4");
  });

  it("warns when it has to guess, because the guess is wrong in Docker", () => {
    resolveProxyOwnIp(undefined);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ detected: expect.any(String) }),
      expect.stringContaining("AMAZON_PROXY_OWN_IP"),
    );
  });
});

describe("getAmazonAuthSummary", () => {
  it("reports not registered when no auth file exists", async () => {
    store.readAmazonAuth.mockRejectedValue(
      Object.assign(new Error("no file"), { code: "ENOENT" }),
    );

    const summary = await getAmazonAuthSummary("./data/amazon-auth.json");

    expect(summary.registered).toBe(false);
    expect(summary.state).toBe("idle");
    // Missing credentials are a state, not an error. The route returns 200.
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("summarises a registration with the serial masked", async () => {
    store.readAmazonAuth.mockResolvedValue({
      version: 1,
      registeredAt: "2026-09-09T00:00:00.000Z",
      marketplace: {
        amazonPage: "amazon.com",
        tld: "com",
        acceptLanguage: "en-US",
        proxyLanguage: "en_US",
        deviceAppName: "alexa-photos",
      },
      registration: { refreshToken: "Atnr|t", deviceSerial: "ABCDEF123456" },
    });
    store.readAmazonSession.mockResolvedValue({
      version: 1,
      cookiesUpdatedAt: new Date(Date.now() - 86400000).toISOString(),
      lastRefreshAt: null,
      cookies: { "at-main": "a" },
    });

    const summary = await getAmazonAuthSummary("./data/amazon-auth.json");

    expect(summary.registered).toBe(true);
    expect(summary.marketplace).toBe("amazon.com");
    expect(summary.deviceSerial).toBe("…123456");
    expect(summary.cookieAgeDays).toBeCloseTo(1, 1);
  });
});

describe("removeRegistration", () => {
  it("clears both files and notifies the app", async () => {
    const changed = vi.fn();
    setCredentialsChangedHandler(changed);

    await removeRegistration("./data/amazon-auth.json");

    expect(store.clearAmazonCredentials).toHaveBeenCalledWith(
      "./data/amazon-auth.json",
    );
    expect(changed).toHaveBeenCalledTimes(1);
    expect(getRegistrationStatus().state).toBe("idle");
  });
});
