/**
 * Typed domain model for the CSP status/control API.
 *
 * The legacy panel consumed the raw `cws-status-resp` XML directly in the browser
 * through a 950-line XSLT. Here the XML is parsed once, server side, and exposed
 * as plain camelCase JSON so the frontend never sees XML.
 */

export interface Jvm {
  os: string;
  name: string;
  version: string;
  heapTotal: number;
  heapFree: number;
  heapUsed: number;
  threads: number;
  filedescOpen?: number;
  filedescMax?: number;
}

export interface ProxyStatus {
  name: string;
  version: string;
  build?: string;
  started: string;
  duration: string;
  connectors: number;
  sessions: number;
  activeSessions: number;
  capacity: number;
  ecmCount: number;
  ecmRate: number;
  ecmForwards: number;
  ecmCacheHits: number;
  ecmDenied: number;
  ecmFiltered: number;
  ecmFailures: number;
  emmCount: number;
  jvm?: Jvm;
}

export interface KeyValue {
  name: string;
  value: string;
}

export interface CacheStatus {
  type: string;
  params: KeyValue[];
}

export interface ListenPort {
  protocol: string;
  port: number;
  users?: number;
  alive?: boolean;
}

export interface CaProfile {
  name: string;
  caId?: string;
  networkId?: string;
  enabled?: boolean;
  debug?: boolean;
  maxCwWait?: number;
  maxCacheWait?: number;
  congestionLimit?: number;
  capacity?: number;
  mappedServices?: number;
  parsedServices?: number;
  parsedConflicts?: number;
  providerIdents?: string;
  listenPorts: ListenPort[];
}

export interface Service {
  id: number;
  hexId: string;
  name: string;
  profile?: string;
  hit?: boolean;
  watchers?: number;
}

export interface Connector {
  name: string;
  profile: string;
  protocol: string;
  status: string;
  /** Derived: a connector is considered up when the proxy reports a duration. */
  connectedNow: boolean;
  host?: string;
  metric?: number;
  connected?: string;
  disconnected?: string;
  duration?: string;
  nextAttempt?: string;
  utilization?: number;
  avgUtilization?: number;
  capacity?: number;
  ecmCount?: number;
  ecmLoad?: number;
  emmCount?: number;
  timeoutCount?: number;
  sendq?: number;
  cutime?: number;
  avgtime?: number;
  serviceCount?: number;
  providerIdents?: string;
  cardData1?: string;
  services: Service[];
  remoteParams: KeyValue[];
}

export interface UserSession {
  user: string;
  displayName?: string;
  profile: string;
  host: string;
  clientId?: string;
  active: boolean;
  count?: number;
  duration?: string;
  lastZap?: string;
  ecmCount: number;
  emmCount: number;
  au?: string;
  avgEcmInterval?: number;
  pendingCount?: number;
  lastTransaction?: number;
  keepaliveCount?: number;
  flags?: string;
  service?: Service;
  timeClient?: number;
  timeQueue?: number;
  timeCws?: number;
  timeCache?: number;
}

export interface ProxyUsers {
  count: number;
  loginFailures: number;
  sessions: UserSession[];
}

export interface LogEvent {
  type: string;
  timestamp: number;
  time: string;
  label?: string;
  message: string;
  logLevel?: string;
  /** Present on user-warning-log entries. */
  user?: string;
  profile?: string;
}

export interface SeenEntry {
  name: string;
  host?: string;
  profile?: string;
  lastLogin?: number;
  lastSeen?: number;
  reason?: string;
}

export interface FailureEntry {
  name: string;
  host?: string;
  count?: number;
  lastFailure?: number;
  firstFailure?: number;
  reason?: string;
}

export interface CommandParamOption {
  value: string;
}

export interface CommandParam {
  name: string;
  label?: string;
  value?: string;
  boolean: boolean;
  allowArbitrary: boolean;
  size?: number;
  options: CommandParamOption[];
}

export interface CtrlCommand {
  name: string;
  label?: string;
  description?: string;
  confirm: boolean;
  params: CommandParam[];
}

export interface CommandGroup {
  name: string;
  handler?: string;
  commands: CtrlCommand[];
}

export interface Plugin {
  name: string;
  version?: string;
  description?: string;
  params: KeyValue[];
}

export interface StatusSnapshot {
  proxy?: ProxyStatus;
  cache?: CacheStatus;
  profiles: CaProfile[];
  connectors: Connector[];
  plugins: Plugin[];
  users?: ProxyUsers;
  events: LogEvent[];
  fileLog: LogEvent[];
  warnings: LogEvent[];
  services: Service[];
  seen: SeenEntry[];
  failures: FailureEntry[];
  commandGroups: CommandGroup[];
  optionLists: Record<string, string[]>;
}

export interface CspIdentity {
  user: string;
  admin: boolean;
  superUser: boolean;
}

export interface StatusCommand {
  command: string;
  params?: Record<string, string | number | boolean | undefined>;
}

export interface Account {
  name: string;
  password: string;
  profiles?: string;
  ipMask?: string;
  maxConnections?: number;
  admin?: boolean;
  enabled?: boolean;
  debug?: boolean;
  displayName?: string;
  email?: string;
  mapExcluded?: boolean;
}
