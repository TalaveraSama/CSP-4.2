import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Resellers.
 *
 * The panel had no user database: it forwarded the login to the softcam. A
 * reseller cannot work that way — he needs to log in and see *only his own*
 * clients — so this is the panel's own little store: accounts with a role, a
 * credit balance, and who owns which client.
 *
 * It is a single JSON file written atomically. A thousand clients and a
 * handful of resellers is a few hundred kB; a database would be ceremony.
 *
 * Credits: creating or renewing a line costs one credit per month. Deleting
 * refunds nothing — otherwise a reseller could recycle credits forever.
 */

export type Role = 'admin' | 'reseller';

export interface Reseller {
  id: string;
  user: string;
  /** scrypt: salt:hash, both hex. */
  password: string;
  credits: number;
  enabled: boolean;
  note?: string;
  /** Optional: where to send him his own expiry digest. */
  telegramChatId?: string;
  /**
   * Reader groups (NCam) or profiles (CSP) this reseller may sell. When set,
   * it is forced on every account he creates or edits: otherwise he could
   * give his customers access to cards he does not pay for.
   */
  group?: string;
  createdAt: string;
}

export interface ClientRecord {
  /** Reseller id, or 'admin' for the ones the administrator created. */
  owner: string;
  /** ISO date; the panel enforces it even on backends with no expiry field. */
  expiresAt?: string;
  createdAt: string;
}

export interface LedgerEntry {
  ts: string;
  reseller: string;
  delta: number;
  balance: number;
  reason: string;
}

interface Database {
  version: 1;
  resellers: Reseller[];
  clients: Record<string, ClientRecord>;
  ledger: LedgerEntry[];
}

const EMPTY: Database = { version: 1, resellers: [], clients: {}, ledger: [] };
const LEDGER_MAX = 2000;

export class ResellerError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

function hash(password: string, salt = randomBytes(16).toString('hex')): string {
  return `${salt}:${scryptSync(password, salt, 32).toString('hex')}`;
}

function verify(password: string, stored: string): boolean {
  const [salt, digest] = stored.split(':');
  if (!salt || !digest) return false;
  const expected = Buffer.from(digest, 'hex');
  const actual = scryptSync(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Add months to a date, clamping the day (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(from: Date, months: number): Date {
  const out = new Date(from.getTime());
  const day = out.getDate();
  out.setMonth(out.getMonth() + months);
  if (out.getDate() < day) out.setDate(0);
  return out;
}

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export class ResellerStore {
  private db: Database = structuredClone(EMPTY);

  constructor(private readonly path: string) {
    this.load();
  }

  private load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Database;
      this.db = { ...structuredClone(EMPTY), ...parsed };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new ResellerError(`cannot read ${this.path}: ${(err as Error).message}`, 500);
      }
    }
  }

  /** Write through a temporary file: a half written store is unrecoverable. */
  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.db, null, 2)}\n`, { mode: 0o640 });
    renameSync(tmp, this.path);
  }

  /* -------------------------------------------------------- resellers */

  list(): Array<Omit<Reseller, 'password'> & { clients: number }> {
    return this.db.resellers.map((r) => ({
      id: r.id,
      user: r.user,
      credits: r.credits,
      enabled: r.enabled,
      note: r.note,
      telegramChatId: r.telegramChatId,
      group: r.group,
      createdAt: r.createdAt,
      clients: Object.values(this.db.clients).filter((c) => c.owner === r.id).length,
    }));
  }

  find(user: string): Reseller | undefined {
    return this.db.resellers.find((r) => r.user.toLowerCase() === user.toLowerCase());
  }

  byId(id: string): Reseller | undefined {
    return this.db.resellers.find((r) => r.id === id);
  }

  create(user: string, password: string, credits = 0, note?: string): Reseller {
    if (!/^[\w.@-]{2,32}$/.test(user)) {
      throw new ResellerError('the name may only contain letters, digits and . _ - @');
    }
    if (!password || password.length < 4) throw new ResellerError('the password is too short');
    if (this.find(user)) throw new ResellerError(`the reseller "${user}" already exists`, 409);
    if (!Number.isInteger(credits) || credits < 0) throw new ResellerError('credits must be a positive whole number');

    const reseller: Reseller = {
      id: randomUUID(),
      user,
      password: hash(password),
      credits,
      enabled: true,
      note,
      createdAt: new Date().toISOString(),
    };
    this.db.resellers.push(reseller);
    if (credits > 0) this.log(reseller, credits, 'initial balance');
    this.save();
    return reseller;
  }

  update(
    id: string,
    patch: { password?: string; enabled?: boolean; note?: string; telegramChatId?: string; group?: string },
  ): Reseller {
    const reseller = this.byId(id);
    if (!reseller) throw new ResellerError('no such reseller', 404);
    if (patch.password) {
      if (patch.password.length < 4) throw new ResellerError('the password is too short');
      reseller.password = hash(patch.password);
    }
    if (patch.enabled !== undefined) reseller.enabled = patch.enabled;
    if (patch.note !== undefined) reseller.note = patch.note;
    if (patch.telegramChatId !== undefined) {
      reseller.telegramChatId = patch.telegramChatId || undefined;
    }
    if (patch.group !== undefined) {
      if (/[\x00-\x1f\x7f]/.test(patch.group) || patch.group.length > 64) {
        throw new ResellerError('the group is not valid');
      }
      reseller.group = patch.group || undefined;
    }
    this.save();
    return reseller;
  }

  remove(id: string): void {
    const before = this.db.resellers.length;
    this.db.resellers = this.db.resellers.filter((r) => r.id !== id);
    if (this.db.resellers.length === before) throw new ResellerError('no such reseller', 404);
    // Their clients stay alive and fall back to the administrator: cutting
    // off paying customers because their reseller left would be worse.
    for (const record of Object.values(this.db.clients)) if (record.owner === id) record.owner = 'admin';
    this.save();
  }

  login(user: string, password: string): Reseller | undefined {
    const reseller = this.find(user);
    if (!reseller) return undefined;
    if (!verify(password, reseller.password)) return undefined;
    if (!reseller.enabled) throw new ResellerError('this reseller account is disabled', 403);
    return reseller;
  }

  /* ---------------------------------------------------------- credits */

  private log(reseller: Reseller, delta: number, reason: string): void {
    this.db.ledger.push({
      ts: new Date().toISOString(),
      reseller: reseller.user,
      delta,
      balance: reseller.credits,
      reason,
    });
    if (this.db.ledger.length > LEDGER_MAX) this.db.ledger.splice(0, this.db.ledger.length - LEDGER_MAX);
  }

  addCredits(id: string, amount: number, reason = 'top up'): Reseller {
    const reseller = this.byId(id);
    if (!reseller) throw new ResellerError('no such reseller', 404);
    if (!Number.isInteger(amount) || amount === 0) throw new ResellerError('the amount must be a whole number');
    if (reseller.credits + amount < 0) throw new ResellerError('that would leave a negative balance');
    reseller.credits += amount;
    this.log(reseller, amount, reason);
    this.save();
    return reseller;
  }

  /** Charge for `months`, or throw if the balance is not enough. */
  charge(id: string, months: number, reason: string): void {
    const reseller = this.byId(id);
    if (!reseller) throw new ResellerError('no such reseller', 404);
    if (!Number.isInteger(months) || months < 1) throw new ResellerError('months must be 1 or more');
    if (reseller.credits < months) {
      throw new ResellerError(`not enough credits: ${reseller.credits} left, ${months} needed`, 402);
    }
    reseller.credits -= months;
    this.log(reseller, -months, reason);
    this.save();
  }

  ledger(limit = 100, resellerId?: string): LedgerEntry[] {
    const name = resellerId ? this.byId(resellerId)?.user : undefined;
    const rows = resellerId ? this.db.ledger.filter((e) => e.reseller === name) : this.db.ledger;
    return rows.slice(-limit).reverse();
  }

  /* ---------------------------------------------------------- clients */

  owner(client: string): string | undefined {
    return this.db.clients[client]?.owner;
  }

  record(client: string): ClientRecord | undefined {
    return this.db.clients[client];
  }

  clientsOf(ownerId: string): string[] {
    return Object.entries(this.db.clients)
      .filter(([, c]) => c.owner === ownerId)
      .map(([name]) => name);
  }

  claim(client: string, owner: string, expiresAt?: string): void {
    this.db.clients[client] = {
      owner,
      expiresAt,
      createdAt: this.db.clients[client]?.createdAt ?? new Date().toISOString(),
    };
    this.save();
  }

  setExpiry(client: string, expiresAt: string | undefined): void {
    const record = this.db.clients[client];
    if (!record) return;
    record.expiresAt = expiresAt;
    this.save();
  }

  release(client: string): void {
    delete this.db.clients[client];
    this.save();
  }

  /** Clients whose date has passed; the caller disables them. */
  expired(now = new Date()): string[] {
    const today = isoDate(now);
    return Object.entries(this.db.clients)
      .filter(([, c]) => c.expiresAt && c.expiresAt < today)
      .map(([name]) => name);
  }
}
