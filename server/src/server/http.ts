import { IncomingMessage, ServerResponse } from "http";

/** Nothing this API accepts comes close; the cap exists to bound memory. */
export const MAX_BODY_BYTES = 1024 * 1024;

export class PayloadTooLargeError extends Error {
  constructor() {
    super("Request body too large");
    this.name = "PayloadTooLargeError";
  }
}

export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer =
      typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.length;
    // Bail on the running total rather than after buffering the whole stream,
    // which is the point of having a cap at all.
    if (size > MAX_BODY_BYTES) throw new PayloadTooLargeError();
    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString("utf-8");
}

/** Node folds repeated headers into an array for some names; take the first. */
export function firstHeaderValue(
  header: string | string[] | undefined,
): string | undefined {
  return Array.isArray(header) ? header[0] : header;
}

/** True for `application/json`, with or without a `; charset=` suffix. */
export function isJsonContentType(
  header: string | string[] | undefined,
): boolean {
  const value = firstHeaderValue(header);
  if (!value) return false;
  return value.split(";")[0].trim().toLowerCase() === "application/json";
}

export function sendJson(
  res: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
