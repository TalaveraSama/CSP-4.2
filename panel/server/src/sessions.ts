import { randomBytes } from 'node:crypto';
import type { CspAuth } from './csp/client.js';
import type { CspIdentity } from './csp/types.js';

export interface PanelSession extends CspIdentity {
  id: string;
  auth: CspAuth;
  createdAt: number;
  lastSeen: number;
}

/**
 * In-memory session store.
 *
 * The browser only ever holds an opaque httpOnly cookie; CSP credentials stay
 * on the server. Restarting the BFF invalidates all panel sessions (by design).
 */
export class SessionStore {
  private readonly sessions = new Map<string, PanelSession>();

  constructor(private readonly ttlMs: number) {
    const timer = setInterval(() => this.sweep(), 60_000);
    timer.unref?.();
  }

  create(identity: CspIdentity, auth: CspAuth): PanelSession {
    const id = randomBytes(24).toString('base64url');
    const now = Date.now();
    const session: PanelSession = { ...identity, id, auth, createdAt: now, lastSeen: now };
    this.sessions.set(id, session);
    return session;
  }

  get(id: string | undefined): PanelSession | undefined {
    if (!id) return undefined;
    const s = this.sessions.get(id);
    if (!s) return undefined;
    if (Date.now() - s.lastSeen > this.ttlMs) {
      this.sessions.delete(id);
      return undefined;
    }
    s.lastSeen = Date.now();
    return s;
  }

  destroy(id: string | undefined): void {
    if (id) this.sessions.delete(id);
  }

  private sweep(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, s] of this.sessions) if (s.lastSeen < cutoff) this.sessions.delete(id);
  }
}

export const COOKIE_NAME = 'csp_panel_sid';
