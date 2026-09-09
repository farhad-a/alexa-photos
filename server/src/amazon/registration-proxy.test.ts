import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AlexaCookieConfig, AlexaRegistrationResult } from "alexa-cookie2";

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

/**
 * alexa-cookie2 is CommonJS consumed through a default import, so the mock
 * factory MUST return a `default` key. Returning the methods at the top level
 * typechecks against nothing and fails at runtime.
 */
const lib = vi.hoisted(() => ({
  generateAlexaCookie: vi.fn(),
  refreshAlexaCookie: vi.fn(),
  stopProxyServer: vi.fn((cb?: () => void) => cb?.()),
  getDeviceAppName: vi.fn(() => "alexa-photos"),
}));
vi.mock("alexa-cookie2", () => ({ default: lib }));

const { startRegistration, refreshRegistration, stopProxy, redact } =
  await import("./registration-proxy.js");

const MARKETPLACE = {
  amazonPage: "amazon.com",
  acceptLanguage: "en-US",
  proxyLanguage: "en_US",
  deviceAppName: "alexa-photos",
};

const PROXY = {
  ...MARKETPLACE,
  proxyOwnIp: "192.168.1.50",
  proxyPort: 3456,
  proxyListenBind: "0.0.0.0",
  timeoutMs: 5000,
};

function result(over: Partial<AlexaRegistrationResult> = {}) {
  return {
    refreshToken: "Atnr|token",
    deviceSerial: "SERIAL",
    amazonPage: "amazon.com",
    localCookie: "at-main=1; session-id=2",
    ...over,
  };
}

/** The exact wording the library uses for its progress notice. */
const PROGRESS = new Error(
  "Please open http://192.168.1.50:3456/ with your browser and login to " +
    "Amazon. The cookie will be output here after successfull login.",
);

beforeEach(() => {
  vi.clearAllMocks();
  lib.stopProxyServer.mockImplementation((cb?: () => void) => cb?.());
});

describe("startRegistration", () => {
  it("ignores the progress notice and resolves on the later real result", async () => {
    // The library reports "open this URL" through the ERROR argument first,
    // then calls back again after sign-in. Settling on the notice would tear
    // the proxy down before the user could log in.
    lib.generateAlexaCookie.mockImplementation((_e, _p, _c, cb) => {
      cb(PROGRESS);
      setTimeout(() => cb(null, result()), 5);
    });

    await expect(startRegistration(PROXY)).resolves.toMatchObject({
      refreshToken: "Atnr|token",
      deviceSerial: "SERIAL",
    });
  });

  it("ignores a callback that fires again after settling", async () => {
    lib.generateAlexaCookie.mockImplementation((_e, _p, _c, cb) => {
      cb(null, result());
      cb(new Error("late failure that must not surface"));
    });

    await expect(startRegistration(PROXY)).resolves.toMatchObject({
      refreshToken: "Atnr|token",
    });
  });

  it("rejects a hostname, because the library needs an IP literal", async () => {
    await expect(
      startRegistration({ ...PROXY, proxyOwnIp: "homeserver.local" }),
    ).rejects.toThrow(/IP literal/);
    expect(lib.generateAlexaCookie).not.toHaveBeenCalled();
  });

  it("pins the marketplace instead of letting the library default to Germany", async () => {
    lib.generateAlexaCookie.mockImplementation((_e, _p, _c, cb) =>
      cb(null, result()),
    );

    await startRegistration(PROXY);

    const config = lib.generateAlexaCookie.mock
      .calls[0][2] as AlexaCookieConfig;
    expect(config.amazonPage).toBe("amazon.com");
    expect(config.baseAmazonPage).toBe("amazon.com");
    expect(config.acceptLanguage).toBe("en-US");
    expect(config.deviceAppName).toBe("alexa-photos");
    expect(config.proxyOnly).toBe(true);
  });

  it("warns when Amazon registers a different marketplace than requested", async () => {
    lib.generateAlexaCookie.mockImplementation((_e, _p, _c, cb) =>
      cb(null, result({ amazonPage: "amazon.de" })),
    );

    await startRegistration(PROXY);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        requested: "amazon.com",
        registered: "amazon.de",
      }),
      expect.stringContaining("different marketplace"),
    );
  });

  it("stops the proxy on success and on failure", async () => {
    lib.generateAlexaCookie.mockImplementation((_e, _p, _c, cb) =>
      cb(null, result()),
    );
    await startRegistration(PROXY);
    expect(lib.stopProxyServer).toHaveBeenCalled();

    lib.stopProxyServer.mockClear();
    lib.generateAlexaCookie.mockImplementation((_e, _p, _c, cb) =>
      cb(new Error("amazon said no")),
    );
    await expect(startRegistration(PROXY)).rejects.toThrow("amazon said no");
    expect(lib.stopProxyServer).toHaveBeenCalled();
  });

  it("times out without hanging, and stops the proxy", async () => {
    vi.useFakeTimers();
    lib.generateAlexaCookie.mockImplementation((_e, _p, _c, cb) =>
      cb(PROGRESS),
    );

    const pending = startRegistration({ ...PROXY, timeoutMs: 1000 });
    const assertion = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(1100);
    await assertion;

    expect(lib.stopProxyServer).toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe("refreshRegistration", () => {
  it("replays the stored blob and the marketplace on every call", async () => {
    lib.refreshAlexaCookie.mockImplementation((_c, cb) => cb(null, result()));
    const former = result({ frc: "device-context" });

    await refreshRegistration(former, MARKETPLACE);

    const config = lib.refreshAlexaCookie.mock.calls[0][0] as AlexaCookieConfig;
    expect(config.formerRegistrationData).toBe(former);
    expect(config.amazonPage).toBe("amazon.com");
    expect(config.deviceAppName).toBe("alexa-photos");
  });

  it("serializes overlapping refreshes, because the library is a singleton", async () => {
    let active = 0;
    let maxActive = 0;
    lib.refreshAlexaCookie.mockImplementation((_c, cb) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      setTimeout(() => {
        active -= 1;
        cb(null, result());
      }, 5);
    });

    await Promise.all([
      refreshRegistration(result(), MARKETPLACE),
      refreshRegistration(result(), MARKETPLACE),
      refreshRegistration(result(), MARKETPLACE),
    ]);

    expect(maxActive).toBe(1);
    expect(lib.refreshAlexaCookie).toHaveBeenCalledTimes(3);
  });

  it("does not wedge the queue when one refresh fails", async () => {
    lib.refreshAlexaCookie
      .mockImplementationOnce((_c, cb) => cb(new Error("transient")))
      .mockImplementationOnce((_c, cb) => cb(null, result()));

    await expect(refreshRegistration(result(), MARKETPLACE)).rejects.toThrow(
      "transient",
    );
    await expect(
      refreshRegistration(result(), MARKETPLACE),
    ).resolves.toMatchObject({ refreshToken: "Atnr|token" });
  });

  it("rejects when the library reports success with no result", async () => {
    lib.refreshAlexaCookie.mockImplementation((_c, cb) => cb(null, undefined));
    await expect(refreshRegistration(result(), MARKETPLACE)).rejects.toThrow(
      /no registration result/,
    );
  });
});

describe("redact", () => {
  it("strips token material the library logs at info level", () => {
    const line = `token Atnr|${"a".repeat(90)} done`;
    const out = redact(line);
    expect(out).not.toContain("a".repeat(90));
    expect(out).toContain("<redacted>");
  });

  it("strips long opaque values that are not obviously tokens", () => {
    expect(redact(`cookie=${"z".repeat(80)}`)).not.toContain("z".repeat(80));
  });

  it("leaves ordinary log lines readable", () => {
    expect(redact("Proxy-Server listening on port 3456")).toBe(
      "Proxy-Server listening on port 3456",
    );
  });
});

describe("stopProxy", () => {
  it("resolves even when the library throws", async () => {
    lib.stopProxyServer.mockImplementation(() => {
      throw new Error("no proxy running");
    });
    await expect(stopProxy()).resolves.toBeUndefined();
  });
});
