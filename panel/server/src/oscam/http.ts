import { createHash, randomBytes } from 'node:crypto';
import { BackendError, type BackendAuth } from '../backend.js';

/**
 * Minimal HTTP transport for the OSCam web interface.
 *
 * OSCam protects the webif with **HTTP Digest** auth (MD5, qop=auth, realm
 * "Forbidden"), which `fetch` does not implement, so the challenge/response
 * dance is done here. Basic auth is supported as a fallback for builds or
 * reverse proxies that use it, and an unauthenticated webif just works.
 */

export interface OscamTransport {
  readonly target: string;
  get(auth: BackendAuth, path: string, query: Record<string, string | undefined>): Promise<string>;
  post(auth: BackendAuth, path: string, form: Record<string, string | undefined>): Promise<string>;
}

const md5 = (value: string) => createHash('md5').update(value, 'utf8').digest('hex');

function parseChallenge(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  const body = header.replace(/^\s*Digest\s+/i, '');
  const re = /(\w+)\s*=\s*(?:"([^"]*)"|([^,]*))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) out[m[1]!.toLowerCase()] = (m[2] ?? m[3] ?? '').trim();
  return out;
}

export class HttpOscamTransport implements OscamTransport {
  /** Cached digest challenge per user, so we don't pay a 401 round-trip per request. */
  private readonly challenges = new Map<string, { params: Record<string, string>; nc: number }>();

  constructor(
    readonly target: string,
    private readonly timeoutMs = 15_000,
  ) {}

  private digestHeader(auth: BackendAuth, method: string, uri: string): string | undefined {
    const cached = this.challenges.get(auth.user);
    if (!cached) return undefined;
    const { params } = cached;
    cached.nc += 1;
    const nc = String(cached.nc).padStart(8, '0');
    const cnonce = randomBytes(8).toString('hex');
    const realm = params.realm ?? 'Forbidden';
    const ha1 = md5(`${auth.user}:${realm}:${auth.password}`);
    const ha2 = md5(`${method}:${uri}`);
    const qop = (params.qop ?? 'auth').split(',')[0]!.trim();
    const response = qop ? md5(`${ha1}:${params.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${params.nonce}:${ha2}`);
    const parts = [
      `username="${auth.user}"`,
      `realm="${realm}"`,
      `nonce="${params.nonce ?? ''}"`,
      `uri="${uri}"`,
      `response="${response}"`,
    ];
    if (params.opaque) parts.push(`opaque="${params.opaque}"`);
    if (params.algorithm) parts.push(`algorithm=${params.algorithm}`);
    if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
    return `Digest ${parts.join(', ')}`;
  }

  private basicHeader(auth: BackendAuth): string {
    return 'Basic ' + Buffer.from(`${auth.user}:${auth.password}`, 'utf8').toString('base64');
  }

  private async send(auth: BackendAuth, method: 'GET' | 'POST', uri: string, body?: string): Promise<string> {
    const url = `${this.target}${uri}`;
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded';

    const attempt = async (authHeader?: string): Promise<Response> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        return await fetch(url, {
          method,
          headers: authHeader ? { ...headers, authorization: authHeader } : headers,
          body,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    };

    try {
      let res = await attempt(this.digestHeader(auth, method, uri));

      if (res.status === 401) {
        const challenge = res.headers.get('www-authenticate') ?? '';
        if (/^\s*digest/i.test(challenge)) {
          // (Re)negotiate: OSCam nonces are short-lived and marked stale on reuse.
          this.challenges.set(auth.user, { params: parseChallenge(challenge), nc: 0 });
          res = await attempt(this.digestHeader(auth, method, uri));
        } else {
          res = await attempt(this.basicHeader(auth));
        }
      }

      if (res.status === 401 || res.status === 403) throw new BackendError('OSCam rejected the credentials', 401);
      const text = await res.text();
      if (!res.ok) throw new BackendError(`OSCam returned HTTP ${res.status}`, 502);
      return text;
    } catch (err) {
      if (err instanceof BackendError) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      throw new BackendError(`Cannot reach OSCam at ${this.target}: ${reason}`, 502);
    }
  }

  private static qs(query: Record<string, string | undefined>): string {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') q.set(k, v);
    return q.toString();
  }

  get(auth: BackendAuth, path: string, query: Record<string, string | undefined>): Promise<string> {
    const qs = HttpOscamTransport.qs(query);
    return this.send(auth, 'GET', qs ? `${path}?${qs}` : path);
  }

  post(auth: BackendAuth, path: string, form: Record<string, string | undefined>): Promise<string> {
    return this.send(auth, 'POST', path, HttpOscamTransport.qs(form));
  }
}
