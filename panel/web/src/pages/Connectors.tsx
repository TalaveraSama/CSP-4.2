import { Fragment, useCallback, useState } from 'react';
import { api } from '../api';
import { useApp } from '../app-context';
import { usePolling } from '../hooks';
import { Badge, Bar, Card, Empty, ErrorBox } from '../components/ui';
import { num } from '../format';
import type { Connector } from '../types';

function statusTone(c: Connector): 'ok' | 'warn' | 'bad' {
  if (!c.connectedNow) return 'bad';
  if ((c.utilization ?? 0) > 90) return 'warn';
  return 'ok';
}

export function Connectors() {
  const { interval, profile, onUnauthorized, identity } = useApp();
  const load = useCallback(() => api.connectors(profile || undefined), [profile]);
  const { data, error, refresh } = usePolling(load, interval, [profile], onUnauthorized);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string>();

  const run = async (command: string, name: string) => {
    setBusy(name + command);
    try {
      const res = await api.runCommand(command, { name });
      setNotice(res.message);
      refresh();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  if (error) return <ErrorBox error={error} onRetry={refresh} />;
  if (!data) return <Empty>Loading connectors…</Empty>;

  return (
    <div className="stack">
      {notice && (
        <div className="notice" onClick={() => setNotice(undefined)}>
          {notice}
        </div>
      )}
      <Card title={`Connectors (${data.connectors.length})`}>
        {data.connectors.length === 0 ? (
          <Empty />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th />
                <th>Name</th>
                <th>Protocol</th>
                <th>Profile</th>
                <th>Status</th>
                <th>Uptime</th>
                <th className="r">ECM</th>
                <th className="r">Load</th>
                <th style={{ width: 160 }}>Utilization</th>
                {identity.admin && <th />}
              </tr>
            </thead>
            <tbody>
              {data.connectors.map((c) => {
                const expanded = open === c.name;
                return (
                  <Fragment key={c.name}>
                    <tr className="rowlink" onClick={() => setOpen(expanded ? null : c.name)}>
                      <td className="chev">{expanded ? '▾' : '▸'}</td>
                      <td>
                        <strong>{c.name}</strong>
                        {c.host && <div className="muted small">{c.host}</div>}
                      </td>
                      <td>{c.protocol}</td>
                      <td>{c.profile}</td>
                      <td>
                        <Badge tone={statusTone(c)}>{c.status}</Badge>
                        {c.nextAttempt && <span className="muted small"> retry {c.nextAttempt}</span>}
                      </td>
                      <td>{c.duration ?? <span className="muted">down</span>}</td>
                      <td className="r">{num(c.ecmCount)}</td>
                      <td className="r">{num(c.ecmLoad)}</td>
                      <td>
                        {c.utilization !== undefined ? (
                          <>
                            <Bar value={c.utilization} />
                            <span className="small muted">{c.utilization}%</span>
                          </>
                        ) : (
                          <span className="muted">-</span>
                        )}
                      </td>
                      {identity.admin && (
                        <td className="r nowrap" onClick={(e) => e.stopPropagation()}>
                          <button className="mini" disabled={busy !== null} onClick={() => run('retry-connector', c.name)}>
                            Retry
                          </button>
                          <button className="mini" disabled={busy !== null} onClick={() => run('reset-connector', c.name)}>
                            Reset map
                          </button>
                          <button className="mini danger" disabled={busy !== null} onClick={() => run('disable-connector', c.name)}>
                            Disable
                          </button>
                        </td>
                      )}
                    </tr>
                    {expanded && (
                      <tr className="detailrow">
                        <td colSpan={identity.admin ? 10 : 9}>
                          <div className="grid3">
                            <dl className="kv compact">
                              <dt>Connected</dt>
                              <dd>{c.connected ?? '-'}</dd>
                              <dt>Disconnected</dt>
                              <dd>{c.disconnected ?? '-'}</dd>
                              <dt>Metric</dt>
                              <dd>{num(c.metric)}</dd>
                              <dt>Capacity</dt>
                              <dd>{num(c.capacity)}</dd>
                              <dt>Queue</dt>
                              <dd>{num(c.sendq)}</dd>
                              <dt>Timeouts</dt>
                              <dd>{num(c.timeoutCount)}</dd>
                              <dt>Processing</dt>
                              <dd>
                                {num(c.cutime)} ms <span className="muted">avg {num(c.avgtime)} ms</span>
                              </dd>
                              <dt>Provider idents</dt>
                              <dd>
                                <code>{c.providerIdents ?? '-'}</code>
                              </dd>
                              <dt>Card data</dt>
                              <dd>
                                <code>{c.cardData1 ?? '-'}</code>
                              </dd>
                            </dl>
                            <div>
                              <h4>Services ({c.services.length})</h4>
                              <ul className="chiplist">
                                {c.services.map((s) => (
                                  <li key={`${c.name}-${s.id}`} className={s.hit ? 'chip hit' : 'chip'}>
                                    {s.name} <span className="muted">0x{s.hexId}</span>
                                  </li>
                                ))}
                                {c.services.length === 0 && <span className="muted">none</span>}
                              </ul>
                            </div>
                            <div>
                              <h4>Remote properties</h4>
                              <dl className="kv compact">
                                {c.remoteParams.map((rp) => (
                                  <Fragment key={rp.name}>
                                    <dt>{rp.name}</dt>
                                    <dd>{rp.value}</dd>
                                  </Fragment>
                                ))}
                              </dl>
                              {c.remoteParams.length === 0 && <span className="muted">none</span>}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
