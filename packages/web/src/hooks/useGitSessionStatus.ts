import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { GitSessionStatusResponse } from '@hyperneo/shared';
import { getGitSessionStatus } from '../lib/api-helpers.ts';

/**
 * Polling interval for live git status while the panel is open and the tab is
 * visible. The backend `git.sessionStatus` recomputes the full review on each
 * call (including a `gh pr view` / `gh pr checks` subprocess with an 8s
 * timeout), so this is deliberately moderate — frequent enough to feel live as
 * the agent edits the tree, without hammering GitHub.
 *
 * A daemon `git.status.bySession` LiveQuery keyed off file writes would be the
 * better long-term signal; this polling is the interim implementation.
 */
const POLL_INTERVAL_MS = 10_000;

export interface UseGitSessionStatusResult {
  status: GitSessionStatusResponse | null;
  loading: boolean;
  error: string | null;
  /** Re-fetch and flip the loading spinner (manual refresh). */
  refresh: () => void;
}

/**
 * Single source of truth for a session's git status. Fetches on mount (and when
 * the session changes), polls on a short interval while the tab is visible, and
 * exposes a manual refresh. Polling is silent (no spinner) so the UI doesn't
 * flicker; only the initial load and manual refresh flip `loading`.
 */
export function useGitSessionStatus(sessionId: string | null): UseGitSessionStatusResult {
  const [status, setStatus] = useState<GitSessionStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);
  const inFlight = useRef(false);

  const load = useCallback(
    (opts: { silent: boolean }) => {
      if (!sessionId) return;
      // Guard against overlapping polls — a single git.sessionStatus call can
      // take seconds (gh subprocess), so don't stack the next one on top.
      if (inFlight.current) return;
      const requestId = ++requestSeq.current;
      inFlight.current = true;
      if (!opts.silent) setLoading(true);
      getGitSessionStatus(sessionId)
        .then((nextStatus) => {
          if (requestId === requestSeq.current) {
            setStatus(nextStatus);
            setError(null);
          }
        })
        .catch((err) => {
          if (requestId === requestSeq.current) {
            setError(err instanceof Error ? err.message : 'Failed to load Git status');
          }
        })
        .finally(() => {
          if (requestId === requestSeq.current && !opts.silent) setLoading(false);
          inFlight.current = false;
        });
    },
    [sessionId]
  );

  // Initial load + reload on session change.
  useEffect(() => {
    requestSeq.current++; // invalidate any in-flight request from the previous session
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
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [sessionId, load]);

  const refresh = useCallback(() => load({ silent: false }), [load]);

  return { status, loading, error, refresh };
}
