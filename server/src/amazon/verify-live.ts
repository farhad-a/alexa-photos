import { AmazonClient } from "./client.js";
import {
  readAmazonAuth,
  readAmazonSession,
  cookieAgeDays,
} from "./credentials.js";

/**
 * Integration-level smoke test against live Amazon.
 *
 * Confirms the stored device registration still authenticates, that a real
 * request succeeds, and that cookie rotation is persisted. Reports cookie
 * names only, never values.
 */

function getAuthPath(): string {
  return process.env.AMAZON_AUTH_PATH || "./data/amazon-auth.json";
}

function maskSerial(serial: string | undefined): string | null {
  if (!serial) return null;
  return serial.length <= 6 ? serial : `…${serial.slice(-6)}`;
}

async function cookieNames(authPath: string): Promise<string[]> {
  const session = await readAmazonSession(authPath);
  return Object.keys(session?.cookies ?? {}).sort();
}

async function main(): Promise<void> {
  const authPath = getAuthPath();

  const auth = await readAmazonAuth(authPath);
  const before = await readAmazonSession(authPath);
  const beforeNames = await cookieNames(authPath);

  const client = await AmazonClient.load({ authPath, autoRefresh: true });
  const status = await client.checkAuthStatus();

  let exercisedRequest = false;
  let requestError: string | undefined;

  if (status.ok) {
    try {
      await client.getRoot();
      exercisedRequest = true;
    } catch (error) {
      requestError = error instanceof Error ? error.message : String(error);
    }
  }

  const after = await readAmazonSession(authPath);
  const afterNames = await cookieNames(authPath);
  const rotated = beforeNames
    .concat(afterNames)
    .filter(
      (name, i, all) =>
        all.indexOf(name) === i &&
        before?.cookies[name] !== after?.cookies[name],
    )
    .sort();

  await client.close();

  console.log(
    JSON.stringify(
      {
        authPath,
        marketplace: auth.marketplace.amazonPage,
        deviceSerial: maskSerial(auth.registration.deviceSerial),
        registeredAt: auth.registeredAt,
        cookieAgeDays: Number((cookieAgeDays(before) ?? 0).toFixed(3)),
        needsReregistration: client.needsReregistration,
        authState: status.state,
        authOk: status.ok,
        authStatusCode: status.statusCode ?? null,
        exercisedRequest,
        requestError: requestError ?? null,
        cookieNames: afterNames,
        rotatedCookieNames: rotated,
        cookiesUpdatedAt: after?.cookiesUpdatedAt ?? null,
        lastRefreshAt: after?.lastRefreshAt ?? null,
      },
      null,
      2,
    ),
  );

  if (!status.ok || requestError) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const code = (error as NodeJS.ErrnoException)?.code;
  console.error(
    JSON.stringify(
      {
        authPath: getAuthPath(),
        error:
          code === "ENOENT"
            ? "No device is registered. Register one in the Alexa Photos web UI."
            : error instanceof Error
              ? error.message
              : String(error),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
});
