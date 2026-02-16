export function renderUI(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Photo Mappings - alexa-photos</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.5;
      padding: 1.5rem;
      background: #f8f9fa;
      color: #1a1a1a;
    }
    @media (prefers-color-scheme: dark) {
      body { background: #1a1a1a; color: #333; }
      .card { background: #2a2a2a; border-color: #3a3a3a; }
      table th { background: #333; }
      table td { border-color: #3a3a3a; }
      table tr:hover td { background: #333; }
      input, select { background: #333; color: #e0e0e0; border-color: #555; }
      .btn { background: #333; color: #e0e0e0; border-color: #555; }
      .btn:hover { background: #444; }
      .btn-danger { background: #c0392b; border-color: #c0392b; color: #fff; }
      .btn-danger:hover { background: #e74c3c; }
      .empty { color: #888; }
    }
    .card {
      background: #fff;
      border: 1px solid #dee2e6;
      border-radius: 8px;
      padding: 1.5rem;
      max-width: 1200px;
      margin: 0 auto;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1rem;
    }
    .header h1 { font-size: 1.25rem; font-weight: 600; }
    .badge {
      background: #e9ecef;
      padding: 0.2rem 0.6rem;
      border-radius: 12px;
      font-size: 0.85rem;
      font-weight: 500;
    }
    @media (prefers-color-scheme: dark) { .badge { background: #444; color: #e0e0e0; } }
    .toolbar {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 1rem;
      flex-wrap: wrap;
      align-items: center;
    }
    input[type="text"] {
      flex: 1;
      min-width: 200px;
      padding: 0.4rem 0.75rem;
      border: 1px solid #ccc;
      border-radius: 4px;
      font-size: 0.9rem;
    }
    select {
      padding: 0.4rem 0.5rem;
      border: 1px solid #ccc;
      border-radius: 4px;
      font-size: 0.9rem;
    }
    .btn {
      padding: 0.4rem 0.75rem;
      border: 1px solid #ccc;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.9rem;
      background: #fff;
    }
    .btn:hover { background: #f0f0f0; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-danger { background: #e74c3c; color: #fff; border-color: #e74c3c; }
    .btn-danger:hover { background: #c0392b; }
    .btn-sm { padding: 0.2rem 0.5rem; font-size: 0.8rem; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    table th {
      text-align: left;
      padding: 0.5rem 0.75rem;
      background: #f8f9fa;
      font-weight: 600;
      border-bottom: 2px solid #dee2e6;
      white-space: nowrap;
    }
    table td {
      padding: 0.5rem 0.75rem;
      border-bottom: 1px solid #eee;
      max-width: 200px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    table tr:hover td { background: #f8f9fa; }
    .mono { font-family: "SF Mono", SFMono-Regular, Consolas, monospace; font-size: 0.8rem; }
    .pagination {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 1rem;
      flex-wrap: wrap;
      gap: 0.5rem;
    }
    .pagination-info { font-size: 0.85rem; color: #666; }
    @media (prefers-color-scheme: dark) { .pagination-info { color: #aaa; } }
    .pagination-controls { display: flex; gap: 0.25rem; align-items: center; }
    .empty {
      text-align: center;
      padding: 3rem 1rem;
      color: #666;
      font-size: 0.95rem;
    }
    .toast {
      position: fixed;
      bottom: 1.5rem;
      right: 1.5rem;
      padding: 0.75rem 1rem;
      border-radius: 6px;
      color: #fff;
      font-size: 0.9rem;
      z-index: 100;
      opacity: 0;
      transition: opacity 0.3s;
    }
    .toast.show { opacity: 1; }
    .toast-success { background: #27ae60; }
    .toast-error { background: #e74c3c; }
    .check-col { width: 32px; text-align: center; }
    .actions-col { width: 60px; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h1>Photo Mappings</h1>
      <span class="badge" id="total-badge">-</span>
    </div>
    <div class="toolbar">
      <input type="text" id="search" placeholder="Filter by ID or checksum...">
      <select id="page-size">
        <option value="25">25 per page</option>
        <option value="50" selected>50 per page</option>
        <option value="100">100 per page</option>
      </select>
      <button class="btn btn-danger" id="bulk-delete" style="display:none" onclick="bulkDelete()">
        Delete Selected (<span id="selected-count">0</span>)
      </button>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th class="check-col"><input type="checkbox" id="select-all" onchange="toggleAll(this.checked)"></th>
            <th>iCloud ID</th>
            <th>Checksum</th>
            <th>Amazon ID</th>
            <th>Synced At</th>
            <th class="actions-col"></th>
          </tr>
        </thead>
        <tbody id="tbody"></tbody>
      </table>
    </div>
    <div id="empty-state" class="empty" style="display:none">No photo mappings found.</div>
    <div class="pagination">
      <div class="pagination-info" id="pagination-info"></div>
      <div class="pagination-controls">
        <button class="btn btn-sm" id="prev-btn" onclick="goPage(-1)">&laquo; Prev</button>
        <span id="page-display" style="font-size:0.85rem;padding:0 0.5rem"></span>
        <button class="btn btn-sm" id="next-btn" onclick="goPage(1)">Next &raquo;</button>
      </div>
    </div>
  </div>
  <div class="toast" id="toast"></div>
  <script>
    let currentPage = 1;
    let totalPages = 1;
    let totalItems = 0;
    const selected = new Set();

    const $ = (id) => document.getElementById(id);
    const pageSize = () => Number($("page-size").value);

    async function fetchMappings() {
      const search = $("search").value.trim();
      const params = new URLSearchParams({
        page: String(currentPage),
        pageSize: String(pageSize()),
        sortBy: "synced_at",
        sortOrder: "desc",
      });
      if (search) params.set("search", search);

      try {
        const res = await fetch("/api/mappings?" + params);
        const json = await res.json();
        totalItems = json.pagination.totalItems;
        totalPages = json.pagination.totalPages;
        render(json.data);
      } catch (e) {
        showToast("Failed to load mappings", "error");
      }
    }

    function render(data) {
      $("total-badge").textContent = totalItems + " total";
      const tbody = $("tbody");
      const empty = $("empty-state");

      if (data.length === 0) {
        tbody.innerHTML = "";
        empty.style.display = "block";
      } else {
        empty.style.display = "none";
        tbody.innerHTML = data.map((m) => {
          const checked = selected.has(m.icloudId) ? "checked" : "";
          const date = new Date(m.syncedAt);
          const dateStr = date.toLocaleDateString() + " " + date.toLocaleTimeString();
          return \`<tr>
            <td class="check-col"><input type="checkbox" \${checked} onchange="toggleSelect('\${esc(m.icloudId)}', this.checked)"></td>
            <td class="mono" title="\${esc(m.icloudId)}">\${esc(m.icloudId)}</td>
            <td class="mono" title="\${esc(m.icloudChecksum)}">\${esc(m.icloudChecksum)}</td>
            <td class="mono" title="\${esc(m.amazonId)}">\${esc(m.amazonId)}</td>
            <td>\${esc(dateStr)}</td>
            <td class="actions-col"><button class="btn btn-danger btn-sm" onclick="deleteSingle('\${esc(m.icloudId)}')">&times;</button></td>
          </tr>\`;
        }).join("");
      }

      $("select-all").checked = false;
      $("prev-btn").disabled = currentPage <= 1;
      $("next-btn").disabled = currentPage >= totalPages;
      $("page-display").textContent = totalPages > 0 ? "Page " + currentPage + " of " + totalPages : "";

      const start = (currentPage - 1) * pageSize() + 1;
      const end = Math.min(currentPage * pageSize(), totalItems);
      $("pagination-info").textContent = totalItems > 0
        ? "Showing " + start + "-" + end + " of " + totalItems
        : "";

      updateBulkButton();
    }

    function esc(s) {
      const d = document.createElement("div");
      d.textContent = s;
      return d.innerHTML;
    }

    function toggleSelect(id, checked) {
      if (checked) selected.add(id); else selected.delete(id);
      updateBulkButton();
    }

    function toggleAll(checked) {
      const boxes = $("tbody").querySelectorAll("input[type=checkbox]");
      boxes.forEach((cb) => {
        cb.checked = checked;
        const id = cb.closest("tr").querySelector(".mono").title;
        if (checked) selected.add(id); else selected.delete(id);
      });
      updateBulkButton();
    }

    function updateBulkButton() {
      const btn = $("bulk-delete");
      $("selected-count").textContent = selected.size;
      btn.style.display = selected.size > 0 ? "inline-block" : "none";
    }

    async function deleteSingle(icloudId) {
      if (!confirm("Delete this mapping? The photo will resync on the next cycle.")) return;
      try {
        const res = await fetch("/api/mappings/" + encodeURIComponent(icloudId), { method: "DELETE" });
        const json = await res.json();
        selected.delete(icloudId);
        showToast("Deleted " + json.deleted + " mapping(s)", "success");
        fetchMappings();
      } catch (e) {
        showToast("Delete failed", "error");
      }
    }

    async function bulkDelete() {
      const ids = [...selected];
      if (!confirm("Delete " + ids.length + " mapping(s)? These photos will resync on the next cycle.")) return;
      try {
        const res = await fetch("/api/mappings/bulk-delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ icloudIds: ids }),
        });
        const json = await res.json();
        selected.clear();
        showToast("Deleted " + json.deleted + " mapping(s)", "success");
        fetchMappings();
      } catch (e) {
        showToast("Bulk delete failed", "error");
      }
    }

    function goPage(delta) {
      currentPage = Math.max(1, Math.min(totalPages, currentPage + delta));
      selected.clear();
      fetchMappings();
    }

    function showToast(msg, type) {
      const t = $("toast");
      t.textContent = msg;
      t.className = "toast toast-" + type + " show";
      setTimeout(() => { t.className = "toast"; }, 3000);
    }

    // Debounced search
    let searchTimer;
    $("search").addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        currentPage = 1;
        selected.clear();
        fetchMappings();
      }, 300);
    });

    $("page-size").addEventListener("change", () => {
      currentPage = 1;
      selected.clear();
      fetchMappings();
    });

    // Initial load
    fetchMappings();
  </script>
</body>
</html>`;
}
