import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api';

// Calls `load` now and then every `intervalMs`, keeping the latest result. Polling
// is how the order view stays "live": a second register, or a refund issued
// elsewhere, shows up within a second. `setData` lets a mutation show its result
// immediately instead of waiting for the next tick.
export function usePolling<T>(load: () => Promise<T>, intervalMs: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  const refresh = useCallback(async () => {
    try {
      setData(await loadRef.current());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, 'UNKNOWN', String(e)));
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, intervalMs);
    return () => clearInterval(timer);
  }, [refresh, intervalMs]);

  return { data, error, refresh, setData };
}

// Responses where we don't know if the money moved: the same request must be
// retried with the SAME Idempotency-Key so the server can find (and finish) it.
export const isRetryable = (e: unknown) =>
  e instanceof ApiError && (e.status === 0 || e.status >= 500);

// One Idempotency-Key per attempt. Submitting the same thing again after an
// unknown outcome reuses the key; any definite outcome, or changing what's being
// submitted, starts a new attempt with a fresh key.
export function useAttemptKey() {
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null);
  return {
    keyFor(fingerprint: string) {
      if (attempt.current?.fingerprint !== fingerprint) {
        attempt.current = { fingerprint, key: crypto.randomUUID() };
      }
      return attempt.current.key;
    },
    settle() {
      attempt.current = null;
    },
  };
}
