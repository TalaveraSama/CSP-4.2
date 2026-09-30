import { useCallback, useState } from 'react';
import { api } from '../api';
import { useApp } from '../app-context';
import { usePolling } from '../hooks';
import { Card, Empty, ErrorBox } from '../components/ui';
import { ago, ts } from '../format';

export function Logs() {
  const { onUnauthorized, identity } = useApp();
  const seen = usePolling(useCallback(() => api.seen(), []), 0, [], onUnauthorized);
  const failures = usePolling(useCallback(() => api.failures(), []), 0, [], onUnauthorized);
  const [notice, setNotice] = useState<string>();

  const clear = async (command: string, refresh: () => void) => {
    try {
      setNotice((await api.runCommand(command, {})).message);
      refresh();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="stack">
      {notice && (
        <div className="notice" onClick={() => setNotice(undefined)}>
          {notice}
        </div>
      )}

      <Card
        title={`Last seen (${seen.data?.seen.length ?? 0})`}
        actions={
          identity.admin && (
            <button className="mini" onClick={() => clear('remove-seen', seen.refresh)}>
              Clear
            </button>
          )
        }
      >
        {seen.error ? (
          <ErrorBox error={seen.error} onRetry={seen.refresh} />
        ) : !seen.data?.seen.length ? (
          <Empty>No disconnected users recorded</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>User</th>
                <th>IP</th>
                <th>Profile</th>
                <th>Last login</th>
                <th>Last seen</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {seen.data.seen.map((e, i) => (
                <tr key={`${e.name}-${i}`}>
                  <td>
                    <strong>{e.name}</strong>
                  </td>
                  <td>
                    <code>{e.host ?? '-'}</code>
                  </td>
                  <td>{e.profile ?? '-'}</td>
                  <td className="nowrap">{ts(e.lastLogin)}</td>
                  <td className="nowrap">
                    {ts(e.lastSeen)} <span className="muted small">{ago(e.lastSeen)}</span>
                  </td>
                  <td>{e.reason ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card
        title={`Login failures (${failures.data?.failures.length ?? 0})`}
        actions={
          identity.admin && (
            <button className="mini" onClick={() => clear('remove-failed', failures.refresh)}>
              Clear
            </button>
          )
        }
      >
        {failures.error ? (
          <ErrorBox error={failures.error} onRetry={failures.refresh} />
        ) : !failures.data?.failures.length ? (
          <Empty>No failed logins</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>User / IP</th>
                <th>Host</th>
                <th className="r">Attempts</th>
                <th>First</th>
                <th>Last</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {failures.data.failures.map((e, i) => (
                <tr key={`${e.name}-${i}`}>
                  <td>
                    <strong>{e.name}</strong>
                  </td>
                  <td>
                    <code>{e.host ?? '-'}</code>
                  </td>
                  <td className="r">{e.count ?? '-'}</td>
                  <td className="nowrap">{ts(e.firstFailure)}</td>
                  <td className="nowrap">
                    {ts(e.lastFailure)} <span className="muted small">{ago(e.lastFailure)}</span>
                  </td>
                  <td>{e.reason ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
