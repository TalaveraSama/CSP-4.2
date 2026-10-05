import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import express from 'express';
import cookieParser from 'cookie-parser';

import { createApiRouter } from '../src/routes.js';
import { SessionStore } from '../src/sessions.js';
import type { BackendAuth, ConfigFile, ProxyBackend, StatusSnapshot } from '../src/backend.js';

/**
 * The layout the installer writes for a proxy that has to hold thousands of
 * accounts: XmlUserManager with a local users.xml. The panel must write that
 * file directly and tell the proxy to re-read it, instead of posting the whole
 * proxy.xml back (which reloads the proxy).
 */
const dir = mkdtempSync(join(tmpdir(), 'csp-users-'));
const usersFile = join(dir, 'users.xml');

const PROXY_XML = `<?xml version="1.0" encoding="UTF-8"?>
<cardserv-proxy ver="1.0">
  <user-manager class="com.bowman.cardserv.XmlUserManager" log-failures="true">
    <auth-config>
      <user name="admin" password="S3cret" admin="true"/>
      <user-file-url>file:${usersFile}</user-file-url>
      <update-interval>5</update-interval>
    </auth-config>
  </user-manager>
</cardserv-proxy>
`;

const controls: string[] = [];
let savedConfigs = 0;

const backend: ProxyBackend = {
  info: {
    kind: 'csp',
    mock: false,
    target: 'http://proxy:8082',
    configFormat: 'xml',
    configFiles: ['proxy.xml'],
    features: { profiles: true, cache: true, plugins: true, connectorServices: true, seen: true, accounts: true },
    labels: { connectors: 'Connectors', connector: 'Connector', profiles: 'CA profiles', product: 'CSP' },
  },
  async login(user) {
    return { user, admin: true, superUser: true };
  },
  async snapshot(): Promise<StatusSnapshot> {
    throw new Error('not used');
  },
  async control(_auth: BackendAuth, command: string) {
    controls.push(command);
    return { ok: true, message: 'ok' };
  },
  async fetchConfig(): Promise<ConfigFile> {
    return { name: 'proxy.xml', content: PROXY_XML, writable: true };
  },
  async saveConfig() {
    savedConfigs += 1;
    return { ok: true, message: 'saved' };
  },
};

function server() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api', createApiRouter(backend, new SessionStore(3_600_000), 'never'));
  return app.listen(0);
}

async function withApi<T>(fn: (base: string, cookie: string) => Promise<T>): Promise<T> {
  const listener = server();
  const { port } = listener.address() as { port: number };
  const base = `http://127.0.0.1:${port}/api`;
  const login = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: 'admin', password: 'S3cret' }),
  });
  const cookie = login.headers.getSetCookie()[0]!.split(';')[0]!;
  try {
    return await fn(base, cookie);
  } finally {
    await new Promise((r) => listener.close(r));
  }
}

test('accounts of a big proxy live in users.xml, not in proxy.xml', async () => {
  writeFileSync(usersFile, '<?xml version="1.0" encoding="UTF-8"?>\n<xml-user-manager ver="1.0">\n</xml-user-manager>\n');
  controls.length = 0;
  savedConfigs = 0;

  await withApi(async (base, cookie) => {
    const json = async (path: string, init?: RequestInit) => {
      const res = await fetch(`${base}${path}`, {
        ...init,
        headers: { cookie, 'content-type': 'application/json', ...(init?.headers ?? {}) },
      });
      return { status: res.status, body: await res.json() };
    };

    const empty = await json('/accounts');
    assert.equal(empty.status, 200);
    assert.equal(empty.body.source, usersFile, 'the panel edits the user file');
    assert.deepEqual(empty.body.accounts, []);

    const created = await json('/accounts', {
      method: 'POST',
      body: JSON.stringify({ name: 'cliente1', password: 'pw1', profiles: 'ncam', maxConnections: 2 }),
    });
    assert.equal(created.status, 200);

    await json('/accounts', { method: 'POST', body: JSON.stringify({ name: 'cliente2', password: 'pw2' }) });
    await json('/accounts/cliente1', { method: 'PUT', body: JSON.stringify({ password: '', maxConnections: 4 }) });

    const listed = await json('/accounts');
    assert.deepEqual(listed.body.accounts.map((a: { name: string }) => a.name), ['cliente1', 'cliente2']);
    assert.equal(listed.body.accounts[0].password, 'pw1', 'an empty password keeps the old one');
    assert.equal(listed.body.accounts[0].maxConnections, 4);

    const file = readFileSync(usersFile, 'utf8');
    assert.ok(file.includes('<xml-user-manager'), 'the file keeps its own root element');
    assert.ok(file.includes('name="cliente2"'));

    const removed = await json('/accounts/cliente2', { method: 'DELETE' });
    assert.equal(removed.status, 200);
    assert.deepEqual(
      (await json('/accounts')).body.accounts.map((a: { name: string }) => a.name),
      ['cliente1'],
    );
  });

  assert.equal(savedConfigs, 0, 'proxy.xml is never rewritten, so the proxy never reloads');
  assert.deepEqual(new Set(controls), new Set(['update-users']), 'the proxy is told to re-read the file');
  assert.equal(controls.length, 4, 'once per change');
});
