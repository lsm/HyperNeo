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
  // Mirrors `status` so the failure handler can decide whether a usable status
  // already exists without depending on `status` (which would re-create `load`
  // and re-trigger the effect on every status update).
  const statusRef = useRef<GitSessionStatusResponse | null>(null);

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
          if (requestId !== requestSeq.current) return;
          statusRef.current = nextStatus;
          setStatus(nextStatus);
          setError(null);
        })
        .catch((err) => {
          if (requestId !== requestSeq.current) return;
          // A transient silent-poll failure must not hide a usable status —
          // only surface a blocking error when there's nothing to render.
          // Non-silent (initial/manual) failures always report so the user
          // gets feedback; GitPanel renders those non-destructively when a
          // status is already on screen.
          if (opts.silent && statusRef.current) return;
          setError(err instanceof Error ? err.message : 'Failed to load Git status');
        })
        .finally(() => {
          // Only the current request owns the in-flight flag and loading
          // spinner. A request superseded by a session switch (requestSeq
          // bumped) leaves both untouched so the new session's load isn't
          // stranded on the loading state.
          if (requestId !== requestSeq.current) return;
          inFlight.current = false;
          if (!opts.silent) setLoading(false);
        });
    },
    [sessionId]
  );

  // Initial load + reload on session change.
  useEffect(() => {
    requestSeq.current++; // invalidate any in-flight request from the previous session
    statusRef.current = null;
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
      // Release the in-flight guard so the next session's initial load always
      // runs, even if this session's fetch is still pending (its settle is
      // ignored via requestSeq, and its finally won't touch the flag).
      inFlight.current = false;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [sessionId, load]);

  const refresh = useCallback(() => load({ silent: false }), [load]);

  return { status, loading, error, refresh };
}
