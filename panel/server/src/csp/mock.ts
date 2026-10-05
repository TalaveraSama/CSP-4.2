import type { BackendAuth, BackendInfo, ConfigFile, LoginResult, ProxyBackend } from '../backend.js';
import { cspInfo } from './client.js';
import { parseStatusResponse } from './xml.js';
import type { StatusCommand, StatusSnapshot } from './types.js';

/**
 * A self-contained fake CSP node.
 *
 * It speaks the exact same XML dialect as the Java proxy, so the panel and the
 * parser are exercised for real — only the data is synthetic. Enabled with
 * CSP_MOCK=1 (the default when no CSP_URL is configured), which makes the panel
 * runnable with zero Java anywhere in the stack.
 */

const START = Date.now() - 3 * 24 * 3600_000 - 4 * 3600_000;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function duration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return d > 0 ? `${d}d ${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

function rnd(seed: number): number {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

interface MockService {
  id: number;
  name: string;
  profile: string;
}

const SERVICES: MockService[] = [
  { id: 4097, name: 'Canal 2 HD', profile: 'cable' },
  { id: 4098, name: 'Canal 4', profile: 'cable' },
  { id: 4099, name: 'Telenica 8', profile: 'cable' },
  { id: 4101, name: 'Vos TV', profile: 'cable' },
  { id: 8201, name: 'Discovery HD', profile: 'sat' },
  { id: 8202, name: 'ESPN Deportes', profile: 'sat' },
  { id: 8203, name: 'HBO Latin', profile: 'sat' },
  { id: 8204, name: 'Nat Geo HD', profile: 'sat' },
  { id: 8205, name: 'TNT Series', profile: 'sat' },
];

const USERS = [
  { name: 'admin', host: '192.168.1.10', client: 'mgcamd 1.38', profile: 'cable' },
  { name: 'oscar', host: '192.168.1.44', client: 'mgcamd 1.38', profile: 'cable' },
  { name: 'maria', host: '10.8.0.7', client: 'acamd 3.90', profile: 'sat' },
  { name: 'luis', host: '186.77.20.3', client: 'oscam 11719', profile: 'sat' },
  { name: 'bodega', host: '10.8.0.21', client: 'mgcamd 1.35', profile: 'sat' },
  { name: 'taller', host: '192.168.1.99', client: 'newcs 1.67', profile: 'cable' },
];

const CONNECTORS = [
  { name: 'card-local', profile: 'cable', protocol: 'Newcamd', host: '127.0.0.1:10000', metric: 1 },
  { name: 'peer-managua', profile: 'cable', protocol: 'Newcamd', host: '10.8.0.2:12000', metric: 1 },
  { name: 'peer-leon', profile: 'sat', protocol: 'CCcam', host: '10.8.0.3:12001', metric: 2 },
  { name: 'peer-granada', profile: 'sat', protocol: 'CCcam', host: '10.8.0.4:12002', metric: 3 },
  { name: 'backup-cs378x', profile: 'sat', protocol: 'Csp', host: '10.8.0.9:8888', metric: 5 },
];

const EVENT_TEMPLATES = [
  { type: 'connect', label: 'Connected', msg: 'Connector %s established session with remote card' },
  { type: 'disconnect', label: 'Disconnected', msg: 'Connector %s lost connection (read timeout)' },
  { type: 'timeout', label: 'Timeout', msg: 'ECM transaction timed out on %s after 5000 ms' },
  { type: 'cache', label: 'Cache', msg: 'Cache peer %s resynchronized' },
  { type: 'lostservice', label: 'Lost service', msg: 'Connector %s can no longer decode service 8203' },
];

const MOCK_CONFIG = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Mock proxy.xml served by the CSP panel mock backend -->
<cardservproxy>
  <ca-profile name="cable" ca-id="0x0B00" network-id="0x0001" max-cw-wait="7000" debug="false">
    <newcamd-listen-port port="10001" des-key="0102030405060708091011121314"/>
  </ca-profile>
  <ca-profile name="sat" ca-id="0x1810" network-id="0x0085" max-cw-wait="9000" debug="true">
    <newcamd-listen-port port="10002" des-key="0102030405060708091011121314"/>
    <cccam-listen-port port="12000"/>
  </ca-profile>
  <cws-connector name="card-local" profile="cable" host="127.0.0.1" port="10000" user="proxy" password="secret"/>
  <cws-connector name="peer-managua" profile="cable" host="10.8.0.2" port="12000" user="proxy" password="secret"/>
  <cws-connector name="peer-leon" profile="sat" protocol="cccam" host="10.8.0.3" port="12001" user="proxy" password="secret"/>
  <user-manager class="com.bowman.cardserv.SimpleUserManager">
    <!-- Accounts: the panel edits these elements in place. -->
    <auth-config>
      <user name="admin" password="admin" profiles="cable sat" admin="true"/>
      <user name="cliente1" password="secreto" profiles="cable" max-connections="2"/>
      <user name="cliente2" password="secreto2" profiles="sat" ip-mask="10.8.0.*"/>
      <user name="moroso" password="x" enabled="false"/>
    </auth-config>
  </user-manager>
  <status-web enabled="true" port="8082"/>
</cardservproxy>
`;

export class MockCspClient implements ProxyBackend {
  readonly info: BackendInfo = cspInfo('mock://csp-4.2', true);

  private counters = { ecm: 184_233, emm: 9_812, hits: 96_144, denied: 412, failures: 87, filtered: 1_205 };
  private lastTick = Date.now();
  private events: { ts: number; type: string; label: string; msg: string }[] = [];
  private disabled = new Set<string>();
  private config = MOCK_CONFIG;

  constructor() {
    for (let i = 12; i >= 0; i--) {
      const t = EVENT_TEMPLATES[i % EVENT_TEMPLATES.length]!;
      const conn = CONNECTORS[i % CONNECTORS.length]!;
      this.events.push({
        ts: Date.now() - i * 7 * 60_000,
        type: t.type,
        label: t.label,
        msg: t.msg.replace('%s', conn.name),
      });
    }
  }

  private tick(): void {
    const now = Date.now();
    const elapsed = Math.max(0, now - this.lastTick) / 1000;
    this.lastTick = now;
    const ecms = Math.round(elapsed * 23);
    this.counters.ecm += ecms;
    this.counters.hits += Math.round(ecms * 0.52);
    this.counters.emm += Math.round(elapsed * 1.1);
    if (rnd(now / 60_000) > 0.93) {
      const t = EVENT_TEMPLATES[Math.floor(rnd(now) * EVENT_TEMPLATES.length)]!;
      const conn = CONNECTORS[Math.floor(rnd(now / 7) * CONNECTORS.length)]!;
      this.events.push({ ts: now, type: t.type, label: t.label, msg: t.msg.replace('%s', conn.name) });
      if (this.events.length > 40) this.events.shift();
    }
  }

  async login(user: string, password: string): Promise<LoginResult | null> {
    // Any non-empty password is accepted; 'admin' and 'root' get elevated rights.
    if (!user || !password) return null;
    return {
      user,
      admin: user === 'admin' || user === 'root',
      superUser: user === 'root',
      sessionId: 'mock' + Math.random().toString(36).slice(2, 8),
    };
  }

  /** Renders the same xml dialect a real CSP node would answer with. */
  async statusXml(commands: StatusCommand[]): Promise<string> {
    this.tick();
    const parts: string[] = [];
    for (const c of commands) {
      const fn = this.renderers[c.command];
      if (fn) parts.push(fn(c.params ?? {}));
    }
    return `<?xml version="1.0" encoding="UTF-8"?>\n<cws-status-resp ver="1.0">\n${parts.join('\n')}\n</cws-status-resp>`;
  }

  async snapshot(_auth: BackendAuth, sections: StatusCommand[]): Promise<StatusSnapshot> {
    return parseStatusResponse(await this.statusXml(sections));
  }

  raw(_auth: BackendAuth, command: string, params: Record<string, string>): Promise<string> {
    return this.statusXml([{ command, params }]);
  }

  async control(_auth: BackendAuth, command: string, params: Record<string, string | undefined>) {
    this.tick();
    const name = params.name ?? '';
    switch (command) {
      case 'disable-connector':
        this.disabled.add(name);
        return { ok: true, message: `Connector '${name}' disabled` };
      case 'retry-connector':
        this.disabled.delete(name);
        return { ok: true, message: `Reconnect attempt scheduled for '${name}'` };
      case 'clear-events':
        this.events = [];
        return { ok: true, message: 'Event log cleared' };
      case 'kick-user':
        return { ok: true, message: `All sessions for '${name}' closed` };
      case 'shutdown':
        return { ok: true, message: 'Shutdown ignored in mock mode' };
      default:
        return { ok: true, message: `Command '${command}' executed (mock)` };
    }
  }

  async fetchConfig(): Promise<ConfigFile> {
    return { name: 'proxy.xml', content: this.config, writable: true };
  }

  async saveConfig(_auth: BackendAuth, xml: string) {
    if (!xml.trim().startsWith('<')) return { ok: false, message: 'Error: not an xml document' };
    this.config = xml;
    return { ok: true, message: 'Configuration updated (mock, not persisted)' };
  }

  /* ------------------------------------------------------------ renderers */

  private connectorState(name: string, idx: number) {
    const up = !this.disabled.has(name) && !(idx === 4);
    const util = Math.round(rnd(Date.now() / 30_000 + idx) * 90) + 5;
    return { up, util };
  }

  private readonly renderers: Record<string, (p: Record<string, unknown>) => string> = {
    'proxy-status': () => {
      const up = Date.now() - START;
      const c = this.counters;
      return `  <proxy-status name="csp-managua" version="4.2.0" build="mock" started="${START}" duration="${duration(up)}"
    connectors="${CONNECTORS.length}" sessions="${USERS.length}" active-sessions="${USERS.length - 1}" capacity="420"
    ecm-count="${c.ecm}" ecm-rate="23.4" ecm-forwards="${c.ecm - c.hits}" ecm-cache-hits="${c.hits}"
    ecm-denied="${c.denied}" ecm-filtered="${c.filtered}" ecm-failures="${c.failures}" emm-count="${c.emm}">
    <jvm os="Linux 6.1 amd64" name="csp-panel mock runtime" version="node ${process.versions.node}"
      heap-total="262144" heap-free="${131072 + Math.round(rnd(Date.now() / 10_000) * 60000)}" threads="${48 + Math.round(rnd(Date.now()) * 6)}"
      filedesc-open="${180 + Math.round(rnd(Date.now() / 5000) * 20)}" filedesc-max="4096"/>
  </proxy-status>`;
    },

    'cache-status': () => `  <cache-status type="ClusteredCache">
    <cache-param name="contains" value="${1200 + Math.round(rnd(Date.now() / 20_000) * 300)}"/>
    <cache-param name="peers" value="2"/>
    <cache-param name="hit-rate" value="52.4%"/>
    <cache-param name="pending" value="${Math.round(rnd(Date.now() / 3000) * 4)}"/>
    <cache-param name="avg-wait" value="${(rnd(Date.now() / 4000) * 60).toFixed(1)} ms"/>
  </cache-status>`,

    'ca-profiles': () => {
      const rows = ['cable', 'sat'].map((name, i) => {
        const svc = SERVICES.filter((s) => s.profile === name).length;
        return `    <profile name="${name}" ca-id="${i === 0 ? '0x0B00' : '0x1810'}" network-id="${i === 0 ? '0x0001' : '0x0085'}"
      enabled="true" debug="${i === 1}" max-cw-wait="${i === 0 ? 7000 : 9000}" max-cache-wait="800" congestion-limit="12"
      capacity="${i === 0 ? 180 : 240}" mapped-services="${svc}" parsed-services="${svc}" parsed-conflicts="0">
      <listen-port protocol="Newcamd" port="${10001 + i}" users="${i === 0 ? 3 : 2}" alive="true"/>${
        i === 1 ? '\n      <listen-port protocol="CCcam" port="12000" users="1" alive="true"/>' : ''
      }
    </profile>`;
      });
      return `  <ca-profiles>\n${rows.join('\n')}\n  </ca-profiles>`;
    },

    'cws-connectors': (p) => {
      const filter = typeof p.profile === 'string' ? p.profile : undefined;
      const rows = CONNECTORS.filter((c) => !filter || c.profile === filter).map((c, i) => {
        const { up, util } = this.connectorState(c.name, i);
        const services = SERVICES.filter((s) => s.profile === c.profile)
          .map(
            (s) =>
              `      <service id="${s.id}" name="${esc(s.name)}" profile="${s.profile}" hit="${rnd(s.id + i) > 0.6}"/>`,
          )
          .join('\n');
        const common = `name="${c.name}" profile="${c.profile}" protocol="${c.protocol}" host="${c.host}" metric="${c.metric}"`;
        if (!up) {
          return `    <connector ${common} status="DISCONNECTED" disconnected="${Date.now() - 900_000}" next-attempt="00:0${
            (i % 5) + 1
          }:12"/>`;
        }
        return `    <connector ${common} status="READY" connected="${START + i * 60_000}" duration="${duration(
          Date.now() - START - i * 60_000,
        )}"
      utilization="${util}" avgutilization="${Math.max(1, util - 12)}" capacity="${60 + i * 25}"
      ecm-count="${12_000 + i * 3_310 + Math.round(rnd(Date.now() / 1000 + i) * 40)}" ecm-load="${Math.round(util * 0.6)}"
      emm-count="${400 + i * 55}" timeout-count="${i * 3}" sendq="${Math.round(rnd(Date.now() / 900 + i) * 3)}"
      cutime="${Math.round(60 + rnd(Date.now() / 700 + i) * 200)}" avgtime="${Math.round(90 + i * 11)}"
      service-count="${SERVICES.filter((s) => s.profile === c.profile).length}" provider-idents="${
        c.profile === 'cable' ? '000000,004101' : '005411,008011'
      }" card-data1="${(0x1000 + i).toString(16)}">
      <remote-info>
        <cws-param name="remote-version" value="4.2.0"/>
        <cws-param name="card-slots" value="${1 + (i % 3)}"/>
        <cws-param name="node-id" value="${(0xaabb00 + i).toString(16)}"/>
      </remote-info>
${services}
    </connector>`;
      });
      return `  <cws-connectors>\n${rows.join('\n')}\n  </cws-connectors>`;
    },

    'proxy-users': (p) => {
      const hideInactive = String(p['hide-inactive'] ?? '') === 'true';
      const rows = USERS.map((u, i) => {
        const active = i !== 5;
        if (hideInactive && !active) return '';
        const svc = SERVICES.filter((s) => s.profile === u.profile)[i % 4] ?? SERVICES[0]!;
        return `    <user name="${u.name}" display-name="${u.name}">
      <session profile="${u.profile}" host="${u.host}" client-id="${esc(u.client)}" active="${active}" count="${
        1 + (i % 2)
      }"
        duration="${duration(3_600_000 + i * 900_000)}" last-zap="${duration(60_000 + i * 30_000)}"
        ecm-count="${320 + i * 47}" emm-count="${12 + i}" ${u.name === 'admin' ? 'au="card-local" ' : ''}avg-ecm-interval="${
          8 + (i % 3)
        }"
        pending-count="${i === 3 ? 2 : 0}" last-transaction="${Math.round(180 + rnd(Date.now() / 800 + i) * 900)}"
        flags="${['CH', 'C-', 'NH', 'C+'][i % 4]}" time-client="12" time-queue="4" time-cws="${
          60 + i * 3
        }" time-cache="2"${active ? '' : ' keepalive-count="3"'}>
        <service id="${svc.id}" name="${esc(svc.name)}" profile="${svc.profile}"/>
      </session>
    </user>`;
      }).filter(Boolean);
      return `  <proxy-users count="${USERS.length}" login-failures="3">\n${rows.join('\n')}\n  </proxy-users>`;
    },

    'error-log': () =>
      `  <error-log>\n${[...this.events]
        .reverse()
        .map((e) => `    <event type="${e.type}" timestamp="${e.ts}" label="${esc(e.label)}" msg="${esc(e.msg)}"/>`)
        .join('\n')}\n  </error-log>`,

    'file-log': () =>
      `  <file-log>\n${[...this.events]
        .slice(-6)
        .reverse()
        .map(
          (e, i) =>
            `    <event type="file" timestamp="${e.ts}" log-level="${i % 3 === 0 ? 'SEVERE' : 'WARNING'}" msg="${esc(
              e.msg,
            )}"/>`,
        )
        .join('\n')}\n  </file-log>`,

    'user-warning-log': () =>
      `  <user-warning-log>\n${USERS.slice(0, 4)
        .map(
          (u, i) =>
            `    <ecm timestamp="${Date.now() - i * 240_000}" name="${u.name}" profile="${u.profile}" label="${
              ['Timeout', 'Congestion', 'Cache miss', 'Denied'][i % 4]
            }" msg="Transaction for ${u.name} exceeded ${900 + i * 300} ms"/>`,
        )
        .join('\n')}\n  </user-warning-log>`,

    'watched-services': (p) => {
      const filter = typeof p.profile === 'string' ? p.profile : undefined;
      const rows = SERVICES.filter((s) => !filter || s.profile === filter).map(
        (s, i) =>
          `    <service id="${s.id}" name="${esc(s.name)}" profile="${s.profile}" watchers="${
            1 + Math.round(rnd(s.id) * 4)
          }" hit="${i % 3 !== 0}"/>`,
      );
      return `  <watched-services>\n${rows.join('\n')}\n  </watched-services>`;
    },

    'all-services': () =>
      `  <all-services>\n${SERVICES.map(
        (s) => `    <service id="${s.id}" name="${esc(s.name)}" profile="${s.profile}"/>`,
      ).join('\n')}\n  </all-services>`,

    'last-seen': () =>
      `  <last-seen>\n${USERS.slice(2)
        .map(
          (u, i) =>
            `    <entry name="${u.name}" host="${u.host}" profile="${u.profile}" last-login="${
              Date.now() - (i + 1) * 3_600_000
            }" last-seen="${Date.now() - (i + 1) * 600_000}" reason="client disconnect"/>`,
        )
        .join('\n')}\n  </last-seen>`,

    'login-failures': () =>
      `  <login-failures>\n${['pirata', '45.12.9.3', 'test']
        .map(
          (n, i) =>
            `    <entry name="${n}" host="45.12.9.${3 + i}" count="${2 + i * 3}" first-failure="${
              Date.now() - 86_400_000
            }" last-failure="${Date.now() - i * 1_800_000}" reason="unknown user or bad password"/>`,
        )
        .join('\n')}\n  </login-failures>`,

    'proxy-plugins': () => `  <proxy-plugins>
    <plugin name="CacheCoveragePlugin" version="1.2" description="Cache coverage reporting">
      <plugin-param name="enabled" value="true"/>
      <plugin-param name="report-interval" value="60"/>
    </plugin>
    <plugin name="ServiceMapPlugin" version="0.9" description="Service map persistence">
      <plugin-param name="file" value="etc/services.dat"/>
    </plugin>
  </proxy-plugins>`,

    'ctrl-commands': () => `  <ctrl-commands>
    <option-list name="@connectors">
${CONNECTORS.map((c) => `      <option value="${c.name}"/>`).join('\n')}
    </option-list>
    <option-list name="@profiles">
      <option value="cable"/>
      <option value="sat"/>
    </option-list>
    <option-list name="@users">
${USERS.map((u) => `      <option value="${u.name}"/>`).join('\n')}
    </option-list>
    <command-group name="Connectors" handler="ProxyCtrlCommands">
      <command name="retry-connector" label="Retry connector" description="Attempt re-connection for one connector.">
        <command-param name="name" label="Connector"><option value="@connectors"/></command-param>
      </command>
      <command name="disable-connector" label="Disable connector" description="Temporarily disable a connector." confirm="true">
        <command-param name="name" label="Connector"><option value="@connectors"/></command-param>
      </command>
      <command name="reset-connector" label="Reset service map" description="Clear the service map for one connector.">
        <command-param name="name" label="Connector"><option value="@connectors"/></command-param>
      </command>
    </command-group>
    <command-group name="Users" handler="ProxyCtrlCommands">
      <command name="kick-user" label="Kick user" description="Close all sessions for the specified user." confirm="true">
        <command-param name="name" label="User"><option value="@users"/></command-param>
      </command>
      <command name="osd-message" label="Send OSD message" description="Send a newcamd osd message to the user sessions.">
        <command-param name="name" label="User"><option value="@users"/></command-param>
        <command-param name="text" label="Text" allow-arbitrary="true" value="Hola"/>
      </command>
      <command name="set-user-debug" label="User debug" description="Toggle debug logging for a user.">
        <command-param name="name" label="User"><option value="@users"/></command-param>
        <command-param name="value" label="Enabled" boolean="true"/>
      </command>
    </command-group>
    <command-group name="Internal" handler="ProxyCtrlCommands">
      <command name="clear-events" label="Clear events" description="Delete all CWS events."/>
      <command name="clear-warnings" label="Clear warnings" description="Delete all user transaction warnings."/>
      <command name="remove-seen" label="Clear last-seen log" description="Clear the last-seen log."/>
      <command name="remove-failed" label="Clear login failures" description="Clear the login-failures log.">
        <command-param name="mask" label="Mask" allow-arbitrary="true" value="*"/>
      </command>
      <command name="shutdown" label="Shutdown proxy" description="Stop this proxy node." confirm="true"/>
    </command-group>
  </ctrl-commands>`,
  };
}
