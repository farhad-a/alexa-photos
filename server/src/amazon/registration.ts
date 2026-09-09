import * as os from "os";
import { logger as rootLogger } from "../lib/logger.js";
import {
  buildAuthRecord,
  clearAmazonCredentials,
  cookieAgeDays,
  parseCookieHeader,
  readAmazonAuth,
  readAmazonSession,
  writeAmazonAuth,
  writeAmazonSession,
  type AmazonAuthRecord,
} from "./credentials.js";
import {
  refreshRegistration,
  startRegistration,
  stopProxy,
} from "./registration-proxy.js";

const logger = rootLogger.child({ component: "amazon-auth" });

/**
 * Drives the one-time device registration behind the admin UI.
 *
 * Module-level state, because alexa-cookie2 is itself a singleton and only one
 * login proxy can run at a time.
 */

export type RegistrationState =
  | "idle"
  | "awaiting_login"
  | "completing"
  | "registered"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface RegistrationStatus {
  state: RegistrationState;
  proxyUrl?: string;
  expiresAt?: string;
  error?: string;
}

export interface RegistrationSettings {
  authPath: string;
  amazonPage: string;
  acceptLanguage: string;
  proxyLanguage: string;
  deviceAppName: string;
  proxyOwnIp?: string;
  proxyPort: number;
  proxyListenBind: string;
  timeoutMs: number;
  /** Where the browser is sent after a successful sign-in. */
  adminPort: number;
}

interface RegistrationRuntime extends RegistrationStatus {
  startedAt?: number;
}

let current: RegistrationRuntime = { state: "idle" };
let onCredentialsChanged: (() => void | Promise<void>) | undefined;

export function setCredentialsChangedHandler(
  handler: (() => void | Promise<void>) | undefined,
): void {
  onCredentialsChanged = handler;
}

export function getRegistrationStatus(): RegistrationStatus {
  const { startedAt: _startedAt, ...status } = current;
  void _startedAt;
  return status;
}

/** Reset to idle. Exposed for tests and for the cancel route. */
export function resetRegistrationState(): void {
  current = { state: "idle" };
}

/**
 * Resolve the address the browser will use to reach the login proxy.
 *
 * Auto-detection is a last resort. Inside Docker it returns the container's
 * bridge address, which no browser can reach, and the failure is silent: the
 * proxy starts and every rewritten Amazon link simply dies. Configure it.
 */
export function resolveProxyOwnIp(configured?: string): string {
  if (configured) return configured;

  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        logger.warn(
          { detected: address.address },
          "AMAZON_PROXY_OWN_IP is not set; guessing the LAN address. Inside Docker this guess is wrong and sign-in will fail silently",
        );
        return address.address;
      }
    }
  }

  throw new Error(
    "Could not determine a LAN address for the login proxy. Set AMAZON_PROXY_OWN_IP to an IP your browser can reach.",
  );
}

/** Page shown by the proxy after sign-in. Sends the browser back to the admin UI. */
function closeWindowHtml(proxyOwnIp: string, adminPort: number): string {
  // Must use the same address the user typed. The browser is on another
  // machine, so localhost would point at itself.
  const target = `http://${proxyOwnIp}:${adminPort}/amazon?registered=1`;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="refresh" content="1;url=${target}">
<title>Amazon sign-in complete</title></head>
<body style="font-family:system-ui;padding:2rem">
<h2>Signed in.</h2>
<p>Returning to Alexa Photos. <a href="${target}">Continue</a> if nothing happens.</p>
</body></html>`;
}

/**
 * Start the login proxy and register a device.
 *
 * Returns as soon as the proxy is listening so the caller can hand the user a
 * URL. Registration continues in the background; poll the status.
 */
export function beginRegistration(
  settings: RegistrationSettings,
): RegistrationStatus {
  if (current.state === "awaiting_login" || current.state === "completing") {
    throw Object.assign(new Error("A registration is already in progress"), {
      code: "REGISTRATION_IN_PROGRESS",
    });
  }

  const proxyOwnIp = resolveProxyOwnIp(settings.proxyOwnIp);
  const proxyUrl = `http://${proxyOwnIp}:${settings.proxyPort}/`;
  const expiresAt = new Date(Date.now() + settings.timeoutMs).toISOString();

  current = {
    state: "awaiting_login",
    proxyUrl,
    expiresAt,
    startedAt: Date.now(),
  };

  void runRegistration(settings, proxyOwnIp, proxyUrl, expiresAt);

  return getRegistrationStatus();
}

async function runRegistration(
  settings: RegistrationSettings,
  proxyOwnIp: string,
  proxyUrl: string,
  expiresAt: string,
): Promise<void> {
  try {
    const registration = await startRegistration({
      amazonPage: settings.amazonPage,
      acceptLanguage: settings.acceptLanguage,
      proxyLanguage: settings.proxyLanguage,
      deviceAppName: settings.deviceAppName,
      proxyOwnIp,
      proxyPort: settings.proxyPort,
      proxyListenBind: settings.proxyListenBind,
      closeWindowHtml: closeWindowHtml(proxyOwnIp, settings.adminPort),
      timeoutMs: settings.timeoutMs,
    });

    if (current.state === "cancelled") {
      logger.info("Registration completed after cancellation; discarding");
      return;
    }

    current = { state: "completing", proxyUrl, expiresAt };

    const auth = buildAuthRecord(registration, {
      amazonPage: settings.amazonPage,
      acceptLanguage: settings.acceptLanguage,
      proxyLanguage: settings.proxyLanguage,
      deviceAppName: settings.deviceAppName,
    });
    await writeAmazonAuth(settings.authPath, auth);

    // Prove the durable loop immediately rather than trusting the sign-in
    // cookies. If minting from the token fails, the registration is useless
    // and the user must find out now, not in a week.
    await mintInitialSession(settings.authPath, auth, registration.localCookie);

    current = { state: "registered" };
    logger.info(
      { deviceSerial: auth.registration.deviceSerial },
      "Amazon device registered",
    );

    await onCredentialsChanged?.();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const timedOut = /timed out/i.test(message);
    current = {
      state: timedOut ? "timed_out" : "failed",
      error: message,
    };
    logger.error({ error }, "Amazon device registration failed");
  } finally {
    await stopProxy();
  }
}

async function mintInitialSession(
  authPath: string,
  auth: AmazonAuthRecord,
  signInCookie: string | undefined,
): Promise<void> {
  let cookies = parseCookieHeader(signInCookie);

  try {
    const refreshed = await refreshRegistration(auth.registration, {
      amazonPage: auth.marketplace.amazonPage,
      acceptLanguage: auth.marketplace.acceptLanguage,
      proxyLanguage: auth.marketplace.proxyLanguage,
      deviceAppName: auth.marketplace.deviceAppName,
    });
    const minted = parseCookieHeader(
      refreshed.localCookie || refreshed.loginCookie,
    );
    if (Object.keys(minted).length > 0) {
      cookies = { ...cookies, ...minted };
    }
  } catch (error) {
    // Keep the sign-in cookies so sync can start, but say so loudly: the
    // durable path is what makes this worth having.
    logger.error(
      { error },
      "Registered, but minting cookies from the refresh token failed. Sync will work until the sign-in cookies expire",
    );
  }

  await writeAmazonSession(authPath, {
    version: 1,
    cookiesUpdatedAt: new Date().toISOString(),
    lastRefreshAt: new Date().toISOString(),
    cookies,
  });
}

/** Stop an in-flight registration. */
export async function cancelRegistration(): Promise<void> {
  if (current.state === "awaiting_login" || current.state === "completing") {
    current = { state: "cancelled" };
  }
  await stopProxy();
}

export interface AmazonAuthSummary {
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

/** Show only the tail of the serial. It identifies the device in Amazon's UI. */
function maskSerial(serial: string | undefined): string | undefined {
  if (!serial) return undefined;
  return serial.length <= 6 ? serial : `…${serial.slice(-6)}`;
}

/**
 * Summarise stored credentials for the admin UI.
 *
 * A missing auth file is reported as "not registered" with a 200, matching how
 * the endpoint it replaces treated a missing cookie file.
 */
export async function getAmazonAuthSummary(
  authPath: string,
): Promise<AmazonAuthSummary> {
  const status = getRegistrationStatus();

  try {
    const auth = await readAmazonAuth(authPath);
    const session = await readAmazonSession(authPath);

    return {
      registered: true,
      state: status.state,
      marketplace: auth.marketplace.amazonPage,
      deviceSerial: maskSerial(auth.registration.deviceSerial),
      deviceAppName: auth.marketplace.deviceAppName,
      registeredAt: auth.registeredAt,
      cookiesUpdatedAt: session?.cookiesUpdatedAt ?? null,
      cookieAgeDays: cookieAgeDays(session),
      lastRefreshAt: session?.lastRefreshAt ?? null,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      logger.warn({ error }, "Could not read Amazon auth record");
    }
    return { registered: false, ...status };
  }
}

/** Forget the local registration. Does not deregister the device at Amazon. */
export async function removeRegistration(authPath: string): Promise<void> {
  await clearAmazonCredentials(authPath);
  resetRegistrationState();
  await onCredentialsChanged?.();
}
