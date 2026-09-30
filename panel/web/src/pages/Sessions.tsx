import { useCallback, useMemo, useState } from 'react';
import { api } from '../api';
import { useApp } from '../app-context';
import { usePolling, useStored } from '../hooks';
import { Badge, Card, Empty, ErrorBox } from '../components/ui';
import { num } from '../format';
import type { UserSession } from '../types';

type SortKey = 'user' | 'profile' | 'host' | 'ecmCount' | 'lastTransaction' | 'avgEcmInterval';

export function Sessions() {
  const { interval, profile, onUnauthorized, identity } = useApp();
  const [hideInactive, setHideInactive] = useStored('csp.hideInactive', true);
  const [showZap, setShowZap] = useStored('csp.showZap', false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'user', dir: 1 });
  const [notice, setNotice] = useState<string>();

  const load = useCallback(() => api.sessions(profile || undefined, hideInactive), [profile, hideInactive]);
  const { data, error, refresh } = usePolling(load, interval, [profile, hideInactive], onUnauthorized);

  const sessions = useMemo(() => {
    const list = [...(data?.users?.sessions ?? [])];
    list.sort((a, b) => {
      const av = a[sort.key] ?? '';
      const bv = b[sort.key] ?? '';
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sort.dir;
      return String(av).localeCompare(String(bv)) * sort.dir;
    });
    return list;
  }, [data, sort]);

  const kick = async (user: string) => {
    if (!confirm(`Close all sessions for "${user}"?`)) return;
    try {
      setNotice((await api.runCommand('kick-user', { name: user })).message);
      refresh();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  };

  const header = (key: SortKey, label: string, cls = '') => (
    <th
      className={`sortable ${cls} ${sort.key === key ? 'sorted' : ''}`}
      onClick={() => setSort((s) => ({ key, dir: s.key === key && s.dir === 1 ? -1 : 1 }))}
    >
      {label}
      {sort.key === key && <span className="arrow">{sort.dir === 1 ? '▲' : '▼'}</span>}
    </th>
  );

  const tone = (s: UserSession): 'ok' | 'warn' | 'bad' | 'neutral' => {
    if (!s.active) return 'neutral';
    if ((s.lastTransaction ?? 0) > 4500) return 'bad';
    if ((s.avgEcmInterval ?? 99) < 7) return 'warn';
    return 'ok';
  };

  if (error) return <ErrorBox error={error} onRetry={refresh} />;
  if (!data) return <Empty>Loading sessions…</Empty>;

  return (
    <div className="stack">
      {notice && (
        <div className="notice" onClick={() => setNotice(undefined)}>
          {notice}
        </div>
      )}
      <Card
        title={`Sessions (${sessions.length})`}
        actions={
          <>
            <label className="check">
              <input type="checkbox" checked={hideInactive} onChange={(e) => setHideInactive(e.target.checked)} /> Hide idle
            </label>
            <label className="check">
              <input type="checkbox" checked={showZap} onChange={(e) => setShowZap(e.target.checked)} /> Show zap time
            </label>
          </>
        }
      >
        {sessions.length === 0 ? (
          <Empty>No sessions</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                {header('user', 'User')}
                <th className="r">#</th>
                {header('host', 'IP')}
                {header('profile', 'Profile')}
                <th>{showZap ? 'Zapped' : 'Connected'}</th>
                {header('ecmCount', 'ECM', 'r')}
                <th className="r">EMM</th>
                {header('avgEcmInterval', 'Iv', 'r')}
                {header('lastTransaction', 'Time', 'r')}
                <th>Flags</th>
                <th>Client</th>
                <th>Service</th>
                {identity.admin && <th />}
              </tr>
            </thead>
            <tbody>
              {sessions.map((s, i) => (
                <tr key={`${s.user}-${s.host}-${s.profile}-${i}`} className={s.active ? '' : 'inactive'}>
                  <td>
                    <Badge tone={tone(s)}>●</Badge> {s.displayName ?? s.user}
                  </td>
                  <td className="r">{s.count ?? 1}</td>
                  <td>
                    <code>{s.host}</code>
                  </td>
                  <td>{s.profile}</td>
                  <td>{(showZap ? s.lastZap : s.duration) ?? '-'}</td>
                  <td className="r">{num(s.ecmCount)}</td>
                  <td className="r">
                    {num(s.emmCount)}
                    {s.au && <span className="muted small"> → {s.au}</span>}
                  </td>
                  <td className={`r ${(s.avgEcmInterval ?? 99) < 7 ? 'bad' : ''}`}>
                    {s.avgEcmInterval !== undefined && s.avgEcmInterval > -1 ? s.avgEcmInterval : '-'}
                    {(s.pendingCount ?? 0) > 1 && <span className="bad"> ({s.pendingCount})</span>}
                  </td>
                  <td className={`r ${(s.lastTransaction ?? 0) > 4500 ? 'bad' : ''}`}>
                    {s.lastTransaction !== undefined && s.lastTransaction > -1 ? `${s.lastTransaction} ms` : '-'}
                  </td>
                  <td>
                    <code>{s.flags}</code>
                  </td>
                  <td className="small">{s.clientId}</td>
                  <td>{s.service?.name ?? <span className="muted">-</span>}</td>
                  {identity.admin && (
                    <td className="r">
                      <button className="mini danger" onClick={() => kick(s.user)}>
                        Kick
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small">
          Flags: C = cache hit, H = handled locally, N = new service, + = forwarded. Rows in grey are idle sessions.
        </p>
      </Card>
    </div>
  );
}
