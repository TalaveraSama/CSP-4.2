import { strict as assert } from 'node:assert';
import test from 'node:test';
import { buildControlRequest, buildStatusRequest, parseLoginResponse, parseStatusResponse } from '../src/csp/xml.js';
import { MockCspClient } from '../src/csp/mock.js';

const auth = { user: 'admin', password: 'x' };

test('builds a multi-command status request', () => {
  const xml = buildStatusRequest([{ command: 'proxy-status' }, { command: 'cws-connectors', params: { profile: 'sat' } }], 'abc123');
  assert.match(xml, /<cws-status-req ver="1\.0">/);
  assert.match(xml, /<session session-id="abc123"\/>/);
  assert.match(xml, /<cws-connectors include="true" profile="sat"\/>/);
});

test('builds a control request and drops empty params', () => {
  const xml = buildControlRequest('kick-user', { name: 'oscar', profile: undefined }, 's1');
  assert.match(xml, /<command command="kick-user" name="oscar"\/>/);
  assert.doesNotMatch(xml, /profile=/);
});

test('parses login responses', () => {
  const ok = parseLoginResponse('<cws-status-resp ver="1.0"><status state="loggedIn" user="u" admin="true" super-user="false" session-id="z"/></cws-status-resp>');
  assert.equal(ok.ok, true);
  assert.equal(ok.admin, true);
  assert.equal(ok.superUser, false);
  assert.equal(parseLoginResponse('<cws-status-resp><status state="failed"/></cws-status-resp>').ok, false);
});

test('parses a full status response from the mock node', async () => {
  const csp = new MockCspClient();
  const xml = await csp.status(auth, [
    { command: 'proxy-status' },
    { command: 'cache-status' },
    { command: 'ca-profiles' },
    { command: 'cws-connectors' },
    { command: 'proxy-users' },
    { command: 'error-log' },
    { command: 'user-warning-log' },
    { command: 'watched-services' },
    { command: 'ctrl-commands' },
    { command: 'last-seen' },
    { command: 'login-failures' },
    { command: 'proxy-plugins' },
  ]);
  const snap = parseStatusResponse(xml);

  assert.equal(snap.proxy?.name, 'csp-managua');
  assert.ok(snap.proxy!.jvm);
  assert.equal(snap.profiles.length, 2);
  assert.equal(snap.profiles[0]!.listenPorts[0]!.protocol, 'Newcamd');
  assert.equal(snap.connectors.length, 5);
  assert.ok(snap.connectors.some((c) => !c.connectedNow), 'expected a disconnected connector');
  assert.ok(snap.connectors[0]!.services.length > 0);
  assert.ok(snap.users!.sessions.length > 0);
  assert.equal(typeof snap.users!.sessions[0]!.ecmCount, 'number');
  assert.ok(snap.events.length > 0);
  assert.ok(snap.warnings.length > 0);
  assert.ok(snap.services.length > 0);
  assert.equal(snap.seen.length > 0, true);
  assert.equal(snap.failures.length > 0, true);
  assert.equal(snap.plugins.length, 2);
  assert.deepEqual(
    snap.commandGroups.map((g) => g.name),
    ['Connectors', 'Users', 'Internal'],
  );
  assert.ok(snap.optionLists['@connectors']!.includes('peer-leon'));
});

test('single element sections are normalised to arrays', () => {
  const snap = parseStatusResponse(
    '<cws-status-resp><ca-profiles><profile name="only" ca-id="0x1"><listen-port protocol="Newcamd" port="1"/></profile></ca-profiles></cws-status-resp>',
  );
  assert.equal(snap.profiles.length, 1);
  assert.equal(snap.profiles[0]!.listenPorts.length, 1);
});

test('control commands round-trip through the mock', async () => {
  const csp = new MockCspClient();
  const res = await csp.control(auth, 'disable-connector', { name: 'peer-leon' });
  assert.equal(res.ok, true);
  const xml = await csp.status(auth, [{ command: 'cws-connectors' }]);
  const conn = parseStatusResponse(xml).connectors.find((c) => c.name === 'peer-leon');
  assert.equal(conn?.connectedNow, false);
});
