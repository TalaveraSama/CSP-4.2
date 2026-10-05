import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import cookieParser from 'cookie-parser';
import express from 'express';

import { listIniAccounts, upsertAccount, upsertIniAccount } from '../src/accounts.js';
import { LoginLimiter } from '../src/security.js';
import { ResellerStore } from '../src/resellers.js';
import { SessionStore } from '../src/sessions.js';
import { createApiRouter } from '../src/routes.js';
import type { BackendAuth, ConfigFile, ProxyBackend, StatusSnapshot } from '../src/backend.js';

/* ------------------------------------------------------------- injection */

test('a value with a newline cannot write extra keys into ncam.user', () => {
  // This is privilege escalation: group = 1,2,3,4 is access to readers the
  // reseller does not pay for, monlevel = 4 is monitor access to the softcam.
  const attack = 'x\ngroup                         = 1,2,3,4\nmonlevel                      = 4';
  assert.throws(
    () => upsertIniAccount('# clients\n', { name: 'malo', password: attack }, { create: true }),
    /cannot contain line breaks/,
  );
  for (const field of ['displayName', 'group', 'ipMask', 'expiry'] as const) {
    assert.throws(
      () => upsertIniAccount('# clients\n', { name: 'm', password: 'p', [field]: 'a\nuser = colado' }, { create: true }),
      /cannot contain line breaks|must look like/,
      field,
    );
  }
});

test('a value cannot break out of an xml attribute either', () => {
  const xml = upsertAccount(
    '<cardserv-proxy ver="0.9.0">\n <user-manager>\n  <auth-config>\n  </auth-config>\n </user-manager>\n</cardserv-proxy>\n',
    { name: 'malo', password: '" admin="true' },
    { create: true },
  );
  assert.ok(xml.includes('password="&quot; admin=&quot;true"'), 'quotes escaped');
  assert.ok(!/name="malo"[^>]*admin="true"/.test(xml), 'not an admin');
});

test('absurd lengths are refused instead of filling a config file', () => {
  assert.throws(
    () => upsertIniAccount('# c\n', { name: 'm', password: 'p'.repeat(200) }, { create: true }),
    /too long/,
  );
});

test('an account that is merely odd still works', () => {
  const out = upsertIniAccount(
    '# clients\n',
    { name: 'cliente.1@casa-2', password: 'p@ss w0rd!#$%', displayName: 'Juan Pérez' },
    { create: true },
  );
  const account = listIniAccounts(out)[0]!;
  assert.equal(account.name, 'cliente.1@casa-2');
  assert.equal(account.password, 'p@ss w0rd!#$%');
  assert.equal(account.displayName, 'Juan Pérez');
});

/* ----------------------------------------------------------- rate limiting */

test('the login locks after a burst, by address and by user name', () => {
  let now = 1_000_000;
  const limiter = new LoginLimiter({ max: 3, windowMs: 60_000, blockMs: 300_000, now: () => now });

  assert.equal(limiter.retryAfter('1.1.1.1', 'juan'), 0);
  limiter.fail('1.1.1.1', 'juan');
  limiter.fail('1.1.1.1', 'juan');
  assert.equal(limiter.retryAfter('1.1.1.1', 'juan'), 0, 'still within the allowance');
  limiter.fail('1.1.1.1', 'juan');
  assert.equal(limiter.retryAfter('1.1.1.1', 'juan'), 300, 'locked for five minutes');

  // Same user from another address is locked too: spraying from a botnet.
  assert.equal(limiter.retryAfter('2.2.2.2', 'juan'), 300);
  // And an untouched user from an untouched address is unaffected.
  assert.equal(limiter.retryAfter('3.3.3.3', 'ana'), 0);

  now += 301_000;
  assert.equal(limiter.retryAfter('1.1.1.1', 'juan'), 0, 'the lock expires');
});

test('a success clears the counter', () => {
  let now = 1_000_000;
  const limiter = new LoginLimiter({ max: 3, windowMs: 60_000, blockMs: 300_000, now: () => now });
  limiter.fail('1.1.1.1', 'juan');
  limiter.fail('1.1.1.1', 'juan');
  limiter.succeed('1.1.1.1', 'juan');
  limiter.fail('1.1.1.1', 'juan');
  limiter.fail('1.1.1.1', 'juan');
  assert.equal(limiter.retryAfter('1.1.1.1', 'juan'), 0, 'the earlier failures were forgiven');
});

/* --------------------------------------------------------------- end to end */

const dir = mkdtempSync(join(tmpdir(), 'csp-sec-'));
const userFile = join(dir, 'ncam.user');

const backend: ProxyBackend = {
  info: {
    kind: 'ncam',
    mock: false,
    target: 'http://box:8888',
    configFormat: 'ini',
    configFiles: ['ncam.conf', 'ncam.user'],
    features: { profiles: true, cache: false, plugins: false, connectorServices: false, seen: true, accounts: true },
    labels: { connectors: 'Readers', connector: 'Reader', profiles: 'CAIDs', product: 'NCam' },
  },
  async login(user: string, password: string) {
    return password === 'adminpw' ? { user, admin: true, superUser: true } : null;
  },
  async snapshot(): Promise<StatusSnapshot> {
    throw new Error('unused');
  },
  async control() {
    return { ok: true, message: 'ok' };
  },
  async fetchConfig(_auth: BackendAuth, file?: string): Promise<ConfigFile> {
    return { name: file ?? 'ncam.user', content: readFileSync(userFile, 'utf8'), writable: true };
  },
  async saveConfig(_auth: BackendAuth, content: string) {
    writeFileSync(userFile, content);
    return { ok: true, message: 'saved' };
  },
};

test('over http: headers, csrf, throttling and pinned groups', async () => {
  writeFileSync(userFile, '# clients\n');
  process.env.BACKEND_USER = 'admin';
  process.env.BACKEND_PASS = 'adminpw';

  const store = new ResellerStore(join(dir, 'r.json'));
  const juan = store.create('juan', 'juanpw', 10);
  store.update(juan.id, { group: '1' }); // may only sell group 1

  const { securityHeaders } = await import('../src/security.js');
  const app = express();
  app.use(securityHeaders);
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api', createApiRouter(backend, new SessionStore(3_600_000), 'never', store));
  const listener = app.listen(0);
  const { port } = listener.address() as { port: number };
  const base = `http://127.0.0.1:${port}/api`;

  try {
    // Headers on every response.
    const meta = await fetch(`${base}/meta`);
    assert.match(meta.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    assert.equal(meta.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(meta.headers.get('x-frame-options'), 'DENY');

    // A cross-site form post cannot reach a mutating endpoint.
    const form = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'user=juan&password=juanpw',
    });
    assert.equal(form.status, 415);

    const login = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: 'juan', password: 'juanpw' }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.getSetCookie()[0]!;
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);

    const session = cookie.split(';')[0]!;
    const call = (path: string, init?: RequestInit) =>
      fetch(`${base}${path}`, {
        ...init,
        headers: { cookie: session, 'content-type': 'application/json', ...(init?.headers ?? {}) },
      });

    // He asks for groups 1,2,3 — he gets the one he pays for.
    const created = await call('/accounts', {
      method: 'POST',
      body: JSON.stringify({ name: 'cliente1', password: 'pw', group: '1,2,3' }),
    });
    assert.equal(created.status, 200);
    assert.match(readFileSync(userFile, 'utf8'), /group\s+= 1\n/);
    assert.ok(!readFileSync(userFile, 'utf8').includes('1,2,3'), 'the request did not decide the groups');

    // And he cannot sneak them in through an edit either.
    await call('/accounts/cliente1', { method: 'PUT', body: JSON.stringify({ group: '1,2,3,4' }) });
    assert.ok(!readFileSync(userFile, 'utf8').includes('1,2,3,4'));

    // The injection is refused by the API, not only by the model.
    const injected = await call('/accounts', {
      method: 'POST',
      body: JSON.stringify({ name: 'malo', password: 'x\nmonlevel = 4' }),
    });
    assert.equal(injected.status, 400);
    assert.match((await injected.json()).error, /line breaks/);

    // Wrong passwords are throttled.
    let last = 200;
    for (let i = 0; i < 12; i++) {
      const res = await fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user: 'juan', password: 'mala' }),
      });
      last = res.status;
      if (last === 429) {
        assert.ok(Number(res.headers.get('retry-after')) > 0);
        break;
      }
    }
    assert.equal(last, 429, 'the login locks instead of answering forever');
  } finally {
    await new Promise((r) => listener.close(r));
  }
});
