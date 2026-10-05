import assert from 'node:assert/strict';
import test from 'node:test';

import { AccountError, findAccount, listAccounts, removeAccount, upsertAccount } from '../src/accounts.js';

const PROXY_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!-- keep this comment -->
<cardservproxy>
  <ca-profile name="cable" ca-id="0x0B00">
    <newcamd-listen-port port="10001" des-key="0102030405060708091011121314"/>
  </ca-profile>
  <user-manager class="com.bowman.cardserv.SimpleUserManager">
    <auth-config>
      <user name="admin" password="admin" profiles="cable sat" admin="true"/>
      <user name="cliente1" password="secreto" profiles="cable" max-connections="2"/>
    </auth-config>
  </user-manager>
  <status-web enabled="true" port="8082"/>
</cardservproxy>
`;

// The real file the installer writes: accounts in <user-manager>, and a
// <user> element inside the connector that is NOT an account.
const REAL_PROXY_XML = `<?xml version="1.0" encoding="UTF-8"?>
<cardserv-proxy ver="1.0">
  <user-manager class="com.bowman.cardserv.SimpleUserManager" log-failures="true">
    <auth-config>
      <user name="admin" password="S3cret" admin="true"/>
    </auth-config>
  </user-manager>
  <connection-manager>
    <cws-connectors>
      <newcamd-connector name="ncam" profile="ncam">
        <host>127.0.0.1</host>
        <port>10000</port>
        <user>csp</user>
        <password>proxypass</password>
      </newcamd-connector>
    </cws-connectors>
  </connection-manager>
</cardserv-proxy>
`;

test('<user-manager> is not an account, and neither are connector credentials', () => {
  // <user\\b also matches <user-manager (a hyphen is a word boundary), and the
  // connector has its own <user>csp</user>. Only real accounts must show up.
  assert.deepEqual(
    listAccounts(REAL_PROXY_XML).map((a) => a.name),
    ['admin'],
  );
});

test('new accounts land in <user-manager>, never inside a connector', () => {
  const xml = upsertAccount(REAL_PROXY_XML, { name: 'cliente1', password: 'pw1' }, { create: true });
  const manager = /<user-manager[\s\S]*?<\/user-manager>/.exec(xml)![0];
  assert.ok(manager.includes('name="cliente1"'), 'the account goes inside user-manager');
  assert.ok(xml.includes('<user>csp</user>'), 'the connector credentials are untouched');
  assert.deepEqual(
    listAccounts(xml).map((a) => a.name),
    ['admin', 'cliente1'],
  );
  const connector = /<newcamd-connector[\s\S]*?<\/newcamd-connector>/.exec(xml)![0];
  assert.ok(!connector.includes('cliente1'));
});

test('reads the accounts out of proxy.xml', () => {
  const accounts = listAccounts(PROXY_XML);
  assert.deepEqual(
    accounts.map((a) => a.name),
    ['admin', 'cliente1'],
  );
  assert.equal(accounts[0]!.admin, true);
  assert.equal(accounts[1]!.maxConnections, 2);
  assert.equal(accounts[1]!.profiles, 'cable');
  // Absent attributes stay absent instead of being invented.
  assert.equal(accounts[1]!.admin, undefined);
});

test('creating an account only adds one line', () => {
  const xml = upsertAccount(PROXY_XML, { name: 'cliente2', password: 'otra', profiles: 'sat' }, { create: true });
  assert.equal(listAccounts(xml).length, 3);
  assert.ok(xml.includes('<user name="cliente2" password="otra" profiles="sat"/>'));

  const before = PROXY_XML.split('\n');
  const after = xml.split('\n');
  assert.equal(after.length, before.length + 1);
  // Everything else, comments included, is untouched.
  assert.deepEqual(
    after.filter((l) => !l.includes('cliente2')),
    before,
  );
});

test('editing an account keeps its position and the rest of the file', () => {
  const xml = upsertAccount(
    PROXY_XML,
    { name: 'cliente1', password: 'nueva', profiles: 'cable sat', maxConnections: 4, enabled: true },
    { create: false },
  );
  const lines = xml.split('\n');
  assert.equal(lines.length, PROXY_XML.split('\n').length);
  assert.match(lines[9]!, /name="cliente1" password="nueva" profiles="cable sat" max-connections="4" enabled="true"/);
  assert.ok(xml.includes('<!-- keep this comment -->'));
  assert.ok(xml.includes('name="admin"'));
});

test('an empty user-manager still accepts the first account', () => {
  const empty = PROXY_XML.replace(/ {6}<user[\s\S]*?cliente1[^\n]*\n/g, '').replace(/ {6}<user[^\n]*\n/g, '');
  assert.equal(listAccounts(empty).length, 0);
  const xml = upsertAccount(empty, { name: 'primero', password: 'pw' }, { create: true });
  assert.deepEqual(
    listAccounts(xml).map((a) => a.name),
    ['primero'],
  );
  assert.ok(/<user name="primero"[^>]*\/>\n\s*<\/user-manager>/.test(xml));
});

test('refuses nonsense instead of writing a broken proxy.xml', () => {
  assert.throws(() => upsertAccount(PROXY_XML, { name: 'admin', password: 'x' }, { create: true }), /already exists/);
  assert.throws(() => upsertAccount(PROXY_XML, { name: 'nadie', password: 'x' }, { create: false }), /no account/);
  assert.throws(() => upsertAccount(PROXY_XML, { name: 'a b', password: 'x' }, { create: true }), /may only contain/);
  assert.throws(() => upsertAccount(PROXY_XML, { name: 'ok', password: '' }, { create: true }), /needs a password/);
  assert.throws(
    () => upsertAccount(PROXY_XML, { name: 'ok', password: 'x', maxConnections: -1 }, { create: true }),
    /positive whole number/,
  );
  const err = (() => {
    try {
      upsertAccount('<cardservproxy/>', { name: 'ok', password: 'x' }, { create: true });
    } catch (e) {
      return e as AccountError;
    }
    return undefined;
  })();
  assert.match(err?.message ?? '', /no <user-manager> section/);
});

test('escapes values so a password cannot break the document', () => {
  const xml = upsertAccount(PROXY_XML, { name: 'raro', password: 'a"b&c<d' }, { create: true });
  assert.ok(xml.includes('password="a&quot;b&amp;c&lt;d"'));
  assert.equal(findAccount(xml, 'raro')?.password, 'a"b&c<d');
});

test('removing an account leaves no blank line behind', () => {
  const xml = removeAccount(PROXY_XML, 'cliente1');
  assert.deepEqual(
    listAccounts(xml).map((a) => a.name),
    ['admin'],
  );
  assert.equal(xml.split('\n').length, PROXY_XML.split('\n').length - 1);
  assert.throws(() => removeAccount(xml, 'cliente1'), /no account/);
});
