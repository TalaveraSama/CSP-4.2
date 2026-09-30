import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api';

export interface PollState<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
  refresh: () => void;
  updatedAt: number | undefined;
}

/**
 * Fetches `loader` once and then every `intervalMs` (0 = manual only).
 * Keeps the previous data visible while refreshing, so tables never flash.
 */
export function usePolling<T>(loader: () => Promise<T>, intervalMs: number, deps: unknown[] = [], onUnauthorized?: () => void): PollState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<number>();
  const [nonce, setNonce] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const run = async () => {
      try {
        const result = await loaderRef.current();
        if (cancelled) return;
        setData(result);
        setError(undefined);
        setUpdatedAt(Date.now());
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) onUnauthorized?.();
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) {
          setLoading(false);
          if (intervalMs > 0) timer = setTimeout(run, intervalMs);
        }
      }
    };

    setLoading(true);
    void run();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, nonce, ...deps]);

  return { data, error, loading, refresh, updatedAt };
}

/** Persisted-in-localStorage state, for user preferences. */
export function useStored<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        localStorage.setItem(key, JSON.stringify(v));
      } catch {
        /* ignore quota errors */
      }
    },
    [key],
  );
  return [value, set];
}
