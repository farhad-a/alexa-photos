import alexaCookie from "alexa-cookie2";
import type { AlexaCookieConfig, AlexaRegistrationResult } from "alexa-cookie2";
import { logger as rootLogger } from "../lib/logger.js";

const logger = rootLogger.child({ component: "amazon-auth" });

/**
 * The only module in the repo that imports `alexa-cookie2`.
 *
 * Everything else talks to this wrapper, so tests never load Express and a
 * change of library touches one file. It turns the library's callback API into
 * promises and absorbs three behaviors that are easy to get wrong.
 */

export interface MarketplaceOptions {
  /** e.g. "amazon.com". The library defaults to amazon.de, so always pass it. */
  amazonPage: string;
  acceptLanguage: string;
  proxyLanguage: string;
  deviceAppName: string;
}

export interface RegistrationProxyOptions extends MarketplaceOptions {
  /** Must be an IP literal the browser can reach, never a hostname. */
  proxyOwnIp: string;
  proxyPort: number;
  proxyListenBind: string;
  /** HTML shown after sign-in. Used to bounce the browser back to the admin UI. */
  closeWindowHtml?: string;
  timeoutMs: number;
}

export type { AlexaRegistrationResult };

const LONG_VALUE = /[\w-]{60,}/g;

/** The library logs cookie and token material at info level. Never pass it through raw. */
export function redact(message: unknown): string {
  return String(message)
    .replace(
      /At[nz][ar]\|[\w.-]+/g,
      (match) => `${match.slice(0, 5)}<redacted>`,
    )
    .replace(LONG_VALUE, "<redacted>");
}

function baseConfig(options: MarketplaceOptions): AlexaCookieConfig {
  return {
    logger: (message: string) =>
      logger.debug({ lib: "alexa-cookie2" }, redact(message)),
    amazonPage: options.amazonPage,
    baseAmazonPage: options.amazonPage,
    acceptLanguage: options.acceptLanguage,
    amazonPageProxyLanguage: options.proxyLanguage,
    deviceAppName: options.deviceAppName,
  };
}

/**
 * On the proxy path the library reports "open this URL" through the ERROR
 * argument, then calls back a second time with the real result once sign-in
 * finishes. A naive settled-guard rejects on the notice and tears the proxy
 * down before anyone can log in. Confirmed against the live library.
 */
function isProgressNotice(
  err: Error | null,
  result?: AlexaRegistrationResult,
): boolean {
  if (result) return false;
  const message = String(err?.message ?? err ?? "");
  return /with your browser|login to amazon|cookie will be output/i.test(
    message,
  );
}

interface SettleOptions {
  timeoutMs?: number;
  onProgress?: (message: string) => void;
  stopProxyOnTimeout?: boolean;
}

function settleOnce(
  invoke: (
    callback: (err: Error | null, result?: AlexaRegistrationResult) => void,
  ) => void,
  options: SettleOptions = {},
): Promise<AlexaRegistrationResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (fn: () => void) => {
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };

    if (options.timeoutMs) {
      timer = setTimeout(() => {
        if (settled) return;
        const fail = () =>
          reject(new Error("Amazon sign-in timed out before it completed"));
        settled = true;
        if (options.stopProxyOnTimeout) alexaCookie.stopProxyServer(fail);
        else fail();
      }, options.timeoutMs);
    }

    invoke((err, result) => {
      if (settled) {
        logger.debug("alexa-cookie2 called back again after settling; ignored");
        return;
      }
      if (isProgressNotice(err, result)) {
        options.onProgress?.(String(err?.message ?? err));
        return;
      }
      if (err) {
        finish(() =>
          reject(err instanceof Error ? err : new Error(String(err))),
        );
        return;
      }
      if (!result) {
        finish(() =>
          reject(new Error("alexa-cookie2 returned no registration result")),
        );
        return;
      }
      finish(() => resolve(result));
    });
  });
}

/**
 * Start the login proxy and resolve once the user has signed in.
 *
 * Resolves with the registration blob, which must be persisted whole. It
 * carries device-context fields the library replays on every later refresh.
 */
export async function startRegistration(
  options: RegistrationProxyOptions,
): Promise<AlexaRegistrationResult> {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(options.proxyOwnIp)) {
    throw new Error(
      `proxyOwnIp must be an IP literal the browser can reach, got "${options.proxyOwnIp}"`,
    );
  }

  const config: AlexaCookieConfig = {
    ...baseConfig(options),
    proxyOnly: true,
    setupProxy: true,
    proxyOwnIp: options.proxyOwnIp,
    proxyPort: options.proxyPort,
    proxyListenBind: options.proxyListenBind,
    proxyLogLevel: "warn",
    ...(options.closeWindowHtml
      ? { proxyCloseWindowHTML: options.closeWindowHtml }
      : {}),
  };

  logger.info(
    {
      proxyOwnIp: options.proxyOwnIp,
      proxyPort: options.proxyPort,
      amazonPage: options.amazonPage,
      deviceAppName: options.deviceAppName,
    },
    "Starting Amazon login proxy",
  );

  try {
    const result = await settleOnce(
      (callback) =>
        alexaCookie.generateAlexaCookie(undefined, undefined, config, callback),
      {
        timeoutMs: options.timeoutMs,
        stopProxyOnTimeout: true,
        onProgress: () => logger.info("Login proxy ready, waiting for sign-in"),
      },
    );

    if (result.amazonPage && result.amazonPage !== options.amazonPage) {
      logger.warn(
        { requested: options.amazonPage, registered: result.amazonPage },
        "Registered against a different marketplace than requested; a wrong marketplace cannot be fixed by config",
      );
    }

    logger.info(
      { deviceSerial: result.deviceSerial, amazonPage: result.amazonPage },
      "Amazon device registration complete",
    );
    return result;
  } finally {
    await stopProxy();
  }
}

/** Stop the login proxy. Safe to call when nothing is running. */
export function stopProxy(): Promise<void> {
  return new Promise((resolve) => {
    try {
      alexaCookie.stopProxyServer(() => resolve());
    } catch (error) {
      logger.debug({ error }, "stopProxyServer threw; treating as stopped");
      resolve();
    }
  });
}

/**
 * The library is a singleton, so refreshes must not overlap. Serialize them.
 */
let refreshChain: Promise<unknown> = Promise.resolve();

/**
 * Mint a fresh cookie set from a stored registration.
 *
 * The marketplace options must be passed on every call, not just registration,
 * or the library falls back to its German defaults.
 */
export function refreshRegistration(
  former: AlexaRegistrationResult,
  options: MarketplaceOptions,
): Promise<AlexaRegistrationResult> {
  const run = refreshChain
    .catch(() => undefined)
    .then(() =>
      settleOnce((callback) =>
        alexaCookie.refreshAlexaCookie(
          { ...baseConfig(options), formerRegistrationData: former },
          callback,
        ),
      ),
    );

  refreshChain = run.catch(() => undefined);
  return run;
}
