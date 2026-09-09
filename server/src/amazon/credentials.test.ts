import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  buildAuthRecord,
  clearAmazonCredentials,
  cookieAgeDays,
  parseCookieHeader,
  readAmazonAuth,
  readAmazonSession,
  sessionPathFor,
  tldFromAmazonPage,
  writeAmazonAuth,
  writeAmazonSession,
  type AmazonAuthRecord,
} from "./credentials.js";

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

let dir: string;
let authPath: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "amazon-creds-"));
  authPath = path.join(dir, "amazon-auth.json");
  vi.clearAllMocks();
});

afterEach(async () => {
  await fs.chmod(dir, 0o700).catch(() => undefined);
  await fs.rm(dir, { recursive: true, force: true });
});

function record(over: Partial<AmazonAuthRecord> = {}): AmazonAuthRecord {
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
    registration: {
      refreshToken: "Atnr|token",
      deviceSerial: "SERIAL",
      frc: "device-context",
      "map-md": "more-context",
    },
    ...over,
  };
}

describe("readAmazonAuth", () => {
  // index.ts and the sync engine both branch on error.code === "ENOENT" to
  // decide the service is unconfigured. Losing that property turns a first
  // run into a crash loop, so assert on the property itself.
  it("propagates a raw ENOENT error when the file is missing", async () => {
    await expect(readAmazonAuth(authPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("round-trips a record, preserving the device-context fields", async () => {
    await writeAmazonAuth(authPath, record());
    const read = await readAmazonAuth(authPath);

    expect(read.registration.refreshToken).toBe("Atnr|token");
    // These are replayed to the library on every refresh. Losing them makes
    // Amazon register a new device each time.
    expect(read.registration.frc).toBe("device-context");
    expect(read.registration["map-md"]).toBe("more-context");
    expect(read.marketplace.tld).toBe("com");
  });

  it("rejects a record with no refresh token rather than half-working", async () => {
    await writeAmazonAuth(
      authPath,
      record({ registration: { deviceSerial: "SERIAL" } }),
    );
    await expect(readAmazonAuth(authPath)).rejects.toThrow(/no refresh token/);
  });

  it("writes the auth file owner-only", async () => {
    await writeAmazonAuth(authPath, record());
    const stat = await fs.stat(authPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("leaves no temp file behind", async () => {
    await writeAmazonAuth(authPath, record());
    const entries = await fs.readdir(dir);
    expect(entries).toEqual(["amazon-auth.json"]);
  });

  // Spying on ESM fs exports is not possible, so fail the write for real by
  // making the directory unwritable. The guarantee under test is that a failed
  // write leaves the previous credentials intact rather than truncating them.
  it.skipIf(process.getuid?.() === 0)(
    "leaves the existing record intact when a write fails",
    async () => {
      await writeAmazonAuth(authPath, record());
      await fs.chmod(dir, 0o500);

      await expect(
        writeAmazonAuth(
          authPath,
          record({ registration: { refreshToken: "Atnr|replacement" } }),
        ),
      ).rejects.toThrow();

      await fs.chmod(dir, 0o700);
      const read = await readAmazonAuth(authPath);
      expect(read.registration.refreshToken).toBe("Atnr|token");
      expect(await fs.readdir(dir)).toEqual(["amazon-auth.json"]);
    },
  );
});

describe("session file", () => {
  // A missing session means "mint cookies now", not "not configured". It must
  // never surface as an ENOENT to the startup branches.
  it("returns null when absent rather than throwing", async () => {
    await expect(readAmazonSession(authPath)).resolves.toBeNull();
  });

  it("returns null and warns when the file is corrupt", async () => {
    await fs.writeFile(sessionPathFor(authPath), "{ not json");
    await expect(readAmazonSession(authPath)).resolves.toBeNull();
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it("round-trips cookies", async () => {
    await writeAmazonSession(authPath, {
      version: 1,
      cookiesUpdatedAt: new Date().toISOString(),
      lastRefreshAt: null,
      cookies: { "at-main": "a", "session-id": "b" },
    });
    const read = await readAmazonSession(authPath);
    expect(read?.cookies["at-main"]).toBe("a");
  });

  it("sits beside the auth file whatever the auth path is", () => {
    expect(sessionPathFor("/data/amazon-auth.json")).toBe(
      "/data/amazon-session.json",
    );
    expect(sessionPathFor("/opt/custom.json")).toBe("/opt/custom-session.json");
  });
});

describe("cookieAgeDays", () => {
  it("is null with no session, so a first run refreshes", () => {
    expect(cookieAgeDays(null)).toBeNull();
  });

  it("measures age from the stored timestamp", () => {
    const threeDaysAgo = new Date(
      Date.now() - 3 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const age = cookieAgeDays({
      version: 1,
      cookiesUpdatedAt: threeDaysAgo,
      lastRefreshAt: null,
      cookies: {},
    });
    expect(age).toBeCloseTo(3, 1);
  });
});

describe("marketplace handling", () => {
  it("derives the tld, including multi-part ones", () => {
    expect(tldFromAmazonPage("amazon.com")).toBe("com");
    expect(tldFromAmazonPage("amazon.co.uk")).toBe("co.uk");
    expect(tldFromAmazonPage("www.amazon.de")).toBe("de");
  });

  it("prefers what Amazon actually registered over what was requested", () => {
    // Catches the library's German default silently winning.
    const built = buildAuthRecord(
      { refreshToken: "Atnr|t", amazonPage: "amazon.de" },
      {
        amazonPage: "amazon.com",
        acceptLanguage: "en-US",
        proxyLanguage: "en_US",
        deviceAppName: "alexa-photos",
      },
    );
    expect(built.marketplace.amazonPage).toBe("amazon.de");
    expect(built.marketplace.tld).toBe("de");
  });

  it("falls back to the requested marketplace when the result omits it", () => {
    const built = buildAuthRecord(
      { refreshToken: "Atnr|t" },
      {
        amazonPage: "amazon.com",
        acceptLanguage: "en-US",
        proxyLanguage: "en_US",
        deviceAppName: "alexa-photos",
      },
    );
    expect(built.marketplace.amazonPage).toBe("amazon.com");
  });
});

describe("parseCookieHeader", () => {
  it("parses a raw Cookie header, which is what the library returns", () => {
    expect(parseCookieHeader("at-main=1; session-id=2; x-main=3")).toEqual({
      "at-main": "1",
      "session-id": "2",
      "x-main": "3",
    });
  });

  it("tolerates values containing equals signs", () => {
    expect(parseCookieHeader("at-main=a=b=c")).toEqual({ "at-main": "a=b=c" });
  });

  it("returns empty for undefined", () => {
    expect(parseCookieHeader(undefined)).toEqual({});
  });
});

describe("clearAmazonCredentials", () => {
  it("removes both files", async () => {
    await writeAmazonAuth(authPath, record());
    await writeAmazonSession(authPath, {
      version: 1,
      cookiesUpdatedAt: new Date().toISOString(),
      lastRefreshAt: null,
      cookies: { "at-main": "a" },
    });

    await clearAmazonCredentials(authPath);

    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("is a no-op when nothing is stored", async () => {
    await expect(clearAmazonCredentials(authPath)).resolves.toBeUndefined();
  });
});
