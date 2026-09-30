import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import type {
  CacheStatus,
  CaProfile,
  CommandGroup,
  Connector,
  CtrlCommand,
  FailureEntry,
  KeyValue,
  ListenPort,
  LogEvent,
  Plugin,
  ProxyStatus,
  ProxyUsers,
  SeenEntry,
  Service,
  StatusCommand,
  StatusSnapshot,
  UserSession,
} from './types.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  allowBooleanAttributes: true,
  parseAttributeValue: false,
  trimValues: true,
});

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  format: true,
  suppressEmptyNode: true,
  // CSP's xml parser expects include="true", not a bare boolean attribute.
  suppressBooleanAttributes: false,
});

/* ------------------------------------------------------------------ helpers */

type Node = Record<string, unknown>;

export function asArray<T = Node>(value: unknown): T[] {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]) as T[];
}

function str(node: Node | undefined, attr: string): string | undefined {
  const v = node?.[`@${attr}`];
  if (v === undefined || v === null || v === '') return undefined;
  return String(v);
}

function num(node: Node | undefined, attr: string): number | undefined {
  const v = str(node, attr);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function numOr(node: Node | undefined, attr: string, fallback: number): number {
  return num(node, attr) ?? fallback;
}

function flag(node: Node | undefined, attr: string): boolean | undefined {
  const v = str(node, attr);
  if (v === undefined) return undefined;
  return v === 'true' || v === '1';
}

function text(node: unknown): string {
  if (node === undefined || node === null) return '';
  if (typeof node === 'object') {
    const t = (node as Node)['#text'];
    return t === undefined ? '' : String(t);
  }
  return String(node);
}

function kvList(container: unknown, tag: string): KeyValue[] {
  return asArray<Node>(container).flatMap((c) =>
    asArray<Node>(c[tag]).map((p) => ({
      name: str(p, 'name') ?? '',
      value: str(p, 'value') ?? text(p),
    })),
  );
}

function hex(id: number | undefined): string {
  return id === undefined ? '' : id.toString(16);
}

/* ------------------------------------------------------------- xml building */

/** Builds a `cws-status-req` document for one or more status commands. */
export function buildStatusRequest(commands: StatusCommand[], sessionId?: string): string {
  const body: Node = { '@ver': '1.0' };
  if (sessionId) body.session = { '@session-id': sessionId };
  for (const c of commands) {
    const node: Node = { '@include': 'true' };
    for (const [k, v] of Object.entries(c.params ?? {})) {
      if (v !== undefined && v !== null && v !== '') node[`@${k}`] = String(v);
    }
    // repeating the same command twice in one request is not supported by CSP
    body[c.command] = node;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n${builder.build({ 'cws-status-req': body })}`;
}

/** Builds a `cws-command-req` document for a single control command. */
export function buildControlRequest(
  command: string,
  params: Record<string, string | undefined>,
  sessionId?: string,
): string {
  const cmd: Node = { '@command': command };
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') cmd[`@${k}`] = String(v);
  }
  const body: Node = { '@ver': '1.0' };
  if (sessionId) body.session = { '@session-id': sessionId };
  body.command = cmd;
  return `<?xml version="1.0" encoding="UTF-8"?>\n${builder.build({ 'cws-command-req': body })}`;
}

export function buildLoginRequest(user: string, password: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${builder.build({
    'cws-status-req': { '@ver': '1.0', 'cws-login': { user: { '@name': user, '@password': password } } },
  })}`;
}

export function parseXml(xml: string): Node {
  return parser.parse(xml) as Node;
}

/* --------------------------------------------------------------- mappers */

function mapProxyStatus(n: Node | undefined): ProxyStatus | undefined {
  if (!n) return undefined;
  const jvmNode = asArray<Node>(n.jvm)[0];
  const heapTotal = numOr(jvmNode, 'heap-total', 0);
  const heapFree = numOr(jvmNode, 'heap-free', 0);
  return {
    name: str(n, 'name') ?? 'CSP',
    version: str(n, 'version') ?? '',
    build: str(n, 'build'),
    started: str(n, 'started') ?? '',
    duration: str(n, 'duration') ?? '',
    connectors: numOr(n, 'connectors', 0),
    sessions: numOr(n, 'sessions', 0),
    activeSessions: numOr(n, 'active-sessions', 0),
    capacity: numOr(n, 'capacity', 0),
    ecmCount: numOr(n, 'ecm-count', 0),
    ecmRate: numOr(n, 'ecm-rate', 0),
    ecmForwards: numOr(n, 'ecm-forwards', 0),
    ecmCacheHits: numOr(n, 'ecm-cache-hits', 0),
    ecmDenied: numOr(n, 'ecm-denied', 0),
    ecmFiltered: numOr(n, 'ecm-filtered', 0),
    ecmFailures: numOr(n, 'ecm-failures', 0),
    emmCount: numOr(n, 'emm-count', 0),
    jvm: jvmNode
      ? {
          os: str(jvmNode, 'os') ?? '',
          name: str(jvmNode, 'name') ?? '',
          version: str(jvmNode, 'version') ?? '',
          heapTotal,
          heapFree,
          heapUsed: Math.max(0, heapTotal - heapFree),
          threads: numOr(jvmNode, 'threads', 0),
          filedescOpen: num(jvmNode, 'filedesc-open'),
          filedescMax: num(jvmNode, 'filedesc-max'),
        }
      : undefined,
  };
}

function mapCache(n: Node | undefined): CacheStatus | undefined {
  if (!n) return undefined;
  return { type: str(n, 'type') ?? 'unknown', params: kvList(n, 'cache-param') };
}

function mapService(n: Node): Service {
  const id = numOr(n, 'id', 0);
  return {
    id,
    hexId: str(n, 'hex-id') ?? hex(id),
    name: str(n, 'name') ?? `Unknown ${id}`,
    profile: str(n, 'profile'),
    hit: flag(n, 'hit'),
    watchers: num(n, 'watchers'),
  };
}

function mapProfiles(container: Node | undefined): CaProfile[] {
  return asArray<Node>(container?.profile).map((p) => ({
    name: str(p, 'name') ?? '',
    caId: str(p, 'ca-id'),
    networkId: str(p, 'network-id'),
    enabled: flag(p, 'enabled'),
    debug: flag(p, 'debug'),
    maxCwWait: num(p, 'max-cw-wait'),
    maxCacheWait: num(p, 'max-cache-wait'),
    congestionLimit: num(p, 'congestion-limit'),
    capacity: num(p, 'capacity'),
    mappedServices: num(p, 'mapped-services'),
    parsedServices: num(p, 'parsed-services'),
    parsedConflicts: num(p, 'parsed-conflicts'),
    providerIdents: str(p, 'provider-idents'),
    listenPorts: asArray<Node>(p['listen-port']).map(
      (lp): ListenPort => ({
        protocol: str(lp, 'protocol') ?? text(lp) ?? '',
        port: numOr(lp, 'port', 0),
        users: num(lp, 'users'),
        alive: flag(lp, 'alive'),
      }),
    ),
  }));
}

function mapConnectors(container: Node | undefined): Connector[] {
  return asArray<Node>(container?.connector).map((c) => ({
    name: str(c, 'name') ?? '',
    profile: str(c, 'profile') ?? '',
    protocol: str(c, 'protocol') ?? '',
    status: str(c, 'status') ?? '',
    connectedNow: str(c, 'duration') !== undefined,
    host: str(c, 'host'),
    metric: num(c, 'metric'),
    connected: str(c, 'connected'),
    disconnected: str(c, 'disconnected'),
    duration: str(c, 'duration'),
    nextAttempt: str(c, 'next-attempt'),
    utilization: num(c, 'utilization'),
    avgUtilization: num(c, 'avgutilization'),
    capacity: num(c, 'capacity'),
    ecmCount: num(c, 'ecm-count'),
    ecmLoad: num(c, 'ecm-load'),
    emmCount: num(c, 'emm-count'),
    timeoutCount: num(c, 'timeout-count'),
    sendq: num(c, 'sendq'),
    cutime: num(c, 'cutime'),
    avgtime: num(c, 'avgtime'),
    serviceCount: num(c, 'service-count'),
    providerIdents: str(c, 'provider-idents'),
    cardData1: str(c, 'card-data1'),
    services: asArray<Node>(c.service).map(mapService),
    remoteParams: kvList(c['remote-info'], 'cws-param'),
  }));
}

function mapUsers(container: Node | undefined): ProxyUsers | undefined {
  if (!container) return undefined;
  const sessions: UserSession[] = [];
  for (const u of asArray<Node>(container.user)) {
    const name = str(u, 'name') ?? '';
    for (const s of asArray<Node>(u.session)) {
      const svc = asArray<Node>(s.service)[0];
      sessions.push({
        user: name,
        displayName: str(u, 'display-name'),
        profile: str(s, 'profile') ?? '',
        host: str(s, 'host') ?? '',
        clientId: str(s, 'client-id'),
        active: flag(s, 'active') ?? true,
        count: num(s, 'count'),
        duration: str(s, 'duration'),
        lastZap: str(s, 'last-zap'),
        ecmCount: numOr(s, 'ecm-count', 0),
        emmCount: numOr(s, 'emm-count', 0),
        au: str(s, 'au'),
        avgEcmInterval: num(s, 'avg-ecm-interval'),
        pendingCount: num(s, 'pending-count'),
        lastTransaction: num(s, 'last-transaction'),
        keepaliveCount: num(s, 'keepalive-count'),
        flags: str(s, 'flags'),
        service: svc ? mapService(svc) : undefined,
        timeClient: num(s, 'time-client'),
        timeQueue: num(s, 'time-queue'),
        timeCws: num(s, 'time-cws'),
        timeCache: num(s, 'time-cache'),
      });
    }
  }
  return {
    count: numOr(container, 'count', sessions.length),
    loginFailures: numOr(container, 'login-failures', 0),
    sessions,
  };
}

function toIso(ts: number | undefined): string {
  if (!ts) return '';
  return new Date(ts).toISOString();
}

function mapEvents(container: Node | undefined, tag: string): LogEvent[] {
  return asArray<Node>(container?.[tag]).map((e) => {
    const ts = numOr(e, 'timestamp', 0);
    return {
      type: str(e, 'type') ?? tag,
      timestamp: ts,
      time: toIso(ts),
      label: str(e, 'label'),
      message: str(e, 'msg') ?? text(e),
      logLevel: str(e, 'log-level'),
      user: str(e, 'user') ?? str(e, 'name'),
      profile: str(e, 'profile'),
    };
  });
}

function mapCommands(container: Node | undefined): {
  groups: CommandGroup[];
  optionLists: Record<string, string[]>;
} {
  const optionLists: Record<string, string[]> = {};
  for (const ol of asArray<Node>(container?.['option-list'])) {
    const name = str(ol, 'name');
    if (!name) continue;
    optionLists[name] = asArray<Node>(ol.option).map((o) => str(o, 'value') ?? text(o));
  }
  const groups = asArray<Node>(container?.['command-group']).map(
    (g): CommandGroup => ({
      name: str(g, 'name') ?? '',
      handler: str(g, 'handler'),
      commands: asArray<Node>(g.command).map(
        (c): CtrlCommand => ({
          name: str(c, 'name') ?? '',
          label: str(c, 'label'),
          description: str(c, 'description'),
          confirm: flag(c, 'confirm') ?? false,
          params: asArray<Node>(c['command-param']).map((p) => ({
            name: str(p, 'name') ?? '',
            label: str(p, 'label'),
            value: str(p, 'value'),
            boolean: flag(p, 'boolean') ?? false,
            allowArbitrary: flag(p, 'allow-arbitrary') ?? false,
            size: num(p, 'size'),
            options: asArray<Node>(p.option).map((o) => ({ value: str(o, 'value') ?? text(o) })),
          })),
        }),
      ),
    }),
  );
  return { groups, optionLists };
}

function mapPlugins(container: Node | undefined): Plugin[] {
  return asArray<Node>(container?.plugin).map((p) => ({
    name: str(p, 'name') ?? '',
    version: str(p, 'version'),
    description: str(p, 'description'),
    params: kvList(p, 'plugin-param'),
  }));
}

/**
 * Turns a full `cws-status-resp` document into the typed snapshot the panel uses.
 * Unknown/absent sections simply come back empty, so a partial query is fine.
 */
export function parseStatusResponse(xml: string): StatusSnapshot {
  const doc = parseXml(xml);
  const root = (doc['cws-status-resp'] ?? {}) as Node;
  const { groups, optionLists } = mapCommands(asArray<Node>(root['ctrl-commands'])[0]);

  const watched = asArray<Node>(root['watched-services'])[0];
  const all = asArray<Node>(root['all-services'])[0];
  const services = [...asArray<Node>(watched?.service), ...asArray<Node>(all?.service)].map(mapService);

  return {
    proxy: mapProxyStatus(asArray<Node>(root['proxy-status'])[0]),
    cache: mapCache(asArray<Node>(root['cache-status'])[0]),
    profiles: mapProfiles(asArray<Node>(root['ca-profiles'])[0]),
    connectors: mapConnectors(asArray<Node>(root['cws-connectors'])[0]),
    plugins: mapPlugins(asArray<Node>(root['proxy-plugins'])[0]),
    users: mapUsers(asArray<Node>(root['proxy-users'])[0]),
    events: mapEvents(asArray<Node>(root['error-log'])[0], 'event'),
    fileLog: mapEvents(asArray<Node>(root['file-log'])[0], 'event'),
    warnings: mapEvents(asArray<Node>(root['user-warning-log'])[0], 'ecm'),
    services,
    seen: asArray<Node>(asArray<Node>(root['last-seen'])[0]?.entry).map(
      (e): SeenEntry => ({
        name: str(e, 'name') ?? '',
        host: str(e, 'host'),
        profile: str(e, 'profile'),
        lastLogin: num(e, 'last-login'),
        lastSeen: num(e, 'last-seen'),
        reason: str(e, 'reason'),
      }),
    ),
    failures: asArray<Node>(asArray<Node>(root['login-failures'])[0]?.entry).map(
      (e): FailureEntry => ({
        name: str(e, 'name') ?? '',
        host: str(e, 'host'),
        count: num(e, 'count') ?? num(e, 'failure-count'),
        lastFailure: num(e, 'last-failure'),
        firstFailure: num(e, 'first-failure'),
        reason: str(e, 'reason'),
      }),
    ),
    commandGroups: groups,
    optionLists,
  };
}

/** Extracts `<status .../>` from a login response. */
export function parseLoginResponse(xml: string): { ok: boolean; user?: string; admin: boolean; superUser: boolean; sessionId?: string } {
  const root = (parseXml(xml)['cws-status-resp'] ?? {}) as Node;
  const status = asArray<Node>(root.status)[0];
  const state = str(status, 'state');
  return {
    ok: state === 'loggedIn',
    user: str(status, 'user'),
    admin: flag(status, 'admin') ?? false,
    superUser: flag(status, 'super-user') ?? false,
    sessionId: str(status, 'session-id'),
  };
}

/** Extracts the result of a control command or a config deployment. */
export function parseCommandResponse(xml: string): { ok: boolean; message: string } {
  const doc = parseXml(xml);
  const root = (doc['cws-status-resp'] ?? doc['cws-command-resp'] ?? doc) as Node;
  const result = asArray<Node>(root['command-result'])[0] ?? asArray<Node>(root['cfg-result'])[0] ?? asArray<Node>((doc as Node)['cfg-result'])[0];
  const message = str(result, 'message') ?? text(result) ?? '';
  const ok = !/error|fail|denied|invalid/i.test(message);
  return { ok, message: message || 'OK' };
}
