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

export type BackendKind = 'csp' | 'oscam';

export interface AppConfig {
  /** Port the BFF listens on. */
  port: number;
  /** Bind address. 0.0.0.0 so it works inside containers / sandboxes. */
  host: string;
  /** Which server software to talk to. */
  backend: BackendKind;
  /** Base url of the legacy CSP proxy http interface, e.g. http://10.0.0.1:8082 */
  cspUrl: string;
  /** Base url of the OSCam web interface, e.g. http://10.0.0.5:8888 */
  oscamUrl: string;
  /** Use the built-in fake node for the selected backend (no real server needed). */
  mock: boolean;
  /** Accept self-signed certificates when the target is https. */
  insecureTls: boolean;
  /** Idle lifetime of a panel session, in milliseconds. */
  sessionTtlMs: number;
  /** Directory with the built frontend (served when it exists). */
  webRoot: string;
}

export function loadConfig(): AppConfig {
  const cspUrl = (process.env.CSP_URL ?? 'http://127.0.0.1:8082').replace(/\/+$/, '');
  const oscamUrl = (process.env.OSCAM_URL ?? 'http://127.0.0.1:8888').replace(/\/+$/, '');

  // BACKEND wins; otherwise whichever url was configured; CSP by default.
  const explicit = (process.env.BACKEND ?? '').trim().toLowerCase();
  const backend: BackendKind = explicit === 'oscam' ? 'oscam' : explicit === 'csp' ? 'csp' : process.env.OSCAM_URL ? 'oscam' : 'csp';

  const mockEnv = process.env.MOCK ?? (backend === 'oscam' ? process.env.OSCAM_MOCK : process.env.CSP_MOCK);
  const configuredUrl = backend === 'oscam' ? process.env.OSCAM_URL : process.env.CSP_URL;

  return {
    port: int(process.env.PORT, 8090),
    host: process.env.HOST ?? '0.0.0.0',
    backend,
    cspUrl,
    oscamUrl,
    mock: bool(mockEnv, !configuredUrl),
    insecureTls: bool(process.env.CSP_INSECURE_TLS ?? process.env.INSECURE_TLS, true),
    sessionTtlMs: int(process.env.SESSION_TTL_MS, 8 * 60 * 60 * 1000),
    webRoot: process.env.WEB_ROOT ?? new URL('../../web/dist/', import.meta.url).pathname,
  };
}

export const config = loadConfig();
