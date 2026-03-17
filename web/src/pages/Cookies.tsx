import { useState, useEffect, useCallback } from "react";
import { useToast } from "../components/Toast";
import { getJson, postJson } from "../lib/api";

interface CookieInfo {
  exists: boolean;
  cookies: Record<string, string>;
  tld: string | null;
  region: string | null;
  presentKeys: string[];
  missingKeys: string[];
}

interface AuthStatus {
  authenticated: boolean;
  error?: string;
}

export default function Cookies() {
  const { showToast } = useToast();
  const [info, setInfo] = useState<CookieInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pasteMode, setPasteMode] = useState(true);
  const [cookieString, setCookieString] = useState("");
  const [manualCookies, setManualCookies] = useState<Record<string, string>>(
    {},
  );

  const US_KEYS = [
    "session-id",
    "ubid-main",
    "at-main",
    "x-main",
    "sess-at-main",
    "sst-main",
  ];

  const fetchCookies = useCallback(async () => {
    try {
      const json = await getJson<CookieInfo>("/api/cookies");
      setInfo(json);
      setLoadError(null);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load cookie info";
      setLoadError(message);
      showToast(message, "error");
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void fetchCookies();
  }, [fetchCookies]);

  const testAuth = async () => {
    setTesting(true);
    setAuth(null);
    try {
      const json = await postJson<AuthStatus>("/api/cookies/test");
      setAuth(json);
      if (json.authenticated) {
        showToast("Authentication successful", "success");
      } else {
        showToast(json.error ?? "Authentication failed", "error");
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Test request failed", "error");
    } finally {
      setTesting(false);
    }
  };

  const saveCookies = async () => {
    setSaving(true);
    try {
      const body = pasteMode
        ? { cookieString }
        : {
            cookies: Object.fromEntries(
              Object.entries(manualCookies).filter(([, v]) => v.trim()),
            ),
          };

      await postJson<CookieInfo>("/api/cookies", body);

      showToast("Cookies saved", "success");
      setCookieString("");
      setManualCookies({});
      setAuth(null);
      await fetchCookies();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Save request failed", "error");
    } finally {
      setSaving(false);
    }
  };

  const handleManualChange = (key: string, value: string) => {
    setManualCookies((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <div className="card">
      <div className="page-header">
        <h2>Amazon Cookies</h2>
      </div>

      {loading && <div className="empty">Loading cookie status…</div>}
      {!loading && loadError && (
        <div className="inline-error" role="alert">
          Could not load cookies: {loadError}
          <button className="btn btn-sm" onClick={() => void fetchCookies()}>
            Retry
          </button>
        </div>
      )}

      {/* Current status */}
      {!loading && info && (
        <>
          <div
            className={`cookie-status ${
              auth
                ? auth.authenticated
                  ? "ok"
                  : "error"
                : info.exists
                  ? "unknown"
                  : "error"
            }`}
          >
            <span
              className={`status-dot ${
                auth
                  ? auth.authenticated
                    ? "ok"
                    : "error"
                  : info.exists
                    ? "unknown"
                    : "error"
              }`}
            />
            {auth
              ? auth.authenticated
                ? "Authenticated"
                : `Not authenticated${auth.error ? `: ${auth.error}` : ""}`
              : info.exists
                ? "Cookies loaded — click Test to verify"
                : "No cookies file found"}
            {info.region && (
              <span className="badge" style={{ marginLeft: "auto" }}>
                {info.region}
              </span>
            )}
          </div>

          {info.exists && (
            <>
              <div className="section-header">Stored Cookies</div>
              <div className="cookie-grid">
                {info.presentKeys.map((key) => (
                  <div className="cookie-row" key={key}>
                    <label>{key}</label>
                    <span className="value">{info.cookies[key]}</span>
                  </div>
                ))}
              </div>
              {info.missingKeys.length > 0 && (
                <div className="inline-error" role="alert">
                  Missing: {info.missingKeys.join(", ")}
                </div>
              )}

              <div style={{ marginTop: "1rem" }}>
                <button
                  className="btn btn-primary"
                  onClick={testAuth}
                  disabled={testing}
                >
                  {testing ? "Testing..." : "Test Authentication"}
                </button>
              </div>
            </>
          )}
        </>
      )}

      {/* Update cookies */}
      <div className="section-header" style={{ marginTop: "2rem" }}>
        Update Cookies
      </div>

      <div className="toolbar">
        <button
          className={`btn ${pasteMode ? "btn-primary" : ""}`}
          onClick={() => setPasteMode(true)}
        >
          Paste Cookie String
        </button>
        <button
          className={`btn ${!pasteMode ? "btn-primary" : ""}`}
          onClick={() => setPasteMode(false)}
        >
          Manual Entry
        </button>
      </div>

      {pasteMode ? (
        <div>
          <p className="inline-muted">
            Open Amazon Photos → DevTools → Network → any request → Cookie
            header → copy the full value.
          </p>
          <textarea
            className="cookie-paste"
            placeholder="session-id=...; ubid-main=...; at-main=...; ..."
            value={cookieString}
            onChange={(e) => setCookieString(e.target.value)}
          />
        </div>
      ) : (
        <div className="cookie-grid">
          {US_KEYS.map((key) => (
            <div className="cookie-row" key={key}>
              <label>{key}</label>
              <input
                type="text"
                style={{ flex: 1 }}
                placeholder={`Enter ${key} value`}
                value={manualCookies[key] ?? ""}
                onChange={(e) => handleManualChange(key, e.target.value)}
              />
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: "1rem" }}>
        <button
          className="btn btn-primary"
          onClick={saveCookies}
          disabled={
            saving ||
            (pasteMode ? !cookieString.trim() : !manualCookies["session-id"])
          }
        >
          {saving ? "Saving..." : "Save Cookies"}
        </button>
      </div>
    </div>
  );
}
