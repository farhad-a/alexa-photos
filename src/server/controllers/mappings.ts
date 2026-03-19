import { IncomingMessage, ServerResponse } from "http";
import { z } from "zod";
import { logger as rootLogger } from "../../lib/logger.js";
import { readBody, sendJson } from "../http.js";
import {
  bulkDeleteMappings,
  deleteMapping,
  listMappings,
} from "../services/mappings.js";
import { AppRequestContext } from "../types.js";

const logger = rootLogger.child({ component: "server" });

const mappingsQuerySchema = z.object({
  page: z.coerce.number().int().catch(1),
  pageSize: z.coerce.number().int().catch(50),
  search: z.string().optional(),
  sortBy: z.enum(["icloud_id", "synced_at"]).catch("synced_at"),
  sortOrder: z.enum(["asc", "desc"]).catch("desc"),
});

const bulkDeleteSchema = z.object({
  icloudIds: z.array(z.string()),
});

export function handleListMappings(
  context: AppRequestContext,
  url: URL,
  res: ServerResponse,
): void {
  const parsed = mappingsQuerySchema.parse({
    page: url.searchParams.get("page") ?? "1",
    pageSize: url.searchParams.get("pageSize") ?? "50",
    search: url.searchParams.get("search") || undefined,
    sortBy: url.searchParams.get("sortBy") ?? undefined,
    sortOrder: url.searchParams.get("sortOrder") ?? undefined,
  });

  sendJson(
    res,
    200,
    listMappings(context.state!, {
      page: Math.max(1, parsed.page),
      pageSize: Math.min(200, Math.max(1, parsed.pageSize)),
      search: parsed.search,
      sortBy: parsed.sortBy,
      sortOrder: parsed.sortOrder,
    }),
  );
}

export function handleDeleteMapping(
  context: AppRequestContext,
  urlPath: string,
  res: ServerResponse,
): void {
  const icloudId = z
    .string()
    .min(1)
    .parse(decodeURIComponent(urlPath.replace("/api/mappings/", "")));
  const deleted = deleteMapping(context.state!, icloudId);

  if (deleted > 0) {
    logger.info({ icloudId }, "Mapping deleted via UI");
  }

  sendJson(res, 200, { deleted });
}

export async function handleBulkDelete(
  context: AppRequestContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readBody(req);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(body);
  } catch {
    sendJson(res, 400, { error: "Invalid JSON" });
    return;
  }

  const parsed = bulkDeleteSchema.safeParse(parsedJson);
  if (!parsed.success) {
    sendJson(res, 400, { error: "icloudIds must be an array" });
    return;
  }

  const deleted = bulkDeleteMappings(context.state!, parsed.data.icloudIds);
  logger.info(
    { count: deleted, requested: parsed.data.icloudIds.length },
    "Bulk delete via UI",
  );

  sendJson(res, 200, { deleted });
}
