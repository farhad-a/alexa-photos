import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "http";
import { AppServer } from "./index.js";

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

function createResponseDouble() {
  let statusCode = 0;
  const headers = new Map<string, string>();
  let body = "";

  const res = {
    headersSent: false,
    setHeader(name: string, value: string) {
      headers.set(name, value);
    },
    writeHead(code: number, responseHeaders?: Record<string, string>) {
      statusCode = code;
      if (responseHeaders) {
        for (const [name, value] of Object.entries(responseHeaders)) {
          headers.set(name, value);
        }
      }
      return this;
    },
    end(chunk?: string) {
      if (chunk) body += chunk;
      return this;
    },
  } as unknown as ServerResponse;

  return {
    res,
    getStatusCode: () => statusCode,
    getHeader: (name: string) => headers.get(name),
    getBody: () => body,
  };
}

describe("AppServer hello route", () => {
  it("responds with hello from codex", async () => {
    const server = new AppServer({ port: 19876, staticDir: "/nonexistent" });
    const req = { method: "GET", url: "/hello" } as IncomingMessage;
    const response = createResponseDouble();

    await (
      server as unknown as {
        handleRequest: (
          req: IncomingMessage,
          res: ServerResponse,
        ) => Promise<void>;
      }
    ).handleRequest(req, response.res);

    expect(response.getStatusCode()).toBe(200);
    expect(response.getHeader("Content-Type")).toBe("application/json");
    expect(JSON.parse(response.getBody())).toEqual({
      message: "hello from codex",
    });
  });
});
