/**
 * useInputDraft Hook
 *
 * Manages draft persistence for message input: loads the draft on session
 * change, debounces saves, and clears on empty. Voice transcripts are
 * DAEMON-coordinated — session.get already presents the composition of
 * typing + staged transcript, a write containing the staged text consumes
 * it server-side (adoption), and the daemon's `session.voiceLanded` event
 * tells this composer to re-read. The hook holds no voice state of its own:
 * no landing markers, no save suppression, no draft backups, no version
 * protocol — concurrent typing is plain last-writer-wins, exactly like every
 * non-voice draft.
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
  // The live session id, so a cancelled get can tell "the user typed" (same
  // session) from "the hook moved to another session" (never touch the new
  // session's content).
  const currentSessionIdRef = useRef(sessionId);
  // The sessionId whose initial draft load has settled. While a session's
  // initial load is still in flight, the signal is transiently '' — letting the
  // save effect issue its immediate "empty → clear" write in that window can
  // wipe the server-side draft (including the voice composition the daemon
  // presented) before the loaded value is re-persisted.
  const initialLoadSettledRef = useRef<string | null>(null);
  // Last state observed for each session while it was active. The switch flush
  // below must NOT read the live signal: by the time it runs, the
  // session-change effect has already cleared the signal to '', and flushing
  // that transient value would wipe the previous session's draft on every
  // switch. `cleared` marks an EXPLICIT post-load deletion, which the switch
  // flush retries (the immediate clear may have failed before reaching
  // SQLite).
  const lastSeenContentRef = useRef<{
    sessionId: string | null;
    content: string;
    cleared?: boolean;
  }>({ sessionId: null, content: '' });
  // The draft value this composer last ADOPTED from a read (initial load or a
  // voiceLanded refresh). A composer still showing exactly this value has no
  // user edits, so a voiceLanded refresh may adopt over it; anything else is
  // typing, and clobbering it is never acceptable.
  const lastLoadedDraftRef = useRef<string>('');

  // Fetch the server draft into the signal, guarded against staleness (the
  // session may have changed or the hook unmounted while the get was in
  // flight). The daemon merges nothing on read — the response's inputDraft is
  // already the composition of typing + staged voice transcript when it fits.
  // `applyGuard` (used by the voiceLanded refresh) re-checks at RESOLVE time
  // that the composer is still idle-or-unchanged, so typing that began
  // mid-get is never clobbered by the response.
  const loadDraft = useCallback(
    (
      targetSessionId: string,
      isCancelled: () => boolean,
      onResult?: (ok: boolean, applied?: boolean, draft?: string) => void,
      applyGuard?: () => boolean
    ): void => {
      const hub = connectionManager.getHubIfConnected();
      if (!hub) {
        onResult?.(false);
        return;
      }
      hub
        .request<{ session?: { metadata?: { inputDraft?: string } } }>('session.get', {
          sessionId: targetSessionId,
        })
        .then((response) => {
          if (isCancelled()) return;
          const draft = response.session?.metadata?.inputDraft ?? '';
          const applied = applyGuard ? applyGuard() : true;
          if (applied) {
            contentSignal.value = draft;
            lastLoadedDraftRef.current = draft;
          }
          onResult?.(true, applied, draft);
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
    currentSessionIdRef.current = sessionId;

    // Clear content immediately to prevent showing stale draft
    contentSignal.value = '';
    lastLoadedDraftRef.current = '';

    // Stale-load guard: if the session changes (or the hook unmounts) while this
    // get is in flight, the cleanup flips `cancelled` so the resolved draft is
    // not written into a signal now backing a different session.
    let cancelled = false;
    loadDraft(
      sessionId,
      () => cancelled,
      () => {
        if (cancelled) return; // session changed / unmounted — not our load
        // Only a load that was NOT cancelled (session still current) marks the
        // initial load settled; a stale rejection must not settle a newer load.
        initialLoadSettledRef.current = sessionId;
      }
    );
    return () => {
      cancelled = true;
    };
  }, [sessionId, contentSignal, loadDraft]);

  // Voice landing refresh: the daemon announces every committed
  // session.appendVoiceDraft on the session channel. An idle-or-unchanged
  // composer re-reads and adopts the composition (typing + staged transcript);
  // a composer with user typing is NEVER clobbered — the staged transcript is
  // durable server-side and converges at the next clear, send, or navigation.
  // After adopting, the composition is saved IMMEDIATELY (not debounced): the
  // daemon's adoption rule then consumes the staging atomically, so editing
  // the transcript in the debounce window cannot leave the un-edited original
  // staged to reappear later.
  useEffect(() => {
    if (!sessionId) return;
    let unsubEvent: (() => void) | null = null;
    const register = (): void => {
      if (unsubEvent) return;
      const hub = connectionManager.getHubIfConnected();
      if (!hub) return; // re-armed by the connection subscription below
      unsubEvent = hub.onEvent(
        'session.voiceLanded',
        (data: { sessionId?: string }, context?: { channel?: string }) => {
          if (context?.channel !== `session:${sessionId}`) return;
          if (currentSessionIdRef.current !== sessionId) return;
          // Only an IDLE or UNCHANGED composer adopts: empty, or still showing
          // exactly the last-read draft (no user edits since). The guard is
          // re-checked at RESOLVE time inside loadDraft, so typing that began
          // mid-get is never clobbered by the response.
          const adoptable = (): boolean => {
            const current = contentSignal.peek();
            return current === '' || current === lastLoadedDraftRef.current;
          };
          if (!adoptable()) return;
          loadDraft(
            sessionId,
            () => currentSessionIdRef.current !== sessionId,
            (ok, applied, draft) => {
              if (!ok || !applied) return;
              if (currentSessionIdRef.current !== sessionId) return;
              if (!draft) return;
              // Typing began mid-get (the guard flipped between the apply and
              // here): the immediate save must not push the composition over
              // newer keystrokes — their own debounced save carries the text,
              // and the staged transcript survives server-side until an
              // adoption or the send-clear consumes it.
              if (contentSignal.peek() !== draft) return;
              const hubNow = connectionManager.getHubIfConnected();
              if (!hubNow) return;
              hubNow
                .request('session.update', {
                  sessionId,
                  metadata: { inputDraft: draft },
                })
                .catch(() => {
                  /* the debounced save path retries the adoption */
                });
            },
            adoptable
          );
        }
      );
    };
    register();
    // Re-arm across connection cycles: a replaced hub drops event handlers,
    // and the subscription must survive reconnects. (Reading .value here would
    // re-run the effect on every connection change; the subscription API
    // itself is the established pattern for connection-keyed re-armoring.)
    const unsubscribeConnection = connectionState.subscribe(() => {
      if (unsubEvent) {
        unsubEvent();
        unsubEvent = null;
      }
      register();
    });
    return () => {
      unsubscribeConnection();
      if (unsubEvent) unsubEvent();
    };
  }, [sessionId, contentSignal, loadDraft]);

  // Save draft with debouncing - uses useSignalEffect to react to signal changes
  useSignalEffect(() => {
    const content = contentSignal.value;

    // Skip save logic entirely when there is no session — draft is ephemeral.
    if (!sessionId) return;
    // Clear any scheduled debounce FIRST, so a stale save scheduled before a
    // content change cannot fire over it.
    if (draftSaveTimeoutRef.current) {
      clearTimeout(draftSaveTimeoutRef.current);
      draftSaveTimeoutRef.current = null;
    }
    // If sessionId changed, flush the previous session's draft immediately —
    // its LAST KNOWN state. Skip only when nothing is known to flush: content,
    // or an explicit deletion whose clear should be retried. The transient
    // pre-load '' is never recorded, so it cannot wipe the previous draft.
    if (prevSessionIdRef.current && prevSessionIdRef.current !== sessionId) {
      const prevSessionId = prevSessionIdRef.current;
      const last = lastSeenContentRef.current;
      const flushContent = last.sessionId === prevSessionId ? last.content.trim() : '';
      const wasCleared = last.sessionId === prevSessionId && !!last.cleared;
      prevSessionIdRef.current = sessionId;
      if (!flushContent && !wasCleared) return;
      const hub = connectionManager.getHubIfConnected();
      if (!hub) return; // offline — the deletion/content is simply not flushed
      hub
        .request('session.update', {
          sessionId: prevSessionId,
          metadata: {
            inputDraft: flushContent || null,
          },
        })
        .catch(() => {
          /* ignore flush errors */
        });
      return;
    }
    prevSessionIdRef.current = sessionId;

    const trimmedContent = content.trim();

    // Empty content: save immediately to clear draft — EXCEPT while this
    // session's initial load is still in flight, when the empty signal is the
    // transient pre-load state, not a user deletion. Clearing then can wipe a
    // server-side draft (including the voice composition) before the loaded
    // value lands.
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
        // The daemon consumes a staged voice transcript exactly when this
        // write contains it (adoption) — nothing further to adopt locally.
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
