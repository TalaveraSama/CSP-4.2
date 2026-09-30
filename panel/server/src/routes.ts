import { Router, type NextFunction, type Request, type Response } from 'express';
import { CspError, type CspClient } from './csp/client.js';
import { parseStatusResponse } from './csp/xml.js';
import type { StatusCommand } from './csp/types.js';
import { COOKIE_NAME, type PanelSession, type SessionStore } from './sessions.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      session?: PanelSession;
    }
  }
}

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;

/** Wraps an async handler so rejections reach the error middleware. */
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res)).catch(next);
};

function qs(req: Request, key: string): string | undefined {
  const v = req.query[key];
  if (typeof v === 'string' && v !== '') return v;
  return undefined;
}

export function createApiRouter(csp: CspClient, sessions: SessionStore, secureCookies: boolean): Router {
  const api = Router();

  const requireSession = (req: Request, res: Response, next: NextFunction) => {
    const session = sessions.get(req.cookies?.[COOKIE_NAME]);
    if (!session) {
      res.status(401).json({ error: 'not authenticated' });
      return;
    }
    req.session = session;
    next();
  };

  const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
    if (!req.session?.admin) {
      res.status(403).json({ error: 'admin privileges required' });
      return;
    }
    next();
  };

  /** Runs status commands and returns the parsed snapshot. */
  const snapshot = (req: Request, commands: StatusCommand[]) => csp.status(req.session!.auth, commands).then(parseStatusResponse);

  /* --------------------------------------------------------------- meta */

  api.get('/meta', (_req, res) => {
    res.json({ backend: csp.kind, target: csp.target, panel: '0.1.0' });
  });

  /* --------------------------------------------------------------- auth */

  api.post(
    '/auth/login',
    wrap(async (req, res) => {
      const { user, password } = (req.body ?? {}) as { user?: string; password?: string };
      if (!user || !password) return res.status(400).json({ error: 'user and password are required' });

      const identity = await csp.login(user, password);
      if (!identity) return res.status(401).json({ error: 'invalid credentials' });

      const session = sessions.create(identity, { user, password, sessionId: identity.sessionId });
      res.cookie(COOKIE_NAME, session.id, {
        httpOnly: true,
        sameSite: 'lax',
        secure: secureCookies,
        path: '/',
      });
      return res.json({ user: session.user, admin: session.admin, superUser: session.superUser });
    }),
  );

  api.post('/auth/logout', (req, res) => {
    sessions.destroy(req.cookies?.[COOKIE_NAME]);
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.json({ ok: true });
  });

  api.get('/auth/me', (req, res) => {
    const session = sessions.get(req.cookies?.[COOKIE_NAME]);
    if (!session) return res.status(401).json({ error: 'not authenticated' });
    return res.json({ user: session.user, admin: session.admin, superUser: session.superUser });
  });

  api.use(requireSession);

  /* ------------------------------------------------------------ queries */

  api.get(
    '/overview',
    wrap(async (req, res) => {
      const data = await snapshot(req, [
        { command: 'proxy-status' },
        { command: 'cache-status' },
        { command: 'proxy-plugins' },
        { command: 'ca-profiles' },
        { command: 'cws-connectors', params: { profile: qs(req, 'profile') } },
      ]);
      res.json(data);
    }),
  );

  api.get(
    '/connectors',
    wrap(async (req, res) => {
      const data = await snapshot(req, [
        { command: 'proxy-status' },
        { command: 'ca-profiles' },
        { command: 'cws-connectors', params: { profile: qs(req, 'profile'), name: qs(req, 'name') } },
      ]);
      res.json(data);
    }),
  );

  api.get(
    '/sessions',
    wrap(async (req, res) => {
      const data = await snapshot(req, [
        { command: 'proxy-status' },
        { command: 'ca-profiles' },
        {
          command: 'proxy-users',
          params: { 'hide-inactive': qs(req, 'hideInactive') ?? 'false', profile: qs(req, 'profile') },
        },
      ]);
      res.json(data);
    }),
  );

  api.get(
    '/events',
    wrap(async (req, res) => {
      const profile = qs(req, 'profile');
      const data = await snapshot(req, [
        { command: 'proxy-status' },
        { command: 'ca-profiles' },
        { command: 'error-log', params: { profile } },
        { command: 'file-log' },
        { command: 'user-warning-log', params: { profile } },
      ]);
      res.json(data);
    }),
  );

  api.get(
    '/channels',
    wrap(async (req, res) => {
      const profile = qs(req, 'profile');
      const commands: StatusCommand[] = [
        { command: 'proxy-status' },
        { command: 'ca-profiles' },
        { command: 'watched-services', params: { profile } },
      ];
      if (qs(req, 'all') === 'true') commands.push({ command: 'all-services', params: { profile, 'include-parsed': 'true' } });
      res.json(await snapshot(req, commands));
    }),
  );

  api.get(
    '/seen',
    wrap(async (req, res) => {
      res.json(await snapshot(req, [{ command: 'proxy-status' }, { command: 'last-seen', params: { name: qs(req, 'name') } }]));
    }),
  );

  api.get(
    '/failures',
    wrap(async (req, res) => {
      res.json(await snapshot(req, [{ command: 'proxy-status' }, { command: 'login-failures', params: { name: qs(req, 'name') } }]));
    }),
  );

  api.get(
    '/commands',
    wrap(async (req, res) => {
      res.json(await snapshot(req, [{ command: 'ctrl-commands', params: { name: qs(req, 'name') } }]));
    }),
  );

  /** Escape hatch: run any status command, including ones added by plugins. */
  api.get(
    '/status/:command',
    wrap(async (req, res) => {
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.query)) if (typeof v === 'string') params[k] = v;
      const xml = await csp.status(req.session!.auth, [{ command: req.params.command!, params }]);
      if (qs(req, 'format') === 'xml') {
        res.type('application/xml').send(xml);
        return;
      }
      res.json(parseStatusResponse(xml));
    }),
  );

  /* ----------------------------------------------------------- mutations */

  api.post(
    '/commands/:name',
    requireAdmin,
    wrap(async (req, res) => {
      const params: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries((req.body ?? {}) as Record<string, unknown>)) {
        if (v === undefined || v === null || v === '') continue;
        params[k] = String(v);
      }
      const result = await csp.control(req.session!.auth, req.params.name!, params);
      res.status(result.ok ? 200 : 400).json(result);
    }),
  );

  api.get(
    '/config',
    requireAdmin,
    wrap(async (req, res) => {
      const xml = await csp.fetchConfig(req.session!.auth);
      res.type('application/xml').send(xml);
    }),
  );

  api.put(
    '/config',
    requireAdmin,
    wrap(async (req, res) => {
      const xml = typeof req.body === 'string' ? req.body : String((req.body as { xml?: string })?.xml ?? '');
      if (!xml.trim()) return res.status(400).json({ ok: false, message: 'empty config' });
      const result = await csp.saveConfig(req.session!.auth, xml);
      return res.status(result.ok ? 200 : 400).json(result);
    }),
  );

  /* --------------------------------------------------------------- errors */

  api.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof CspError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error('[api] unhandled error:', message);
    res.status(500).json({ error: message });
  });

  return api;
}
