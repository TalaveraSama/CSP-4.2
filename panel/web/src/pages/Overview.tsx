import { Fragment, useCallback } from 'react';
import { api } from '../api';
import { useApp } from '../app-context';
import { usePolling } from '../hooks';
import { Badge, Bar, Card, Empty, ErrorBox, Stat } from '../components/ui';
import { kb, num, pct } from '../format';

export function Overview() {
  const { interval, profile, onUnauthorized } = useApp();
  const load = useCallback(() => api.overview(profile || undefined), [profile]);
  const { data, error, refresh } = usePolling(load, interval, [profile], onUnauthorized);

  if (error) return <ErrorBox error={error} onRetry={refresh} />;
  if (!data?.proxy) return <Empty>Loading proxy status…</Empty>;

  const p = data.proxy;
  const load1 = data.connectors.reduce((acc, c) => acc + (c.ecmLoad ?? 0), 0);

  return (
    <div className="stack">
      <div className="statgrid">
        <Stat label="Uptime" value={p.duration} sub={`since ${new Date(Number(p.started) || Date.parse(p.started)).toLocaleString()}`} />
        <Stat label="Sessions" value={`${p.activeSessions} / ${p.sessions}`} sub="active / total" />
        <Stat
          label="Connectors"
          value={`${data.connectors.filter((c) => c.connectedNow).length} / ${data.connectors.length}`}
          sub="online / configured"
          tone={data.connectors.some((c) => !c.connectedNow) ? 'warn' : 'ok'}
        />
        <Stat label="ECM rate" value={`${p.ecmRate}/s`} sub={`${num(p.ecmCount)} total`} />
        <Stat label="Cache hits" value={pct(p.ecmCacheHits, p.ecmCount)} sub={`${num(p.ecmCacheHits)} hits`} tone="ok" />
        <Stat
          label="Denied / failed"
          value={`${num(p.ecmDenied)} / ${num(p.ecmFailures)}`}
          sub={`filtered ${num(p.ecmFiltered)}`}
          tone={p.ecmFailures > 0 ? 'warn' : undefined}
        />
        <Stat label="Load / capacity" value={`${num(load1)} / ${num(p.capacity)}`} sub="ECM per cw period" />
        <Stat label="EMM" value={num(p.emmCount)} sub="forwarded" />
      </div>

      <div className="grid2">
        <Card title={`Proxy · ${p.name}`}>
          <dl className="kv">
            <dt>Version</dt>
            <dd>
              {p.version} {p.build && <span className="muted">build {p.build}</span>}
            </dd>
            <dt>ECM forwards</dt>
            <dd>
              {num(p.ecmForwards)} <span className="muted">({pct(p.ecmForwards, p.ecmCount)})</span>
            </dd>
            {p.jvm && (
              <>
                <dt>Runtime</dt>
                <dd>
                  {p.jvm.name} {p.jvm.version}
                </dd>
                <dt>OS</dt>
                <dd>{p.jvm.os}</dd>
                <dt>Heap</dt>
                <dd>
                  {kb(p.jvm.heapUsed)} / {kb(p.jvm.heapTotal)}
                  <Bar value={p.jvm.heapUsed} max={p.jvm.heapTotal} />
                </dd>
                <dt>Threads</dt>
                <dd>{p.jvm.threads}</dd>
                {p.jvm.filedescMax !== undefined && (
                  <>
                    <dt>File descriptors</dt>
                    <dd>
                      {p.jvm.filedescOpen} / {p.jvm.filedescMax}
                    </dd>
                  </>
                )}
              </>
            )}
          </dl>
        </Card>

        <Card title={`Cache · ${data.cache?.type ?? 'n/a'}`}>
          {data.cache ? (
            <dl className="kv">
              {data.cache.params.map((param) => (
                <Fragment key={param.name}>
                  <dt>{param.name}</dt>
                  <dd>{param.value}</dd>
                </Fragment>
              ))}
            </dl>
          ) : (
            <Empty />
          )}
        </Card>
      </div>

      <Card title={`CA profiles (${data.profiles.length})`}>
        {data.profiles.length === 0 ? (
          <Empty />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Profile</th>
                <th>CA id</th>
                <th>Network</th>
                <th>Listen ports</th>
                <th className="r">Capacity</th>
                <th className="r">Mapped services</th>
                <th>Debug</th>
              </tr>
            </thead>
            <tbody>
              {data.profiles.map((prof) => (
                <tr key={prof.name}>
                  <td>
                    <strong>{prof.name}</strong>
                  </td>
                  <td>
                    <code>{prof.caId}</code>
                  </td>
                  <td>
                    <code>{prof.networkId}</code>
                  </td>
                  <td>
                    {prof.listenPorts.map((lp) => (
                      <Badge key={`${lp.protocol}-${lp.port}`} tone={lp.alive === false ? 'bad' : 'info'}>
                        {lp.protocol} :{lp.port}
                        {lp.users !== undefined ? ` (${lp.users})` : ''}
                      </Badge>
                    ))}
                  </td>
                  <td className="r">{num(prof.capacity)}</td>
                  <td className="r">{num(prof.mappedServices)}</td>
                  <td>{prof.debug ? <Badge tone="warn">debug</Badge> : <span className="muted">off</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {data.plugins.length > 0 && (
        <Card title={`Plugins (${data.plugins.length})`}>
          <div className="grid2">
            {data.plugins.map((pl) => (
              <div key={pl.name} className="subcard">
                <strong>{pl.name}</strong> <span className="muted">{pl.version}</span>
                <p className="muted">{pl.description}</p>
                <dl className="kv compact">
                  {pl.params.map((param) => (
                    <Fragment key={param.name}>
                      <dt>{param.name}</dt>
                      <dd>{param.value}</dd>
                    </Fragment>
                  ))}
                </dl>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
