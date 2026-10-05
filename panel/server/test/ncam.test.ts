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

test('reports the product name and a writable config despite the webif quirk', async () => {
  // Real NCam/OSCam always answer writable="0" for config files (the template
  // variable is filled before the flag is computed); httpreadonly is the real
  // permission, so the editor must stay enabled.
  const doc = (readonly: string) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<ncam version="Unofficial" revision="gitb988280" starttime="2026-10-05T02:41:01+0000" uptime="42" readonly="${readonly}">\n\t<file filename="ncam.user" writable="0"><![CDATA[[account]]]></file>\n</ncam>`;
  const transport = (readonly: string): OscamTransport => ({
    target: 'http://box:8888',
    async get() {
      return doc(readonly);
    },
    async post() {
      return doc(readonly);
    },
  });

  const rw = await new OscamClient(transport('0'), false, NCAM_FLAVOUR).fetchConfig(auth, 'ncam.user');
  assert.equal(rw.writable, true, 'editable when httpreadonly=0');

  const ro = await new OscamClient(transport('1'), false, NCAM_FLAVOUR).fetchConfig(auth, 'ncam.user');
  assert.equal(ro.writable, false, 'read-only when httpreadonly=1');
});

test('a softcam with no accounts yet still renders the dashboard', async () => {
  // part=userstats answers <error>Invalid client</error> until the first
  // account exists; that must not blank out the whole overview.
  const status =
    `<?xml version="1.0" encoding="UTF-8"?>\n<ncam version="Unofficial" revision="git1234567" starttime="2026-10-05T02:41:01+0000" uptime="42" readonly="0">\n\t<status>\n\t\t<client type="s" name="root" protocol="server" thid="id_0x1"><request/><times login="2026-10-05T02:41:01+0000" online="42" idle="42"/><connection ip="127.0.0.1" port="0">OK</connection></client>\n\t</status>\n</ncam>`;
  const failure =
    `<?xml version="1.0" encoding="UTF-8"?>\n<ncam version="Unofficial" revision="git1234567" uptime="42" readonly="0">\n\t<error>Invalid client</error>\n</ncam>`;

  const transport: OscamTransport = {
    target: 'http://box:8888',
    async get(_auth, _path, query) {
      return query.part === 'userstats' ? failure : status;
    },
    async post() {
      return status;
    },
  };

  const snap = await new OscamClient(transport, false, NCAM_FLAVOUR).snapshot(auth, [
    { command: 'proxy-status' },
    { command: 'proxy-users' },
  ]);
  assert.equal(snap.proxy?.name, 'NCam Unofficial');
  assert.deepEqual(snap.users?.sessions, []);
});

test('the proxy card shows the fork name, not OSCam', async () => {
  const snap = await ncam().snapshot(auth, [{ command: 'proxy-status' }]);
  assert.match(snap.proxy?.name ?? '', /^NCam/);
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
