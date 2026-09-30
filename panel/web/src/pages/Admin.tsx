import { useCallback, useState, type FormEvent } from 'react';
import { api } from '../api';
import { useApp } from '../app-context';
import { usePolling } from '../hooks';
import { Card, Empty, ErrorBox } from '../components/ui';
import type { CtrlCommand, StatusSnapshot } from '../types';

function CommandForm({ command, optionLists, onDone }: { command: CtrlCommand; optionLists: Record<string, string[]>; onDone: (msg: string) => void }) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const p of command.params) {
      const first = p.options[0]?.value ?? '';
      init[p.name] = first.startsWith('@') ? (optionLists[first]?.[0] ?? '') : (p.value ?? first);
    }
    return init;
  });
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (command.confirm && !confirm(`Run "${command.label ?? command.name}"?`)) return;
    setBusy(true);
    try {
      const res = await api.runCommand(command.name, { ...values, ...(command.confirm ? { confirm: 'true' } : {}) });
      onDone(res.message);
    } catch (err) {
      onDone(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="cmdform" onSubmit={submit}>
      <div className="cmdhead">
        <strong>{command.label ?? command.name}</strong>
        <code className="muted">{command.name}</code>
      </div>
      <p className="muted small">{command.description}</p>
      <div className="cmdrow">
        {command.params.map((p) => {
          const listRef = p.options[0]?.value;
          const list = listRef?.startsWith('@') ? (optionLists[listRef] ?? []) : p.options.map((o) => o.value);
          const set = (v: string) => setValues((prev) => ({ ...prev, [p.name]: v }));
          return (
            <label key={p.name} className="cmdparam">
              <span>{p.label ?? p.name}</span>
              {p.boolean ? (
                <input type="checkbox" checked={values[p.name] === 'true'} onChange={(e) => set(String(e.target.checked))} />
              ) : p.allowArbitrary ? (
                <input value={values[p.name] ?? ''} onChange={(e) => set(e.target.value)} />
              ) : (
                <select value={values[p.name] ?? ''} onChange={(e) => set(e.target.value)}>
                  {list.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              )}
            </label>
          );
        })}
        <button type="submit" className={command.confirm ? 'mini danger' : 'mini'} disabled={busy}>
          {busy ? '…' : 'Run'}
        </button>
      </div>
    </form>
  );
}

export function Admin() {
  const { onUnauthorized, identity } = useApp();
  const load = useCallback(() => api.commands(), []);
  const { data, error, refresh } = usePolling<StatusSnapshot>(load, 0, [], onUnauthorized);
  const [notice, setNotice] = useState<string>();

  if (!identity.admin) return <Empty>Admin privileges are required for this section.</Empty>;
  if (error) return <ErrorBox error={error} onRetry={refresh} />;
  if (!data) return <Empty>Loading commands…</Empty>;

  return (
    <div className="stack">
      {notice && (
        <div className="notice" onClick={() => setNotice(undefined)}>
          {notice}
        </div>
      )}
      {data.commandGroups.length === 0 && <Empty>No control commands exposed by this proxy.</Empty>}
      {data.commandGroups.map((g) => (
        <Card key={g.name} title={`${g.name} commands`} actions={<code className="muted">{g.handler}</code>}>
          {g.commands.map((c) => (
            <CommandForm key={c.name} command={c} optionLists={data.optionLists} onDone={setNotice} />
          ))}
        </Card>
      ))}
    </div>
  );
}
