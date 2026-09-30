import type { BackendAuth } from '../backend.js';
import type { OscamTransport } from './http.js';
import { OSCAM_CONFIG_FILES } from './client.js';

/**
 * Synthetic OSCam node.
 *
 * Emits exactly the documents `/oscamapi.html` produces (api.xml templates), so
 * the OSCam mapper and the whole panel can be exercised without a receiver.
 */

const START = Date.now() - 2 * 86_400_000 - 5 * 3600_000;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function rnd(seed: number): number {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

interface MockClient {
  type: 'c' | 'r' | 'p' | 's';
  name: string;
  desc: string;
  protocol: string;
  au: string;
  caid: string;
  provid: string;
  srvid: string;
  channel: string;
  ip: string;
  port: string;
  state: string;
  onlineBase: number;
  idle: number;
  thid: string;
}

const CLIENTS: MockClient[] = [
  { type: 's', name: 'root', desc: 'server', protocol: 'server', au: '0', caid: '0000', provid: '000000', srvid: '0000', channel: '', ip: '0.0.0.0', port: '0', state: 'OK', onlineBase: 0, idle: 0, thid: '0x0001' },
  { type: 'r', name: 'sky-v14', desc: 'local smartcard', protocol: 'internal', au: 'ON', caid: '0963', provid: '000000', srvid: '1001', channel: 'Canal 2 HD', ip: '127.0.0.1', port: '0', state: 'CARDOK', onlineBase: 0, idle: 3, thid: '0x0011' },
  { type: 'r', name: 'conax-slot2', desc: 'phoenix reader', protocol: 'internal', au: 'ON', caid: '0B00', provid: '000000', srvid: '1004', channel: 'Telenica 8', ip: '127.0.0.1', port: '0', state: 'CARDOK', onlineBase: 0, idle: 17, thid: '0x0012' },
  { type: 'p', name: 'peer-managua', desc: 'cccam proxy', protocol: 'cccam', au: '0', caid: '1810', provid: '008011', srvid: '2001', channel: 'Discovery HD', ip: '10.8.0.2', port: '12000', state: 'CONNECTED', onlineBase: 0, idle: 1, thid: '0x0021' },
  { type: 'p', name: 'peer-leon', desc: 'newcamd proxy', protocol: 'newcamd', au: '0', caid: '1810', provid: '008011', srvid: '2003', channel: 'HBO Latin', ip: '10.8.0.3', port: '12001', state: 'CONNECTED', onlineBase: 0, idle: 6, thid: '0x0022' },
  { type: 'p', name: 'peer-granada', desc: 'cccam proxy', protocol: 'cccam', au: '0', caid: '1810', provid: '008011', srvid: '0000', channel: '', ip: '10.8.0.4', port: '12002', state: 'OFF', onlineBase: -1, idle: 0, thid: '0x0023' },
  { type: 'c', name: 'oscar', desc: 'sala', protocol: 'newcamd', au: 'sky-v14', caid: '0963', provid: '000000', srvid: '1001', channel: 'Canal 2 HD', ip: '192.168.1.44', port: '10001', state: 'CONNECTED', onlineBase: 7_200, idle: 4, thid: '0x0101' },
  { type: 'c', name: 'maria', desc: 'cuarto', protocol: 'cccam', au: '0', caid: '1810', provid: '008011', srvid: '2001', channel: 'Discovery HD', ip: '10.8.0.7', port: '12000', state: 'CONNECTED', onlineBase: 5_400, idle: 9, thid: '0x0102' },
  { type: 'c', name: 'luis', desc: 'dvbapi', protocol: 'dvbapi', au: '0', caid: '1810', provid: '008011', srvid: '2003', channel: 'HBO Latin', ip: '127.0.0.1', port: '0', state: 'CONNECTED', onlineBase: 12_600, idle: 2, thid: '0x0103' },
  { type: 'c', name: 'bodega', desc: 'tienda', protocol: 'newcamd', au: '0', caid: '0B00', provid: '000000', srvid: '1004', channel: 'Telenica 8', ip: '10.8.0.21', port: '10001', state: 'CONNECTED', onlineBase: 900, idle: 41, thid: '0x0104' },
  { type: 'c', name: 'taller', desc: 'taller', protocol: 'newcamd', au: '0', caid: '0963', provid: '000000', srvid: '0000', channel: '', ip: '192.168.1.99', port: '10001', state: 'Sleep', onlineBase: 18_000, idle: 940, thid: '0x0105' },
];

const USERS = [
  { name: 'oscar', status: 'online', ip: '192.168.1.44', protocol: 'newcamd', cwok: 5_412, cwnok: 31, cwcache: 2_190, emmok: 84 },
  { name: 'maria', status: 'online', ip: '10.8.0.7', protocol: 'cccam', cwok: 3_180, cwnok: 12, cwcache: 1_004, emmok: 12 },
  { name: 'luis', status: 'online', ip: '127.0.0.1', protocol: 'dvbapi', cwok: 9_233, cwnok: 54, cwcache: 4_120, emmok: 310 },
  { name: 'bodega', status: 'online', ip: '10.8.0.21', protocol: 'newcamd', cwok: 1_002, cwnok: 3, cwcache: 410, emmok: 4 },
  { name: 'taller', status: 'connected', ip: '192.168.1.99', protocol: 'newcamd', cwok: 640, cwnok: 9, cwcache: 210, emmok: 0 },
  { name: 'granada', status: 'offline', ip: '10.8.0.30', protocol: 'cccam', cwok: 120, cwnok: 44, cwcache: 30, emmok: 0 },
  { name: 'viejo', status: 'disabled', ip: '0.0.0.0', protocol: 'newcamd', cwok: 0, cwnok: 0, cwcache: 0, emmok: 0 },
];

const LOG_LINES = [
  'c   (client) oscar: connected (newcamd, ip 192.168.1.44)',
  'r   (reader) sky-v14: card detected, caid 0963, serial 00A1B2C3',
  'p   (cccam) peer-managua: connected, 214 cards available',
  'c   (ecm) luis: found (32 ms) by sky-v14 - Canal 2 HD',
  'p   (cccam) peer-granada: connection lost, retrying in 30 s',
  'c   (ecm) bodega: timeout after 3000 ms on Telenica 8',
  'r   (emm) conax-slot2: emm written (4 ok, 0 skipped)',
  'w   (anticasc) maria: too many connections, request rejected',
  'c   (ecm) oscar: not found (no matching reader) for caid 1810',
  's   (main) loadbalancer statistics saved',
];

export class MockOscamTransport implements OscamTransport {
  readonly target = 'mock://oscam';
  private files = new Map<string, string>();
  private disabledReaders = new Set<string>(['peer-granada']);
  private disabledUsers = new Set<string>(['viejo']);
  private killed = new Set<string>();

  constructor() {
    this.files.set(
      'oscam.conf',
      `[global]
logfile                       = /tmp/oscam.log
nice                          = -1
maxlogsize                    = 100
preferlocalcards              = 1
saveinithistory               = 1

[newcamd]
port                          = 10001@0963:000000
key                           = 0102030405060708091011121314
keepalive                     = 1

[cccam]
port                          = 12000
reshare                       = 1
version                       = 2.3.0

[dvbapi]
enabled                       = 1
au                            = 1
pmt_mode                      = 0
user                          = luis

[webif]
httpport                      = 8888
httpuser                      = admin
httppwd                       = secret
httprefresh                   = 5
httpallowed                   = 127.0.0.1,192.168.1.0-192.168.1.255
`,
    );
    this.files.set(
      'oscam.user',
      `[account]
user                          = oscar
pwd                           = 1234
group                         = 1
au                            = sky-v14

[account]
user                          = maria
pwd                           = 1234
group                         = 1,2

[account]
user                          = viejo
pwd                           = 1234
group                         = 1
disabled                      = 1
`,
    );
    this.files.set(
      'oscam.server',
      `[reader]
label                         = sky-v14
protocol                      = internal
device                        = /dev/sci0
caid                          = 0963
group                         = 1

[reader]
label                         = peer-managua
protocol                      = cccam
device                        = 10.8.0.2,12000
user                          = proxy
password                      = secret
group                         = 2
`,
    );
    for (const f of OSCAM_CONFIG_FILES) if (!this.files.has(f)) this.files.set(f, `# ${f} (empty)\n`);
  }

  private header(): string {
    const uptime = Math.floor((Date.now() - START) / 1000);
    return `<?xml version="1.0" encoding="UTF-8"?>\n<oscam version="1.20_svn" revision="11719" starttime="${stamp(
      new Date(START),
    )}" uptime="${uptime}" readonly="0">`;
  }

  private statusXml(appendLog: boolean): string {
    const now = Date.now();
    const bits = CLIENTS.filter((c) => !this.killed.has(c.thid))
      .filter((c) => !(this.disabledReaders.has(c.name) && c.type === 'p' && false))
      .map((c) => {
        const down = this.disabledReaders.has(c.name) || c.onlineBase < 0;
        const online = down ? 0 : c.onlineBase > 0 ? c.onlineBase + Math.floor((now - START) / 1000) % 600 : Math.floor((now - START) / 1000);
        const idle = down ? 0 : Math.max(0, Math.round(c.idle + rnd(now / 5000 + c.name.length) * 6));
        const ecmtime = c.type === 's' ? 0 : Math.round(40 + rnd(now / 3000 + c.name.length) * 260);
        const state = down ? 'OFF' : c.state;
        return `      <client type="${c.type}" name="${esc(c.name)}" desc="${esc(c.desc)}" protocol="${c.protocol}" protocolext="" au="${
          c.au
        }" thid="${c.thid}">
         <request caid="${c.caid}" provid="${c.provid}" srvid="${down ? '0000' : c.srvid}" ecmtime="${ecmtime}" ecmhistory="" answered="${
           c.type === 'c' ? 'sky-v14' : ''
         }">${esc(down ? '' : c.channel)}</request>
         <times login="${stamp(new Date(now - online * 1000))}" online="${online}" idle="${idle}"></times>
         <connection ip="${c.ip}" port="${c.port}">${state}</connection>
      </client>`;
      })
      .join('\n');

    const log = appendLog
      ? `\n\t<log><![CDATA[\n${LOG_LINES.map(
          (l, i) => `${stamp(new Date(now - (LOG_LINES.length - i) * 137_000))} ${(0x1a2b0000 + i).toString(16)} ${l}`,
        ).join('\n')}\n\t]]></log>`
      : '';

    return `${this.header()}\n\t<status>\n${bits}\n\t</status>${log}\n</oscam>`;
  }

  private userStatsXml(): string {
    const rows = USERS.map((u) => {
      const disabled = this.disabledUsers.has(u.name);
      return `        <user name="${esc(u.name)}" status="${disabled ? 'disabled' : u.status}" ip="${u.ip}" protocol="${u.protocol}">
            <stats>
                <cwok>${u.cwok}</cwok>
                <cwnok>${u.cwnok}</cwnok>
                <cwignore>0</cwignore>
                <cwtimeout>${Math.round(u.cwnok / 3)}</cwtimeout>
                <cwcache>${u.cwcache}</cwcache>
                <cwtun>0</cwtun>
                <cwlastresptime>${60 + (u.cwok % 120)}</cwlastresptime>
                <emmok>${u.emmok}</emmok>
                <emmnok>0</emmnok>
                <cwrate>${(u.cwok / 3600).toFixed(2)}</cwrate>
                <timeonchannel>00:02:14</timeonchannel>
                <expectsleep>-</expectsleep>
            </stats>
        </user>`;
    }).join('\n');

    const sum = (key: 'cwok' | 'cwnok' | 'cwcache' | 'emmok') => USERS.reduce((a, u) => a + u[key], 0);
    return `${this.header()}
    <users>
${rows}
    </users>
    <totals>
        <cwok>${sum('cwok')}</cwok>
        <cwnok>${sum('cwnok')}</cwnok>
        <cwignore>12</cwignore>
        <cwtimeout>${Math.round(sum('cwnok') / 3)}</cwtimeout>
        <cwcache>${sum('cwcache')}</cwcache>
        <cwtun>4</cwtun>
        <usertotal>${USERS.length}</usertotal>
        <userdisabled>${this.disabledUsers.size}</userdisabled>
        <userexpired>0</userexpired>
        <useractive>${USERS.length - this.disabledUsers.size}</useractive>
        <userconnected>5</userconnected>
        <useronline>4</useronline>
    </totals>
</oscam>`;
  }

  private failbanXml(): string {
    const now = Date.now();
    const rows = [
      { ip: '45.12.9.3', user: 'pirata', count: 7 },
      { ip: '188.43.2.10', user: '', count: 3 },
    ]
      .map(
        (e, i) =>
          `\t\t<ip ipinteger="${i + 1}" user="${e.user}" count="${e.count}" date="${stamp(
            new Date(now - (i + 1) * 900_000),
          )}" secondsleft="${600 - i * 120}">${e.ip}</ip>`,
      )
      .join('\n');
    return `${this.header()}\n\t<failban>\n${rows}\n\t</failban>\n</oscam>`;
  }

  private readerListXml(): string {
    const rows = CLIENTS.filter((c) => c.type === 'r' || c.type === 'p')
      .map(
        (c) =>
          `\t\t<reader label="${esc(c.name)}" protocol="${c.protocol}" type="${c.type === 'p' ? 'proxy' : 'reader'}" enabled="${
            this.disabledReaders.has(c.name) ? '0' : '1'
          }"></reader>`,
      )
      .join('\n');
    return `${this.header()}\n\t<readers>\n${rows}\n\t</readers>\n</oscam>`;
  }

  private fileXml(name: string): string {
    const content = this.files.get(name) ?? '';
    return `${this.header()}\n\t<file filename="${esc(name)}" writable="1">\n\t<![CDATA[${content}]]>\n\t</file>\n</oscam>`;
  }

  private error(message: string): string {
    return `${this.header()}\n\t\t<error>${esc(message)}</error>\n</oscam>`;
  }

  private handle(query: Record<string, string | undefined>): string {
    const part = query.part ?? '';
    const action = (query.action ?? '').toLowerCase();

    if (part === 'status') {
      if (action === 'kill' && query.threadid) this.killed.add(query.threadid);
      if (action === 'restart' && query.label) this.disabledReaders.delete(query.label);
      return this.statusXml(query.appendlog === '1');
    }
    if (part === 'userstats') {
      if (action === 'disable' && query.user) this.disabledUsers.add(query.user);
      if (action === 'enable' && query.user) this.disabledUsers.delete(query.user);
      return this.userStatsXml();
    }
    if (part === 'readerlist') {
      if (action === 'disable' && query.label) this.disabledReaders.add(query.label);
      if (action === 'enable' && query.label) this.disabledReaders.delete(query.label);
      return this.readerListXml();
    }
    if (part === 'failban') return this.failbanXml();
    if (part === 'files') {
      const file = query.file ?? 'oscam.conf';
      if (!this.files.has(file)) return this.error(`file ${file} not found`);
      if (action === 'save' && query.filecontent !== undefined) this.files.set(file, query.filecontent);
      return this.fileXml(file);
    }
    if (part === 'shutdown') return `${this.header()}\n\t<confirmation>${action} ignored in mock mode</confirmation>\n</oscam>`;
    return this.error('part not found');
  }

  async get(_auth: BackendAuth, _path: string, query: Record<string, string | undefined>): Promise<string> {
    return this.handle(query);
  }

  async post(_auth: BackendAuth, _path: string, form: Record<string, string | undefined>): Promise<string> {
    return this.handle(form);
  }
}
