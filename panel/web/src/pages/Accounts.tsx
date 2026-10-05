import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useApp } from '../app-context';
import { usePolling } from '../hooks';
import { Badge, Card, Empty, ErrorBox } from '../components/ui';
import type { Account } from '../types';

const BLANK: Account = { name: '', password: '', profiles: '', ipMask: '', enabled: true };

/** Accounts live in proxy.xml; every change is a fetch / edit / post round trip. */
export function Accounts() {
  const { interval, onUnauthorized, meta } = useApp();
  const load = useCallback(() => api.accounts(), []);
  const { data, error, refresh } = usePolling(load, interval, [], onUnauthorized);

  const [editing, setEditing] = useState<Account | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [failure, setFailure] = useState<string>();

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(undefined), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  if (!meta.features.accounts) {
    return (
      <Card title="Accounts">
        <Empty>
          {meta.kind === 'csp'
            ? 'This backend does not expose its user list.'
            : `${meta.labels.product ?? meta.kind} keeps its accounts in its own config file — open the Config tab to edit it.`}
        </Empty>
      </Card>
    );
  }

  const run = async (what: () => Promise<{ message: string }>) => {
    setBusy(true);
    setFailure(undefined);
    try {
      setNotice((await what()).message);
      setEditing(null);
      setCreating(false);
      refresh();
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const save = (account: Account) =>
    run(() => (creating ? api.createAccount(account) : api.updateAccount(account.name, account)));

  const remove = (name: string) => {
    if (!confirm(`Delete the account "${name}"? Its sessions will be dropped on the next reload.`)) return;
    void run(() => api.deleteAccount(name));
  };

  if (error) return <ErrorBox error={error} onRetry={refresh} />;
  if (!data) return <Empty>Loading accounts…</Empty>;

  const accounts = data.accounts;

  return (
    <>
      {notice && <div className="notice">{notice}</div>}
      {failure && <div className="errorbox">{failure}</div>}

      <Card
        title={`Accounts (${accounts.length})`}
        actions={
          <>
            <button className="mini" onClick={refresh} disabled={busy}>
              Reload
            </button>
            <button
              className="mini primary"
              disabled={busy || !data.writable}
              onClick={() => {
                setCreating(true);
                setEditing({ ...BLANK });
              }}
            >
              New account
            </button>
          </>
        }
      >
        {accounts.length === 0 ? (
          <Empty>No accounts defined in proxy.xml yet.</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>User</th>
                <th>Profiles</th>
                <th>IP mask</th>
                <th className="r">Max conn.</th>
                <th>Flags</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.name} className={a.enabled === false ? 'inactive' : ''}>
                  <td>
                    <strong>{a.name}</strong>
                    {a.displayName && <div className="muted small">{a.displayName}</div>}
                  </td>
                  <td>{a.profiles || <span className="muted">all</span>}</td>
                  <td>{a.ipMask || <span className="muted">any</span>}</td>
                  <td className="r">{a.maxConnections ?? '—'}</td>
                  <td className="nowrap">
                    {a.admin && <Badge tone="info">admin</Badge>}
                    {a.enabled === false && <Badge tone="bad">disabled</Badge>}
                    {a.debug && <Badge tone="warn">debug</Badge>}
                  </td>
                  <td className="r nowrap">
                    <button
                      className="mini"
                      disabled={busy}
                      onClick={() => {
                        setCreating(false);
                        setEditing({ ...a, password: '' });
                      }}
                    >
                      Edit
                    </button>
                    <button className="mini danger" disabled={busy} onClick={() => remove(a.name)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small">
          Stored as <code>&lt;user&gt;</code> elements in proxy.xml. Saving posts the whole config back to the proxy,
          which reloads it — existing sessions stay connected.
        </p>
      </Card>

      {editing && (
        <AccountForm
          account={editing}
          creating={creating}
          busy={busy}
          onCancel={() => {
            setEditing(null);
            setCreating(false);
          }}
          onSave={save}
        />
      )}
    </>
  );
}

function AccountForm({
  account,
  creating,
  busy,
  onCancel,
  onSave,
}: {
  account: Account;
  creating: boolean;
  busy: boolean;
  onCancel: () => void;
  onSave: (a: Account) => void;
}) {
  const [form, setForm] = useState<Account>(account);
  const set = <K extends keyof Account>(key: K, value: Account[K]) => setForm((f) => ({ ...f, [key]: value }));

  return (
    <Card title={creating ? 'New account' : `Edit ${account.name}`}>
      <form
        className="acctform"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(form);
        }}
      >
        <label className="cmdparam">
          <span>User name</span>
          <input
            value={form.name}
            disabled={!creating}
            autoFocus={creating}
            onChange={(e) => set('name', e.target.value)}
            placeholder="cliente1"
            required
          />
        </label>
        <label className="cmdparam">
          <span>Password{!creating && <em> (leave empty to keep it)</em>}</span>
          <input
            value={form.password}
            type="text"
            onChange={(e) => set('password', e.target.value)}
            required={creating}
          />
        </label>
        <label className="cmdparam">
          <span>Profiles</span>
          <input
            value={form.profiles ?? ''}
            onChange={(e) => set('profiles', e.target.value)}
            placeholder="cable sat (empty = all)"
          />
        </label>
        <label className="cmdparam">
          <span>IP mask</span>
          <input value={form.ipMask ?? ''} onChange={(e) => set('ipMask', e.target.value)} placeholder="192.168.0.*" />
        </label>
        <label className="cmdparam">
          <span>Max connections</span>
          <input
            type="number"
            min={0}
            value={form.maxConnections ?? ''}
            onChange={(e) => set('maxConnections', e.target.value === '' ? undefined : Number(e.target.value))}
            placeholder="unlimited"
          />
        </label>
        <label className="cmdparam">
          <span>Display name</span>
          <input value={form.displayName ?? ''} onChange={(e) => set('displayName', e.target.value)} />
        </label>
        <div className="acctchecks">
          <label className="check">
            <input type="checkbox" checked={form.enabled !== false} onChange={(e) => set('enabled', e.target.checked)} />
            <span>Enabled</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={!!form.admin} onChange={(e) => set('admin', e.target.checked)} />
            <span>Admin</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={!!form.debug} onChange={(e) => set('debug', e.target.checked)} />
            <span>Debug</span>
          </label>
        </div>
        <div className="acctactions">
          <button type="button" className="mini" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="mini primary" disabled={busy}>
            {busy ? 'Saving…' : creating ? 'Create' : 'Save'}
          </button>
        </div>
      </form>
    </Card>
  );
}
