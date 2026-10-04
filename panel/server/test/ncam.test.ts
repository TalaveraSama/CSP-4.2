import { strict as assert } from 'node:assert';
import test from 'node:test';
import { NCAM_FLAVOUR, OscamClient } from '../src/oscam/client.js';
import { MockOscamTransport } from '../src/oscam/mock.js';
import type { OscamTransport } from '../src/oscam/http.js';
import type { BackendAuth } from '../src/backend.js';
import type { StatusCommand } from '../src/csp/types.js';

/**
 * NCam is an OSCam fork with the same XML API: the panel only has to hit
 * /ncamapi.html, accept a <ncam> root element and know the ncam.* file names.
 */

const auth = { user: 'admin', password: 'x' };
const ncam = () => new OscamClient(new MockOscamTransport(NCAM_FLAVOUR), true, NCAM_FLAVOUR);

const ALL: StatusCommand[] = [
  { command: 'proxy-status' },
  { command: 'cws-connectors' },
  { command: 'proxy-users' },
  { command: 'error-log' },
  { command: 'ctrl-commands' },
];

test('ncam backend advertises its own name and config files', () => {
  const info = ncam().info;
  assert.equal(info.kind, 'ncam');
  assert.equal(info.configFormat, 'ini');
  assert.equal(info.labels.connectors, 'Readers');
  assert.ok(info.configFiles.includes('ncam.conf'));
  assert.ok(info.configFiles.includes('ncam.srvid2'));
  assert.ok(!info.configFiles.some((f) => f.startsWith('oscam.')));
});

test('parses a <ncam> document into the normalised snapshot', async () => {
  const snap = await ncam().snapshot(auth, ALL);
  assert.ok(snap.proxy, 'proxy status');
  assert.match(snap.proxy?.version ?? '', /1\.20/);
  assert.ok(snap.connectors.length > 0, 'readers');
  assert.ok((snap.users?.sessions.length ?? 0) > 0, 'sessions');
  assert.ok(snap.events.length > 0, 'log events');
  assert.ok(snap.commandGroups.length >= 3, 'command groups');
});

test('config editor round-trips ncam.user', async () => {
  const client = ncam();
  const file = await client.fetchConfig(auth, 'ncam.user');
  assert.equal(file.name, 'ncam.user');
  assert.ok(file.content.includes('[account]'));

  const saved = await client.saveConfig(auth, '[account]\nuser = nuevo\n', 'ncam.user');
  assert.equal(saved.ok, true);
  assert.match(saved.message ?? '', /NCam/);
  assert.equal((await client.fetchConfig(auth, 'ncam.user')).content.trim(), '[account]\nuser = nuevo');

  await assert.rejects(() => client.fetchConfig(auth, 'oscam.conf'), /Unknown config file/);
});

test('uses the /ncamapi.html endpoint', async () => {
  const seen: string[] = [];
  const spy: OscamTransport = {
    target: 'http://box:8888',
    async get(_auth: BackendAuth, path: string) {
      seen.push(path);
      return '<?xml version="1.0" encoding="UTF-8"?>\n<ncam version="1.20" revision="1" starttime="2026-10-04T00:00:00+0000" uptime="60" readonly="0">\n\t<status></status>\n</ncam>';
    },
    async post(_auth: BackendAuth, path: string) {
      seen.push(path);
      return '<ncam readonly="0"><file filename="ncam.conf" writable="1"><![CDATA[x]]></file></ncam>';
    },
  };
  const client = new OscamClient(spy, false, NCAM_FLAVOUR);
  const login = await client.login('admin', 'x');
  assert.deepEqual(login, { user: 'admin', admin: true, superUser: true });
  await client.saveConfig(auth, 'x', 'ncam.conf');
  assert.deepEqual(seen, ['/ncamapi.html', '/ncamapi.html']);
});

test('restart/shutdown commands are labelled NCam', async () => {
  const snap = await ncam().snapshot(auth, [{ command: 'ctrl-commands' }]);
  const server = snap.commandGroups.find((g) => g.name === 'Server');
  assert.ok(server, 'server group');
  assert.equal(server?.handler, 'ncamapi');
  assert.ok(server?.commands.some((c) => c.label === 'Restart NCam'));
  const result = await ncam().control(auth, 'restart', {});
  assert.equal(result.ok, true);
  assert.match(result.message ?? '', /NCam restart requested/);
});
