import { useCallback, useMemo, useState } from 'react';
import { api } from '../api';
import { useApp } from '../app-context';
import { usePolling } from '../hooks';
import { Badge, Card, Empty, ErrorBox } from '../components/ui';
import { hexId } from '../format';

export function Channels() {
  const { interval, profile, onUnauthorized } = useApp();
  const [all, setAll] = useState(false);
  const [filter, setFilter] = useState('');
  const load = useCallback(() => api.channels(profile || undefined, all), [profile, all]);
  const { data, error, refresh } = usePolling(load, interval > 0 ? Math.max(interval, 10_000) : 0, [profile, all], onUnauthorized);

  const services = useMemo(() => {
    const seen = new Map<string, (typeof list)[number]>();
    const list = data?.services ?? [];
    for (const s of list) {
      const key = `${s.profile ?? ''}:${s.id}`;
      const prev = seen.get(key);
      seen.set(key, prev ? { ...prev, ...s, watchers: s.watchers ?? prev.watchers } : s);
    }
    const term = filter.trim().toLowerCase();
    return [...seen.values()]
      .filter((s) => !term || s.name.toLowerCase().includes(term) || s.hexId.includes(term) || String(s.id) === term)
      .sort((a, b) => (b.watchers ?? 0) - (a.watchers ?? 0) || a.name.localeCompare(b.name));
  }, [data, filter]);

  const exportBouquet = () => {
    const lines = services.map((s) => `#SERVICE 1:0:1:${s.hexId.toUpperCase()}:0:0:0:0:0:0:\n#DESCRIPTION ${s.name}`);
    const blob = new Blob([`#NAME CSP ${profile || 'all'}\n${lines.join('\n')}\n`], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `userbouquet.csp-${profile || 'all'}.tv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (error) return <ErrorBox error={error} onRetry={refresh} />;
  if (!data) return <Empty>Loading services…</Empty>;

  return (
    <Card
      title={`Services (${services.length})`}
      actions={
        <>
          <input className="search" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <label className="check">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Include all known
          </label>
          <button className="mini" onClick={exportBouquet} disabled={services.length === 0}>
            Export bouquet
          </button>
        </>
      }
    >
      {services.length === 0 ? (
        <Empty>No services being watched</Empty>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Service</th>
              <th>Profile</th>
              <th>SID (dec)</th>
              <th>SID (hex)</th>
              <th className="r">Watchers</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {services.map((s) => (
              <tr key={`${s.profile}-${s.id}`}>
                <td>
                  <strong>{s.name}</strong>
                </td>
                <td>{s.profile ?? '-'}</td>
                <td>{s.id}</td>
                <td>
                  <code>{hexId(s.id)}</code>
                </td>
                <td className="r">{s.watchers ?? 0}</td>
                <td>{s.hit ? <Badge tone="ok">decoding</Badge> : <Badge tone="neutral">idle</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
