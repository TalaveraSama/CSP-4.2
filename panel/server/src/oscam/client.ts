import { XMLParser } from 'fast-xml-parser';
import {
  BackendError,
  emptySnapshot,
  formatDuration,
  type BackendAuth,
  type BackendInfo,
  type ConfigFile,
  type LoginResult,
  type ProxyBackend,
} from '../backend.js';
import type {
  CaProfile,
  CommandGroup,
  Connector,
  LogEvent,
  Service,
  StatusCommand,
  StatusSnapshot,
  UserSession,
} from '../csp/types.js';
import type { OscamTransport } from './http.js';

/**
 * OSCam backend.
 *
 * Maps the OSCam web API (`/oscamapi.html?part=...`) onto the same normalised
 * model the panel uses for CardServProxy, so every screen keeps working:
 *
 *   OSCam                         ->  panel model
 *   client type 'r'/'p' (readers) ->  connectors
 *   client type 'c'/'m' (clients) ->  sessions      (+ counters from userstats)
 *   distinct CAIDs                ->  "profiles" (CSP has no direct equivalent)
 *   <request srvid/caid>          ->  watched services
 *   <log> CDATA                   ->  events / warnings
 *   failban entries               ->  login failures
 *   userstats (offline users)     ->  last seen
 *   oscam.conf & friends          ->  config editor (ini instead of xml)
 */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  allowBooleanAttributes: true,
  parseAttributeValue: false,
  trimValues: true,
});

type Node = Record<string, any>;

const arr = <T = Node>(v: unknown): T[] => (v === undefined || v === null ? [] : Array.isArray(v) ? (v as T[]) : [v as T]);
const attr = (n: Node | undefined, name: string): string | undefined => {
  const v = n?.[`@${name}`];
  return v === undefined || v === null || v === '' ? undefined : String(v);
};
const int = (n: Node | undefined, name: string): number | undefined => {
  const v = attr(n, name);
  if (v === undefined) return undefined;
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : undefined;
};
const txt = (n: unknown): string => {
  if (n === undefined || n === null) return '';
  if (typeof n === 'object') return String((n as Node)['#text'] ?? '');
  return String(n);
};
const numText = (n: unknown): number => {
  const v = Number(txt(n));
  return Number.isFinite(v) ? v : 0;
};

/** OSCam reports caids/srvids as bare hex strings ("0B00", "1001"). */
const hexToInt = (v: string | undefined): number => {
  if (!v) return 0;
  const n = Number.parseInt(v.replace(/^0x/i, ''), 16);
  return Number.isFinite(n) ? n : 0;
};

export const OSCAM_CONFIG_FILES = [
  'oscam.conf',
  'oscam.user',
  'oscam.server',
  'oscam.services',
  'oscam.srvid',
  'oscam.provid',
  'oscam.dvbapi',
  'oscam.whitelist',
  'oscam.ratelimit',
];

/**
 * NCam is an OSCam fork: same web API, same XML templates, same digest auth.
 * Only the endpoint, the document root element and the config file names are
 * renamed, so one flavour descriptor is enough to support it.
 */
export const NCAM_CONFIG_FILES = [
  'ncam.conf',
  'ncam.user',
  'ncam.server',
  'ncam.services',
  'ncam.srvid',
  'ncam.srvid2',
  'ncam.provid',
  'ncam.dvbapi',
  'ncam.whitelist',
  'ncam.ratelimit',
  'ncam.tiers',
  // Present in the actively maintained builds (fairbird/NCam); older forks
  // simply answer with an error for the ones they do not know.
  'ncam.fakecws',
  'ncam.twin',
  'ncam.fs',
];

export interface OscamFlavour {
  /** Backend id reported by /api/meta. */
  kind: 'oscam' | 'ncam';
  /** Human name used in messages and command labels. */
  label: string;
  /** API endpoint: /oscamapi.html or /ncamapi.html. */
  apiPath: string;
  /** Root element of every API document: <oscam> or <ncam>. */
  rootTag: string;
  configFiles: string[];
  /** File opened by the config editor by default. */
  defaultConfigFile: string;
}

export const OSCAM_FLAVOUR: OscamFlavour = {
  kind: 'oscam',
  label: 'OSCam',
  apiPath: '/oscamapi.html',
  rootTag: 'oscam',
  configFiles: OSCAM_CONFIG_FILES,
  defaultConfigFile: 'oscam.conf',
};

export const NCAM_FLAVOUR: OscamFlavour = {
  kind: 'ncam',
  label: 'NCam',
  apiPath: '/ncamapi.html',
  rootTag: 'ncam',
  configFiles: NCAM_CONFIG_FILES,
  defaultConfigFile: 'ncam.conf',
};

export function oscamInfo(target: string, mock: boolean, flavour: OscamFlavour = OSCAM_FLAVOUR): BackendInfo {
  return {
    kind: flavour.kind,
    mock,
    target,
    configFormat: 'ini',
    configFiles: flavour.configFiles,
    features: { profiles: true, cache: false, plugins: false, connectorServices: false, seen: true },
    labels: { connectors: 'Readers', connector: 'Reader', profiles: 'CAIDs' },
  };
}

interface OscamClientNode {
  type: string;
  name: string;
  desc?: string;
  protocol?: string;
  protocolExt?: string;
  au?: string;
  thid?: string;
  caid?: string;
  provid?: string;
  srvid?: string;
  ecmTime?: number;
  answered?: string;
  channel?: string;
  login?: string;
  online: number;
  idle: number;
  ip?: string;
  port?: string;
  state: string;
}

interface UserStat {
  name: string;
  status: string;
  ip?: string;
  protocol?: string;
  cwok: number;
  cwnok: number;
  cwignore: number;
  cwtimeout: number;
  cwcache: number;
  cwtun: number;
  cwrate: number;
  cwLastRespTime: number;
  emmok: number;
  emmnok: number;
  timeOnChannel: string;
}

export class OscamClient implements ProxyBackend {
  readonly info: BackendInfo;

  constructor(
    private readonly transport: OscamTransport,
    mock = false,
    private readonly flavour: OscamFlavour = OSCAM_FLAVOUR,
  ) {
    this.info = oscamInfo(transport.target, mock, flavour);
  }

  /* ------------------------------------------------------------- plumbing */

  private async api(auth: BackendAuth, query: Record<string, string | undefined>): Promise<Node> {
    const xml = await this.transport.get(auth, this.flavour.apiPath, query);
    const doc = parser.parse(xml) as Node;
    // Accept either root element: some forks answer <oscam> on /ncamapi.html.
    const root = doc[this.flavour.rootTag] ?? doc.oscam ?? doc.ncam ?? doc;
    const error = arr(root?.error)[0];
    if (error !== undefined) throw new BackendError(`${this.flavour.label}: ${txt(error) || 'api error'}`, 400);
    if (!root) throw new BackendError(`${this.flavour.label} returned an unexpected document`, 502);
    return root as Node;
  }

  async login(user: string, password: string): Promise<LoginResult | null> {
    try {
      const root = await this.api({ user, password }, { part: 'status' });
      // OSCam has a single webif account; http_readonly decides what it may do.
      const readonly = attr(root, 'readonly') === '1';
      return { user, admin: !readonly, superUser: !readonly };
    } catch (err) {
      if (err instanceof BackendError && err.status === 401) return null;
      throw err;
    }
  }

  /* -------------------------------------------------------------- reading */

  private parseClients(root: Node): OscamClientNode[] {
    const status = arr(root.status)[0];
    return arr(status?.client).map((c): OscamClientNode => {
      const request = arr(c.request)[0];
      const times = arr(c.times)[0];
      const connection = arr(c.connection)[0];
      return {
        type: attr(c, 'type') ?? '?',
        name: attr(c, 'name') ?? '',
        desc: attr(c, 'desc'),
        protocol: attr(c, 'protocol'),
        protocolExt: attr(c, 'protocolext'),
        au: attr(c, 'au'),
        thid: attr(c, 'thid'),
        caid: attr(request, 'caid'),
        provid: attr(request, 'provid'),
        srvid: attr(request, 'srvid'),
        ecmTime: int(request, 'ecmtime'),
        answered: attr(request, 'answered'),
        channel: txt(request).trim() || undefined,
        login: attr(times, 'login'),
        online: int(times, 'online') ?? 0,
        idle: int(times, 'idle') ?? 0,
        ip: attr(connection, 'ip'),
        port: attr(connection, 'port'),
        state: txt(connection).trim() || 'UNKNOWN',
      };
    });
  }

  private parseUserStats(root: Node): { users: UserStat[]; totals: Node | undefined } {
    const container = arr(root.users)[0];
    const users = arr(container?.user).map((u): UserStat => {
      const s = arr(u.stats)[0] ?? {};
      return {
        name: attr(u, 'name') ?? '',
        status: attr(u, 'status') ?? '',
        ip: attr(u, 'ip'),
        protocol: attr(u, 'protocol'),
        cwok: numText(s.cwok),
        cwnok: numText(s.cwnok),
        cwignore: numText(s.cwignore),
        cwtimeout: numText(s.cwtimeout),
        cwcache: numText(s.cwcache),
        cwtun: numText(s.cwtun),
        cwrate: numText(s.cwrate),
        cwLastRespTime: numText(s.cwlastresptime),
        emmok: numText(s.emmok),
        emmnok: numText(s.emmnok),
        timeOnChannel: txt(s.timeonchannel),
      };
    });
    return { users, totals: arr(root.totals)[0] };
  }

  /** OSCam log lines look like: `2026/09/30 14:03:11 1a2b3c4d c (module) message`. */
  private parseLog(root: Node): LogEvent[] {
    const raw = txt(arr(root.log)[0]);
    if (!raw) return [];
    const events: LogEvent[] = [];
    for (const line of raw.split('\n')) {
      const text = line.trim();
      if (!text) continue;
      const m = /^(\d{4}\/\d{2}\/\d{2})\s+(\d{2}:\d{2}:\d{2})(?:\.\d+)?\s+([0-9A-Fa-f]+)?\s*([a-zA-Z])?\s*(.*)$/.exec(text);
      const when = m ? Date.parse(`${m[1]!.replace(/\//g, '-')}T${m[2]}`) : Number.NaN;
      const message = m ? (m[5] ?? '') : text;
      const lower = message.toLowerCase();
      const level = /error|fail|reject|denied|invalid|cannot|not found/.test(lower)
        ? 'SEVERE'
        : /warn|timeout|retry|disconnect|dropped/.test(lower)
          ? 'WARNING'
          : 'INFO';
      events.push({
        type: 'log',
        timestamp: Number.isFinite(when) ? when : Date.now(),
        time: Number.isFinite(when) ? new Date(when).toISOString() : '',
        label: m?.[4] ? `type ${m[4]}` : undefined,
        logLevel: level,
        message,
      });
    }
    return events.reverse();
  }

  private buildConnectors(clients: OscamClientNode[]): Connector[] {
    return clients
      .filter((c) => c.type === 'r' || c.type === 'p')
      .map((c): Connector => {
        const up = c.online > 0 && !/^(off|error|unknown|disconnect)/i.test(c.state);
        return {
          name: c.name,
          profile: c.caid ? c.caid.toUpperCase() : '',
          protocol: c.protocolExt || c.protocol || (c.type === 'p' ? 'proxy' : 'reader'),
          status: c.state,
          connectedNow: up,
          host: c.ip ? `${c.ip}${c.port ? `:${c.port}` : ''}` : undefined,
          connected: c.login,
          duration: up ? formatDuration(c.online) : undefined,
          cutime: c.ecmTime,
          services: [],
          remoteParams: [
            { name: 'type', value: c.type === 'p' ? 'proxy' : 'local reader' },
            { name: 'description', value: c.desc ?? '-' },
            { name: 'last caid', value: c.caid ?? '-' },
            { name: 'last provid', value: c.provid ?? '-' },
            { name: 'last service', value: c.channel ?? '-' },
            { name: 'au', value: c.au ?? '-' },
            { name: 'idle', value: formatDuration(c.idle) },
            { name: 'thread', value: c.thid ?? '-' },
          ],
        };
      });
  }

  private buildSessions(clients: OscamClientNode[], stats: UserStat[]): UserSession[] {
    const byUser = new Map(stats.map((s) => [s.name, s]));
    const sessionCount = new Map<string, number>();
    const clientNodes = clients.filter((c) => c.type === 'c' || c.type === 'm');
    for (const c of clientNodes) sessionCount.set(c.name, (sessionCount.get(c.name) ?? 0) + 1);

    return clientNodes.map((c): UserSession => {
      const s = byUser.get(c.name);
      const service: Service | undefined = c.srvid && hexToInt(c.srvid) > 0
        ? {
            id: hexToInt(c.srvid),
            hexId: c.srvid.toLowerCase(),
            name: c.channel || `Unknown ${c.srvid}`,
            profile: c.caid?.toUpperCase(),
            hit: true,
          }
        : undefined;
      return {
        user: c.name,
        displayName: c.desc || undefined,
        profile: c.caid ? c.caid.toUpperCase() : '',
        host: c.ip ?? '',
        clientId: [c.protocol, c.protocolExt].filter(Boolean).join(' ') || undefined,
        active: c.idle < 300 && !/sleep|duplicate/i.test(c.state),
        count: sessionCount.get(c.name),
        duration: formatDuration(c.online),
        lastZap: formatDuration(c.idle),
        ecmCount: s ? s.cwok + s.cwnok + s.cwignore + s.cwtimeout + s.cwcache : 0,
        emmCount: s ? s.emmok : 0,
        au: c.au && c.au !== '0' && c.au.toLowerCase() !== 'off' ? c.au : undefined,
        avgEcmInterval: s && s.cwrate > 0 ? Math.round(s.cwrate) : undefined,
        lastTransaction: c.ecmTime,
        flags: c.state,
        service,
      };
    });
  }

  private buildProfiles(clients: OscamClientNode[]): CaProfile[] {
    const groups = new Map<string, { services: Set<number>; ports: Map<string, { port: number; users: number }>; users: number }>();
    for (const c of clients) {
      if (!c.caid || hexToInt(c.caid) === 0) continue;
      const key = c.caid.toUpperCase();
      const g = groups.get(key) ?? { services: new Set<number>(), ports: new Map(), users: 0 };
      if (c.srvid && hexToInt(c.srvid) > 0) g.services.add(hexToInt(c.srvid));
      if (c.type === 'c' || c.type === 'm') {
        g.users += 1;
        const proto = c.protocol ?? 'unknown';
        const entry = g.ports.get(proto) ?? { port: Number(c.port ?? 0), users: 0 };
        entry.users += 1;
        g.ports.set(proto, entry);
      }
      groups.set(key, g);
    }
    return [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([caid, g]) => ({
        name: caid,
        caId: `0x${caid}`,
        enabled: true,
        mappedServices: g.services.size,
        listenPorts: [...g.ports.entries()].map(([protocol, p]) => ({ protocol, port: p.port, users: p.users, alive: true })),
      }));
  }

  private buildServices(clients: OscamClientNode[]): Service[] {
    const map = new Map<string, Service>();
    for (const c of clients) {
      if (!c.srvid || hexToInt(c.srvid) === 0) continue;
      const key = `${c.caid ?? ''}:${c.srvid}`;
      const existing = map.get(key);
      if (existing) {
        existing.watchers = (existing.watchers ?? 0) + 1;
        continue;
      }
      map.set(key, {
        id: hexToInt(c.srvid),
        hexId: c.srvid.toLowerCase(),
        name: c.channel || `Unknown ${c.srvid}`,
        profile: c.caid?.toUpperCase(),
        watchers: c.type === 'c' || c.type === 'm' ? 1 : 0,
        hit: c.idle < 60,
      });
    }
    return [...map.values()];
  }

  private buildCommands(clients: OscamClientNode[], stats: UserStat[]): { groups: CommandGroup[]; optionLists: Record<string, string[]> } {
    const readers = [...new Set(clients.filter((c) => c.type === 'r' || c.type === 'p').map((c) => c.name))].sort();
    const users = [...new Set([...stats.map((s) => s.name), ...clients.filter((c) => c.type === 'c').map((c) => c.name)])].sort();
    const readerParam = { name: 'label', label: 'Reader', boolean: false, allowArbitrary: false, options: [{ value: '@readers' }] };
    const userParam = { name: 'name', label: 'User', boolean: false, allowArbitrary: false, options: [{ value: '@users' }] };

    const groups: CommandGroup[] = [
      {
        name: 'Readers',
        handler: this.flavour.kind === 'ncam' ? 'ncamapi' : 'oscamapi',
        commands: [
          { name: 'retry-connector', label: 'Restart reader', description: 'Restart the reader thread (part=status&action=restart).', confirm: false, params: [readerParam] },
          { name: 'reset-connector', label: 'Reread cards', description: 'Force a card re-read (part=readerlist&action=reread).', confirm: false, params: [readerParam] },
          { name: 'enable-connector', label: 'Enable reader', description: 'Enable a disabled reader.', confirm: false, params: [readerParam] },
          { name: 'disable-connector', label: 'Disable reader', description: 'Disable the reader until it is enabled again.', confirm: true, params: [readerParam] },
          { name: 'reset-reader-stats', label: 'Reset reader stats', description: 'Clear load-balancer statistics for all readers.', confirm: true, params: [] },
        ],
      },
      {
        name: 'Users',
        handler: this.flavour.kind === 'ncam' ? 'ncamapi' : 'oscamapi',
        commands: [
          { name: 'kick-user', label: 'Kick user', description: 'Kill every client thread of this user (part=status&action=kill).', confirm: true, params: [userParam] },
          { name: 'enable-user', label: 'Enable user', description: 'Re-enable a disabled account.', confirm: false, params: [userParam] },
          { name: 'disable-user', label: 'Disable user', description: `Disable the account in ${this.flavour.kind}.user.`, confirm: true, params: [userParam] },
          { name: 'reset-user-stats', label: 'Reset user stats', description: 'Reset the ECM/EMM counters of one user.', confirm: false, params: [userParam] },
        ],
      },
      {
        name: 'Server',
        handler: this.flavour.kind === 'ncam' ? 'ncamapi' : 'oscamapi',
        commands: [
          { name: 'reset-server-stats', label: 'Reset server stats', description: 'Reset the global counters.', confirm: true, params: [] },
          { name: 'reload-readers', label: 'Reload readers', description: `Re-read ${this.flavour.kind}.server and restart the readers.`, confirm: true, params: [] },
          { name: 'restart', label: `Restart ${this.flavour.label}`, description: `Restart the ${this.flavour.label} process.`, confirm: true, params: [] },
          { name: 'shutdown', label: `Shutdown ${this.flavour.label}`, description: `Stop the ${this.flavour.label} process.`, confirm: true, params: [] },
        ],
      },
    ];
    return { groups, optionLists: { '@readers': readers, '@users': users } };
  }

  async snapshot(auth: BackendAuth, sections: StatusCommand[]): Promise<StatusSnapshot> {
    const want = new Set(sections.map((s) => s.command));
    const wantsLog = want.has('error-log') || want.has('file-log') || want.has('user-warning-log');
    const wantsStatus =
      wantsLog ||
      ['proxy-status', 'cws-connectors', 'proxy-users', 'ca-profiles', 'watched-services', 'all-services', 'ctrl-commands'].some((s) =>
        want.has(s),
      );
    const wantsUsers = ['proxy-status', 'proxy-users', 'last-seen', 'ctrl-commands'].some((s) => want.has(s));
    const wantsFailban = want.has('login-failures');

    const [statusRoot, userRoot, failbanRoot] = await Promise.all([
      wantsStatus ? this.api(auth, { part: 'status', appendlog: wantsLog ? '1' : undefined }) : undefined,
      wantsUsers ? this.api(auth, { part: 'userstats' }) : undefined,
      wantsFailban ? this.api(auth, { part: 'failban' }) : undefined,
    ]);

    const snap = emptySnapshot();
    const clients = statusRoot ? this.parseClients(statusRoot) : [];
    const { users: stats, totals } = userRoot ? this.parseUserStats(userRoot) : { users: [], totals: undefined };
    const head = statusRoot ?? userRoot;

    if (want.has('proxy-status') && head) {
      const cwok = numText(totals?.cwok);
      const cwnok = numText(totals?.cwnok);
      const cwignore = numText(totals?.cwignore);
      const cwtimeout = numText(totals?.cwtimeout);
      const cwcache = numText(totals?.cwcache);
      const cwtun = numText(totals?.cwtun);
      const uptime = int(head, 'uptime') ?? 0;
      const total = cwok + cwnok + cwignore + cwtimeout + cwcache;
      snap.proxy = {
        name: `${this.flavour.label} ${attr(head, 'version') ?? ''}`.trim(),
        version: attr(head, 'version') ?? '',
        build: attr(head, 'revision'),
        started: attr(head, 'starttime') ?? '',
        duration: formatDuration(uptime),
        connectors: clients.filter((c) => c.type === 'r' || c.type === 'p').length,
        sessions: clients.filter((c) => c.type === 'c' || c.type === 'm').length,
        activeSessions: clients.filter((c) => (c.type === 'c' || c.type === 'm') && c.idle < 300).length,
        capacity: numText(totals?.useractive),
        ecmCount: total,
        ecmRate: uptime > 0 ? Number((total / uptime).toFixed(2)) : 0,
        ecmForwards: cwok,
        ecmCacheHits: cwcache,
        ecmDenied: cwignore,
        ecmFiltered: cwtun,
        ecmFailures: cwnok + cwtimeout,
        emmCount: stats.reduce((acc, s) => acc + s.emmok, 0),
      };
    }

    if (want.has('ca-profiles')) snap.profiles = this.buildProfiles(clients);
    if (want.has('cws-connectors')) snap.connectors = this.buildConnectors(clients);
    if (want.has('proxy-users')) {
      const sessions = this.buildSessions(clients, stats);
      const hideInactive = sections.find((s) => s.command === 'proxy-users')?.params?.['hide-inactive'];
      snap.users = {
        count: stats.length || new Set(sessions.map((s) => s.user)).size,
        loginFailures: 0,
        sessions: String(hideInactive) === 'true' ? sessions.filter((s) => s.active) : sessions,
      };
    }
    if (want.has('watched-services') || want.has('all-services')) snap.services = this.buildServices(clients);

    if (wantsLog && statusRoot) {
      const log = this.parseLog(statusRoot);
      if (want.has('error-log')) snap.events = log;
      if (want.has('file-log')) snap.fileLog = log.filter((e) => e.logLevel !== 'INFO');
      if (want.has('user-warning-log')) snap.warnings = log.filter((e) => e.logLevel === 'SEVERE');
    }

    if (want.has('last-seen')) {
      const online = new Set(clients.filter((c) => c.type === 'c' || c.type === 'm').map((c) => c.name));
      snap.seen = stats
        .filter((s) => !online.has(s.name))
        .map((s) => ({ name: s.name, host: s.ip, profile: s.protocol, reason: s.status || 'offline' }));
    }

    if (failbanRoot) {
      const container = arr(failbanRoot.failban)[0] ?? failbanRoot;
      snap.failures = arr(container?.ip).map((e) => {
        const date = attr(e, 'date');
        const parsed = date ? Date.parse(date.replace(/\//g, '-').replace(' ', 'T')) : Number.NaN;
        return {
          name: attr(e, 'user') || txt(e) || 'unknown',
          host: txt(e) || undefined,
          count: int(e, 'count'),
          lastFailure: Number.isFinite(parsed) ? parsed : undefined,
          reason: `failban, ${attr(e, 'secondsleft') ?? '0'}s left`,
        };
      });
    }

    if (want.has('ctrl-commands')) {
      const { groups, optionLists } = this.buildCommands(clients, stats);
      snap.commandGroups = groups;
      snap.optionLists = optionLists;
    }

    return snap;
  }

  raw(auth: BackendAuth, command: string, params: Record<string, string>): Promise<string> {
    return this.transport.get(auth, this.flavour.apiPath, { part: command, ...params });
  }

  /* ------------------------------------------------------------- mutating */

  async control(auth: BackendAuth, command: string, params: Record<string, string | undefined>) {
    const label = params.label ?? params.name;
    const ok = (message: string) => ({ ok: true, message });

    switch (command) {
      case 'retry-connector':
        await this.api(auth, { part: 'status', action: 'restart', label });
        return ok(`Reader '${label}' restarted`);
      case 'reset-connector':
        await this.api(auth, { part: 'readerlist', action: 'reread', label });
        return ok(`Reader '${label}' re-reading card`);
      case 'enable-connector':
        await this.api(auth, { part: 'readerlist', action: 'enable', label });
        return ok(`Reader '${label}' enabled`);
      case 'disable-connector':
        await this.api(auth, { part: 'readerlist', action: 'disable', label });
        return ok(`Reader '${label}' disabled`);
      case 'reset-reader-stats':
        await this.api(auth, { part: 'readerlist', action: 'resetallrdrstats' });
        return ok('Reader statistics reset');
      case 'reload-readers':
        await this.api(auth, { part: 'readerlist', action: 'reloadreaders' });
        return ok('Readers reloaded');
      case 'kick-user': {
        // OSCam/NCam kill client *threads*, so resolve the thread ids of the user first.
        const clients = this.parseClients(await this.api(auth, { part: 'status' }));
        const targets = clients.filter((c) => (c.type === 'c' || c.type === 'm') && c.name === label && c.thid);
        if (targets.length === 0) return { ok: false, message: `No active session for '${label}'` };
        for (const t of targets) await this.api(auth, { part: 'status', action: 'kill', threadid: t.thid });
        return ok(`Killed ${targets.length} session(s) of '${label}'`);
      }
      case 'enable-user':
        await this.api(auth, { part: 'userstats', action: 'enable', user: label });
        return ok(`User '${label}' enabled`);
      case 'disable-user':
        await this.api(auth, { part: 'userstats', action: 'disable', user: label });
        return ok(`User '${label}' disabled`);
      case 'reset-user-stats':
        await this.api(auth, { part: 'userstats', action: 'resetstats', user: label });
        return ok(`Statistics of '${label}' reset`);
      case 'reset-server-stats':
      case 'clear-events':
      case 'clear-warnings':
        await this.api(auth, { part: 'status', action: 'resetserverstats' });
        return ok('Server statistics reset');
      case 'restart':
        await this.api(auth, { part: 'shutdown', action: 'restart' });
        return ok(`${this.flavour.label} restart requested`);
      case 'shutdown':
        await this.api(auth, { part: 'shutdown', action: 'shutdown' });
        return ok(`${this.flavour.label} shutdown requested`);
      default:
        return { ok: false, message: `Command '${command}' is not supported by the ${this.flavour.label} backend` };
    }
  }

  async fetchConfig(auth: BackendAuth, file = this.flavour.defaultConfigFile): Promise<ConfigFile> {
    if (!this.flavour.configFiles.includes(file)) throw new BackendError(`Unknown config file '${file}'`, 400);
    const root = await this.api(auth, { part: 'files', file });
    const node = arr(root.file)[0];
    // Upstream quirk (module-webif.c in both OSCam and NCam): APIWRITABLE is
    // written to the template *before* `writable` is computed, so the XML API
    // always answers writable="0" for configuration files. The flag that
    // really decides is httpreadonly, reported on the document root.
    const readonly = attr(root, 'readonly') === '1';
    return {
      name: attr(node, 'filename') ?? file,
      content: txt(node),
      writable: attr(node, 'writable') === '1' || !readonly,
    };
  }

  async saveConfig(auth: BackendAuth, content: string, file = this.flavour.defaultConfigFile) {
    if (!this.flavour.configFiles.includes(file)) return { ok: false, message: `Unknown config file '${file}'` };
    const xml = await this.transport.post(auth, this.flavour.apiPath, {
      part: 'files',
      file,
      action: 'Save',
      filecontent: content,
    });
    const doc = parser.parse(xml) as Node;
    const root = doc[this.flavour.rootTag] ?? doc.oscam ?? doc.ncam ?? {};
    const error = arr(root.error)[0];
    if (error !== undefined) return { ok: false, message: `${this.flavour.label}: ${txt(error)}` };
    return { ok: true, message: `${file} saved (${this.flavour.label} may need a restart to apply some settings)` };
  }
}
