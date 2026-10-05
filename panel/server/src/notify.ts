import type { ResellerStore } from './resellers.js';

/**
 * Warning before the line dies.
 *
 * A customer cut off without notice is a customer phoning his reseller
 * angry, so the panel shows what expires soon and can push a daily digest to
 * Telegram: one message to the operator with everything, and one to each
 * reseller who has a chat id, with only his own.
 */

export interface ExpiringLine {
  name: string;
  /** ISO date. */
  expiresAt: string;
  /** Negative when it already expired. */
  daysLeft: number;
  owner: string;
  ownerId: string;
}

export function daysUntil(date: string, now = new Date()): number {
  const end = new Date(`${date}T23:59:59Z`).getTime();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((end - today) / 86_400_000) - 1;
}

/**
 * Lines expiring within `days`, expired ones included: a reseller wants to
 * see both the one that dies tomorrow and the one that died yesterday.
 */
export function expiringSoon(resellers: ResellerStore, days = 3, now = new Date()): ExpiringLine[] {
  const out: ExpiringLine[] = [];
  for (const [name, record] of Object.entries(resellersClients(resellers))) {
    if (!record.expiresAt) continue;
    const daysLeft = daysUntil(record.expiresAt, now);
    if (daysLeft > days) continue;
    out.push({
      name,
      expiresAt: record.expiresAt,
      daysLeft,
      ownerId: record.owner,
      owner: resellers.byId(record.owner)?.user ?? 'admin',
    });
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft || a.name.localeCompare(b.name));
}

/** The store keeps clients private; this is the only place that needs them all. */
function resellersClients(resellers: ResellerStore): Record<string, { owner: string; expiresAt?: string }> {
  const out: Record<string, { owner: string; expiresAt?: string }> = {};
  for (const owner of ['admin', ...resellers.list().map((r) => r.id)]) {
    for (const name of resellers.clientsOf(owner)) {
      const record = resellers.record(name);
      if (record) out[name] = { owner: record.owner, expiresAt: record.expiresAt };
    }
  }
  return out;
}

/** Plain text, because Telegram markdown breaks on names with underscores. */
export function digest(lines: ExpiringLine[], title: string, withOwner: boolean): string | undefined {
  if (lines.length === 0) return undefined;
  const when = (l: ExpiringLine) =>
    l.daysLeft < 0 ? `vencida hace ${-l.daysLeft} d` : l.daysLeft === 0 ? 'vence hoy' : `${l.daysLeft} d`;
  const rows = lines.map((l) => `• ${l.name} — ${when(l)} (${l.expiresAt})${withOwner ? ` · ${l.owner}` : ''}`);
  return `${title}\n${rows.join('\n')}`;
}

export interface TelegramConfig {
  token: string;
  /** Chat of the operator; each reseller may have his own. */
  chatId?: string;
}

export async function sendTelegram(
  config: TelegramConfig,
  chatId: string,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const url = `${process.env.TELEGRAM_API ?? 'https://api.telegram.org'}/bot${config.token}/sendMessage`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  if (!res.ok) throw new Error(`telegram answered HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/**
 * One digest a day, to the operator and to every reseller with a chat id.
 * Returns what was sent, so the caller can log it.
 */
export async function notifyExpiring(options: {
  resellers: ResellerStore;
  telegram?: TelegramConfig;
  days?: number;
  now?: Date;
  fetchImpl?: typeof fetch;
}): Promise<{ lines: ExpiringLine[]; sent: string[]; failed: string[] }> {
  const days = options.days ?? 3;
  const lines = expiringSoon(options.resellers, days, options.now);
  const sent: string[] = [];
  const failed: string[] = [];
  if (!options.telegram?.token || lines.length === 0) return { lines, sent, failed };

  const title = `Líneas que vencen en ${days} día(s)`;
  const targets: Array<{ chatId: string; text: string; label: string }> = [];

  if (options.telegram.chatId) {
    const text = digest(lines, title, true);
    if (text) targets.push({ chatId: options.telegram.chatId, text, label: 'operator' });
  }

  for (const reseller of options.resellers.list()) {
    const chatId = reseller.telegramChatId;
    if (!chatId) continue;
    const own = lines.filter((l) => l.ownerId === reseller.id);
    const text = digest(own, title, false);
    if (text) targets.push({ chatId, text, label: reseller.user });
  }

  for (const target of targets) {
    try {
      await sendTelegram(options.telegram, target.chatId, target.text, options.fetchImpl);
      sent.push(target.label);
    } catch {
      failed.push(target.label);
    }
  }
  return { lines, sent, failed };
}

/** Fire the digest once a day at `hour` (local time), and never twice. */
export function startNotifier(options: {
  resellers: ResellerStore;
  telegram?: TelegramConfig;
  days?: number;
  hour?: number;
  log?: (message: string) => void;
}): () => void {
  const hour = options.hour ?? 9;
  const log = options.log ?? (() => undefined);
  let lastRun = '';

  const tick = async () => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    if (now.getHours() !== hour || lastRun === today) return;
    lastRun = today;
    const { lines, sent, failed } = await notifyExpiring({ ...options, now });
    if (lines.length > 0) log(`${lines.length} line(s) expiring; notified: ${sent.join(', ') || 'nobody'}`);
    for (const who of failed) log(`could not notify ${who}`);
  };

  const timer = setInterval(() => void tick(), 5 * 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
