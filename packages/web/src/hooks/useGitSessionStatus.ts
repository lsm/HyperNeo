import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { GitSessionStatusResponse } from '@hyperneo/shared';
import { getGitSessionStatus } from '../lib/api-helpers.ts';

const POLL_INTERVAL_MS = 10_000;

export interface UseGitSessionStatusResult {
  status: GitSessionStatusResponse | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useGitSessionStatus(sessionId: string | null): UseGitSessionStatusResult {
  const [status, setStatus] = useState<GitSessionStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);
  const inFlight = useRef(false);
  const pendingManual = useRef(false);
  const statusRef = useRef<GitSessionStatusResponse | null>(null);
  const loadRef = useRef<(opts: { silent: boolean }) => void>(() => {});

  const load = useCallback(
    (opts: { silent: boolean }) => {
      if (!sessionId) return;
      if (inFlight.current) {
        if (!opts.silent) {
          pendingManual.current = true;
          setLoading(true);
        }
        return;
      }
      const requestId = ++requestSeq.current;
      inFlight.current = true;
      if (!opts.silent) setLoading(true);
      getGitSessionStatus(sessionId)
        .then((nextStatus) => {
          if (requestId !== requestSeq.current) return;
          statusRef.current = nextStatus;
          setStatus(nextStatus);
          setError(null);
        })
        .catch((err) => {
          if (requestId !== requestSeq.current) return;
          if (opts.silent && statusRef.current) return;
          setError(err instanceof Error ? err.message : 'Failed to load Git status');
        })
        .finally(() => {
          if (requestId !== requestSeq.current) return;
          inFlight.current = false;
          if (!opts.silent) setLoading(false);
          if (pendingManual.current) {
            pendingManual.current = false;
            loadRef.current({ silent: false });
          }
        });
    },
    [sessionId]
  );

  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    requestSeq.current++;
    statusRef.current = null;
    pendingManual.current = false;
    setStatus(null);
    setError(null);
    setLoading(true);
    if (!sessionId) {
      setLoading(false);
      return;
    }
    load({ silent: false });

    const poll = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      load({ silent: true });
    };
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    const onVisibility = () => {
      if (!document.hidden) load({ silent: true });
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      requestSeq.current++;
      inFlight.current = false;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [sessionId, load]);

  const refresh = useCallback(() => load({ silent: false }), [load]);

  return { status, loading, error, refresh };
}
