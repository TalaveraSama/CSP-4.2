import { useCallback } from 'react';
import { api } from '../api';
import { useApp } from '../app-context';
import { usePolling } from '../hooks';
import { Badge, Card, Empty, ErrorBox, Stat } from '../components/ui';
import { num } from '../format';

const ago = (ts?: number) => (ts ? `${Math.max(0, Math.round((Date.now() - ts) / 1000))}s` : '—');
const hex = (n: number, w: number) => n.toString(16).toUpperCase().padStart(w, '0');

/** What the companion cache peer (csp-cache-node) sees on the cluster. */
export function Cache() {
  const { interval, onUnauthorized, meta } = useApp();
  const load = useCallback(() => api.cache(), []);
  const { data, error, refresh } = usePolling(load, interval || 5000, [], onUnauthorized);

  if (!meta.features.cacheNode) {
    return (
      <Card title="Cache cluster">
        <Empty>
          No cache peer configured. Start <code>csp-cache-node</code> and point the panel at it with
          <code> CACHE_NODE_URL=http://127.0.0.1:8099</code> in /etc/csp-panel/panel.env.
        </Empty>
      </Card>
    );
  }

  if (error) return <ErrorBox error={error} onRetry={refresh} />;
  if (!data) return <Empty>Talking to the cache peer…</Empty>;

  const total = data.hits + data.misses;
  const hitRate = total > 0 ? Math.round((data.hits / total) * 100) : 0;

  return (
    <>
      <Card title={`Cache peer on udp/${data.port}`} actions={<button className="mini" onClick={refresh}>Reload</button>}>
        <div className="stats">
          <Stat label="Entries held" value={num(data.entries)} sub={`${data.pending} pending`} />
          <Stat label="Received" value={num(data.received.replies)} sub="ecm → cw pairs" />
          <Stat label="Sent" value={num(data.sent.replies)} sub="ecm → cw pairs" />
          <Stat
            label="Resend hit rate"
            value={`${hitRate}%`}
            sub={`${num(data.hits)} served / ${num(data.misses)} missed`}
            tone={total === 0 ? undefined : hitRate > 50 ? 'ok' : 'warn'}
          />
          <Stat label="Pings" value={`${num(data.sent.pings)} / ${num(data.received.pings)}`} sub="sent / answered" />
          <Stat
            label="Bad datagrams"
            value={num(data.received.invalid)}
            tone={data.received.invalid > 0 ? 'warn' : undefined}
            sub="not CSP cache protocol"
          />
        </div>
      </Card>

      <Card title="Peers">
        {data.peers.length === 0 ? (
          <Empty>No peers configured. Set CACHE_PEERS in /etc/csp-panel/cache.env.</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Peer</th>
                <th className="r">Round trip</th>
                <th className="r">Last seen</th>
                <th>How</th>
              </tr>
            </thead>
            <tbody>
              {data.peers.map((p) => {
                const stale = !p.lastSeen || Date.now() - p.lastSeen > 60_000;
                return (
                  <tr key={`${p.host}:${p.port}`} className={stale ? 'inactive' : ''}>
                    <td>
                      {p.host}:{p.port}
                    </td>
                    <td className="r">{p.rtt === undefined ? '—' : `${p.rtt} ms`}</td>
                    <td className="r">{ago(p.lastSeen)}</td>
                    <td>
                      {p.auto ? <Badge tone="info">learned</Badge> : <Badge tone="neutral">configured</Badge>}
                      {stale && <Badge tone="bad">silent</Badge>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {data.sources.length > 0 && (
          <>
            <p className="muted small">
              Traffic actually received, by source address. CardServProxy sends from a random port, so this does not
              always line up with the peer list above.
            </p>
            <table className="table">
              <thead>
                <tr>
                  <th>Source</th>
                  <th className="r">Entries</th>
                  <th className="r">Pending</th>
                  <th className="r">Last seen</th>
                </tr>
              </thead>
              <tbody>
                {data.sources.map((s) => (
                  <tr key={`${s.host}:${s.port}`}>
                    <td>
                      {s.host}:{s.port}
                    </td>
                    <td className="r">{num(s.replies)}</td>
                    <td className="r">{num(s.requests)}</td>
                    <td className="r">{ago(s.lastSeen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Card>

      <Card title="Newest entries">
        {!data.entriesList || data.entriesList.length === 0 ? (
          <Empty>Nothing in the cache yet.</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>CAID</th>
                <th>Service</th>
                <th>Key</th>
                <th>Origin</th>
                <th className="r">Age</th>
              </tr>
            </thead>
            <tbody>
              {data.entriesList.map((e) => (
                <tr key={e.key}>
                  <td>{hex(e.caId, 4)}</td>
                  <td>{hex(e.serviceId, 4)}</td>
                  <td className="muted small">{e.key}</td>
                  <td>{e.origin ?? e.from ?? <span className="muted">local</span>}</td>
                  <td className="r">{e.age}s</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
