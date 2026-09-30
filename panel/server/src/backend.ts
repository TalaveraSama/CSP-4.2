import type { CspIdentity, StatusCommand, StatusSnapshot } from './csp/types.js';

/**
 * Backend abstraction.
 *
 * The panel UI only knows the normalised domain model in `csp/types.ts`.
 * Each backend (CardServProxy, OSCam, or their mocks) is responsible for
 * translating its own dialect into that model.
 */

export interface BackendAuth {
  user: string;
  password: string;
  /** Backend-side session id, when the backend issues one at login. */
  sessionId?: string;
}

export interface LoginResult extends CspIdentity {
  sessionId?: string;
}

export interface ConfigFile {
  name: string;
  content: string;
  writable: boolean;
}

export interface BackendInfo {
  /** Which server software we are talking to. */
  kind: 'csp' | 'oscam';
  /** True when the data is synthetic (no real server involved). */
  mock: boolean;
  /** Human readable target, shown in the UI. */
  target: string;
  /** Syntax of the editable configuration, drives validation in the editor. */
  configFormat: 'xml' | 'ini';
  /** Config files the editor may open. */
  configFiles: string[];
  features: {
    /** Backend reports real CA profiles (CSP) vs synthesised CAID groups (OSCam). */
    profiles: boolean;
    cache: boolean;
    plugins: boolean;
    /** Per-connector service maps. */
    connectorServices: boolean;
    /** last-seen style log. */
    seen: boolean;
  };
  /** Wording differences, e.g. OSCam calls connectors "readers". */
  labels: {
    connectors: string;
    connector: string;
    profiles: string;
  };
}

export class BackendError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
    this.name = 'BackendError';
  }
}

export interface ProxyBackend {
  readonly info: BackendInfo;
  login(user: string, password: string): Promise<LoginResult | null>;
  /** Collects the requested sections into one normalised snapshot. */
  snapshot(auth: BackendAuth, sections: StatusCommand[]): Promise<StatusSnapshot>;
  /** Raw passthrough for power users / plugin commands. */
  raw(auth: BackendAuth, command: string, params: Record<string, string>): Promise<string>;
  control(auth: BackendAuth, command: string, params: Record<string, string | undefined>): Promise<{ ok: boolean; message: string }>;
  fetchConfig(auth: BackendAuth, file?: string): Promise<ConfigFile>;
  saveConfig(auth: BackendAuth, content: string, file?: string): Promise<{ ok: boolean; message: string }>;
}

/** Empty snapshot used as a starting point by the backends. */
export function emptySnapshot(): StatusSnapshot {
  return {
    profiles: [],
    connectors: [],
    plugins: [],
    events: [],
    fileLog: [],
    warnings: [],
    services: [],
    seen: [],
    failures: [],
    commandGroups: [],
    optionLists: {},
  };
}

/** Formats a number of seconds the way both CSP and the panel display uptimes. */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const d = Math.floor(s / 86400);
  const pad = (n: number) => String(n).padStart(2, '0');
  const hms = `${pad(Math.floor((s % 86400) / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  return d > 0 ? `${d}d ${hms}` : hms;
}
