import { Router, type NextFunction, type Request, type Response } from 'express';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { ResellerError, ResellerStore, addMonths, isoDate } from './resellers.js';
import {
  AccountError,
  findAccount,
  findIniAccount,
  listAccounts,
  listIniAccounts,
  removeAccount,
  removeIniAccount,
  upsertAccount,
  upsertIniAccount,
  type Account,
} from './accounts.js';
import { BackendError, type ProxyBackend } from './backend.js';
import type { StatusCommand } from './csp/types.js';
import { COOKIE_NAME, type PanelSession, type SessionStore } from './sessions.js';
import { PANEL_VERSION } from './version.js';

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

export type SecureCookieMode = 'auto' | 'always' | 'never';

/**
 * Decides the `Secure` flag of the session cookie.
 * 'auto' follows the request scheme, honouring X-Forwarded-Proto when the app
 * runs behind a reverse proxy (nginx in aaPanel, Caddy, Traefik...).
 */
function wantsSecure(mode: SecureCookieMode, req: Request): boolean {
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  return req.secure || (req.headers['x-forwarded-proto'] ?? '').toString().split(',')[0]?.trim() === 'https';
}

export function createApiRouter(
  backend: ProxyBackend,
  sessions: SessionStore,
  secureCookies: SecureCookieMode = 'auto',
  resellers?: ResellerStore,
): Router {
  /**
   * Credentials the panel uses on behalf of resellers, who have no account on
   * the softcam. Set BACKEND_USER/BACKEND_PASS in panel.env; otherwise the
   * last successful admin login is reused, which works until a restart.
   */
  let serviceAuth: { user: string; password: string } | undefined =
    process.env.BACKEND_USER && process.env.BACKEND_PASS
      ? { user: process.env.BACKEND_USER, password: process.env.BACKEND_PASS }
      : undefined;
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

  /** Accounts are the one admin area a reseller is allowed into. */
  const requireAccountAccess = (req: Request, res: Response, next: NextFunction) => {
    if (!req.session?.admin && req.session?.role !== 'reseller') {
      res.status(403).json({ error: 'admin privileges required' });
      return;
    }
    next();
  };

  const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
    if (!req.session?.admin) {
      res.status(403).json({ error: 'admin privileges required' });
      return;
    }
    next();
  };

  /** Collects the requested sections into a normalised snapshot. */
  const snapshot = (req: Request, commands: StatusCommand[]) => backend.snapshot(req.session!.auth, commands);

  /* --------------------------------------------------------------- meta */

  api.get('/meta', (_req, res) => {
    res.json({
      ...backend.info,
      panel: PANEL_VERSION,
      // A cache peer is optional and independent of the backend.
      features: { ...backend.info.features, cacheNode: Boolean(process.env.CACHE_NODE_URL) },
    });
  });

  /* --------------------------------------------------------------- auth */

  api.post(
    '/auth/login',
    wrap(async (req, res) => {
      const { user, password } = (req.body ?? {}) as { user?: string; password?: string };
      if (!user || !password) return res.status(400).json({ error: 'user and password are required' });

      // Resellers are the panel's own users, so they are checked here first;
      // everybody else is still authenticated by the softcam itself.
      const reseller = resellers?.login(user, password);
      if (reseller && !serviceAuth) {
        return res.status(503).json({
          error:
            'resellers cannot be served yet: set BACKEND_USER and BACKEND_PASS in /etc/csp-panel/panel.env ' +
            '(the softcam credentials the panel uses on their behalf), or log in once as administrator first',
        });
      }
      if (reseller) {
        const session = sessions.create(
          { user: reseller.user, admin: false, superUser: false },
          // A reseller has no credentials on the backend: the panel talks to
          // it with its own service account, configured in panel.env.
          { user: serviceAuth!.user, password: serviceAuth!.password },
        );
        session.role = 'reseller';
        session.resellerId = reseller.id;
        res.cookie(COOKIE_NAME, session.id, {
          httpOnly: true,
          sameSite: 'lax',
          secure: wantsSecure(secureCookies, req),
          path: '/',
        });
        return res.json({ user: reseller.user, admin: false, superUser: false, role: 'reseller', credits: reseller.credits });
      }

      const identity = await backend.login(user, password);
      if (!identity) return res.status(401).json({ error: 'invalid credentials' });

      const session = sessions.create(identity, { user, password, sessionId: identity.sessionId });
      session.role = 'admin';
      // Remember a working admin login so reseller sessions can reach the
      // backend without having credentials of their own.
      serviceAuth = { user, password };
      res.cookie(COOKIE_NAME, session.id, {
        httpOnly: true,
        sameSite: 'lax',
        secure: wantsSecure(secureCookies, req),
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
    return res.json({
      user: session.user,
      admin: session.admin,
      superUser: session.superUser,
      role: session.role ?? 'admin',
      credits: session.resellerId ? resellers?.byId(session.resellerId)?.credits : undefined,
    });
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
      if (qs(req, 'format') === 'xml') {
        res.type('application/xml').send(await backend.raw(req.session!.auth, req.params.command!, params));
        return;
      }
      res.json(await snapshot(req, [{ command: req.params.command!, params }]));
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
      const result = await backend.control(req.session!.auth, req.params.name!, params);
      res.status(result.ok ? 200 : 400).json(result);
    }),
  );

  api.get(
    '/config',
    requireAdmin,
    wrap(async (req, res) => {
      const file = await backend.fetchConfig(req.session!.auth, qs(req, 'file'));
      res.json(file);
    }),
  );

  api.put(
    '/config',
    requireAdmin,
    wrap(async (req, res) => {
      const body = req.body as { content?: string; file?: string } | string;
      const content = typeof body === 'string' ? body : String(body?.content ?? '');
      if (!content.trim()) return res.status(400).json({ ok: false, message: 'empty config' });
      const file = typeof body === 'string' ? qs(req, 'file') : (body?.file ?? qs(req, 'file'));
      const result = await backend.saveConfig(req.session!.auth, content, file);
      return res.status(result.ok ? 200 : 400).json(result);
    }),
  );

  /* -------------------------------------------------------------- accounts */

  /**
   * Where the client accounts of this backend live, and how to change them.
   *
   * Three cases, because the stack has three:
   *  - CSP with SimpleUserManager: <user> elements inside proxy.xml, changed
   *    with fetch-cfg / cfgHandler (the proxy reloads its whole config).
   *  - CSP with XmlUserManager and a local file: the panel writes that file
   *    directly and fires the `update-users` control command. proxy.xml is
   *    never touched, nothing is reloaded — this is the one that scales to
   *    thousands of accounts.
   *  - OSCam/NCam: [account] blocks in ncam.user, through the webif file API.
   */
  interface AccountStore {
    kind: 'xml' | 'ini';
    /** Human readable origin, shown in the UI. */
    source: string;
    writable: boolean;
    read(): Promise<string>;
    write(content: string): Promise<void>;
  }

  const localUserFile = (xml: string): string | undefined => {
    if (!/<user-manager[^>]*XmlUserManager/i.test(xml)) return undefined;
    const url = /<user-file-url>\s*([^<]+?)\s*<\/user-file-url>/i.exec(xml)?.[1];
    if (!url?.startsWith('file:')) return undefined; // http/ftp sources are not ours to edit
    const path = url.slice('file:'.length);
    return path.startsWith('/') ? path : resolve(process.cwd(), path);
  };

  const accountStore = async (req: Request): Promise<AccountStore> => {
    const auth = req.session!.auth;

    if (backend.info.kind === 'csp') {
      const config = await backend.fetchConfig(auth);
      const file = localUserFile(config.content);
      if (file) {
        return {
          kind: 'xml',
          source: file,
          writable: true,
          read: async () => {
            try {
              return await readFile(file, 'utf8');
            } catch (err) {
              if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                return '<?xml version="1.0" encoding="UTF-8"?>\n<user-manager>\n  <auth-config>\n  </auth-config>\n</user-manager>\n';
              }
              throw new AccountError(`cannot read ${file}: ${(err as Error).message}`, 502);
            }
          },
          write: async (content) => {
            try {
              await writeFile(file, content, { mode: 0o640 });
            } catch (err) {
              throw new AccountError(`cannot write ${file}: ${(err as Error).message}`, 502);
            }
            // Tell the proxy to pick it up now instead of at the next poll.
            await backend.control(auth, 'update-users', {}).catch(() => undefined);
          },
        };
      }
      return {
        kind: 'xml',
        source: config.name,
        writable: config.writable,
        read: async () => config.content,
        write: async (content) => {
          const result = await backend.saveConfig(auth, content);
          if (!result.ok) throw new AccountError(result.message || 'the proxy refused the new config', 400);
        },
      };
    }

    // OSCam and NCam: the accounts file of the running softcam.
    const file = backend.info.configFiles.find((f) => f.endsWith('.user'));
    if (!file) throw new AccountError('this backend has no accounts file', 501);
    const current = await backend.fetchConfig(auth, file);
    return {
      kind: 'ini',
      source: file,
      writable: current.writable,
      read: async () => current.content,
      write: async (content) => {
        const result = await backend.saveConfig(auth, content, file);
        if (!result.ok) throw new AccountError(result.message || `${backend.info.labels.product} refused the file`, 400);
      },
    };
  };

  /* --- reseller scoping ---------------------------------------------------
   * A reseller may only see and touch the clients he owns, and every line he
   * creates or renews costs credits. The administrator sees everything and
   * pays nothing.
   */
  const requireResellers = (): ResellerStore => {
    if (!resellers) throw new ResellerError('reseller support is not enabled on this panel', 501);
    return resellers;
  };

  const isReseller = (req: Request) => req.session?.role === 'reseller';

  const ownedBy = (req: Request) => (isReseller(req) ? req.session!.resellerId! : 'admin');

  const assertOwner = (req: Request, name: string) => {
    if (!isReseller(req)) return;
    if (requireResellers().owner(name) !== req.session!.resellerId) {
      // Not "forbidden": a reseller has no business learning which names
      // exist outside his own list.
      throw new AccountError(`there is no account called "${name}"`, 404);
    }
  };

  /** Months asked for in the request body, defaulting to one. */
  const monthsOf = (body: unknown): number => {
    const value = Number((body as { months?: unknown })?.months ?? 1);
    if (!Number.isInteger(value) || value < 1 || value > 60) {
      throw new AccountError('months must be a whole number between 1 and 60');
    }
    return value;
  };

  const readAccounts = (store: AccountStore, text: string) =>
    store.kind === 'xml' ? listAccounts(text) : listIniAccounts(text);
  const findOne = (store: AccountStore, text: string, name: string) =>
    store.kind === 'xml' ? findAccount(text, name) : findIniAccount(text, name);
  const upsert = (store: AccountStore, text: string, account: Account, create: boolean) =>
    store.kind === 'xml'
      ? upsertAccount(text, account, { create })
      : upsertIniAccount(text, account, { create });
  const remove = (store: AccountStore, text: string, name: string) =>
    store.kind === 'xml' ? removeAccount(text, name) : removeIniAccount(text, name);

  api.get(
    '/accounts',
    requireAccountAccess,
    wrap(async (req, res) => {
      const store = await accountStore(req);
      const text = await store.read();
      let accounts = readAccounts(store, text);

      if (isReseller(req)) {
        const mine = new Set(requireResellers().clientsOf(req.session!.resellerId!));
        accounts = accounts.filter((a) => mine.has(a.name));
      }

      // The panel tracks expiry itself, so it works on backends that have no
      // expiry field of their own.
      if (resellers) {
        accounts = accounts.map((a) => {
          const record = resellers.record(a.name);
          return record?.expiresAt ? { ...a, expiry: record.expiresAt } : a;
        });
      }

      res.json({
        accounts,
        writable: store.writable,
        source: store.source,
        kind: store.kind,
        credits: isReseller(req) ? requireResellers().byId(req.session!.resellerId!)?.credits : undefined,
      });
    }),
  );

  api.post(
    '/accounts',
    requireAccountAccess,
    wrap(async (req, res) => {
      const store = await accountStore(req);
      const account = { ...(req.body as Account) };
      const months = monthsOf(req.body);
      const owner = ownedBy(req);

      if (resellers && !account.expiry) {
        account.expiry = isoDate(addMonths(new Date(), months));
      }

      if (isReseller(req)) {
        // Charge first: a failed charge must not leave the account created.
        requireResellers().charge(owner, months, `create ${account.name} (${months} m)`);
      }

      try {
        await store.write(upsert(store, await store.read(), account, true));
      } catch (err) {
        if (isReseller(req)) requireResellers().addCredits(owner, months, `refund, ${account.name} failed`);
        throw err;
      }

      resellers?.claim(account.name, owner, account.expiry);
      res.json({
        ok: true,
        message: `account ${account.name} created${account.expiry ? `, expires ${account.expiry}` : ''}`,
      });
    }),
  );

  api.put(
    '/accounts/:name',
    requireAccountAccess,
    wrap(async (req, res) => {
      assertOwner(req, req.params.name!);
      const store = await accountStore(req);
      const text = await store.read();
      const current = findOne(store, text, req.params.name!);
      if (!current) throw new AccountError(`there is no account called "${req.params.name}"`, 404);

      // An empty password means "leave it as it was".
      const patch = req.body as Partial<Account> & { renew?: number };
      const account: Account = { ...current, ...patch, name: current.name };
      if (!patch.password) account.password = current.password;

      // Renewing extends from today, or from the current date when it is
      // still in the future: nobody should lose the days he already paid for.
      let renewed: string | undefined;
      if (patch.renew) {
        const months = monthsOf({ months: patch.renew });
        const owner = requireResellers().owner(req.params.name!) ?? 'admin';
        const record = requireResellers().record(req.params.name!);
        const today = isoDate(new Date());
        const from = record?.expiresAt && record.expiresAt > today ? new Date(record.expiresAt) : new Date();
        renewed = isoDate(addMonths(from, months));
        if (isReseller(req)) {
          requireResellers().charge(owner, months, `renew ${req.params.name} (${months} m)`);
        }
        account.expiry = renewed;
        account.enabled = true; // paying brings a cut off line back
      }

      await store.write(upsert(store, text, account, false));
      if (resellers) {
        if (!resellers.record(account.name)) resellers.claim(account.name, ownedBy(req), account.expiry);
        else resellers.setExpiry(account.name, account.expiry);
      }
      res.json({
        ok: true,
        message: renewed ? `account ${account.name} renewed until ${renewed}` : `account ${account.name} updated`,
      });
    }),
  );

  api.delete(
    '/accounts/:name',
    requireAccountAccess,
    wrap(async (req, res) => {
      assertOwner(req, req.params.name!);
      const store = await accountStore(req);
      await store.write(remove(store, await store.read(), req.params.name!));
      // No refund: otherwise credits could be recycled by deleting lines.
      resellers?.release(req.params.name!);
      res.json({ ok: true, message: `account ${req.params.name} removed` });
    }),
  );

  /* ------------------------------------------------------------ resellers */

  api.get(
    '/resellers',
    requireAdmin,
    wrap(async (_req, res) => {
      const store = requireResellers();
      res.json({ resellers: store.list(), ledger: store.ledger(60) });
    }),
  );

  api.post(
    '/resellers',
    requireAdmin,
    wrap(async (req, res) => {
      const { user, password, credits, note } = req.body as {
        user?: string;
        password?: string;
        credits?: number;
        note?: string;
      };
      const created = requireResellers().create(user ?? '', password ?? '', Number(credits ?? 0), note);
      res.json({ ok: true, message: `reseller ${created.user} created with ${created.credits} credit(s)` });
    }),
  );

  api.put(
    '/resellers/:id',
    requireAdmin,
    wrap(async (req, res) => {
      const { password, enabled, note, credits } = req.body as {
        password?: string;
        enabled?: boolean;
        note?: string;
        credits?: number;
      };
      const store = requireResellers();
      const updated = store.update(req.params.id!, { password, enabled, note });
      if (credits !== undefined && Number(credits) !== 0) {
        store.addCredits(req.params.id!, Number(credits), Number(credits) > 0 ? 'top up' : 'adjustment');
      }
      res.json({ ok: true, message: `reseller ${updated.user} updated` });
    }),
  );

  api.delete(
    '/resellers/:id',
    requireAdmin,
    wrap(async (req, res) => {
      requireResellers().remove(req.params.id!);
      res.json({ ok: true, message: 'reseller removed (his clients were kept)' });
    }),
  );

  /* ----------------------------------------------------------- cache node */

  // Optional companion process (csp-cache-node) that sits in the CSP cache
  // cluster. The panel only reads its stats; it is a separate daemon so that
  // restarting the panel never disturbs the cache.
  const cacheNodeUrl = process.env.CACHE_NODE_URL?.replace(/\/$/, '');

  const fromCacheNode = async (path: string) => {
    if (!cacheNodeUrl) throw new AccountError('no cache node configured (set CACHE_NODE_URL)', 501);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const res = await fetch(`${cacheNodeUrl}${path}`, { signal: controller.signal });
      if (!res.ok) throw new AccountError(`the cache node answered HTTP ${res.status}`, 502);
      return await res.json();
    } catch (err) {
      if (err instanceof AccountError) throw err;
      throw new AccountError(
        `cannot reach the cache node at ${cacheNodeUrl}: ${err instanceof Error ? err.message : String(err)}`,
        502,
      );
    } finally {
      clearTimeout(timer);
    }
  };

  api.get(
    '/cache',
    wrap(async (_req, res) => {
      const [stats, recent] = await Promise.all([fromCacheNode('/stats'), fromCacheNode('/recent?limit=40')]);
      // /recent answers { entries: [...] }, and /stats already uses `entries`
      // for the count: keep both, under names that mean what they say.
      res.json({ ...(stats as object), entriesList: (recent as { entries?: unknown }).entries ?? [] });
    }),
  );

  /* --------------------------------------------------------------- errors */

  api.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ResellerError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    if (err instanceof AccountError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    if (err instanceof BackendError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error('[api] unhandled error:', message);
    res.status(500).json({ error: message });
  });

  return api;
}
