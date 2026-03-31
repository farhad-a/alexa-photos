export const METRICS_REFRESH_EVENT = "alexa-photos:metrics-refresh";

export function requestMetricsRefresh(reason: string): void {
  window.dispatchEvent(
    new CustomEvent(METRICS_REFRESH_EVENT, {
      detail: { reason, at: new Date().toISOString() },
    }),
  );
}
