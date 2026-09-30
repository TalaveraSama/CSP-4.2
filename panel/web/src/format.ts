export function pct(part: number | undefined, total: number | undefined): string {
  if (!part || !total) return '0%';
  return `${((part / total) * 100).toFixed(1)}%`;
}

export function num(n: number | undefined | null): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '-';
  return n.toLocaleString('en-US');
}

export function kb(n: number | undefined): string {
  if (!n) return '-';
  if (n > 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} GB`;
  if (n > 1024) return `${(n / 1024).toFixed(1)} MB`;
  return `${n} KB`;
}

/** Epoch millis -> local short timestamp. */
export function ts(value: number | undefined): string {
  if (!value) return '-';
  const d = new Date(value);
  return d.toLocaleString(undefined, {
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function ago(value: number | undefined): string {
  if (!value) return '-';
  const secs = Math.max(0, Math.round((Date.now() - value) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

export function hexId(id: number | undefined): string {
  return id === undefined ? '-' : `0x${id.toString(16)}`;
}
