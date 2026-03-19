import { describe, it, expect, vi } from "vitest";
import { _test, validateIcloudStartupAccess } from "./startup-validation.js";

describe("startup iCloud validation", () => {
  it("extractHttpStatus parses 3-digit status from message", () => {
    expect(_test.extractHttpStatus("Failed to fetch webstream: 403")).toBe(403);
    expect(_test.extractHttpStatus("no status here")).toBeUndefined();
  });

  it("classifies only high-confidence auth 4xx as invalid_token", () => {
    expect(
      _test.classifyIcloudStartupError(
        new Error("Failed to fetch webstream: 401"),
      ),
    ).toBe("invalid_token");
    expect(
      _test.classifyIcloudStartupError(
        new Error("Failed to fetch asset URLs: 404"),
      ),
    ).toBe("invalid_token");
    expect(
      _test.classifyIcloudStartupError(
        new Error("Failed to fetch webstream: 408"),
      ),
    ).toBe("transient");
    expect(
      _test.classifyIcloudStartupError(
        new Error("Failed to fetch webstream: 400"),
      ),
    ).toBe("transient");
  });

  it("classifies 429/5xx as transient", () => {
    expect(
      _test.classifyIcloudStartupError(
        new Error("Failed to fetch webstream: 429"),
      ),
    ).toBe("transient");
    expect(
      _test.classifyIcloudStartupError(
        new Error("Failed to fetch webstream: 503"),
      ),
    ).toBe("transient");
  });

  it("classifies network-style errors as transient", () => {
    expect(_test.classifyIcloudStartupError(new Error("fetch failed"))).toBe(
      "transient",
    );
    expect(
      _test.classifyIcloudStartupError(new Error("getaddrinfo ENOTFOUND")),
    ).toBe("transient");
  });

  it("returns validated=true on successful startup check", async () => {
    const icloud = { getPhotos: vi.fn().mockResolvedValue([]) };

    const result = await validateIcloudStartupAccess(icloud as any);

    expect(result).toEqual({ validated: true, transient: false });
  });

  it("throws clear token error on invalid-token classification", async () => {
    const icloud = {
      getPhotos: vi
        .fn()
        .mockRejectedValue(new Error("Failed to fetch webstream: 403")),
    };

    await expect(validateIcloudStartupAccess(icloud as any)).rejects.toThrow(
      "ICLOUD_ALBUM_TOKEN validation failed",
    );
  });

  it("returns transient result on inconclusive startup error", async () => {
    const icloud = {
      getPhotos: vi.fn().mockRejectedValue(new Error("fetch failed")),
    };

    const result = await validateIcloudStartupAccess(icloud as any);

    expect(result.validated).toBe(false);
    expect(result.transient).toBe(true);
    expect(result.details).toContain("fetch failed");
  });
});
