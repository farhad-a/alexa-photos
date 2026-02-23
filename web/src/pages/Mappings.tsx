import { useState, useEffect, useCallback, useRef } from "react";
import { useToast } from "../components/Toast";
import { deleteJson, getJson, postJson } from "../lib/api";

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

export default function Mappings() {
  const { showToast } = useToast();
  const [data, setData] = useState<Mapping[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
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
        const json = await getJson<MappingsResponse>(`/api/mappings?${params}`, {
          signal: controller.signal,
        });
        setData(json.data);
        setPagination(json.pagination);
        setLoadError(null);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          return;
        }
        const message = err instanceof Error ? err.message : "Failed to load mappings";
        setLoadError(message);
        showToast(message, "error");
      } finally {
        setLoading(false);
      }
    },
    [search, pageSize, showToast],
  );

  useEffect(() => {
    void fetchMappings(1);
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
    void fetchMappings(newPage);
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
      const json = await deleteJson<{ deleted: number }>(
        `/api/mappings/${encodeURIComponent(icloudId)}`,
      );
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(icloudId);
        return next;
      });
      showToast(`Deleted ${json.deleted} mapping(s)`, "success");
      await fetchMappings(pagination.page);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Delete failed", "error");
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
      const json = await postJson<{ deleted: number }>(
        "/api/mappings/bulk-delete",
        {
          icloudIds: ids,
        },
      );
      setSelected(new Set());
      showToast(`Deleted ${json.deleted} mapping(s)`, "success");
      await fetchMappings(pagination.page);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Bulk delete failed", "error");
    }
  };

  const start = (pagination.page - 1) * pagination.pageSize + 1;
  const end = Math.min(
    pagination.page * pagination.pageSize,
    pagination.totalItems,
  );

  return (
    <div className="card mappings-card">
      <div className="page-header">
        <h2>Photo Mappings</h2>
        <span className="badge">{pagination.totalItems} total</span>
      </div>

      <p className="mappings-subtitle">
        Manage iCloud ↔ Amazon photo links. Deleting a mapping forces that photo to resync on the next cycle.
      </p>

      <div className="mappings-toolbar toolbar">
        <input
          type="text"
          placeholder="Filter by ID or checksum..."
          value={searchInput}
          onChange={(e) => handleSearchChange(e.target.value)}
          className="mappings-search"
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

      {loading && <div className="empty">Loading mappings…</div>}
      {!loading && loadError && (
        <div className="inline-error" role="alert">
          Failed to load mappings: {loadError}
          <button className="btn btn-sm" onClick={() => void fetchMappings(1)}>
            Retry
          </button>
        </div>
      )}

      {!loading && !loadError &&
        (data.length > 0 ? (
          <>
            <div className="table-wrap mappings-table-wrap">
              <table className="mappings-table">
                <thead>
                  <tr>
                    <th className="mappings-select-col">
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
                    <th className="mappings-actions-col" />
                  </tr>
                </thead>
                <tbody>
                  {data.map((m) => {
                    const dateStr = formatDateTime(m.syncedAt);
                    return (
                      <tr key={m.icloudId}>
                        <td className="mappings-select-col">
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
                        <td className="mappings-actions-col">
                          <button
                            className="btn btn-danger btn-sm mappings-delete-btn"
                            onClick={() => deleteSingle(m.icloudId)}
                            aria-label={`Delete mapping ${m.icloudId}`}
                            title="Delete mapping"
                          >
                            <span aria-hidden="true">×</span>
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
                <span className="mappings-page-label">
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
        ))}
    </div>
  );
}
