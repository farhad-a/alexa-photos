import { describe, expect, it } from "vitest";
import {
  classifyAmazonAuthError,
  classifyAmazonAuthResponse,
  classifyIcloudProviderError,
  extractHttpStatus,
} from "./provider-errors.js";

describe("provider error normalization", () => {
  describe("extractHttpStatus", () => {
    it("parses 3-digit status codes from provider messages", () => {
      expect(extractHttpStatus("Failed to fetch webstream: 403")).toBe(403);
      expect(extractHttpStatus("no status here")).toBeUndefined();
    });
  });

  describe("classifyIcloudProviderError", () => {
    it("maps invalid token statuses to actionable non-retriable errors", () => {
      expect(
        classifyIcloudProviderError(
          new Error("Failed to fetch webstream: 401"),
        ),
      ).toMatchObject({
        provider: "icloud",
        status: 401,
        kind: "invalid_token",
        retriable: false,
        actionable: true,
      });
      expect(
        classifyIcloudProviderError(
          new Error("Failed to fetch webstream: 403"),
        ),
      ).toMatchObject({
        provider: "icloud",
        status: 403,
        kind: "invalid_token",
        retriable: false,
        actionable: true,
      });
    });

    it("maps transient iCloud failures to retryable non-actionable errors", () => {
      expect(
        classifyIcloudProviderError(
          new Error("Failed to fetch asset URLs: 404"),
        ),
      ).toMatchObject({
        provider: "icloud",
        status: 404,
        kind: "unknown",
        retriable: true,
        actionable: false,
      });
      expect(
        classifyIcloudProviderError(
          new Error("Failed to fetch webstream: 429"),
        ),
      ).toMatchObject({
        provider: "icloud",
        status: 429,
        kind: "network",
        retriable: true,
        actionable: false,
      });
      expect(
        classifyIcloudProviderError(new Error("getaddrinfo ENOTFOUND")),
      ).toMatchObject({
        provider: "icloud",
        kind: "network",
        retriable: true,
        actionable: false,
      });
    });
  });

  describe("classifyAmazonAuthResponse", () => {
    it("maps Amazon auth responses into the shared status model", () => {
      expect(classifyAmazonAuthResponse(200, true)).toMatchObject({
        provider: "amazon",
        status: 200,
        kind: "ok",
        retriable: false,
        actionable: false,
      });
      expect(classifyAmazonAuthResponse(401, false)).toMatchObject({
        provider: "amazon",
        status: 401,
        kind: "unauthorized",
        retriable: false,
        actionable: true,
      });
      expect(classifyAmazonAuthResponse(429, false)).toMatchObject({
        provider: "amazon",
        status: 429,
        kind: "rate_limited",
        retriable: true,
        actionable: false,
      });
      expect(classifyAmazonAuthResponse(503, false)).toMatchObject({
        provider: "amazon",
        status: 503,
        kind: "bot_detection",
        retriable: true,
        actionable: false,
      });
      expect(classifyAmazonAuthResponse(500, false)).toMatchObject({
        provider: "amazon",
        status: 500,
        kind: "unknown",
        retriable: true,
        actionable: false,
      });
    });
  });

  describe("classifyAmazonAuthError", () => {
    it("normalizes network failures as retryable non-actionable errors", () => {
      expect(classifyAmazonAuthError(new Error("network error"))).toMatchObject(
        {
          provider: "amazon",
          kind: "network",
          retriable: true,
          actionable: false,
        },
      );
    });
  });
});
