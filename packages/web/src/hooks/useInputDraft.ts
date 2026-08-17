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
  // A landing that could not surface yet — the composer was typing at event
  // time, typing began mid-get, or the refresh get failed on a dropped
  // socket — arms a ONE-SHOT re-check: the next transition to an empty
  // composer (a send or clear) or the next connection transition retries the
  // adoption refresh once. This mirrors the pre-PR client, where a landing
  // during typing deferred until the composer cleared and a refresh that
  // failed offline retried on reconnect.
  const deferredVoiceAdoptRef = useRef<string | null>(null);
  // Monotonic id of the latest loadDraft REQUEST: a response applies only
  // while its request is still the newest. A slower OLDER response (the
  // mount-time get racing a voiceLanded refresh, or two refreshes) must never
  // overwrite what a newer request already applied — the initial get resolving
  // after an adoption would otherwise regress the composer and its next save
  // to the pre-transcript draft, durably dropping an already-consumed staging.
  // A superseding request that FAILS simply never applies anything; the
  // composer then converges on its next event rather than regressing.
  const loadRequestSeqRef = useRef(0);

  // Fetch the server draft into the signal, guarded against staleness (the
  // session may have changed or the hook unmounted while the get was in
  // flight). The daemon merges nothing on read — the response's inputDraft is
  // already the composition of typing + staged voice transcript when it fits.
  // Two resolve-time guards: `applyGuard` (used by the voiceLanded refresh
  // and the initial load) re-checks that the composer is still
  // idle-or-unchanged, so typing that began mid-get is never clobbered; and
  // the request-sequence check discards responses of superseded loads, so an
  // older get can never overwrite a newer load's applied state.
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
      const requestSeq = ++loadRequestSeqRef.current;
      hub
        .request<{ session?: { metadata?: { inputDraft?: string } } }>('session.get', {
          sessionId: targetSessionId,
        })
        .then((response) => {
          if (isCancelled()) return;
          const draft = response.session?.metadata?.inputDraft ?? '';
          const applied =
            (applyGuard ? applyGuard() : true) && loadRequestSeqRef.current === requestSeq;
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

  // Issue the voiceLanded adoption refresh for `targetSessionId`: re-read the
  // composed draft and, for an idle-or-unchanged composer, adopt it and save
  // the composition IMMEDIATELY (not debounced) so the daemon's adoption rule
  // consumes the staging in one write — editing the transcript in the
  // debounce window cannot then leave the un-edited original staged to
  // reappear later. Shared by the voiceLanded listener, the deferred re-check
  // when a typing composer empties, and the post-reconnect retry.
  const issueAdoptionRefresh = useCallback(
    (targetSessionId: string): void => {
      // Only an IDLE or UNCHANGED composer adopts: empty, or still showing
      // exactly the last-read draft (no user edits since). The guard is
      // re-checked at RESOLVE time inside loadDraft, so typing that began
      // mid-get is never clobbered by the response.
      const adoptable = (): boolean => {
        const current = contentSignal.peek();
        return current === '' || current === lastLoadedDraftRef.current;
      };
      if (!adoptable()) {
        // Typing: the transcript stays durable server-side and the one-shot
        // re-check below surfaces it when the composer empties.
        deferredVoiceAdoptRef.current = targetSessionId;
        return;
      }
      loadDraft(
        targetSessionId,
        () => currentSessionIdRef.current !== targetSessionId,
        (ok, applied, draft) => {
          if (currentSessionIdRef.current !== targetSessionId) return;
          if (!ok || !applied) {
            // The refresh failed (dropped socket / transient get error) or
            // was rejected (typing began mid-get): retry once on the next
            // empty-composer or connection transition.
            deferredVoiceAdoptRef.current = targetSessionId;
            return;
          }
          deferredVoiceAdoptRef.current = null;
          if (!draft) return; // nothing staged — the landing is handled
          // Typing began mid-get (the guard flipped between the apply and
          // here): the immediate save must not push the composition over
          // newer keystrokes — their own debounced save carries the text,
          // and the staged transcript survives server-side until an
          // adoption or the send-clear consumes it.
          if (contentSignal.peek() !== draft) {
            deferredVoiceAdoptRef.current = targetSessionId;
            return;
          }
          // Record the adopted composition as the session's LAST-SEEN
          // content before saving: a session switch in the frame before the
          // deferred save effect runs would otherwise take the switch-flush
          // branch with the STALE pre-adoption value (lastSeenContentRef
          // still held it) and write it over this save — regressing the
          // server past the staging this write just consumed.
          lastSeenContentRef.current = { sessionId: targetSessionId, content: draft };
          // Cancel any armed debounced save SYNCHRONOUSLY, before the
          // immediate save below: the save effect that would normally
          // clear it is rAF-deferred, and a timer due inside that frame
          // gap would fire AFTER this save and write its STALE
          // pre-adoption value — regressing the server past the staging
          // this save just consumed (deterministically in hidden tabs,
          // where rAF never runs while clamped timers still fire).
          if (draftSaveTimeoutRef.current) {
            clearTimeout(draftSaveTimeoutRef.current);
            draftSaveTimeoutRef.current = null;
          }
          const hubNow = connectionManager.getHubIfConnected();
          if (!hubNow) {
            // Offline at resolve time: the debounced effect retries when the
            // connection returns (and the one-shot re-check covers a retry
            // on the next transition).
            deferredVoiceAdoptRef.current = targetSessionId;
            return;
          }
          hubNow
            .request('session.update', {
              sessionId: targetSessionId,
              metadata: { inputDraft: draft },
            })
            .catch(() => {
              /* the debounced save path retries the adoption */
            });
        },
        adoptable
      );
    },
    [contentSignal, loadDraft]
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
    // Apply-guard, re-checked at RESOLVE time: the composer must still be
    // pre-load ('') or unchanged since the last read. Typing that began while
    // the mount-time get was in flight is NEVER clobbered by its response —
    // the same rule as the voiceLanded refresh — and the server draft it
    // raced converges on the next re-read.
    const adoptable = (): boolean => {
      const current = contentSignal.peek();
      return current === '' || current === lastLoadedDraftRef.current;
    };
    loadDraft(
      sessionId,
      () => cancelled,
      (_ok, applied) => {
        if (cancelled) return; // session changed / unmounted — not our load
        // Only a load that actually APPLIED marks the initial load settled. A
        // load discarded as superseded (a voiceLanded refresh's get was newer)
        // must not open the empty-clear guard while the signal still shows the
        // transient pre-load '' — that write would wipe the server draft.
        if (!applied) return;
        initialLoadSettledRef.current = sessionId;
      },
      adoptable
    );
    return () => {
      cancelled = true;
    };
  }, [sessionId, contentSignal, loadDraft]);

  // Voice landing refresh: the daemon announces every committed
  // session.appendVoiceDraft on the session channel. An idle-or-unchanged
  // composer re-reads and adopts the composition (typing + staged transcript);
  // a composer with user typing is NEVER clobbered at event time — the
  // one-shot re-check (see deferredVoiceAdoptRef) surfaces the staging when
  // the composer next empties or the connection cycles, and until then the
  // staging stays durable server-side (a typing-only send-clear deliberately
  // leaves it staged).
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
          issueAdoptionRefresh(sessionId);
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
      // A refresh that failed on a dropped socket (or was deferred by
      // typing) retries ONCE here — the landing event itself was already
      // consumed. Bounded by the one-shot marker: issueAdoptionRefresh
      // re-arms it only on another failure/deferral.
      if (deferredVoiceAdoptRef.current === sessionId) {
        deferredVoiceAdoptRef.current = null;
        issueAdoptionRefresh(sessionId);
      }
    });
    return () => {
      unsubscribeConnection();
      if (unsubEvent) unsubEvent();
    };
  }, [sessionId, issueAdoptionRefresh]);

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
      // A landing that arrived while this composer was typing surfaces NOW
      // that the composer emptied (a send or a deliberate clear): one-shot
      // re-check, mirroring the pre-PR deferred surfacing. Issued after the
      // clear write above so the requests stay sequenced on the socket.
      if (deferredVoiceAdoptRef.current === sessionId) {
        deferredVoiceAdoptRef.current = null;
        issueAdoptionRefresh(sessionId);
      }
      return;
    }

    // Non-empty content: debounce save. Reaching here with content means the
    // composer is past its transient pre-load state, so the load is de-facto
    // settled — any LATER empty signal is a deliberate user deletion, not the
    // pre-load transient (this cannot open the wipe window: that transient
    // takes the empty branch above, never this one).
    initialLoadSettledRef.current = sessionId;
    lastSeenContentRef.current = { sessionId, content };
    draftSaveTimeoutRef.current = setTimeout(async () => {
      // A newer edit or an adoption may have advanced the signal while this
      // timer waited — the effect run that would cancel it is rAF-deferred
      // and can lose the race (deterministically in hidden tabs, where rAF
      // never runs but clamped timers still fire). Writing the armed value
      // then would regress the server past a newer save; skip instead; the
      // newer content arms (or already armed) its own save.
      if (contentSignal.peek() !== content) return;
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
