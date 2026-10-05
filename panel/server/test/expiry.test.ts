import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { sweepExpired } from '../src/expiry.js';
import { ResellerStore, addMonths, isoDate } from '../src/resellers.js';
import type { BackendAuth, ConfigFile, ProxyBackend, StatusSnapshot } from '../src/backend.js';

const dir = mkdtempSync(join(tmpdir(), 'csp-exp-'));
const userFile = join(dir, 'ncam.user');
let writes = 0;

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
  async login() {
    return { user: 'admin', admin: true, superUser: true };
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
    writes += 1;
    writeFileSync(userFile, content);
    return { ok: true, message: 'saved' };
  },
};

const auth: BackendAuth = { user: 'admin', password: 'x' };

test('a line whose month ran out stops working, and only that one', async () => {
  writeFileSync(
    userFile,
    `[account]
user                          = aldia
pwd                           = p1
group                         = 1

[account]
user                          = vencido
pwd                           = p2
group                         = 1
caid                          = 1802

[account]
user                          = vencido2
pwd                           = p3
group                         = 1
`,
  );
  writes = 0;

  const store = new ResellerStore(join(dir, 'r.json'));
  const juan = store.create('juan', 'juanpw', 10);
  store.claim('aldia', juan.id, isoDate(addMonths(new Date(), 1)));
  store.claim('vencido', juan.id, '2020-01-01');
  store.claim('vencido2', juan.id, '2020-02-01');

  const result = await sweepExpired(backend, store, auth);
  assert.equal(result.checked, 2);
  assert.deepEqual(result.disabled.sort(), ['vencido', 'vencido2']);
  assert.deepEqual(result.failed, []);
  assert.equal(writes, 1, 'one read, one write, whatever the number of accounts');

  const text = readFileSync(userFile, 'utf8');
  const block = (name: string) =>
    text
      .split('[account]')
      .find((chunk) => new RegExp(`user\\s+= ${name}\\b`).test(chunk)) ?? '';

  assert.match(block('vencido'), /disabled\s+= 1/);
  assert.match(block('vencido2'), /disabled\s+= 1/);
  assert.ok(!/disabled/.test(block('aldia')), 'a paid line is left alone');
  // Disabled, not deleted: renewing must bring it back with its settings.
  assert.ok(block('vencido').includes('caid                          = 1802'));
});

test('sweeping twice does nothing the second time', async () => {
  const store = new ResellerStore(join(dir, 'r.json'));
  writes = 0;
  const again = await sweepExpired(backend, store, auth);
  assert.deepEqual(again.disabled, []);
  assert.equal(writes, 0, 'nothing to change, nothing written');
});

test('an account deleted behind the panel stops being tracked', async () => {
  writeFileSync(userFile, '# empty\n');
  const store = new ResellerStore(join(dir, 'r2.json'));
  const juan = store.create('juan', 'juanpw', 1);
  store.claim('fantasma', juan.id, '2020-01-01');

  const result = await sweepExpired(backend, store, auth);
  assert.deepEqual(result.disabled, []);
  assert.equal(store.owner('fantasma'), undefined, 'forgotten instead of retried forever');
});

test('renewing after the cut brings the line back', async () => {
  writeFileSync(
    userFile,
    `[account]
user                          = vuelve
pwd                           = p
group                         = 1
disabled                      = 1
`,
  );
  const store = new ResellerStore(join(dir, 'r3.json'));
  const juan = store.create('juan', 'juanpw', 5);
  store.claim('vuelve', juan.id, '2020-01-01');

  // What the renew endpoint does: extend the date and enable it again.
  const { findOne, resolveAccountStore, upsert } = await import('../src/account-store.js');
  const accounts = await resolveAccountStore(backend, auth);
  const text = await accounts.read();
  const account = findOne(accounts, text, 'vuelve')!;
  assert.equal(account.enabled, false);
  await accounts.write(upsert(accounts, text, { ...account, enabled: true }, false));
  store.setExpiry('vuelve', isoDate(addMonths(new Date(), 1)));

  assert.deepEqual(store.expired(), []);
  assert.ok(!readFileSync(userFile, 'utf8').includes('disabled'));
});
