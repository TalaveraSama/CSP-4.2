import { BackendError, type BackendAuth, type BackendInfo, type ConfigFile, type LoginResult, type ProxyBackend } from '../backend.js';
import { buildControlRequest, buildLoginRequest, buildStatusRequest, parseCommandResponse, parseLoginResponse, parseStatusResponse } from './xml.js';
import type { StatusCommand, StatusSnapshot } from './types.js';

export type CspAuth = BackendAuth;

/** Backend descriptor shared by the real CSP client and the CSP mock. */
export function cspInfo(target: string, mock: boolean): BackendInfo {
  return {
    kind: 'csp',
    mock,
    target,
    configFormat: 'xml',
    configFiles: ['proxy.xml'],
    features: { profiles: true, cache: true, plugins: true, connectorServices: true, seen: true, accounts: true },
    labels: { connectors: 'Connectors', connector: 'Connector', profiles: 'CA profiles', product: 'CSP' },
  };
}

/** Talks to a real (Java) CardServProxy node over its HTTP/XML API. */
export class HttpCspClient implements ProxyBackend {
  readonly info: BackendInfo;

  constructor(
    target: string,
    private readonly timeoutMs = 15_000,
  ) {
    this.info = cspInfo(target, false);
  }

  private get target(): string {
    return this.info.target;
  }

  private basic(auth: BackendAuth): string {
    return 'Basic ' + Buffer.from(`${auth.user}:${auth.password}`, 'utf8').toString('base64');
  }

  private async post(path: string, auth: BackendAuth | null, body: string, contentType = 'text/xml; charset=UTF-8'): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.target}${path}`, {
        method: 'POST',
        headers: {
          'content-type': contentType,
          ...(auth ? { authorization: this.basic(auth) } : {}),
        },
        body,
        signal: controller.signal,
      });
      const textBody = await res.text();
      if (res.status === 401) throw new BackendError('CSP rejected the credentials', 401);
      if (!res.ok) throw new BackendError(`CSP returned HTTP ${res.status}`, 502);
      return textBody;
    } catch (err) {
      if (err instanceof BackendError) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      throw new BackendError(`Cannot reach CSP at ${this.target}: ${reason}`, 502);
    } finally {
      clearTimeout(timer);
    }
  }

  async login(user: string, password: string): Promise<LoginResult | null> {
    // The xml login works without basic auth and also validates the credentials.
    const xml = await this.post('/xmlHandler', null, buildLoginRequest(user, password));
    const parsed = parseLoginResponse(xml);
    if (!parsed.ok) return null;
    return { user: parsed.user ?? user, admin: parsed.admin, superUser: parsed.superUser, sessionId: parsed.sessionId };
  }

  async snapshot(auth: BackendAuth, sections: StatusCommand[]): Promise<StatusSnapshot> {
    return parseStatusResponse(await this.post('/xmlHandler', auth, buildStatusRequest(sections, auth.sessionId)));
  }

  raw(auth: BackendAuth, command: string, params: Record<string, string>): Promise<string> {
    return this.post('/xmlHandler', auth, buildStatusRequest([{ command, params }], auth.sessionId));
  }

  async control(auth: BackendAuth, command: string, params: Record<string, string | undefined>) {
    return parseCommandResponse(await this.post('/xmlHandler', auth, buildControlRequest(command, params, auth.sessionId)));
  }

  async fetchConfig(auth: BackendAuth): Promise<ConfigFile> {
    // fetch-cfg answers with the raw proxy.xml (no cws-status-resp wrapper).
    const content = await this.post('/xmlHandler', auth, buildStatusRequest([{ command: 'fetch-cfg' }], auth.sessionId));
    return { name: 'proxy.xml', content, writable: true };
  }

  async saveConfig(auth: BackendAuth, content: string) {
    return parseCommandResponse(await this.post('/cfgHandler', auth, content));
  }
}
