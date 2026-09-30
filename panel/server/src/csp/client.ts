import { buildControlRequest, buildLoginRequest, buildStatusRequest, parseCommandResponse, parseLoginResponse } from './xml.js';
import type { CspIdentity, StatusCommand } from './types.js';

export interface CspAuth {
  user: string;
  password: string;
  /** CSP-side session id, when the proxy issued one at login. */
  sessionId?: string;
}

export interface LoginResult extends CspIdentity {
  sessionId?: string;
}

export class CspError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
    this.name = 'CspError';
  }
}

/** Everything the panel needs from a CSP node. Implemented for real and for mock. */
export interface CspClient {
  readonly kind: 'http' | 'mock';
  readonly target: string;
  login(user: string, password: string): Promise<LoginResult | null>;
  status(auth: CspAuth, commands: StatusCommand[]): Promise<string>;
  control(auth: CspAuth, command: string, params: Record<string, string | undefined>): Promise<{ ok: boolean; message: string }>;
  fetchConfig(auth: CspAuth): Promise<string>;
  saveConfig(auth: CspAuth, xml: string): Promise<{ ok: boolean; message: string }>;
}

/** Talks to a real (Java) CSP node over its HTTP/XML API. */
export class HttpCspClient implements CspClient {
  readonly kind = 'http' as const;

  constructor(
    readonly target: string,
    private readonly timeoutMs = 15_000,
  ) {}

  private basic(auth: CspAuth): string {
    return 'Basic ' + Buffer.from(`${auth.user}:${auth.password}`, 'utf8').toString('base64');
  }

  private async post(path: string, auth: CspAuth | null, body: string, contentType = 'text/xml; charset=UTF-8'): Promise<string> {
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
      if (res.status === 401) throw new CspError('CSP rejected the credentials', 401);
      if (!res.ok) throw new CspError(`CSP returned HTTP ${res.status}`, 502);
      return textBody;
    } catch (err) {
      if (err instanceof CspError) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      throw new CspError(`Cannot reach CSP at ${this.target}: ${reason}`, 502);
    } finally {
      clearTimeout(timer);
    }
  }

  async login(user: string, password: string): Promise<LoginResult | null> {
    // The xml login works without basic auth and also validates the credentials.
    const xml = await this.post('/xmlHandler', null, buildLoginRequest(user, password));
    const parsed = parseLoginResponse(xml);
    if (!parsed.ok) return null;
    return {
      user: parsed.user ?? user,
      admin: parsed.admin,
      superUser: parsed.superUser,
      sessionId: parsed.sessionId,
    };
  }

  status(auth: CspAuth, commands: StatusCommand[]): Promise<string> {
    return this.post('/xmlHandler', auth, buildStatusRequest(commands, auth.sessionId));
  }

  async control(auth: CspAuth, command: string, params: Record<string, string | undefined>) {
    const xml = await this.post('/xmlHandler', auth, buildControlRequest(command, params, auth.sessionId));
    return parseCommandResponse(xml);
  }

  async fetchConfig(auth: CspAuth): Promise<string> {
    // fetch-cfg answers with the raw proxy.xml (no cws-status-resp wrapper).
    return this.post('/xmlHandler', auth, buildStatusRequest([{ command: 'fetch-cfg' }], auth.sessionId));
  }

  async saveConfig(auth: CspAuth, xml: string) {
    const res = await this.post('/cfgHandler', auth, xml);
    return parseCommandResponse(res);
  }
}
