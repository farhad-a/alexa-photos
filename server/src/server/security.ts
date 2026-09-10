import { IncomingMessage } from "http";
import * as net from "net";
import { firstHeaderValue } from "./http.js";

/**
 * Request guards for the admin server.
 *
 * There is no authentication: anyone who can reach the port can drive every
 * endpoint. These guards do not change that. What they close is the remote
 * vector — a page the admin merely *visits* driving the API from their browser,
 * which needs no network access to the box at all.
 */

/**
 * Not a CORS-safelisted header, so a cross-origin caller cannot set it without
 * triggering a preflight — and with no `Access-Control-Allow-Origin` anywhere,
 * that preflight fails. A cross-origin caller that omits it is rejected here.
 *
 * Preferred over comparing `Origin` against `Host`: the Vite dev proxy's Host
 * handling varies by version, so that comparison breaks in dev, whereas a
 * custom header behaves identically in dev and production.
 */
export const CSRF_HEADER = "x-requested-with";
export const CSRF_VALUE = "alexa-photos";

/** Methods that cannot change anything, so they need no CSRF token. */
const SAFE_METHODS = new Set(["GET", "HEAD"]);

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/** Strip the `:port` suffix and normalise, leaving bracketed IPv6 intact. */
function hostnameOf(hostHeader: string): string {
  const host = hostHeader.trim().toLowerCase();

  // [::1]:3000 -> ::1
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? host : host.slice(1, end);
  }

  // A bare IPv6 literal has several colons; only strip a real port.
  const colon = host.lastIndexOf(":");
  if (colon !== -1 && !host.slice(colon + 1).includes(":")) {
    const maybePort = host.slice(colon + 1);
    if (/^\d+$/.test(maybePort)) return host.slice(0, colon);
  }

  return host;
}

/**
 * Guard against DNS rebinding, which CORS cannot stop: an attacker domain that
 * resolves to this machine's LAN address is *same-origin* to the browser, so
 * every same-origin protection is bypassed. The one thing the attacker cannot
 * change is the Host header — it carries their domain.
 *
 * IP literals and loopback are always allowed, so IP-based LAN access needs no
 * configuration. Any other name must be listed explicitly: a hostname the admin
 * uses and an attacker's hostname are structurally indistinguishable, which is
 * exactly what makes the attack work, so there is nothing safe to infer.
 */
export function isAllowedHost(
  hostHeader: string | undefined,
  allowedHosts: string[],
): boolean {
  // A browser always sends Host, so its absence cannot be this attack.
  if (!hostHeader) return true;

  const hostname = hostnameOf(hostHeader);
  if (!hostname) return true;

  if (LOOPBACK_HOSTS.has(hostname)) return true;
  if (net.isIP(hostname) !== 0) return true;

  // Entries are normalised here rather than at load time so config stays a
  // plain env-var mapping and this module owns what a hostname means.
  return allowedHosts.some((allowed) => hostnameOf(allowed) === hostname);
}

export function isSafeMethod(method: string | undefined): boolean {
  return SAFE_METHODS.has((method ?? "GET").toUpperCase());
}

export function hasCsrfHeader(req: IncomingMessage): boolean {
  const value = firstHeaderValue(req.headers?.[CSRF_HEADER]);
  return value?.trim().toLowerCase() === CSRF_VALUE;
}
