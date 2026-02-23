import { useState, useEffect, useCallback, useRef } from "react";
import Toast, { toast } from "../components/Toast";

interface Mapping {
  icloudId: string;
  icloudChecksum: string;
  amazonId: string;
  syncedAt: string;
}

interface PaginationInfo {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

interface MappingsResponse {
  data: Mapping[];
  pagination: PaginationInfo;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

async function parseJsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const err = (await res.json()) as { error?: string };
      if (err.error) message = err.error;
    } catch {
      // ignore JSON parse failures for error bodies
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export default function Mappings() {
  const [data, setData] = useState<Mapping[]>([]);
  const [pagination, setPagination] = useState<PaginationInfo>({
    page: 1,
    pageSize: 50,
    totalItems: 0,
    totalPages: 1,
  });
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [pageSize, setPageSize] = useState(50);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchAbortController = useRef<AbortController | null>(null);

  const fetchMappings = useCallback(
    async (page?: number) => {
      fetchAbortController.current?.abort();
      const controller = new AbortController();
      fetchAbortController.current = controller;

      const params = new URLSearchParams({
        page: String(page ?? 1),
        pageSize: String(pageSize),
        sortBy: "synced_at",
        sortOrder: "desc",
      });
      if (search) params.set("search", search);

      try {
        const res = await fetch(`/api/mappings?${params}`, {
          signal: controller.signal,
        });
        const json = await parseJsonOrThrow<MappingsResponse>(res);
        setData(json.data);
        setPagination(json.pagination);
      } catch (err) {
        if (
          err instanceof DOMException &&
          err.name === "AbortError"
        ) {
          return;
        }
        toast("Failed to load mappings", "error");
      }
    },
    [search, pageSize],
  );

  useEffect(() => {
    fetchMappings(1);
  }, [fetchMappings]);

  useEffect(() => {
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
      fetchAbortController.current?.abort();
    };
  }, []);

  const handleSearchChange = (value: string) => {
    setSearchInput(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setSelected(new Set());
      setSearch(value);
    }, 300);
  };

  const goPage = (delta: number) => {
    const newPage = Math.max(
      1,
      Math.min(pagination.totalPages, pagination.page + delta),
    );
    setSelected(new Set());
    fetchMappings(newPage);
  };

  const toggleSelect = (id: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const toggleAll = (checked: boolean) => {
    if (checked) {
      setSelected(new Set(data.map((m) => m.icloudId)));
    } else {
      setSelected(new Set());
    }
  };

  const deleteSingle = async (icloudId: string) => {
    if (
      !confirm("Delete this mapping? The photo will resync on the next cycle.")
    )
      return;
    try {
      const res = await fetch(
        `/api/mappings/${encodeURIComponent(icloudId)}`,
        { method: "DELETE" },
      );
      const json = await parseJsonOrThrow<{ deleted: number }>(res);
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(icloudId);
        return next;
      });
      toast(`Deleted ${json.deleted} mapping(s)`, "success");
      await fetchMappings(pagination.page);
    } catch {
      toast("Delete failed", "error");
    }
  };

  const bulkDelete = async () => {
    const ids = [...selected];
    if (
      !confirm(
        `Delete ${ids.length} mapping(s)? These photos will resync on the next cycle.`,
      )
    )
      return;
    try {
      const res = await fetch("/api/mappings/bulk-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ icloudIds: ids }),
      });
      const json = await parseJsonOrThrow<{ deleted: number }>(res);
      setSelected(new Set());
      toast(`Deleted ${json.deleted} mapping(s)`, "success");
      await fetchMappings(pagination.page);
    } catch {
      toast("Bulk delete failed", "error");
    }
  };

  const start = (pagination.page - 1) * pagination.pageSize + 1;
  const end = Math.min(
    pagination.page * pagination.pageSize,
    pagination.totalItems,
  );

  return (
    <>
      <div className="card">
        <div className="page-header">
          <h2>Photo Mappings</h2>
          <span className="badge">{pagination.totalItems} total</span>
        </div>

        <div className="toolbar">
          <input
            type="text"
            placeholder="Filter by ID or checksum..."
            value={searchInput}
            onChange={(e) => handleSearchChange(e.target.value)}
            style={{ flex: 1, minWidth: 200 }}
            aria-label="Search mappings"
          />
          <select
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number(e.target.value));
              setSelected(new Set());
            }}
            aria-label="Mappings page size"
          >
            <option value={25}>25 per page</option>
            <option value={50}>50 per page</option>
            <option value={100}>100 per page</option>
          </select>
          {selected.size > 0 && (
            <button className="btn btn-danger" onClick={bulkDelete}>
              Delete Selected ({selected.size})
            </button>
          )}
        </div>

        {data.length > 0 ? (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 32, textAlign: "center" }}>
                      <input
                        type="checkbox"
                        checked={
                          data.length > 0 &&
                          data.every((m) => selected.has(m.icloudId))
                        }
                        onChange={(e) => toggleAll(e.target.checked)}
                        aria-label="Select all mappings on this page"
                      />
                    </th>
                    <th>iCloud ID</th>
                    <th>Checksum</th>
                    <th>Amazon ID</th>
                    <th>Synced At</th>
                    <th style={{ width: 60, textAlign: "center" }} />
                  </tr>
                </thead>
                <tbody>
                  {data.map((m) => {
                    const dateStr = formatDateTime(m.syncedAt);
                    return (
                      <tr key={m.icloudId}>
                        <td style={{ textAlign: "center" }}>
                          <input
                            type="checkbox"
                            checked={selected.has(m.icloudId)}
                            onChange={(e) =>
                              toggleSelect(m.icloudId, e.target.checked)
                            }
                            aria-label={`Select mapping ${m.icloudId}`}
                          />
                        </td>
                        <td className="mono" title={m.icloudId}>
                          {m.icloudId}
                        </td>
                        <td className="mono" title={m.icloudChecksum}>
                          {m.icloudChecksum}
                        </td>
                        <td className="mono" title={m.amazonId}>
                          {m.amazonId}
                        </td>
                        <td>{dateStr}</td>
                        <td style={{ textAlign: "center" }}>
                          <button
                            className="btn btn-danger btn-sm"
                            onClick={() => deleteSingle(m.icloudId)}
                            aria-label={`Delete mapping ${m.icloudId}`}
                            title="Delete mapping"
                          >
                            &times;
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="pagination">
              <div className="pagination-info">
                {pagination.totalItems > 0
                  ? `Showing ${start}-${end} of ${pagination.totalItems}`
                  : ""}
              </div>
              <div className="pagination-controls">
                <button
                  className="btn btn-sm"
                  onClick={() => goPage(-1)}
                  disabled={pagination.page <= 1}
                >
                  &laquo; Prev
                </button>
                <span style={{ fontSize: "0.85rem", padding: "0 0.5rem" }}>
                  {pagination.totalPages > 0
                    ? `Page ${pagination.page} of ${pagination.totalPages}`
                    : ""}
                </span>
                <button
                  className="btn btn-sm"
                  onClick={() => goPage(1)}
                  disabled={pagination.page >= pagination.totalPages}
                >
                  Next &raquo;
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="empty">No photo mappings found.</div>
        )}
      </div>
      <Toast />
    </>
  );
}
