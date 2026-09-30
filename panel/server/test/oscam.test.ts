import { strict as assert } from 'node:assert';
import test from 'node:test';
import { OscamClient } from '../src/oscam/client.js';
import { MockOscamTransport } from '../src/oscam/mock.js';
import type { StatusCommand } from '../src/csp/types.js';

const auth = { user: 'admin', password: 'x' };
const client = () => new OscamClient(new MockOscamTransport(), true);

const ALL: StatusCommand[] = [
  { command: 'proxy-status' },
  { command: 'ca-profiles' },
  { command: 'cws-connectors' },
  { command: 'proxy-users' },
  { command: 'watched-services' },
  { command: 'error-log' },
  { command: 'user-warning-log' },
  { command: 'last-seen' },
  { command: 'login-failures' },
  { command: 'ctrl-commands' },
];

test('backend advertises oscam wording and ini config', () => {
  const info = client().info;
  assert.equal(info.kind, 'oscam');
  assert.equal(info.configFormat, 'ini');
  assert.equal(info.labels.connectors, 'Readers');
  assert.ok(info.configFiles.includes('oscam.conf'));
});

test('login reports admin when the webif is not readonly', async () => {
  const identity = await client().login('admin', 'secret');
  assert.equal(identity?.admin, true);
  assert.equal(identity?.user, 'admin');
});

test('maps the oscam status api onto the panel model', async () => {
  const snap = await client().snapshot(auth, ALL);

  assert.match(snap.proxy!.name, /^OSCam/);
  assert.equal(snap.proxy!.build, '11719');
  assert.ok(snap.proxy!.ecmCount > 0);
  assert.ok(snap.proxy!.ecmCacheHits > 0);
  assert.equal(snap.proxy!.connectors, 5);

  // readers + proxies become connectors, one of them is down
  const names = snap.connectors.map((c) => c.name);
  assert.ok(names.includes('sky-v14'));
  assert.ok(names.includes('peer-managua'));
  assert.equal(snap.connectors.find((c) => c.name === 'peer-granada')?.connectedNow, false);
  assert.equal(snap.connectors.find((c) => c.name === 'sky-v14')?.connectedNow, true);

  // clients become sessions, enriched with userstats counters
  const oscar = snap.users!.sessions.find((s) => s.user === 'oscar');
  assert.ok(oscar);
  assert.equal(oscar!.host, '192.168.1.44');
  assert.ok(oscar!.ecmCount > 5000);
  assert.equal(oscar!.service?.name, 'Canal 2 HD');
  assert.equal(oscar!.service?.id, 0x1001);
  assert.equal(snap.users!.sessions.find((s) => s.user === 'taller')?.active, false);

  // caids act as profiles
  assert.deepEqual(snap.profiles.map((p) => p.name).sort(), ['0963', '0B00', '1810']);

  // watched services, log and failban
  assert.ok(snap.services.length >= 3);
  assert.ok(snap.events.length > 0);
  assert.ok(snap.warnings.every((w) => w.logLevel === 'SEVERE'));
  assert.ok(snap.failures.some((f) => f.name === 'pirata'));
  assert.ok(snap.seen.some((s) => s.name === 'granada'));

  // synthesised control commands
  assert.deepEqual(snap.commandGroups.map((g) => g.name), ['Readers', 'Users', 'Server']);
  assert.ok(snap.optionLists['@readers']!.includes('peer-leon'));
  assert.ok(snap.optionLists['@users']!.includes('maria'));
});

test('hide-inactive filters idle sessions', async () => {
  const snap = await client().snapshot(auth, [{ command: 'proxy-users', params: { 'hide-inactive': 'true' } }]);
  assert.ok(snap.users!.sessions.length > 0);
  assert.ok(snap.users!.sessions.every((s) => s.active));
});

test('disabling and restarting a reader round-trips', async () => {
  const csp = client();
  assert.equal((await csp.control(auth, 'disable-connector', { label: 'peer-leon' })).ok, true);
  let snap = await csp.snapshot(auth, [{ command: 'cws-connectors' }]);
  assert.equal(snap.connectors.find((c) => c.name === 'peer-leon')?.connectedNow, false);

  assert.equal((await csp.control(auth, 'enable-connector', { label: 'peer-leon' })).ok, true);
  snap = await csp.snapshot(auth, [{ command: 'cws-connectors' }]);
  assert.equal(snap.connectors.find((c) => c.name === 'peer-leon')?.connectedNow, true);
});

test('kick-user resolves thread ids and removes the session', async () => {
  const csp = client();
  const res = await csp.control(auth, 'kick-user', { name: 'maria' });
  assert.equal(res.ok, true);
  assert.match(res.message, /1 session/);
  const snap = await csp.snapshot(auth, [{ command: 'proxy-users' }]);
  assert.equal(snap.users!.sessions.some((s) => s.user === 'maria'), false);
  assert.equal((await csp.control(auth, 'kick-user', { name: 'nobody' })).ok, false);
});

test('reads and writes oscam config files', async () => {
  const csp = client();
  const conf = await csp.fetchConfig(auth, 'oscam.conf');
  assert.equal(conf.name, 'oscam.conf');
  assert.equal(conf.writable, true);
  assert.match(conf.content, /\[webif\]/);

  const updated = conf.content.replace('httprefresh                   = 5', 'httprefresh                   = 9');
  assert.equal((await csp.saveConfig(auth, updated, 'oscam.conf')).ok, true);
  assert.match((await csp.fetchConfig(auth, 'oscam.conf')).content, /httprefresh\s+= 9/);

  await assert.rejects(() => csp.fetchConfig(auth, 'passwd'), /Unknown config file/);
});

test('unsupported commands fail loudly instead of pretending', async () => {
  const res = await client().control(auth, 'osd-message', { name: 'oscar', text: 'hola' });
  assert.equal(res.ok, false);
  assert.match(res.message, /not supported/);
});
