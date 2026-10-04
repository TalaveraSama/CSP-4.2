import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, backendName, type Meta } from './api';
import { AppContext } from './app-context';
import { Login } from './components/Login';
import { Spinner } from './components/ui';
import { useStored } from './hooks';
import { Overview } from './pages/Overview';
import { Connectors } from './pages/Connectors';
import { Sessions } from './pages/Sessions';
import { Events } from './pages/Events';
import { Channels } from './pages/Channels';
import { Admin } from './pages/Admin';
import { Config } from './pages/Config';
import { Logs } from './pages/Logs';
import type { CspIdentity } from './types';

const SECTIONS = [
  { id: 'overview', label: 'Overview', component: Overview, admin: false },
  { id: 'connectors', label: 'Connectors', component: Connectors, admin: false },
  { id: 'sessions', label: 'Sessions', component: Sessions, admin: false },
  { id: 'channels', label: 'Channels', component: Channels, admin: false },
  { id: 'events', label: 'Events', component: Events, admin: false },
  { id: 'logs', label: 'Logs', component: Logs, admin: false },
  { id: 'admin', label: 'Admin', component: Admin, admin: true },
  { id: 'config', label: 'Config', component: Config, admin: true },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

const INTERVALS = [
  { label: 'off', value: 0 },
  { label: '2s', value: 2000 },
  { label: '5s', value: 5000 },
  { label: '15s', value: 15000 },
  { label: '60s', value: 60000 },
];

function useHashRoute(): [SectionId, (id: SectionId) => void] {
  const read = (): SectionId => {
    const id = window.location.hash.replace(/^#\/?/, '') as SectionId;
    return SECTIONS.some((s) => s.id === id) ? id : 'overview';
  };
  const [route, setRoute] = useState<SectionId>(read);
  useEffect(() => {
    const onHash = () => setRoute(read());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const go = useCallback((id: SectionId) => {
    window.location.hash = `#/${id}`;
    setRoute(id);
  }, []);
  return [route, go];
}

export function App() {
  const [identity, setIdentity] = useState<CspIdentity | null>(null);
  const [meta, setMeta] = useState<Meta>();
  const [booting, setBooting] = useState(true);
  const [route, go] = useHashRoute();
  const [interval, setInterval] = useStored('csp.interval', 5000);
  const [profile, setProfile] = useStored('csp.profile', '');
  const [profiles, setProfiles] = useState<string[]>([]);
  const [proxyName, setProxyName] = useState<string>();

  useEffect(() => {
    void api.meta().then(setMeta).catch(() => undefined);
    api
      .me()
      .then(setIdentity)
      .catch(() => setIdentity(null))
      .finally(() => setBooting(false));
  }, []);

  // Profile list + proxy name for the shell (cheap, refreshed occasionally).
  useEffect(() => {
    if (!identity) return;
    let stop = false;
    const load = () =>
      api
        .overview()
        .then((snap) => {
          if (stop) return;
          setProfiles(snap.profiles.map((p) => p.name));
          setProxyName(snap.proxy?.name);
        })
        .catch(() => undefined);
    void load();
    const timer = window.setInterval(load, 60_000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [identity]);

  const onUnauthorized = useCallback(() => setIdentity(null), []);

  const ctx = useMemo(
    () => (identity && meta ? { identity, interval, profile, setProfile, onUnauthorized, meta } : null),
    [identity, interval, profile, setProfile, onUnauthorized, meta],
  );

  if (booting) {
    return (
      <div className="boot">
        <Spinner /> starting panel…
      </div>
    );
  }

  if (!identity || !ctx) return <Login meta={meta} onLogin={setIdentity} />;

  // OSCam calls connectors "readers"; keep the wording of whatever we're talking to.
  const label = (id: SectionId, fallback: string) => (id === 'connectors' ? ctx.meta.labels.connectors : fallback);
  const visible = SECTIONS.filter((s) => !s.admin || identity.admin);
  const active = visible.find((s) => s.id === route) ?? visible[0]!;
  const Section = active.component;

  const logout = async () => {
    await api.logout().catch(() => undefined);
    setIdentity(null);
  };

  return (
    <AppContext.Provider value={ctx}>
      <div className="shell">
        <header className="topbar">
          <div className="brand" onClick={() => go('overview')}>
            CSP<span>panel</span>
          </div>
          <nav className="nav">
            {visible.map((s) => (
              <button key={s.id} className={s.id === active.id ? 'navitem active' : 'navitem'} onClick={() => go(s.id)}>
                {label(s.id, s.label)}
              </button>
            ))}
          </nav>
          <div className="topright">
            {proxyName && <span className="proxyname">{proxyName}</span>}
            <span className="badge badge-info">{meta?.kind === 'csp' ? 'CSP' : backendName(meta?.kind)}</span>
            {meta?.mock && <span className="badge badge-warn">mock data</span>}
            <select
              className="mini-select"
              value={profile}
              onChange={(e) => setProfile(e.target.value)}
              title="Filter by CA profile"
            >
              <option value="">all profiles</option>
              {profiles.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <select
              className="mini-select"
              value={interval}
              onChange={(e) => setInterval(Number(e.target.value))}
              title="Auto refresh"
            >
              {INTERVALS.map((i) => (
                <option key={i.value} value={i.value}>
                  ↻ {i.label}
                </option>
              ))}
            </select>
            <span className="user" title={identity.superUser ? 'superuser' : identity.admin ? 'admin' : 'user'}>
              {identity.user}
              {identity.admin && <span className="badge badge-info">{identity.superUser ? 'super' : 'admin'}</span>}
            </span>
            <button className="mini" onClick={logout}>
              Log out
            </button>
          </div>
        </header>
        <main className="content">
          <Section />
        </main>
      </div>
    </AppContext.Provider>
  );
}
