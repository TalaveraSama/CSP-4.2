import type { NextFunction, Request, Response } from 'express';

/**
 * Hardening for a panel that faces the internet.
 *
 * Resellers log in from anywhere, which turns the login form into the most
 * attacked surface of the whole stack. None of this replaces running behind
 * nginx with TLS, but it is the part the application itself must do.
 */

/* ------------------------------------------------------------------ headers */

/**
 * The panel is a self-contained SPA: no external scripts, no fonts, no
 * analytics. So the policy can be as tight as it gets and still work.
 */
export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      // Vite inlines a small style block, hence 'unsafe-inline' for styles only.
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), interest-cohort=()');
  // Only meaningful over https; harmless otherwise, and the panel is meant
  // to be published with TLS.
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

/* ------------------------------------------------------------------- csrf */

/**
 * The session lives in a SameSite cookie, which already stops cross-site
 * form posts. This is the second lock: a state changing request must look
 * like it came from our own code (fetch with a JSON body), never from a
 * form on someone else's page, which can only send urlencoded or multipart.
 */
export function requireJsonForWrites(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (type === 'application/json' || type === '') return next();
  res.status(415).json({ error: 'this endpoint only accepts application/json' });
}

/* ------------------------------------------------------------ rate limiting */

interface Attempt {
  count: number;
  first: number;
  blockedUntil?: number;
}

export interface LoginLimiterOptions {
  /** Failures allowed inside the window before locking. */
  max?: number;
  windowMs?: number;
  blockMs?: number;
  now?: () => number;
}

/**
 * Login throttling, per source address *and* per user name: locking only by
 * IP lets a botnet spray one password across many addresses, and locking
 * only by user lets anybody lock out a reseller on purpose.
 *
 * In memory on purpose: a panel serves one box, and a restart clearing the
 * counters is not worth a database.
 */
export class LoginLimiter {
  private readonly attempts = new Map<string, Attempt>();
  private readonly max: number;
  private readonly windowMs: number;
  private readonly blockMs: number;
  private readonly now: () => number;

  constructor(options: LoginLimiterOptions = {}) {
    this.max = options.max ?? 8;
    this.windowMs = options.windowMs ?? 10 * 60_000;
    this.blockMs = options.blockMs ?? 15 * 60_000;
    this.now = options.now ?? Date.now;
  }

  private keys(ip: string, user: string): string[] {
    return [`ip:${ip}`, `user:${user.toLowerCase()}`];
  }

  /** Seconds to wait, or 0 when the attempt may go ahead. */
  retryAfter(ip: string, user: string): number {
    const now = this.now();
    let wait = 0;
    for (const key of this.keys(ip, user)) {
      const attempt = this.attempts.get(key);
      if (attempt?.blockedUntil && attempt.blockedUntil > now) {
        wait = Math.max(wait, Math.ceil((attempt.blockedUntil - now) / 1000));
      }
    }
    return wait;
  }

  fail(ip: string, user: string): void {
    const now = this.now();
    for (const key of this.keys(ip, user)) {
      const attempt = this.attempts.get(key);
      if (!attempt || now - attempt.first > this.windowMs) {
        this.attempts.set(key, { count: 1, first: now });
        continue;
      }
      attempt.count += 1;
      if (attempt.count >= this.max) {
        attempt.blockedUntil = now + this.blockMs;
        attempt.count = 0;
        attempt.first = now;
      }
    }
    this.sweep(now);
  }

  succeed(ip: string, user: string): void {
    for (const key of this.keys(ip, user)) this.attempts.delete(key);
  }

  private sweep(now: number): void {
    if (this.attempts.size < 5000) return;
    for (const [key, attempt] of this.attempts) {
      const dead = (attempt.blockedUntil ?? 0) < now && now - attempt.first > this.windowMs;
      if (dead) this.attempts.delete(key);
    }
  }
}

/** Best effort client address, honouring express' trust proxy setting. */
export function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}
