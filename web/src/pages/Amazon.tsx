import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useToast } from "../components/Toast";
import { deleteJson, getJson, postJson } from "../lib/api";
import { requestMetricsRefresh } from "../lib/events";

type RegistrationState =
  | "idle"
  | "awaiting_login"
  | "completing"
  | "registered"
  | "failed"
  | "cancelled"
  | "timed_out";

interface AmazonStatus {
  registered: boolean;
  state: RegistrationState;
  proxyUrl?: string;
  expiresAt?: string;
  error?: string;
  marketplace?: string;
  deviceSerial?: string;
  deviceAppName?: string;
  registeredAt?: string;
  cookiesUpdatedAt?: string | null;
  cookieAgeDays?: number | null;
  lastRefreshAt?: string | null;
}

interface RegistrationProgress {
  state: RegistrationState;
  proxyUrl?: string;
  expiresAt?: string;
  error?: string;
}

interface AuthTestResult {
  authenticated: boolean;
  state: string;
  error?: string;
}

const POLL_MS = 2000;

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleString();
}

function formatAge(days: number | null | undefined): string {
  if (days === null || days === undefined) return "not minted yet";
  if (days < 1) return "less than a day old";
  const rounded = Math.floor(days);
  return `${rounded} day${rounded === 1 ? "" : "s"} old`;
}

export default function Amazon() {
  const { showToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const [status, setStatus] = useState<AmazonStatus | null>(null);
  const [progress, setProgress] = useState<RegistrationProgress | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [auth, setAuth] = useState<AuthTestResult | null>(null);

  const pollRef = useRef<number | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      setStatus(await getJson<AmazonStatus>("/api/amazon/status"));
      setLoadError(null);
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : "Failed to load status",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  // The proxy redirects the browser back here after sign-in, so pick the new
  // state up rather than making the user reload.
  useEffect(() => {
    if (searchParams.get("registered") !== "1") return;
    void fetchStatus();
    showToast("Signed in to Amazon", "success");
    searchParams.delete("registered");
    setSearchParams(searchParams, { replace: true });
  }, [searchParams, setSearchParams, fetchStatus, showToast]);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // Sign-in finishes in another tab or on another device, so the page has to
  // watch for it rather than wait for an interaction.
  const startPolling = useCallback(() => {
    stopPolling();
    pollRef.current = window.setInterval(async () => {
      try {
        const next = await getJson<RegistrationProgress>(
          "/api/amazon/registration/status",
        );
        setProgress(next);

        if (next.state === "registered") {
          stopPolling();
          setProgress(null);
          await fetchStatus();
          requestMetricsRefresh("amazon-registered");
          showToast("Device registered", "success");
        } else if (
          next.state === "failed" ||
          next.state === "timed_out" ||
          next.state === "cancelled"
        ) {
          stopPolling();
        }
      } catch {
        // Transient. Keep polling; the countdown bounds it.
      }
    }, POLL_MS);
  }, [fetchStatus, showToast, stopPolling]);

  useEffect(() => stopPolling, [stopPolling]);

  const register = async () => {
    setBusy("register");
    try {
      const started = await postJson<RegistrationProgress>(
        "/api/amazon/registration/start",
      );
      setProgress(started);
      startPolling();
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : "Could not start registration",
        "error",
      );
    } finally {
      setBusy(null);
    }
  };

  const cancel = async () => {
    setBusy("cancel");
    try {
      await postJson("/api/amazon/registration/cancel");
      stopPolling();
      setProgress(null);
      await fetchStatus();
    } finally {
      setBusy(null);
    }
  };

  const testAuth = async () => {
    setBusy("test");
    try {
      const result = await postJson<AuthTestResult>("/api/amazon/auth/test");
      setAuth(result);
      requestMetricsRefresh("amazon-auth-test");
      showToast(
        result.authenticated
          ? "Authentication is working"
          : "Not authenticated",
        result.authenticated ? "success" : "error",
      );
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Test failed", "error");
    } finally {
      setBusy(null);
    }
  };

  const refreshCookies = async () => {
    setBusy("refresh");
    try {
      const result = await postJson<{ refreshed: boolean }>(
        "/api/amazon/auth/refresh",
      );
      await fetchStatus();
      requestMetricsRefresh("amazon-refresh");
      showToast(
        result.refreshed ? "Minted fresh cookies" : "Refresh failed",
        result.refreshed ? "success" : "error",
      );
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Refresh failed", "error");
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    const ok = window.confirm(
      "Remove the stored registration?\n\n" +
        "This only forgets the credentials on this machine. The device stays " +
        "registered in your Amazon account until you remove it at " +
        "amazon.com/mycd.",
    );
    if (!ok) return;

    setBusy("remove");
    try {
      await deleteJson("/api/amazon/registration");
      setAuth(null);
      await fetchStatus();
      requestMetricsRefresh("amazon-removed");
      showToast("Registration removed", "success");
    } finally {
      setBusy(null);
    }
  };

  const pending =
    progress &&
    (progress.state === "awaiting_login" || progress.state === "completing");

  const failed =
    progress &&
    (progress.state === "failed" ||
      progress.state === "timed_out" ||
      progress.state === "cancelled");

  return (
    <div className="card">
      <div className="page-header">
        <h2>Amazon Account</h2>
      </div>

      {loading && <div className="empty">Loading account status…</div>}

      {loadError && (
        <div className="inline-error" role="alert">
          {loadError}
          <button className="btn btn-sm" onClick={() => void fetchStatus()}>
            Retry
          </button>
        </div>
      )}

      {pending && progress && (
        <div className="amazon-panel">
          <div className="section-header">Waiting for sign-in</div>
          <p className="inline-muted">
            Open this address in a browser on any device on your network, then
            sign in to Amazon. Two-step verification is handled there.
          </p>
          <p>
            <a
              className="amazon-proxy-link"
              href={progress.proxyUrl}
              target="_blank"
              rel="noreferrer"
            >
              {progress.proxyUrl}
            </a>
          </p>
          <p className="inline-muted">
            If that address is not reachable from your browser, set
            AMAZON_PROXY_OWN_IP to this machine&rsquo;s LAN address and try
            again. Expires {formatDate(progress.expiresAt)}.
          </p>
          <div className="toolbar">
            <button
              className="btn"
              onClick={() => void cancel()}
              disabled={busy === "cancel"}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {failed && progress && (
        <div className="inline-error" role="alert">
          {progress.state === "timed_out"
            ? "Sign-in timed out before it completed."
            : progress.state === "cancelled"
              ? "Registration cancelled."
              : (progress.error ?? "Registration failed.")}
          <button className="btn btn-sm" onClick={() => void register()}>
            Try again
          </button>
        </div>
      )}

      {!loading && !pending && status && !status.registered && (
        <div className="amazon-panel">
          <div className="section-header">No device registered</div>
          <p className="inline-muted">
            Sync signs in to Amazon once, through a login proxy on this machine,
            and keeps a long-lived device token afterwards. Your password is
            never sent to or stored by this app.
          </p>
          <div className="toolbar">
            <button
              className="btn btn-primary"
              onClick={() => void register()}
              disabled={busy === "register"}
            >
              {busy === "register" ? "Starting…" : "Register device"}
            </button>
          </div>
        </div>
      )}

      {!loading && status?.registered && (
        <>
          <div className="home-metrics-grid" style={{ marginTop: "1rem" }}>
            <div className="metric-tile">
              <div className="metric-label">Marketplace</div>
              <div className="metric-value" style={{ fontSize: "1rem" }}>
                {status.marketplace ?? "—"}
              </div>
            </div>
            <div className="metric-tile">
              <div className="metric-label">Device</div>
              <div className="metric-value" style={{ fontSize: "1rem" }}>
                {status.deviceSerial ?? "—"}
              </div>
            </div>
            <div className="metric-tile">
              <div className="metric-label">Registered</div>
              <div className="metric-value" style={{ fontSize: "1rem" }}>
                {formatDate(status.registeredAt)}
              </div>
            </div>
            <div className="metric-tile">
              <div className="metric-label">Cookies</div>
              <div className="metric-value" style={{ fontSize: "1rem" }}>
                {formatAge(status.cookieAgeDays)}
              </div>
            </div>
          </div>

          <p className="inline-muted" style={{ marginTop: "0.75rem" }}>
            Cookies are minted from the device token and refresh themselves
            before they expire. Last refresh {formatDate(status.lastRefreshAt)}.
          </p>

          {auth && (
            <div
              className={`auth-status ${auth.authenticated ? "ok" : "error"}`}
            >
              <span
                className={`status-dot ${auth.authenticated ? "ok" : "error"}`}
              />
              {auth.authenticated
                ? "Authenticated with Amazon"
                : (auth.error ?? `Not authenticated (${auth.state})`)}
            </div>
          )}

          <div className="toolbar" style={{ marginTop: "1rem" }}>
            <button
              className="btn"
              onClick={() => void testAuth()}
              disabled={busy === "test"}
            >
              {busy === "test" ? "Testing…" : "Test auth"}
            </button>
            <button
              className="btn"
              onClick={() => void refreshCookies()}
              disabled={busy === "refresh"}
            >
              {busy === "refresh" ? "Refreshing…" : "Refresh cookies now"}
            </button>
            <button
              className="btn"
              onClick={() => void register()}
              disabled={busy === "register"}
            >
              Re-register
            </button>
            <button
              className="btn btn-danger"
              onClick={() => void remove()}
              disabled={busy === "remove"}
            >
              Remove
            </button>
          </div>
        </>
      )}
    </div>
  );
}
