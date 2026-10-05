import assert from 'node:assert/strict';
import test from 'node:test';

import { findIniAccount, listIniAccounts, removeIniAccount, upsertIniAccount } from '../src/accounts.js';

// A realistic ncam.user: tuning the panel does not model must survive.
const NCAM_USER = `# clients
[account]
user                          = csp
pwd                           = proxypass
group                         = 1

[account]
user                          = cliente1
pwd                           = abc123
description                   = Juan
group                         = 1
caid                          = 1802
ident                         = 1802:000000
cacheex                       = 2
max_connections               = 2

[account]
user                          = moroso
pwd                           = x
group                         = 1
disabled                      = 1
`;

test('reads the accounts of an ncam.user', () => {
  const accounts = listIniAccounts(NCAM_USER);
  assert.deepEqual(accounts.map((a) => a.name), ['csp', 'cliente1', 'moroso']);
  assert.equal(accounts[1]!.displayName, 'Juan');
  assert.equal(accounts[1]!.maxConnections, 2);
  assert.equal(accounts[1]!.group, '1');
  assert.equal(accounts[1]!.enabled, true);
  assert.equal(accounts[2]!.enabled, false, 'disabled = 1');
});

test('editing an account keeps the keys the panel does not model', () => {
  const out = upsertIniAccount(NCAM_USER, { name: 'cliente1', password: 'nueva', group: '1', maxConnections: 4 }, { create: false });
  const block = /\[account\]\nuser\s+= cliente1[\s\S]*?(?=\n\[account\]|$)/.exec(out)![0];
  assert.match(block, /pwd\s+= nueva/);
  assert.match(block, /max_connections\s+= 4/);
  // untouched tuning
  assert.match(block, /caid\s+= 1802/);
  assert.match(block, /ident\s+= 1802:000000/);
  assert.match(block, /cacheex\s+= 2/);
  // the other accounts are intact
  assert.ok(out.includes('user                          = csp'));
  assert.equal(listIniAccounts(out).length, 3);
});

test('disabling and re-enabling toggles the disabled key', () => {
  const off = upsertIniAccount(NCAM_USER, { name: 'cliente1', password: 'abc123', enabled: false }, { create: false });
  assert.equal(findIniAccount(off, 'cliente1')?.enabled, false);
  assert.match(off, /user\s+= cliente1[\s\S]*?disabled\s+= 1/);

  const on = upsertIniAccount(off, { name: 'cliente1', password: 'abc123', enabled: true }, { create: false });
  assert.equal(findIniAccount(on, 'cliente1')?.enabled, true);
  const block = /\[account\]\nuser\s+= cliente1[\s\S]*?(?=\n\[account\]|$)/.exec(on)![0];
  assert.ok(!block.includes('disabled'), 'the key is removed, not set to 0');
});

test('creating appends a well formed block', () => {
  const out = upsertIniAccount(NCAM_USER, { name: 'cliente9', password: 'pw9', group: '1', expiry: '2026-12-31' }, { create: true });
  assert.deepEqual(listIniAccounts(out).map((a) => a.name), ['csp', 'cliente1', 'moroso', 'cliente9']);
  assert.match(out, /\[account\]\nuser\s+= cliente9\npwd\s+= pw9\ngroup\s+= 1\nexpdate\s+= 2026-12-31\n$/);
  assert.throws(() => upsertIniAccount(out, { name: 'cliente9', password: 'x' }, { create: true }), /already exists/);
});

test('removing takes the whole block and no neighbour', () => {
  const out = removeIniAccount(NCAM_USER, 'cliente1');
  assert.deepEqual(listIniAccounts(out).map((a) => a.name), ['csp', 'moroso']);
  assert.ok(out.includes('# clients'), 'the header comment stays');
  assert.ok(!out.includes('Juan'));
  assert.throws(() => removeIniAccount(out, 'cliente1'), /no account/);
});

test('a file with no accounts yet still accepts the first one', () => {
  const out = upsertIniAccount('# add your accounts here, or from the panel\n', { name: 'primero', password: 'pw' }, { create: true });
  assert.deepEqual(listIniAccounts(out).map((a) => a.name), ['primero']);
});
