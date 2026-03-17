export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

async function requestJson<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(input, init);

  let payload: unknown;
  const contentType = res.headers.get("content-type") ?? "";
  const isJson = contentType.includes("application/json");

  if (isJson) {
    payload = await res.json();
  } else {
    const text = await res.text();
    payload = text ? { error: text } : {};
  }

  if (!res.ok) {
    const message =
      typeof payload === "object" &&
      payload !== null &&
      "error" in payload &&
      typeof (payload as { error: unknown }).error === "string"
        ? (payload as { error: string }).error
        : `Request failed (${res.status})`;
    throw new ApiError(res.status, message);
  }

  return payload as T;
}

export function getJson<T>(input: RequestInfo | URL, init?: RequestInit) {
  return requestJson<T>(input, init);
}

export function postJson<T>(
  input: RequestInfo | URL,
  body?: unknown,
  init?: Omit<RequestInit, "method" | "body">,
) {
  return requestJson<T>(input, {
    ...init,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function deleteJson<T>(input: RequestInfo | URL, init?: RequestInit) {
  return requestJson<T>(input, { ...init, method: "DELETE" });
}
