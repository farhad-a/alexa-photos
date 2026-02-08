import { describe, it, expect } from "vitest";
import {
  parseCookieString,
  detectTld,
  extractRequiredCookies,
} from "./login.js";

describe("parseCookieString", () => {
  it("parses a standard cookie header string", () => {
    const raw = "session-id=123; ubid-main=456; at-main=Atza|token";
    const result = parseCookieString(raw);
    expect(result).toEqual({
      "session-id": "123",
      "ubid-main": "456",
      "at-main": "Atza|token",
    });
  });

  it("handles values containing = signs", () => {
    const raw = "session-id=abc; at-main=Atza|token==extra";
    const result = parseCookieString(raw);
    expect(result["at-main"]).toBe("Atza|token==extra");
  });

  it("trims whitespace around keys and values", () => {
    const raw = "  session-id = 123 ;  at-main = token  ";
    const result = parseCookieString(raw);
    expect(result["session-id"]).toBe("123");
    expect(result["at-main"]).toBe("token");
  });

  it("skips entries without = sign", () => {
    const raw = "session-id=123; badentry; at-main=token";
    const result = parseCookieString(raw);
    expect(result).toEqual({
      "session-id": "123",
      "at-main": "token",
    });
  });

  it("returns empty object for empty string", () => {
    expect(parseCookieString("")).toEqual({});
  });

  it("parses a real-world cookie string with many values", () => {
    const raw =
      "session-id=133-1234567-8901234; session-id-time=2082787201l; " +
      "ubid-main=131-1234567-8901234; at-main=Atza|longtoken123; " +
      "x-main=abc; sess-at-main=sesstoken; sst-main=ssttoken; " +
      "csm-hit=abc123; skin=noskin";
    const result = parseCookieString(raw);
    expect(result["session-id"]).toBe("133-1234567-8901234");
    expect(result["at-main"]).toBe("Atza|longtoken123");
    expect(result["x-main"]).toBe("abc");
    expect(result["sst-main"]).toBe("ssttoken");
    expect(result["csm-hit"]).toBe("abc123");
  });
});

describe("detectTld", () => {
  it("detects US from at-main (hyphen)", () => {
    expect(detectTld({ "at-main": "token", "session-id": "123" })).toBe("com");
  });

  it("detects US from at_main (underscore)", () => {
    expect(detectTld({ at_main: "token", "session-id": "123" })).toBe("com");
  });

  it("detects co.uk from at-acbco.uk", () => {
    expect(detectTld({ "at-acbco.uk": "token", "session-id": "123" })).toBe(
      "co.uk",
    );
  });

  it("detects de from at-acbde", () => {
    expect(detectTld({ "at-acbde": "token", "session-id": "123" })).toBe("de");
  });

  it("returns null when no recognizable keys", () => {
    expect(detectTld({ "session-id": "123", "some-cookie": "val" })).toBeNull();
  });
});

describe("extractRequiredCookies", () => {
  const fullUsCookies: Record<string, string> = {
    "session-id": "133-123",
    "ubid-main": "131-456",
    "at-main": "Atza|token",
    "x-main": "xval",
    "sess-at-main": "sessval",
    "sst-main": "sstval",
    "csm-hit": "irrelevant",
    skin: "noskin",
  };

  it("extracts all 6 US cookies from a full cookie map", () => {
    const { cookies, missing } = extractRequiredCookies(fullUsCookies, "com");
    expect(missing).toEqual([]);
    expect(Object.keys(cookies)).toHaveLength(6);
    expect(cookies["session-id"]).toBe("133-123");
    expect(cookies["at-main"]).toBe("Atza|token");
    expect(cookies["sst-main"]).toBe("sstval");
  });

  it("excludes non-Amazon cookies", () => {
    const { cookies } = extractRequiredCookies(fullUsCookies, "com");
    expect(cookies["csm-hit"]).toBeUndefined();
    expect(cookies["skin"]).toBeUndefined();
  });

  it("reports missing required US cookies", () => {
    const partial = { "session-id": "123", "x-main": "x" };
    const { missing } = extractRequiredCookies(partial, "com");
    expect(missing).toContain("ubid-main");
    expect(missing).toContain("at-main");
  });

  it("does not flag optional US cookies as missing", () => {
    const requiredOnly = {
      "session-id": "123",
      "ubid-main": "456",
      "at-main": "Atza|tok",
    };
    const { cookies, missing } = extractRequiredCookies(requiredOnly, "com");
    expect(missing).toEqual([]);
    expect(Object.keys(cookies)).toHaveLength(3);
  });

  it("extracts international cookies", () => {
    const intl = {
      "session-id": "123",
      "ubid-acbde": "456",
      "at-acbde": "Atza|de-token",
      "other-cookie": "ignore",
    };
    const { cookies, missing } = extractRequiredCookies(intl, "de");
    expect(missing).toEqual([]);
    expect(cookies["session-id"]).toBe("123");
    expect(cookies["ubid-acbde"]).toBe("456");
    expect(cookies["at-acbde"]).toBe("Atza|de-token");
    expect(cookies["other-cookie"]).toBeUndefined();
  });

  it("reports missing international cookies", () => {
    const partial = { "session-id": "123" };
    const { missing } = extractRequiredCookies(partial, "co.uk");
    expect(missing).toContain("ubid-acbco.uk");
    expect(missing).toContain("at-acbco.uk");
  });
});
