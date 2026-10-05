import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BackendError, type BackendAuth } from '../backend.js';

/**
 * Minimal HTTP transport for the OSCam web interface.
 *
 * OSCam protects the webif with **HTTP Digest** auth (MD5, qop=auth, realm
 * "Forbidden"), which `fetch` does not implement, so the challenge/response
 * dance is done here. Basic auth is supported as a fallback for builds or
 * reverse proxies that use it, and an unauthenticated webif just works.
 *
 * node:http is used instead of fetch on purpose: the webif is a tiny embedded
 * server that closes the connection after every response, and undici's
 * keep-alive pool turns that into sporadic "fetch failed (UND_ERR_SOCKET)"
 * errors — reproducible when saving a config file. Here every request is sent
 * with `Connection: close`.
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

interface HttpReply {
  status: number;
  headers: Record<string, string | undefined>;
  text: string;
}

export class HttpOscamTransport implements OscamTransport {
  /** Cached digest challenge per user, so we don't pay a 401 round-trip per request. */
  private readonly challenges = new Map<string, { params: Record<string, string>; nc: number }>();

  constructor(
    readonly target: string,
    private readonly timeoutMs = 15_000,
    /** Product name used in error messages: OSCam or NCam. */
    private readonly label = 'OSCam',
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
    // Header names are capitalised on purpose, see this.request().
    if (body !== undefined) headers['Content-Type'] = 'application/x-www-form-urlencoded';

    const attempt = (authHeader?: string): Promise<HttpReply> =>
      this.request(url, method, authHeader ? { ...headers, Authorization: authHeader } : headers, body);

    try {
      let res = await attempt(this.digestHeader(auth, method, uri));

      if (res.status === 401) {
        const challenge = res.headers['www-authenticate'] ?? '';
        if (/^\s*digest/i.test(challenge)) {
          // (Re)negotiate: OSCam nonces are short-lived and marked stale on reuse.
          this.challenges.set(auth.user, { params: parseChallenge(challenge), nc: 0 });
          res = await attempt(this.digestHeader(auth, method, uri));
        } else {
          res = await attempt(this.basicHeader(auth));
        }
      }

      if (res.status === 401 || res.status === 403) throw new BackendError(`${this.label} rejected the credentials`, 401);
      if (res.status >= 400) throw new BackendError(`${this.label} returned HTTP ${res.status}`, 502);
      return res.text;
    } catch (err) {
      if (err instanceof BackendError) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      const cause = (err as { cause?: { code?: string } })?.cause?.code;
      throw new BackendError(
        `Cannot reach ${this.label} at ${this.target}: ${reason}${cause ? ` (${cause})` : ''}`,
        502,
      );
    }
  }

  /**
   * One request, one connection: no pooling, no keep-alive surprises.
   *
   * Header names must keep their canonical capitalisation: the webif parses
   * POST bodies with `strstr(request, "Content-Length: ")` (check_request() in
   * module-webif.c), so a lower-case `content-length` — what fetch/undici and
   * most HTTP clients send over HTTP/1.1 — makes OSCam/NCam wait forever for a
   * body it thinks has not arrived, and every config save times out.
   */
  private request(
    url: string,
    method: 'GET' | 'POST',
    headers: Record<string, string>,
    body?: string,
  ): Promise<HttpReply> {
    const target = new URL(url);
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const payload = body === undefined ? undefined : Buffer.from(body, 'utf8');

    return new Promise<HttpReply>((resolve, reject) => {
      const req = send(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || (target.protocol === 'https:' ? 443 : 80),
          path: `${target.pathname}${target.search}`,
          method,
          headers: {
            ...headers,
            Connection: 'close',
            ...(payload ? { 'Content-Length': String(payload.byteLength) } : {}),
          },
          timeout: this.timeoutMs,
        },
        (res: IncomingMessage) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers as Record<string, string | undefined>,
              text: Buffer.concat(chunks).toString('utf8'),
            }),
          );
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error(`timed out after ${this.timeoutMs} ms`)));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
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

  async post(auth: BackendAuth, path: string, form: Record<string, string | undefined>): Promise<string> {
    const body = HttpOscamTransport.qs(form);
    // The webif answers an unauthenticated POST with 401 and closes the socket
    // without draining the body, so make sure a digest nonce is already known
    // before sending one.
    if (!this.challenges.has(auth.user)) await this.refreshChallenge(auth, path);
    try {
      return await this.send(auth, 'POST', path, body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/UND_ERR_SOCKET|ECONNRESET|socket hang up|fetch failed/i.test(message)) throw err;
      this.challenges.delete(auth.user);
      await this.refreshChallenge(auth, path);
      return await this.send(auth, 'POST', path, body);
    }
  }

  /** Cheap authenticated GET whose only purpose is to obtain a fresh nonce. */
  private async refreshChallenge(auth: BackendAuth, path: string): Promise<void> {
    try {
      await this.send(auth, 'GET', `${path}?part=status`);
    } catch {
      /* the POST will report the real error */
    }
  }
}
