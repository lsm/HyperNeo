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
import { connectionState } from '../lib/state';
import {
  consumeVoiceTranscriptLanded,
  voiceTranscriptLandedSignal,
} from '../lib/voice/voice-transcript-outbox';

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

  // Fetch the server draft into the signal, guarded against staleness (the
  // session may have changed or the hook unmounted while the get was in
  // flight). Shared by the initial session-change load and the outbox-replay
  // refresh below. The daemon merges any staged voice transcript
  // (inputDraftVoicePending) into inputDraft atomically while serving the
  // request, so the draft here already includes it — no client-side merge.
  // `onResult` runs once the load has settled: `ok` is whether the get
  // succeeded (no hub counts as a failure), and `pendingRetained` reports
  // whether the daemon KEPT `inputDraftVoicePending` because the draft was too
  // full to merge — the landed transcript is still staged, so a landing must
  // not be consumed as delivered. The initial load marks itself settled
  // regardless; the replay refresh consumes its landing only on a successful
  // FULL merge.
  const loadDraft = useCallback(
    (
      targetSessionId: string,
      isCancelled: () => boolean,
      onResult?: (ok: boolean, pendingRetained?: boolean) => void
    ): void => {
      const hub = connectionManager.getHubIfConnected();
      if (!hub) {
        onResult?.(false);
        return;
      }
      hub
        .request<{
          session: { metadata?: { inputDraft?: string; inputDraftVoicePending?: string | null } };
        }>('session.get', {
          sessionId: targetSessionId,
        })
        .then((response) => {
          if (isCancelled()) return;
          const draft = response.session?.metadata?.inputDraft;
          if (draft) contentSignal.value = draft;
          const pendingRetained = !!response.session?.metadata?.inputDraftVoicePending;
          onResult?.(true, pendingRetained);
        })
        .catch(() => {
          // A stale request (session changed / hook unmounted while this get
          // was in flight) must not report a failure that settles a NEWER
          // load — mirror the success path's cancellation guard.
          if (isCancelled()) return;
          onResult?.(false);
        });
    },
    [contentSignal]
  );

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
    loadDraft(
      sessionId,
      () => cancelled,
      () => {
        initialLoadSettledRef.current = sessionId;
      }
    );
    return () => {
      cancelled = true;
    };
  }, [sessionId, contentSignal, loadDraft]);

  // Refresh the mounted draft when the outbox lands a transcript for this
  // session (e.g. after a page reload or reconnect replay). The pending field
  // is otherwise merged only during session.get, which runs on session change —
  // without this, a replay into an already-open composer stays invisible until
  // the next navigation. Guard on an IDLE composer: the get overwrites the
  // local signal, so reloading over in-progress typing would lose keystrokes.
  // Reading contentSignal (not peek()) subscribes the effect to typing, so a
  // landing while the composer has text DEFERS (the session stays in the map)
  // until it clears, and a keystroke that lands mid-get re-runs the effect
  // whose cleanup aborts the stale get — the server draft can never clobber
  // newer keystrokes. Reading connectionState re-runs the effect when the
  // connection is restored, so a refresh that failed on a dropped socket
  // retries once the session.get can succeed again. The landing of generation
  // `generation` is consumed only after a refresh that observed exactly that
  // generation AND saw the pending fully merged — a newer landing or a
  // retained pending (draft too full) keeps a refresh pending.
  const prevReplayContentRef = useRef('');
  useSignalEffect(() => {
    const generation = voiceTranscriptLandedSignal.value.get(sessionId);
    if (generation === undefined) return;
    void connectionState.value;
    const content = contentSignal.value;
    // The composer just emptied (a send/clear) when its previous content was
    // non-empty: clear the possibly-stale server draft BEFORE the get merges
    // the pending transcript — the two RPCs must not race, or the clear could
    // erase the just-merged transcript (or the merge resurrect already-sent
    // text). A fresh-mount empty composer keeps the get only.
    const justCleared = prevReplayContentRef.current.trim() !== '';
    prevReplayContentRef.current = content;
    if (content.trim() !== '') return;
    let cancelled = false;
    const refresh = () => {
      if (cancelled) return;
      loadDraft(
        sessionId,
        () => cancelled,
        (ok, pendingRetained) => {
          if (ok && !pendingRetained) consumeVoiceTranscriptLanded(sessionId, generation);
        }
      );
    };
    if (justCleared) {
      const hub = connectionManager.getHubIfConnected();
      if (hub) {
        hub
          .request('session.update', { sessionId, metadata: { inputDraft: null } })
          .catch(() => {
            /* the get still runs — a failed clear just leaves the old text */
          })
          .then(refresh);
      } else {
        refresh();
      }
    } else {
      refresh();
    }
    return () => {
      cancelled = true;
    };
  });

  // Save draft with debouncing - uses useSignalEffect to react to signal changes
  // Last state observed for each session while it was active. The flush below
  // must NOT read the live signal: by the time it runs, the session-change
  // effect has already cleared the signal to '', and flushing that transient
  // value would wipe the previous session's draft on every switch. `cleared`
  // marks an EXPLICIT post-load deletion, which the switch flush retries (the
  // immediate clear may have failed before reaching SQLite).
  const lastSeenContentRef = useRef<{
    sessionId: string | null;
    content: string;
    cleared?: boolean;
  }>({ sessionId: null, content: '' });
  useSignalEffect(() => {
    const content = contentSignal.value;

    // Skip save logic entirely when there is no session — draft is ephemeral.
    if (!sessionId) return;
    // Clear any scheduled debounce FIRST, so a save scheduled before a landing
    // fired cannot later issue a stale write while we suppress for the landing.
    if (draftSaveTimeoutRef.current) {
      clearTimeout(draftSaveTimeoutRef.current);
      draftSaveTimeoutRef.current = null;
    }
    // While a landing is pending for THIS session — or the PREVIOUS session
    // being flushed on a switch — the server draft may have been updated (this
    // tab's or another tab's refresh merged the landed transcript), so this
    // tab's local copy is stale and a debounced save or the switch flush would
    // overwrite the transcript. Suppress those until the landing is consumed by
    // the idle refresh. The refresh itself owns the clear-before-merge for an
    // explicit send/clear (see the replay effect), so nothing is suppressed
    // here that would otherwise resurrect already-sent text.
    if (
      voiceTranscriptLandedSignal.value.has(sessionId) ||
      (prevSessionIdRef.current !== null &&
        voiceTranscriptLandedSignal.value.has(prevSessionIdRef.current))
    ) {
      return;
    }

    // If sessionId changed, flush the previous session's draft immediately —
    // its LAST KNOWN state. Skip only when nothing is known to flush: content,
    // or an explicit deletion whose clear should be retried. The transient
    // pre-load '' is never recorded, so it cannot wipe the previous draft.
    if (prevSessionIdRef.current && prevSessionIdRef.current !== sessionId) {
      const prevSessionId = prevSessionIdRef.current;
      const last = lastSeenContentRef.current;
      const trimmedContent = last.sessionId === prevSessionId ? last.content.trim() : '';

      const hub = connectionManager.getHubIfConnected();
      if (hub && (trimmedContent || (last.sessionId === prevSessionId && last.cleared))) {
        hub
          .request('session.update', {
            sessionId: prevSessionId,
            metadata: {
              inputDraft: trimmedContent || null,
            },
          })
          .catch(() => {
            /* ignore flush errors */
          });
      }
    }
    prevSessionIdRef.current = sessionId;

    const trimmedContent = content.trim();

    // Empty content: save immediately to clear draft — EXCEPT while this
    // session's initial load is still in flight, when the empty signal is the
    // transient pre-load state, not a user deletion. Clearing then can wipe a
    // server-side draft (including a just-merged voice transcript) before the
    // loaded value lands.
    if (trimmedContent === '') {
      if (initialLoadSettledRef.current !== sessionId) return;
      lastSeenContentRef.current = { sessionId, content: '', cleared: true };
      const hub = connectionManager.getHubIfConnected();
      if (hub) {
        hub
          .request('session.update', {
            sessionId,
            metadata: {
              inputDraft: null,
            },
          })
          .then(() => {
            // Deletion CONFIRMED server-side: drop the retry marker so a later
            // switch flush cannot null a NEWER draft another client saved in
            // the meantime. A rejected clear keeps the marker and retries.
            if (lastSeenContentRef.current.sessionId === sessionId) {
              lastSeenContentRef.current = { sessionId, content: '' };
            }
          })
          .catch(() => {
            /* ignore clear errors */
          });
      }
      return;
    }

    // Non-empty content: debounce save
    lastSeenContentRef.current = { sessionId, content };
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
