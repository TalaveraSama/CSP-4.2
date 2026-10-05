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
 * Accounts are only looked for inside <user-manager>. proxy.xml has other
 * `<user>` elements — the credentials of every newcamd-connector, for one —
 * and inserting an account next to those would quietly break the proxy.
 */
function managerRegion(xml: string): { start: number; end: number; text: string } | undefined {
  const m = MANAGER_RE.exec(xml);
  if (!m) return undefined;
  return { start: m.index, end: m.index + m[0].length, text: m[0] };
}

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

function validate(account: Account): void {
  if (!account.name?.trim()) throw new AccountError('the account needs a name');
  if (!/^[\w.@-]+$/.test(account.name)) {
    throw new AccountError('the name may only contain letters, digits and . _ - @');
  }
  if (!account.password) throw new AccountError('the account needs a password');
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

  // First account: right before </user-manager>, which is where CSP's
  // SimpleUserManager/XmlUserManager look for them.
  const anchor = /([ \t]*)<\/user-manager\s*>/.exec(region.text)!;
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
