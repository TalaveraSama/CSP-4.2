import { useState, type FormEvent } from 'react';
import { api, type Meta } from '../api';
import type { CspIdentity } from '../types';

export function Login({ meta, onLogin }: { meta: Meta | undefined; onLogin: (identity: CspIdentity) => void }) {
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      onLogin(await api.login(user, password));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <h1>
          CSP<span>panel</span>
        </h1>
        <p className="login-sub">
          {meta ? (
            <>
              backend: <code>{meta.backend}</code> · <code>{meta.target}</code>
            </>
          ) : (
            'connecting…'
          )}
        </p>
        <label>
          User
          <input value={user} onChange={(e) => setUser(e.target.value)} autoFocus autoComplete="username" />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </label>
        {error && <div className="login-error">{error}</div>}
        <button type="submit" disabled={busy || !user || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {meta?.backend === 'mock' && (
          <p className="login-hint">
            Mock backend: any credentials work. Use <code>admin</code> for admin rights, <code>root</code> for superuser.
          </p>
        )}
      </form>
    </div>
  );
}
