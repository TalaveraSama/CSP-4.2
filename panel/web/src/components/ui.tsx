import type { ReactNode } from 'react';

export function Card({ title, actions, children, className = '' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-head">
          <h2>{title}</h2>
          <div className="card-actions">{actions}</div>
        </header>
      )}
      <div className="card-body">{children}</div>
    </section>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'ok' | 'warn' | 'bad' }) {
  return (
    <div className={`stat ${tone ? `stat-${tone}` : ''}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {sub !== undefined && <span className="stat-sub">{sub}</span>}
    </div>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: 'ok' | 'warn' | 'bad' | 'neutral' | 'info'; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Bar({ value, max = 100, tone }: { value: number; max?: number; tone?: 'ok' | 'warn' | 'bad' }) {
  const ratio = Math.max(0, Math.min(1, value / (max || 1)));
  const auto: 'ok' | 'warn' | 'bad' = ratio > 0.9 ? 'bad' : ratio > 0.7 ? 'warn' : 'ok';
  return (
    <div className="bar" title={`${value} / ${max}`}>
      <div className={`bar-fill bar-${tone ?? auto}`} style={{ width: `${ratio * 100}%` }} />
    </div>
  );
}

export function Empty({ children = 'No data' }: { children?: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function ErrorBox({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="errorbox">
      <strong>Error</strong>
      <span>{error}</span>
      {onRetry && (
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" aria-label="loading" />;
}
