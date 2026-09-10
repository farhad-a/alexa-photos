import type { RegistrationSettings } from "../amazon/registration.js";
import type { LinkSettings } from "./services/links.js";
import { StateStore } from "../state/store.js";
import { SyncMetrics } from "../sync/engine.js";

export interface HealthMetrics extends SyncMetrics {
  status: "healthy" | "unhealthy" | "starting";
  uptime: number;
}

export interface AppServerOptions {
  port: number;
  state?: StateStore;
  amazonAuthPath?: string;
  registrationSettings?: RegistrationSettings;
  linkSettings?: LinkSettings;
  /** Extra Host header values to accept; loopback and IP literals always pass. */
  allowedHosts?: string[];
  staticDir?: string;
  onAmazonAuthChecked?: (authenticated: boolean) => void;
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
  amazonAuthPath: string;
  registrationSettings?: RegistrationSettings;
  linkSettings?: LinkSettings;
  allowedHosts?: string[];
  staticDir: string;
  onAmazonAuthChecked?: (authenticated: boolean) => void;
  onSyncRequested?: () => void | Promise<void>;
  isSyncRunning?: () => boolean;
}
