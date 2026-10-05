import { findOne, resolveAccountStore, upsert } from './account-store.js';
import type { BackendAuth, ProxyBackend } from './backend.js';
import type { ResellerStore } from './resellers.js';

/**
 * Cutting off lines that ran out.
 *
 * Credits only mean something if a line stops working when the month is up.
 * The panel keeps the expiry date itself (so this works on any backend) and
 * this sweeper disables the accounts whose date has passed. It disables,
 * never deletes: a customer who renews must get his line back, with its
 * settings and its history.
 */

export interface SweepResult {
  checked: number;
  disabled: string[];
  failed: Array<{ name: string; error: string }>;
}

export async function sweepExpired(
  backend: ProxyBackend,
  resellers: ResellerStore,
  auth: BackendAuth,
  now = new Date(),
): Promise<SweepResult> {
  const expired = resellers.expired(now);
  const result: SweepResult = { checked: expired.length, disabled: [], failed: [] };
  if (expired.length === 0) return result;

  const store = await resolveAccountStore(backend, auth);

  // One read/write per account would be N round trips to the softcam; this
  // reads once, applies everything and writes once.
  let text = await store.read();
  let changed = false;

  for (const name of expired) {
    const account = findOne(store, text, name);
    if (!account) {
      // Deleted behind the panel's back: stop tracking it.
      resellers.release(name);
      continue;
    }
    if (account.enabled === false) continue; // already cut off
    try {
      text = upsert(store, text, { ...account, enabled: false }, false);
      result.disabled.push(name);
      changed = true;
    } catch (err) {
      result.failed.push({ name, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (changed) await store.write(text);
  return result;
}

/**
 * Run the sweep every `intervalMs`, and once at startup: the panel may have
 * been down while a dozen lines expired.
 */
export function startExpirySweeper(options: {
  backend: ProxyBackend;
  resellers: ResellerStore;
  auth: () => BackendAuth | undefined;
  intervalMs?: number;
  log?: (message: string) => void;
}): () => void {
  const interval = options.intervalMs ?? 10 * 60_000;
  const log = options.log ?? (() => undefined);

  const run = async () => {
    const auth = options.auth();
    if (!auth) return; // no service credentials yet; nothing we can do
    try {
      const result = await sweepExpired(options.backend, options.resellers, auth);
      if (result.disabled.length > 0) log(`expired, disabled: ${result.disabled.join(', ')}`);
      for (const failure of result.failed) log(`could not disable ${failure.name}: ${failure.error}`);
    } catch (err) {
      log(`sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const timer = setInterval(() => void run(), interval);
  timer.unref?.();
  // A few seconds in, so a panel that is still starting does not race the
  // backend's own startup.
  const first = setTimeout(() => void run(), 15_000);
  first.unref?.();

  return () => {
    clearInterval(timer);
    clearTimeout(first);
  };
}
