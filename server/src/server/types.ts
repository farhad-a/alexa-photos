import type { RegistrationSettings } from "../amazon/registration.js";
import { StateStore } from "../state/store.js";
import { SyncMetrics } from "../sync/engine.js";

export interface HealthMetrics extends SyncMetrics {
  status: "healthy" | "unhealthy" | "starting";
  uptime: number;
}

export interface AppServerOptions {
  port: number;
  state?: StateStore;
  cookiesPath?: string;
  amazonAuthPath?: string;
  registrationSettings?: RegistrationSettings;
  staticDir?: string;
  onAmazonAuthChecked?: (authenticated: boolean) => void;
  onCookiesSaved?: () => void | Promise<void>;
  onSyncRequested?: () => void | Promise<void>;
  isSyncRunning?: () => boolean;
}

export interface SyncControls {
  onSyncRequested?: () => void | Promise<void>;
  isSyncRunning?: () => boolean;
}

export interface AppRequestContext {
  port: number;
  startTime: Date;
  metrics: HealthMetrics;
  state: StateStore | null;
  cookiesPath: string;
  amazonAuthPath: string;
  registrationSettings?: RegistrationSettings;
  staticDir: string;
  onAmazonAuthChecked?: (authenticated: boolean) => void;
  onCookiesSaved?: () => void | Promise<void>;
  onSyncRequested?: () => void | Promise<void>;
  isSyncRunning?: () => boolean;
}
