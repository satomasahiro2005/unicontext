import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet } from './api';

export interface ApiState<T> {
  data: T | undefined;
  error: unknown;
  /** True while there is no data yet (first load, or the path changed). */
  loading: boolean;
  refetch: () => Promise<void>;
}

interface Internal<T> {
  path: string | null;
  data: T | undefined;
  error: unknown;
  loading: boolean;
}

export interface UseApiOptions {
  /** Refetch interval in ms (the Today screen polls every 60s). */
  pollMs?: number;
}

/**
 * Tiny data hook: loads `path`, keeps the last data while refetching, refetches when the window
 * regains focus or becomes visible, and optionally on an interval. Stale responses are dropped.
 */
export function useApi<T>(path: string | null, options: UseApiOptions = {}): ApiState<T> {
  const { pollMs } = options;
  const [state, setState] = useState<Internal<T>>({
    path,
    data: undefined,
    error: undefined,
    loading: path !== null,
  });
  const seq = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    if (path === null) return;
    const id = ++seq.current;
    try {
      const data = await apiGet<T>(path);
      if (id === seq.current) setState({ path, data, error: undefined, loading: false });
    } catch (error) {
      if (id === seq.current) setState((s) => ({ ...s, path, error, loading: false }));
    }
  }, [path]);

  useEffect(() => {
    setState({ path, data: undefined, error: undefined, loading: path !== null });
    void load();
    return () => {
      seq.current++;
    };
  }, [path, load]);

  useEffect(() => {
    if (path === null) return;
    const onFocus = (): void => void load();
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void load();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    const timer = pollMs ? window.setInterval(() => void load(), pollMs) : undefined;
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [path, pollMs, load]);

  const current = state.path === path;
  return {
    data: current ? state.data : undefined,
    error: current ? state.error : undefined,
    loading: current ? state.loading : path !== null,
    refetch: load,
  };
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = (): void => setMatches(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

export function usePageTitle(title: string): void {
  useEffect(() => {
    document.title = title === '' ? 'UniContext' : `${title} - UniContext`;
  }, [title]);
}
