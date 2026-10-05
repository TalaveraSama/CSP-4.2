import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import cookieParser from 'cookie-parser';
import express from 'express';

import { createApiRouter } from '../src/routes.js';
import { ResellerStore } from '../src/resellers.js';
import { SessionStore } from '../src/sessions.js';
import type { BackendAuth, ConfigFile, ProxyBackend, StatusSnapshot } from '../src/backend.js';

/** An ncam.user living in a temp file, like the real webif would hold it. */
const dir = mkdtempSync(join(tmpdir(), 'csp-resapi-'));
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

function api(resellers: ResellerStore) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api', createApiRouter(backend, new SessionStore(3_600_000), 'never', resellers));
  return app.listen(0);
}

async function client(listener: ReturnType<typeof api>, user: string, password: string) {
  const { port } = listener.address() as { port: number };
  const base = `http://127.0.0.1:${port}/api`;
  const login = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user, password }),
  });
  const cookie = login.headers.getSetCookie()[0]?.split(';')[0] ?? '';
  const call = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { cookie, 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
    return { status: res.status, body: (await res.json()) as never };
  };
  return { login: { status: login.status, body: (await login.json()) as never }, call };
}

test('a reseller sells lines out of his credit balance', async () => {
  writeFileSync(userFile, '# clients\n');
  process.env.BACKEND_USER = 'admin';
  process.env.BACKEND_PASS = 'adminpw';

  const store = new ResellerStore(join(dir, 'resellers.json'));
  store.create('juan', 'juanpw', 3);
  const listener = api(store);

  try {
    const juan = await client(listener, 'juan', 'juanpw');
    assert.equal(juan.login.status, 200);
    assert.deepEqual(juan.login.body, { user: 'juan', admin: false, superUser: false, role: 'reseller', credits: 3 });

    // Creating a line for two months costs two credits.
    const created = await juan.call('/accounts', {
      method: 'POST',
      body: JSON.stringify({ name: 'cliente1', password: 'pw1', group: '1', months: 2 }),
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(store.find('juan')?.credits, 1);

    const listed = await juan.call('/accounts');
    assert.deepEqual((listed.body as { accounts: { name: string }[] }).accounts.map((a) => a.name), ['cliente1']);
    assert.equal((listed.body as { credits: number }).credits, 1);
    assert.ok(readFileSync(userFile, 'utf8').includes('user                          = cliente1'));

    // One credit left: a three month renewal has to be refused, untouched.
    const broke = await juan.call('/accounts/cliente1', { method: 'PUT', body: JSON.stringify({ renew: 3 }) });
    assert.equal(broke.status, 402);
    assert.match((broke.body as { error: string }).error, /not enough credits: 1 left, 3 needed/);
    assert.equal(store.find('juan')?.credits, 1);

    const renewed = await juan.call('/accounts/cliente1', { method: 'PUT', body: JSON.stringify({ renew: 1 }) });
    assert.equal(renewed.status, 200);
    assert.equal(store.find('juan')?.credits, 0);
    assert.match((renewed.body as { message: string }).message, /renewed until \d{4}-\d{2}-\d{2}/);

    // Three months paid in total, counted from today.
    const expiry = store.record('cliente1')!.expiresAt!;
    const months = (new Date(expiry).getFullYear() - new Date().getFullYear()) * 12 +
      new Date(expiry).getMonth() - new Date().getMonth();
    assert.equal(months, 3);
  } finally {
    await new Promise((r) => listener.close(r));
  }
});

test('a reseller never sees, touches or deletes what is not his', async () => {
  writeFileSync(userFile, '# clients\n');
  const store = new ResellerStore(join(dir, 'resellers2.json'));
  store.create('juan', 'juanpw', 5);
  store.create('ana', 'anapw', 5);
  const listener = api(store);

  try {
    const juan = await client(listener, 'juan', 'juanpw');
    const ana = await client(listener, 'ana', 'anapw');
    await juan.call('/accounts', { method: 'POST', body: JSON.stringify({ name: 'dejuan', password: 'x' }) });
    await ana.call('/accounts', { method: 'POST', body: JSON.stringify({ name: 'deana', password: 'y' }) });

    const juanSees = (await juan.call('/accounts')).body as { accounts: { name: string }[] };
    assert.deepEqual(juanSees.accounts.map((a) => a.name), ['dejuan']);

    // 404, not 403: he has no business learning the name even exists.
    assert.equal((await juan.call('/accounts/deana', { method: 'PUT', body: '{"password":"z"}' })).status, 404);
    assert.equal((await juan.call('/accounts/deana', { method: 'DELETE' })).status, 404);
    assert.ok(readFileSync(userFile, 'utf8').includes('user                          = deana'));

    // And the reseller area itself is off limits.
    assert.equal((await juan.call('/resellers')).status, 403);
    assert.equal((await juan.call('/config?file=ncam.user')).status, 403);
  } finally {
    await new Promise((r) => listener.close(r));
  }
});

test('the administrator sees everything and pays nothing', async () => {
  writeFileSync(userFile, '# clients\n');
  const store = new ResellerStore(join(dir, 'resellers3.json'));
  const juan = store.create('juan', 'juanpw', 2);
  const listener = api(store);

  try {
    const r = await client(listener, 'juan', 'juanpw');
    await r.call('/accounts', { method: 'POST', body: JSON.stringify({ name: 'dejuan', password: 'x' }) });

    const admin = await client(listener, 'admin', 'adminpw');
    assert.equal(admin.login.status, 200);
    const all = (await admin.call('/accounts')).body as { accounts: { name: string }[] };
    assert.deepEqual(all.accounts.map((a) => a.name), ['dejuan']);

    const created = await admin.call('/accounts', {
      method: 'POST',
      body: JSON.stringify({ name: 'propio', password: 'x' }),
    });
    assert.equal(created.status, 200);
    assert.equal(store.find('juan')?.credits, 1, 'the admin does not spend the reseller credits');

    const list = (await admin.call('/resellers')).body as { resellers: { user: string; clients: number }[] };
    assert.deepEqual(list.resellers.map((x) => [x.user, x.clients]), [['juan', 1]]);

    // Topping up goes through the ledger.
    await admin.call(`/resellers/${juan.id}`, { method: 'PUT', body: JSON.stringify({ credits: 10 }) });
    assert.equal(store.find('juan')?.credits, 11);
  } finally {
    await new Promise((r) => listener.close(r));
  }
});
