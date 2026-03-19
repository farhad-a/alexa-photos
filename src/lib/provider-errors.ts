export type ProviderName = "icloud" | "amazon";

export type ProviderErrorKind =
  | "ok"
  | "invalid_token"
  | "unauthorized"
  | "rate_limited"
  | "bot_detection"
  | "network"
  | "not_configured"
  | "unknown";

export interface ProviderErrorStatus {
  provider: ProviderName;
  status?: number;
  kind: ProviderErrorKind;
  retriable: boolean;
  actionable: boolean;
}

const NETWORK_ERROR_NEEDLES = [
  "fetch failed",
  "network",
  "enotfound",
  "econnreset",
  "econnrefused",
  "etimedout",
  "timeout",
  "dns",
  "tls",
  "socket",
];

export function extractHttpStatus(message: string): number | undefined {
  const match = message.match(/:\s*(\d{3})\b/);
  if (!match) return undefined;
  const status = Number(match[1]);
  return Number.isFinite(status) ? status : undefined;
}

function isNetworkErrorMessage(message: string): boolean {
  return NETWORK_ERROR_NEEDLES.some((needle) => message.includes(needle));
}

export function classifyIcloudProviderError(
  error: unknown,
): ProviderErrorStatus {
  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase();
  const status = extractHttpStatus(message);

  if (status !== undefined) {
    if (status === 401 || status === 403) {
      return {
        provider: "icloud",
        status,
        kind: "invalid_token",
        retriable: false,
        actionable: true,
      };
    }

    if (status === 408 || status === 429 || status >= 500) {
      return {
        provider: "icloud",
        status,
        kind: "network",
        retriable: true,
        actionable: false,
      };
    }

    if (status >= 400 && status < 500) {
      return {
        provider: "icloud",
        status,
        kind: "unknown",
        retriable: true,
        actionable: false,
      };
    }
  }

  if (isNetworkErrorMessage(message)) {
    return {
      provider: "icloud",
      kind: "network",
      retriable: true,
      actionable: false,
    };
  }

  return {
    provider: "icloud",
    status,
    kind: "unknown",
    retriable: true,
    actionable: false,
  };
}

export function classifyAmazonAuthResponse(
  status: number,
  ok: boolean,
): ProviderErrorStatus {
  if (ok) {
    return {
      provider: "amazon",
      status,
      kind: "ok",
      retriable: false,
      actionable: false,
    };
  }

  if (status === 401) {
    return {
      provider: "amazon",
      status,
      kind: "unauthorized",
      retriable: false,
      actionable: true,
    };
  }

  if (status === 429) {
    return {
      provider: "amazon",
      status,
      kind: "rate_limited",
      retriable: true,
      actionable: false,
    };
  }

  if (status === 503) {
    return {
      provider: "amazon",
      status,
      kind: "bot_detection",
      retriable: true,
      actionable: false,
    };
  }

  return {
    provider: "amazon",
    status,
    kind: "unknown",
    retriable: status >= 500,
    actionable: false,
  };
}

export function classifyAmazonAuthError(error: unknown): ProviderErrorStatus {
  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase();

  if (isNetworkErrorMessage(message)) {
    return {
      provider: "amazon",
      kind: "network",
      retriable: true,
      actionable: false,
    };
  }

  return {
    provider: "amazon",
    kind: "network",
    retriable: true,
    actionable: false,
  };
}
