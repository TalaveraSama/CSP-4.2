/**
 * Account management for the CSP backend.
 *
 * CardServProxy has no "create user" control command: accounts live as
 * `<user .../>` elements inside `<user-manager>` in proxy.xml, and the way to
 * change them is to fetch the config (`fetch-cfg`), edit it and post it back
 * to `/cfgHandler`, which makes the proxy reload.
 *
 * proxy.xml is a hand-maintained file full of comments and deliberate
 * formatting, so this module edits it as *text*. Parsing it into a DOM and
 * serialising it back would silently reformat the whole file and drop the
 * comments, which is exactly the kind of thing that makes people distrust a
 * panel.
 */

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
  /** OSCam/NCam only: the reader groups this account may use. */
  group?: string;
  /** OSCam/NCam only: expiry date (expdate), e.g. 2026-12-31. */
  expiry?: string;
}

/** Attribute name in proxy.xml <-> field in the Account model. */
const FIELDS: ReadonlyArray<readonly [keyof Account, string, 'string' | 'number' | 'boolean']> = [
  ['name', 'name', 'string'],
  ['password', 'password', 'string'],
  ['profiles', 'profiles', 'string'],
  ['ipMask', 'ip-mask', 'string'],
  ['maxConnections', 'max-connections', 'number'],
  ['admin', 'admin', 'boolean'],
  ['enabled', 'enabled', 'boolean'],
  ['debug', 'debug', 'boolean'],
  ['displayName', 'display-name', 'string'],
  ['email', 'email', 'string'],
  ['mapExcluded', 'map-exclude', 'boolean'],
];

/**
 * `<user .../>` or `<user ...> ... </user>`, including the leading indent.
 *
 * The lookahead matters: `<user\b` also matches `<user-manager>` (a hyphen is
 * a word boundary), and the greedy close would then swallow every account
 * inside it.
 */
const USER_RE = /([ \t]*)<user(?=[\s/>])([^>]*?)(\/>|>[\s\S]*?<\/user\s*>)/g;

/** `<user-manager>…</user-manager>`, the only place accounts may live. */
const MANAGER_RE = /<user-manager\b[\s\S]*?<\/user-manager\s*>/;

/**
 * Where the accounts of this document live.
 *
 * Two shapes, both of them CSP's:
 *  - proxy.xml: only inside <user-manager>. The file has other `<user>`
 *    elements — the credentials of every newcamd-connector, for one — and
 *    inserting an account next to those would quietly break the proxy.
 *  - a standalone user file (XmlUserManager's user-file-url): a document
 *    whose root holds nothing but accounts. Upstream ignores the root element
 *    name, so we do too.
 */
function managerRegion(xml: string): { start: number; end: number; text: string } | undefined {
  const m = MANAGER_RE.exec(xml);
  if (m) return { start: m.index, end: m.index + m[0].length, text: m[0] };
  // A proxy.xml without <user-manager> has nowhere to put accounts; anything
  // else is the external user file.
  if (/<cardserv-proxy\b/i.test(xml)) return undefined;
  return { start: 0, end: xml.length, text: xml };
}

/** Last closing tag of a standalone user file: where a new account goes. */
const ROOT_CLOSE_RE = /([ \t]*)<\/[A-Za-z][\w.-]*\s*>(?=\s*$)/;

export class AccountError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function attrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w:-]+)\s*=\s*"([^"]*)"|([\w:-]+)\s*=\s*'([^']*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const key = (m[1] ?? m[3])!.toLowerCase();
    out[key] = unescapeXml(m[2] ?? m[4] ?? '');
  }
  return out;
}

function toAccount(raw: string): Account | undefined {
  const a = attrs(raw);
  if (!a.name) return undefined;
  const account: Account = { name: a.name, password: a.password ?? '' };
  for (const [field, attr, kind] of FIELDS) {
    if (field === 'name' || field === 'password') continue;
    const value = a[attr];
    if (value === undefined || value === '') continue;
    if (kind === 'number') {
      const n = Number(value);
      if (Number.isFinite(n)) (account[field] as number) = n;
    } else if (kind === 'boolean') {
      (account[field] as boolean) = value === 'true' || value === '1' || value === 'yes';
    } else {
      (account[field] as string) = value;
    }
  }
  return account;
}

/** Render an account as a single self-closing element. */
function toElement(account: Account): string {
  const parts: string[] = [];
  for (const [field, attr, kind] of FIELDS) {
    const value = account[field];
    if (value === undefined || value === null || value === '') continue;
    if (kind === 'boolean') parts.push(`${attr}="${value ? 'true' : 'false'}"`);
    else parts.push(`${attr}="${escapeXml(String(value))}"`);
  }
  return `<user ${parts.join(' ')}/>`;
}

export function listAccounts(xml: string): Account[] {
  const region = managerRegion(xml);
  if (!region) return [];
  const out: Account[] = [];
  for (const match of region.text.matchAll(USER_RE)) {
    const account = toAccount(match[2] ?? '');
    if (account) out.push(account);
  }
  return out;
}

export function findAccount(xml: string, name: string): Account | undefined {
  return listAccounts(xml).find((a) => a.name === name);
}

/**
 * Every value that reaches a config file goes through here.
 *
 * ncam.user is a line oriented ini file: a value carrying a newline writes
 * *new keys* into the account. A reseller could have set his own
 * `group = 1,2,3,4` (readers he does not pay for) or `monlevel = 4` (monitor
 * access to the softcam) through the password field. Anything with a control
 * character is refused rather than silently stripped, so nobody wonders
 * later why half a password disappeared.
 */
const MAX_LENGTH: Partial<Record<keyof Account, number>> = {
  name: 64,
  password: 64,
  profiles: 256,
  ipMask: 256,
  displayName: 128,
  email: 128,
  group: 64,
  expiry: 32,
};

function clean(field: keyof Account, value: string): string {
  if (/[\x00-\x1f\x7f]/.test(value)) {
    throw new AccountError(`"${field}" cannot contain line breaks or control characters`);
  }
  const trimmed = value.trim();
  const max = MAX_LENGTH[field] ?? 128;
  if (trimmed.length > max) throw new AccountError(`"${field}" is too long (max ${max})`);
  return trimmed;
}

/** Validates in place: callers get back values safe for both file formats. */
function validate(account: Account): void {
  if (!account.name?.trim()) throw new AccountError('the account needs a name');
  if (!/^[\w.@-]+$/.test(account.name)) {
    throw new AccountError('the name may only contain letters, digits and . _ - @');
  }
  if (!account.password) throw new AccountError('the account needs a password');

  for (const [field, value] of Object.entries(account) as Array<[keyof Account, unknown]>) {
    if (typeof value === 'string') (account[field] as string) = clean(field, value);
  }

  if (account.expiry !== undefined && account.expiry !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(account.expiry)) {
    throw new AccountError('the expiry date must look like 2026-12-31');
  }
  if (account.maxConnections !== undefined && (!Number.isInteger(account.maxConnections) || account.maxConnections < 0)) {
    throw new AccountError('max-connections must be a positive whole number');
  }
}

/**
 * Insert or replace one account, leaving the rest of proxy.xml byte-identical.
 * New accounts are appended after the last existing one, or just before
 * `</user-manager>` when this is the first account.
 */
export function upsertAccount(xml: string, account: Account, { create }: { create: boolean }): string {
  validate(account);

  const region = managerRegion(xml);
  if (!region) {
    throw new AccountError(
      'proxy.xml has no <user-manager> section, so there is nowhere to store accounts. ' +
        'Add one (class="com.bowman.cardserv.SimpleUserManager") and try again.',
      409,
    );
  }

  const existing = [...region.text.matchAll(USER_RE)].filter((m) => attrs(m[2] ?? '').name);
  const match = existing.find((m) => attrs(m[2] ?? '').name === account.name);

  if (match) {
    if (create) throw new AccountError(`the account "${account.name}" already exists`, 409);
    const indent = match[1] ?? '';
    const start = region.start + match.index! + indent.length;
    return xml.slice(0, start) + toElement(account) + xml.slice(start + match[0].length - indent.length);
  }

  if (!create) throw new AccountError(`there is no account called "${account.name}"`, 404);

  const last = existing[existing.length - 1];
  if (last) {
    const indent = last[1] ?? '';
    const end = region.start + last.index! + last[0].length;
    return `${xml.slice(0, end)}\n${indent}${toElement(account)}${xml.slice(end)}`;
  }

  // First account: inside <auth-config> when the file has one, because that
  // is the path SimpleUserManager reads (user-manager/auth-config/user); in a
  // standalone user file, just before the closing root element.
  const anchor =
    /([ \t]*)<\/auth-config\s*>/.exec(region.text) ??
    /([ \t]*)<\/user-manager\s*>/.exec(region.text) ??
    ROOT_CLOSE_RE.exec(region.text);
  if (!anchor) {
    throw new AccountError('the user file has no element to put accounts in', 409);
  }
  const at = region.start + anchor.index;
  const indent = `${anchor[1] ?? ''}  `;
  return `${xml.slice(0, at)}${indent}${toElement(account)}\n${xml.slice(at)}`;
}

export function removeAccount(xml: string, name: string): string {
  const region = managerRegion(xml);
  if (!region) throw new AccountError(`there is no account called "${name}"`, 404);
  for (const match of region.text.matchAll(USER_RE)) {
    if (attrs(match[2] ?? '').name !== name) continue;
    const start = region.start + match.index!;
    let end = start + match[0].length;
    // Swallow the line break that followed the element, so no blank line is left.
    if (xml.startsWith('\r\n', end)) end += 2;
    else if (xml.startsWith('\n', end)) end += 1;
    return xml.slice(0, start) + xml.slice(end);
  }
  throw new AccountError(`there is no account called "${name}"`, 404);
}

/* -------------------------------------------------------------------------
 * OSCam / NCam accounts: ncam.user, an ini file of [account] blocks.
 *
 * Same rule as proxy.xml: edit the text, never regenerate it. These files are
 * full of per-account tuning (caid, ident, services, cacheex, betatunnel…)
 * that the panel does not model, and losing it on a password change would be
 * unforgivable.
 * ---------------------------------------------------------------------- */

/** Account model field <-> ncam.user key. */
const INI_FIELDS: ReadonlyArray<readonly [keyof Account, string]> = [
  ['name', 'user'],
  ['password', 'pwd'],
  ['displayName', 'description'],
  ['ipMask', 'hostname'],
  ['group', 'group'],
  ['maxConnections', 'max_connections'],
  ['expiry', 'expdate'],
];

const INI_PAD = 30;

function iniLine(key: string, value: string): string {
  return `${key.padEnd(INI_PAD)}= ${value}`;
}

interface IniBlock {
  start: number;
  end: number;
  lines: string[];
}

/** Split the file into [account] blocks, keeping their exact text. */
function iniBlocks(text: string): IniBlock[] {
  const lines = text.split('\n');
  const out: IniBlock[] = [];
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim().toLowerCase();
    if (line === '[account]') {
      if (start >= 0) out.push({ start, end: i, lines: lines.slice(start, i) });
      start = i;
    } else if (/^\[[a-z]+\]$/.test(line) && start >= 0) {
      out.push({ start, end: i, lines: lines.slice(start, i) });
      start = -1;
    }
  }
  if (start >= 0) out.push({ start, end: lines.length, lines: lines.slice(start) });
  return out;
}

function iniGet(block: IniBlock, key: string): string | undefined {
  for (const line of block.lines) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && m[1]!.toLowerCase() === key) return m[2];
  }
  return undefined;
}

function blockToAccount(block: IniBlock): Account | undefined {
  const name = iniGet(block, 'user');
  if (!name) return undefined;
  const account: Account = { name, password: iniGet(block, 'pwd') ?? '' };
  for (const [field, key] of INI_FIELDS) {
    if (field === 'name' || field === 'password') continue;
    const value = iniGet(block, key);
    if (value === undefined || value === '') continue;
    if (field === 'maxConnections') {
      const n = Number(value);
      if (Number.isFinite(n)) account.maxConnections = n;
    } else {
      (account[field] as string) = value;
    }
  }
  // NCam stores the negative: disabled = 1.
  account.enabled = iniGet(block, 'disabled') !== '1';
  return account;
}

export function listIniAccounts(text: string): Account[] {
  const out: Account[] = [];
  for (const block of iniBlocks(text)) {
    const account = blockToAccount(block);
    if (account) out.push(account);
  }
  return out;
}

export function findIniAccount(text: string, name: string): Account | undefined {
  return listIniAccounts(text).find((a) => a.name === name);
}

/** Rewrite one block, keeping every key the panel does not know about. */
function applyToBlock(lines: string[], account: Account): string[] {
  const wanted = new Map<string, string | undefined>();
  for (const [field, key] of INI_FIELDS) {
    const value = account[field];
    wanted.set(key, value === undefined || value === '' ? undefined : String(value));
  }
  wanted.set('disabled', account.enabled === false ? '1' : undefined);

  const seen = new Set<string>();
  const out = lines.map((line) => {
    const m = /^(\s*)([A-Za-z0-9_]+)(\s*)=\s*(.*?)\s*$/.exec(line);
    if (!m) return line;
    const key = m[2]!.toLowerCase();
    if (!wanted.has(key)) return line; // not ours: leave it exactly as it is
    seen.add(key);
    const value = wanted.get(key);
    // Dropping a value means dropping the line (e.g. re-enabling an account).
    return value === undefined ? null : iniLine(m[2]!, value);
  }).filter((line): line is string => line !== null);

  // New keys go after the last real line of the block, not after the blank
  // line that separates it from the next [account].
  const trailing: string[] = [];
  while (out.length > 0 && out[out.length - 1]!.trim() === '') trailing.unshift(out.pop()!);
  for (const [key, value] of wanted) {
    if (value === undefined || seen.has(key)) continue;
    out.push(iniLine(key, value));
  }
  return [...out, ...trailing];
}

export function upsertIniAccount(text: string, account: Account, { create }: { create: boolean }): string {
  validate(account);
  const lines = text.split('\n');
  const blocks = iniBlocks(text);
  const existing = blocks.find((b) => iniGet(b, 'user') === account.name);

  if (existing) {
    if (create) throw new AccountError(`the account "${account.name}" already exists`, 409);
    const replaced = applyToBlock(existing.lines, account);
    return [...lines.slice(0, existing.start), ...replaced, ...lines.slice(existing.end)].join('\n');
  }

  if (!create) throw new AccountError(`there is no account called "${account.name}"`, 404);

  const block = applyToBlock(['[account]'], account);
  const body = text.replace(/\s*$/, '');
  return `${body}\n\n${block.join('\n')}\n`;
}

export function removeIniAccount(text: string, name: string): string {
  const lines = text.split('\n');
  const block = iniBlocks(text).find((b) => iniGet(b, 'user') === name);
  if (!block) throw new AccountError(`there is no account called "${name}"`, 404);
  let start = block.start;
  // Swallow the blank lines that separated this block from the previous one.
  while (start > 0 && lines[start - 1]!.trim() === '') start -= 1;
  const kept = [...lines.slice(0, start), ...lines.slice(block.end)];
  return kept.join('\n').replace(/^\n+/, '');
}
