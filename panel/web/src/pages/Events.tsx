import { useCallback, useState } from 'react';
import { api } from '../api';
import { useApp } from '../app-context';
import { usePolling } from '../hooks';
import { Badge, Card, Empty, ErrorBox } from '../components/ui';
import { ago, ts } from '../format';
import type { LogEvent } from '../types';

function tone(e: LogEvent): 'ok' | 'warn' | 'bad' | 'info' | 'neutral' {
  const t = `${e.type} ${e.logLevel ?? ''} ${e.label ?? ''}`.toLowerCase();
  if (t.includes('severe') || t.includes('disconnect') || t.includes('lost') || t.includes('denied')) return 'bad';
  if (t.includes('warning') || t.includes('timeout') || t.includes('congestion')) return 'warn';
  if (t.includes('connect')) return 'ok';
  return 'info';
}

function EventTable({ events, emptyText }: { events: LogEvent[]; emptyText: string }) {
  if (events.length === 0) return <Empty>{emptyText}</Empty>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th style={{ width: 150 }}>Time</th>
          <th style={{ width: 110 }}>Type</th>
          <th>Message</th>
        </tr>
      </thead>
      <tbody>
        {events.map((e, i) => (
          <tr key={`${e.timestamp}-${i}`}>
            <td className="nowrap">
              {ts(e.timestamp)}
              <div className="muted small">{ago(e.timestamp)}</div>
            </td>
            <td>
              <Badge tone={tone(e)}>{e.logLevel ?? e.label ?? e.type}</Badge>
            </td>
            <td>
              {e.user && <strong>{e.user} </strong>}
              {e.message}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Events() {
  const { interval, profile, onUnauthorized, identity } = useApp();
  const load = useCallback(() => api.events(profile || undefined), [profile]);
  const { data, error, refresh } = usePolling(load, interval, [profile], onUnauthorized);
  const [notice, setNotice] = useState<string>();

  const clear = async (command: string) => {
    try {
      setNotice((await api.runCommand(command, {})).message);
      refresh();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  };

  if (error) return <ErrorBox error={error} onRetry={refresh} />;
  if (!data) return <Empty>Loading events…</Empty>;

  return (
    <div className="stack">
      {notice && (
        <div className="notice" onClick={() => setNotice(undefined)}>
          {notice}
        </div>
      )}
      <Card
        title={`CWS events (${data.events.length})`}
        actions={
          identity.admin && (
            <button className="mini" onClick={() => clear('clear-events')}>
              Clear
            </button>
          )
        }
      >
        <EventTable events={data.events} emptyText="No events" />
      </Card>

      <Card
        title={`User warnings (${data.warnings.length})`}
        actions={
          identity.admin && (
            <button className="mini" onClick={() => clear('clear-warnings')}>
              Clear
            </button>
          )
        }
      >
        <EventTable events={data.warnings} emptyText="No warnings" />
      </Card>

      <Card title={`File log (${data.fileLog.length})`}>
        <EventTable events={data.fileLog} emptyText="No file log entries" />
      </Card>
    </div>
  );
}
