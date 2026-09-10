import { describe, it, expect } from "vitest";
import {
  detectTld,
  extractTrackedSetCookies,
  isAccessTokenCookieName,
  isTrackedAuthCookieName,
} from "./cookie-names.js";

describe("isTrackedAuthCookieName", () => {
  it("recognises the US auth cookies", () => {
    for (const name of [
      "session-id",
      "session-token",
      "session-id-time",
      "ubid-main",
      "at-main",
      "x-main",
      "sess-at-main",
      "sst-main",
    ]) {
      expect(isTrackedAuthCookieName(name)).toBe(true);
    }
  });

  it("recognises international variants", () => {
    expect(isTrackedAuthCookieName("at-acbde")).toBe(true);
    expect(isTrackedAuthCookieName("ubid-acbco.uk")).toBe(true);
  });

  it("accepts underscores, which some sources use instead of hyphens", () => {
    expect(isTrackedAuthCookieName("at_main")).toBe(true);
  });

  it("ignores cookies that carry no auth state", () => {
    for (const name of ["csm-hit", "lc-main", "i18n-prefs", "skin"]) {
      expect(isTrackedAuthCookieName(name)).toBe(false);
    }
  });
});

describe("isAccessTokenCookieName", () => {
  it("matches only the access token", () => {
    expect(isAccessTokenCookieName("at-main")).toBe(true);
    expect(isAccessTokenCookieName("at-acbde")).toBe(true);
    // sess-at looks similar and is not the access token.
    expect(isAccessTokenCookieName("sess-at-main")).toBe(false);
    expect(isAccessTokenCookieName("ubid-main")).toBe(false);
  });
});

describe("extractTrackedSetCookies", () => {
  it("keeps tracked cookies and drops the rest", () => {
    const headers = new Headers();
    headers.append("set-cookie", "at-main=rotated; Path=/; Secure; HttpOnly");
    headers.append("set-cookie", "csm-hit=noise; Path=/");

    expect(extractTrackedSetCookies(headers)).toEqual({ "at-main": "rotated" });
  });

  it("tolerates a response with no Set-Cookie support", () => {
    expect(extractTrackedSetCookies(undefined)).toEqual({});
    expect(extractTrackedSetCookies(null)).toEqual({});
    expect(
      extractTrackedSetCookies({} as Pick<Headers, "getSetCookie">),
    ).toEqual({});
  });

  it("skips malformed entries rather than storing empty values", () => {
    const headers = new Headers();
    headers.append("set-cookie", "at-main=; Path=/");
    expect(extractTrackedSetCookies(headers)).toEqual({});
  });
});

describe("detectTld", () => {
  it("reads the marketplace off the access token cookie", () => {
    expect(detectTld({ "at-main": "x" })).toBe("com");
    expect(detectTld({ "at-acbde": "x" })).toBe("de");
    expect(detectTld({ "at-acbco.uk": "x" })).toBe("co.uk");
  });

  it("returns null when nothing identifies a marketplace", () => {
    expect(detectTld({ "session-id": "x" })).toBeNull();
    expect(detectTld({})).toBeNull();
  });

  it("tolerates undefined values, since the jar allows them", () => {
    expect(detectTld({ "at-main": undefined, "at-acbde": "x" })).toBe("de");
  });
});
