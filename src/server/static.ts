import * as fs from "fs/promises";
import * as path from "path";
import { ServerResponse } from "http";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/**
 * Serve a static file from `baseDir`. Returns true if a file was served.
 * Falls back to index.html for SPA routing (non-API, non-dotfile paths).
 */
export async function serveStaticFile(
  baseDir: string,
  urlPath: string,
  res: ServerResponse,
): Promise<boolean> {
  // Don't serve static files for API routes or health endpoints
  if (
    urlPath.startsWith("/api/") ||
    urlPath === "/health" ||
    urlPath === "/metrics"
  )
    return false;

  // Prevent path traversal
  const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, "");

  const filePath = path.join(baseDir, safePath);

  // Try exact file first
  if ((await fileExists(filePath)) && !(await isDirectory(filePath))) {
    return await sendFile(filePath, res);
  }

  // For directory or unknown paths, serve index.html (SPA fallback)
  const indexPath = path.join(baseDir, "index.html");
  if (await fileExists(indexPath)) {
    return await sendFile(indexPath, res);
  }

  return false;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function sendFile(
  filePath: string,
  res: ServerResponse,
): Promise<boolean> {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}
