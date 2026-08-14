/**
 * useInputDraft Hook
 *
 * Manages draft persistence for message input.
 * Handles loading drafts on session change, debounced saving,
 * and immediate clearing when content is empty.
 *
 * IMPORTANT: Uses Preact Signals instead of useState to prevent lost keystrokes.
 *
 * Why signals? When server pushes state updates (e.g., agent working status),
 * components that read .value in render re-render immediately. With useState,
 * these re-renders can use stale content values (before React flushes pending
 * state updates), causing typed characters to be lost. Signals are synchronous
 * and always return the current value, eliminating this race condition.
 *
 * See: packages/web/src/components/__tests__/MessageInput.signal-state-race.test.tsx
 *
 * @example
 * ```typescript
 * const { content, setContent } = useInputDraft(sessionId);
 *
 * <textarea
 *   value={content}
 *   onInput={(e) => setContent(e.target.value)}
 * />
 * ```
 */

import { useEffect, useRef, useCallback, useMemo } from 'preact/hooks';
import { useSignal, useSignalEffect } from '@preact/signals';
import { connectionManager } from '../lib/connection-manager';

export interface UseInputDraftResult {
  /** Current content value */
  content: string;
  /** Update the content (triggers debounced save) */
  setContent: (content: string) => void;
  /** Clear the content and draft */
  clear: () => void;
}

/**
 * Hook for managing message input draft persistence
 *
 * Uses Preact Signals for content state to prevent race conditions
 * between signal-triggered re-renders and React state updates.
 *
 * @param sessionId - Current session ID
 * @param debounceMs - Debounce delay for saving (default: 250ms)
 */
export function useInputDraft(sessionId: string, debounceMs = 250): UseInputDraftResult {
  // Use signal for content to prevent lost keystrokes during signal-triggered re-renders
  const contentSignal = useSignal('');
  const draftSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevSessionIdRef = useRef<string | null>(null);
  // The sessionId whose initial draft load has settled. While a session's
  // initial load is still in flight, the signal is transiently '' — letting the
  // save effect issue its immediate "empty → clear" write in that window can
  // wipe the server-side draft (including a voice transcript the daemon merged
  // while serving the load) before the loaded value is re-persisted.
  const initialLoadSettledRef = useRef<string | null>(null);

  // Load draft on session change
  useEffect(() => {
    // Clear content immediately when sessionId changes
    if (!sessionId) {
      contentSignal.value = '';
      return;
    }

    // A new load begins: invalidate the settled marker BEFORE clearing the
    // signal, so the transient '' cannot pass the empty-clear guard. Without
    // this, loading A -> B -> back to A would see the stale marker for A and
    // clear A's durable draft while A's fresh get is still in flight.
    initialLoadSettledRef.current = null;

    // Clear content immediately to prevent showing stale draft
    contentSignal.value = '';

    // Stale-load guard: if the session changes (or the hook unmounts) while this
    // get is in flight, the cleanup flips `cancelled` so the resolved draft is
    // not written into a signal now backing a different session.
    let cancelled = false;
    const loadDraft = async () => {
      const hub = connectionManager.getHubIfConnected();
      if (!hub) {
        initialLoadSettledRef.current = sessionId;
        return;
      }

      try {
        const response = await hub.request<{
          session: { metadata?: { inputDraft?: string } };
        }>('session.get', { sessionId });
        if (cancelled) return;
        // The daemon merges any staged voice transcript (inputDraftVoicePending)
        // into inputDraft atomically while serving this request, so the draft
        // here already includes it — no client-side merge needed.
        const draft = response.session?.metadata?.inputDraft;
        if (draft) {
          contentSignal.value = draft;
        }
      } catch {
        // Ignore errors loading draft
      } finally {
        if (!cancelled) initialLoadSettledRef.current = sessionId;
      }
    };

    loadDraft();
    return () => {
      cancelled = true;
    };
  }, [sessionId, contentSignal]);

  // Save draft with debouncing - uses useSignalEffect to react to signal changes
  // Last content observed for each session while it was active. The flush below
  // must NOT read the live signal: by the time it runs, the session-change
  // effect has already cleared the signal to '', and flushing that transient
  // value would wipe the previous session's draft on every switch.
  const lastSeenContentRef = useRef<{ sessionId: string | null; content: string }>({
    sessionId: null,
    content: '',
  });
  useSignalEffect(() => {
    const content = contentSignal.value;

    // Skip save logic entirely when there is no session — draft is ephemeral.
    if (!sessionId) return;
    // Clear existing timeout
    if (draftSaveTimeoutRef.current) {
      clearTimeout(draftSaveTimeoutRef.current);
      draftSaveTimeoutRef.current = null;
    }

    // If sessionId changed, flush the previous session's draft immediately —
    // its LAST KNOWN content. Skip when there is nothing to flush: real
    // in-session deletions were already cleared immediately (post-settle), and
    // an empty flush here would wipe the previous draft based only on the
    // transient pre-load ''.
    if (prevSessionIdRef.current && prevSessionIdRef.current !== sessionId) {
      const prevSessionId = prevSessionIdRef.current;
      const last = lastSeenContentRef.current;
      const trimmedContent = last.sessionId === prevSessionId ? last.content.trim() : '';

      const hub = connectionManager.getHubIfConnected();
      if (hub && trimmedContent) {
        hub
          .request('session.update', {
            sessionId: prevSessionId,
            metadata: {
              inputDraft: trimmedContent,
            },
          })
          .catch(() => {
            /* ignore flush errors */
          });
      }
    }
    prevSessionIdRef.current = sessionId;

    const trimmedContent = content.trim();
    lastSeenContentRef.current = { sessionId, content };

    // Empty content: save immediately to clear draft — EXCEPT while this
    // session's initial load is still in flight, when the empty signal is the
    // transient pre-load state, not a user deletion. Clearing then can wipe a
    // server-side draft (including a just-merged voice transcript) before the
    // loaded value lands.
    if (trimmedContent === '') {
      if (initialLoadSettledRef.current !== sessionId) return;
      const hub = connectionManager.getHubIfConnected();
      if (hub) {
        hub
          .request('session.update', {
            sessionId,
            metadata: {
              inputDraft: null,
            },
          })
          .catch(() => {
            /* ignore clear errors */
          });
      }
      return;
    }

    // Non-empty content: debounce save
    draftSaveTimeoutRef.current = setTimeout(async () => {
      const hub = connectionManager.getHubIfConnected();
      if (!hub) return;

      try {
        await hub.request('session.update', {
          sessionId,
          metadata: {
            inputDraft: trimmedContent,
          },
        });
      } catch {
        // Ignore draft save errors
      }
    }, debounceMs);

    return () => {
      if (draftSaveTimeoutRef.current) {
        clearTimeout(draftSaveTimeoutRef.current);
        draftSaveTimeoutRef.current = null;
      }
    };
  });

  // Stable setter that updates the signal
  const setContent = useCallback(
    (newContent: string) => {
      contentSignal.value = newContent;
    },
    [contentSignal]
  );

  // Stable clear function
  const clear = useCallback(() => {
    contentSignal.value = '';
  }, [contentSignal]);

  // Return the current signal value as content
  // useMemo ensures we return a consistent object reference when only content changes
  return useMemo(
    () => ({
      get content() {
        return contentSignal.value;
      },
      setContent,
      clear,
    }),
    [contentSignal, setContent, clear]
  );
}
