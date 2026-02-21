import { Link } from "react-router-dom";
import { useCallback, useEffect, useMemo, useState } from "react";

interface LastSync {
  timestamp: string;
  durationMs: number;
  photosAdded: number;
  photosRemoved: number;
  success: boolean;
  error?: string;
}

interface Metrics {
  status: "healthy" | "unhealthy" | "starting";
  uptime: number;
  totalSyncs: number;
  totalErrors: number;
  amazonAuthenticated: boolean;
  lastSync?: LastSync;
  nextSync?: string;
}

function formatUptime(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export default function Home() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchMetrics = useCallback(async () => {
    try {
      const res = await fetch("/metrics");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: Metrics = await res.json();
      setMetrics(json);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load metrics");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMetrics();
    const id = setInterval(fetchMetrics, 15000);
    return () => clearInterval(id);
  }, [fetchMetrics]);

  const successRate = useMemo(() => {
    if (!metrics || metrics.totalSyncs === 0) return "—";
    const ok = metrics.totalSyncs - metrics.totalErrors;
    return `${Math.max(0, Math.round((ok / metrics.totalSyncs) * 100))}%`;
  }, [metrics]);

  return (
    <div className="card home-card">
      <div className="page-header">
        <h2>Admin Home</h2>
      </div>

      <p className="home-subtitle">
        Live system snapshot and quick actions for alexa-photos.
      </p>

      <div className="home-hero">
        <div>
          <div className="home-hero-label">Service Status</div>
          <div className={`home-hero-value ${metrics?.status ?? "starting"}`}>
            {loading ? "Loading..." : metrics?.status ?? "unknown"}
          </div>
        </div>
        <div className="home-hero-meta">
          <span className={`status-dot ${metrics?.amazonAuthenticated ? "ok" : "error"}`} />
          Amazon auth {metrics?.amazonAuthenticated ? "connected" : "disconnected"}
        </div>
      </div>

      {error && <div className="home-error">Metrics unavailable: {error}</div>}

      <div className="home-metrics-grid">
        <div className="metric-tile">
          <div className="metric-label">Uptime</div>
          <div className="metric-value">{metrics ? formatUptime(metrics.uptime) : "—"}</div>
        </div>
        <div className="metric-tile">
          <div className="metric-label">Total syncs</div>
          <div className="metric-value">{metrics?.totalSyncs ?? "—"}</div>
        </div>
        <div className="metric-tile">
          <div className="metric-label">Total errors</div>
          <div className="metric-value">{metrics?.totalErrors ?? "—"}</div>
        </div>
        <div className="metric-tile">
          <div className="metric-label">Success rate</div>
          <div className="metric-value">{successRate}</div>
        </div>
      </div>

      <div className="home-last-sync">
        <h3>Last Sync</h3>
        {metrics?.lastSync ? (
          <ul>
            <li>
              <strong>When:</strong> {new Date(metrics.lastSync.timestamp).toLocaleString()}
            </li>
            <li>
              <strong>Duration:</strong> {metrics.lastSync.durationMs} ms
            </li>
            <li>
              <strong>Changes:</strong> +{metrics.lastSync.photosAdded} / -{metrics.lastSync.photosRemoved}
            </li>
            <li>
              <strong>Result:</strong> {metrics.lastSync.success ? "Success" : "Failed"}
            </li>
            {metrics.lastSync.error && (
              <li>
                <strong>Error:</strong> {metrics.lastSync.error}
              </li>
            )}
            {metrics.nextSync && (
              <li>
                <strong>Next sync:</strong> {new Date(metrics.nextSync).toLocaleString()}
              </li>
            )}
          </ul>
        ) : (
          <p>No sync has run yet.</p>
        )}
      </div>

      <div className="home-links">
        <Link className="home-link" to="/mappings">
          <h3>Photo Mappings</h3>
          <p>Browse, search, and delete iCloud ↔ Amazon mapping entries.</p>
        </Link>

        <Link className="home-link" to="/cookies">
          <h3>Amazon Cookies</h3>
          <p>View, update, and test Amazon authentication cookies.</p>
        </Link>
      </div>
    </div>
  );
}
