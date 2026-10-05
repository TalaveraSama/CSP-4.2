import { useCallback, useState } from 'react';
import { api } from '../api';
import { useApp } from '../app-context';
import { usePolling } from '../hooks';
import { Badge, Card, Empty, ErrorBox, Stat } from '../components/ui';
import { num } from '../format';
import type { Reseller } from '../types';

/** Resellers: panel-only accounts that sell lines out of a credit balance. */
export function Resellers() {
  const { interval, onUnauthorized } = useApp();
  const load = useCallback(() => api.resellers(), []);
  const { data, error, refresh } = usePolling(load, interval, [], onUnauthorized);

  const [form, setForm] = useState<{ user: string; password: string; credits: string; note: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [failure, setFailure] = useState<string>();

  const run = async (what: () => Promise<{ message: string }>) => {
    setBusy(true);
    setFailure(undefined);
    try {
      setNotice((await what()).message);
      setForm(null);
      refresh();
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const topUp = (r: Reseller) => {
    const amount = prompt(`Credits to add to "${r.user}" (negative to subtract):`, '10');
    if (amount === null) return;
    const n = Number(amount);
    if (!Number.isInteger(n) || n === 0) return setFailure('give a whole number other than zero');
    void run(() => api.updateReseller(r.id, { credits: n }));
  };

  const setPassword = (r: Reseller) => {
    const password = prompt(`New password for "${r.user}":`);
    if (!password) return;
    void run(() => api.updateReseller(r.id, { password }));
  };

  const remove = (r: Reseller) => {
    if (!confirm(`Delete the reseller "${r.user}"? His ${r.clients} client(s) stay alive and pass to you.`)) return;
    void run(() => api.deleteReseller(r.id));
  };

  if (error) return <ErrorBox error={error} onRetry={refresh} />;
  if (!data) return <Empty>Loading resellers…</Empty>;

  const totalCredits = data.resellers.reduce((acc, r) => acc + r.credits, 0);
  const totalClients = data.resellers.reduce((acc, r) => acc + r.clients, 0);

  return (
    <>
      {notice && <div className="notice">{notice}</div>}
      {failure && <div className="errorbox">{failure}</div>}

      <div className="stats">
        <Stat label="Resellers" value={num(data.resellers.length)} sub={`${data.resellers.filter((r) => r.enabled).length} active`} />
        <Stat label="Credits out there" value={num(totalCredits)} sub="1 credit = 1 month of one line" />
        <Stat label="Their clients" value={num(totalClients)} />
      </div>

      <Card
        title="Resellers"
        actions={
          <>
            <button className="mini" onClick={refresh} disabled={busy}>
              Reload
            </button>
            <button
              className="mini primary"
              disabled={busy}
              onClick={() => setForm({ user: '', password: '', credits: '0', note: '' })}
            >
              New reseller
            </button>
          </>
        }
      >
        {data.resellers.length === 0 ? (
          <Empty>No resellers yet. Create one and give him credits; he will see only his own clients.</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Reseller</th>
                <th className="r">Credits</th>
                <th className="r">Clients</th>
                <th>Since</th>
                <th>Note</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.resellers.map((r) => (
                <tr key={r.id} className={r.enabled ? '' : 'inactive'}>
                  <td>
                    <strong>{r.user}</strong> {!r.enabled && <Badge tone="bad">disabled</Badge>}
                  </td>
                  <td className="r">
                    <Badge tone={r.credits > 10 ? 'ok' : r.credits > 0 ? 'warn' : 'bad'}>{num(r.credits)}</Badge>
                  </td>
                  <td className="r">{num(r.clients)}</td>
                  <td className="muted small">{r.createdAt.slice(0, 10)}</td>
                  <td className="muted small">{r.note}</td>
                  <td className="r nowrap">
                    <button className="mini" disabled={busy} onClick={() => topUp(r)}>
                      Credits
                    </button>
                    <button className="mini" disabled={busy} onClick={() => setPassword(r)}>
                      Password
                    </button>
                    <button
                      className="mini"
                      disabled={busy}
                      onClick={() => void run(() => api.updateReseller(r.id, { enabled: !r.enabled }))}
                    >
                      {r.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button className="mini danger" disabled={busy} onClick={() => remove(r)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {form && (
        <Card title="New reseller">
          <form
            className="acctform"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() =>
                api.createReseller({
                  user: form.user,
                  password: form.password,
                  credits: Number(form.credits) || 0,
                  note: form.note || undefined,
                }),
              );
            }}
          >
            <label className="cmdparam">
              <span>User name</span>
              <input value={form.user} autoFocus onChange={(e) => setForm({ ...form, user: e.target.value })} required />
            </label>
            <label className="cmdparam">
              <span>Password</span>
              <input value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
            </label>
            <label className="cmdparam">
              <span>Credits</span>
              <input
                type="number"
                min={0}
                value={form.credits}
                onChange={(e) => setForm({ ...form, credits: e.target.value })}
              />
            </label>
            <label className="cmdparam">
              <span>Note</span>
              <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="whatsapp, zona…" />
            </label>
            <div className="acctactions">
              <button type="button" className="mini" onClick={() => setForm(null)} disabled={busy}>
                Cancel
              </button>
              <button type="submit" className="mini primary" disabled={busy}>
                {busy ? 'Creating…' : 'Create'}
              </button>
            </div>
          </form>
        </Card>
      )}

      <Card title="Credit movements">
        {data.ledger.length === 0 ? (
          <Empty>Nothing yet.</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Reseller</th>
                <th className="r">Change</th>
                <th className="r">Balance</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {data.ledger.map((e, i) => (
                <tr key={`${e.ts}-${i}`}>
                  <td className="muted small nowrap">{e.ts.slice(0, 16).replace('T', ' ')}</td>
                  <td>{e.reseller}</td>
                  <td className="r">
                    <span className={e.delta < 0 ? 'bad' : ''}>
                      {e.delta > 0 ? '+' : ''}
                      {e.delta}
                    </span>
                  </td>
                  <td className="r">{e.balance}</td>
                  <td className="muted small">{e.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
