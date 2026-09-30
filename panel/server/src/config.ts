/**
 * Runtime configuration for the CSP panel BFF.
 * Everything is env-driven so the same build works in dev, docker and on-box.
 */

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

export interface AppConfig {
  /** Port the BFF listens on. */
  port: number;
  /** Bind address. 0.0.0.0 so it works inside containers / sandboxes. */
  host: string;
  /** Base url of the legacy CSP proxy http interface, e.g. http://10.0.0.1:8082 */
  cspUrl: string;
  /** Use the built-in fake CSP (no Java proxy required). */
  mock: boolean;
  /** Accept self-signed certificates when cspUrl is https. */
  insecureTls: boolean;
  /** Idle lifetime of a panel session, in milliseconds. */
  sessionTtlMs: number;
  /** Directory with the built frontend (served when it exists). */
  webRoot: string;
}

export function loadConfig(): AppConfig {
  return {
    port: int(process.env.PORT, 8090),
    host: process.env.HOST ?? '0.0.0.0',
    cspUrl: (process.env.CSP_URL ?? 'http://127.0.0.1:8082').replace(/\/+$/, ''),
    mock: bool(process.env.CSP_MOCK, !process.env.CSP_URL),
    insecureTls: bool(process.env.CSP_INSECURE_TLS, true),
    sessionTtlMs: int(process.env.SESSION_TTL_MS, 8 * 60 * 60 * 1000),
    webRoot: process.env.WEB_ROOT ?? new URL('../../web/dist/', import.meta.url).pathname,
  };
}

export const config = loadConfig();
