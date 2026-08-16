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
import { appendDraftText } from '@hyperneo/shared';
import { connectionManager } from '../lib/connection-manager';
import { connectionState } from '../lib/state';
import {
  clearDraftBackup,
  consumeVoiceTranscriptLanded,
  getDraftBackup,
  getLandingGeneration,
  getLandingTranscript,
  hasClearTombstone,
  isLandingLive,
  removeClearTombstone,
  saveClearTombstone,
  saveDraftBackup,
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
  // The live session id, so a cancelled get can tell "the user typed" (same
  // session — reconcile the merged transcript into the local draft) from "the
  // hook moved to another session" (never touch the new session's content).
  const currentSessionIdRef = useRef(sessionId);
  // A session awaiting a COMMITTED clear before its landing can be merged.
  // While set, the refresh must not run: merging the pending onto the old
  // draft would resurrect text the user already sent or cleared. The clear is
  // retried on the next effect run (reconnect / content change).
  const pendingClearRef = useRef<string | null>(null);
  // The daemon draft VERSION each session's composer last read (from
  // session.get). Saves echo it as expectedDraftVersion so the daemon can
  // tell a write derived from the CURRENT draft (applied as-is) from a stale
  // in-flight save (transcripts folded in) — a suffix comparison cannot.
  const draftVersionsRef = useRef<Map<string, number>>(new Map());
  // Advance the cached draft version MONOTONICALLY: overlapping saves and
  // gets can acknowledge out of order, and an older response must never move
  // the cache backward (the next save would then be misclassified as stale
  // and fold a transcript the draft already contains).
  const advanceDraftVersion = (sid: string, version: number | undefined): void => {
    if (typeof version !== 'number') return;
    const cached = draftVersionsRef.current.get(sid);
    if (cached === undefined || version > cached) draftVersionsRef.current.set(sid, version);
  };
  // The landing generation whose reconciliation was already folded into local
  // content (or consumed). Overlapping refresh gets can both observe the same
  // merged draft; without this, each cancelled response blindly appends the
  // full transcript and one voice occurrence becomes two.
  const foldedLandingRef = useRef<Map<string, number>>(new Map());

  // Consume a landing generation and record it as reconciled — every path
  // that settles a landing goes through here, so the fold guard above stays
  // consistent with what was actually handled.
  const consumeLanding = useCallback((sessionId: string, generation: number): void => {
    foldedLandingRef.current.set(sessionId, generation);
    removeClearTombstone(sessionId);
    consumeVoiceTranscriptLanded(sessionId, generation);
  }, []);

  // Fetch the server draft into the signal, guarded against staleness (the
  // session may have changed or the hook unmounted while the get was in
  // flight). Shared by the initial session-change load and the outbox-replay
  // refresh below. The daemon merges any staged voice transcript
  // (inputDraftVoicePending) into inputDraft atomically while serving the
  // request, so the draft here already includes it — no client-side merge.
  // `onResult` runs once the load has settled: `ok` is whether the get
  // succeeded (no hub counts as a failure), `pendingRetained` reports whether
  // the daemon KEPT `inputDraftVoicePending` (draft too full to merge — the
  // transcript is still staged, so a landing must not be consumed as
  // delivered), `wasCancelled` reports whether the effect was torn down while
  // the get was in flight.
  const loadDraft = useCallback(
    (
      targetSessionId: string,
      isCancelled: () => boolean,
      onResult?: (
        ok: boolean,
        pendingRetained?: boolean,
        wasCancelled?: boolean,
        draft?: string
      ) => void,
      reconcileOnCancel?: boolean
    ): void => {
      const hub = connectionManager.getHubIfConnected();
      if (!hub) {
        onResult?.(false);
        return;
      }
      // The landing generation at REQUEST time — the fold below must happen
      // at most once per generation, however many overlapping gets observe
      // the same merged draft.
      const requestedGeneration = voiceTranscriptLandedSignal.peek().get(targetSessionId);
      hub
        .request<{
          session: {
            metadata?: {
              inputDraft?: string;
              inputDraftVoicePending?: string | null;
              inputDraftVersion?: number | null;
            };
          };
        }>('session.get', {
          sessionId: targetSessionId,
        })
        .then((response) => {
          const cancelled = isCancelled();
          const draft = response.session?.metadata?.inputDraft;
          const pendingRetained = !!response.session?.metadata?.inputDraftVoicePending;
          if (typeof response.session?.metadata?.inputDraftVersion === 'number') {
            // Monotonic, like save acks: overlapping gets can complete out of
            // order, and an older response must not regress the cache (the
            // next save would fold a transcript the draft already contains).
            advanceDraftVersion(targetSessionId, response.session.metadata.inputDraftVersion);
          }
          if (!cancelled && draft) {
            contentSignal.value = draft;
          } else if (
            cancelled &&
            reconcileOnCancel &&
            // Only a get that MERGED (pendingRetained false) put the transcript
            // on the server; folding after a retained pending would bake the
            // text into the local draft AND leave it staged server-side, and a
            // later reload restore would then duplicate it.
            !pendingRetained &&
            currentSessionIdRef.current === targetSessionId &&
            // Fold each landing generation at most once: overlapping refresh
            // gets can both observe the same already-merged draft, and a
            // second blind append would duplicate the transcript.
            foldedLandingRef.current.get(targetSessionId) !== requestedGeneration
          ) {
            // A cancelled REPLAY get still merged the transcript server-side.
            // Fold ONLY the transcripts — from the landing aggregate, when the
            // merged draft actually ends with it — into the local typed text so
            // a subsequent save does not overwrite it (consuming the landing
            // below re-enables saves). Appended blindly, NOT via a substring
            // check: the user may legitimately have typed the same phrase, and
            // skipping then would drop the voice occurrence. Scoped to the
            // SAME session — a stale get from a moved-on session must never
            // touch the new session's content.
            const transcript = getLandingTranscript(targetSessionId);
            if (transcript && (draft ?? '').endsWith(transcript)) {
              contentSignal.value = appendDraftText(contentSignal.peek(), transcript);
            }
            if (requestedGeneration !== undefined) {
              foldedLandingRef.current.set(targetSessionId, requestedGeneration);
            }
          }
          onResult?.(true, pendingRetained, cancelled, draft);
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

    // Stale-load guard: if the session changes (or the hook unmounts) while this
    // get is in flight, the cleanup flips `cancelled` so the resolved draft is
    // not written into a signal now backing a different session.
    let cancelled = false;
    loadDraft(
      sessionId,
      () => cancelled,
      (ok, pendingRetained, wasCancelled, draft) => {
        // Only a load that was NOT cancelled (session still current) marks the
        // initial load settled; a stale rejection must not settle a newer load.
        if (wasCancelled) return;
        initialLoadSettledRef.current = sessionId;
        // A clear the previous page life owed but could not COMMIT (socket
        // down) persists as a tombstone: do NOT restore the pre-clear backup
        // (that would resurrect text the user already sent or deleted) —
        // re-arm the owed clear so the replay effect's reconcile runs as soon
        // as the connection allows, and leave the landing for it to consume.
        if (hasClearTombstone(sessionId)) {
          pendingClearRef.current = sessionId;
          if (isLandingLive(sessionId)) {
            // Re-trigger the replay effect directly: the settle-time draft
            // application changed content while that effect was dormant (it
            // cannot subscribe to content before its settled guard without
            // re-running on every keystroke), and the owed clear must
            // reconcile the merged draft instead of leaving the sent text on
            // screen.
            voiceTranscriptLandedSignal.value = new Map(voiceTranscriptLandedSignal.value);
          }
          return;
        }
        // Restore any draft backup from a deferred-landing session (the user's
        // edits persisted locally while the server draft kept the transcript),
        // so a reload does not lose what they were typing. The fold below
        // reconciles the transcripts so the re-enabled saves persist BOTH
        // instead of clobbering the merged transcript with the
        // transcript-free backup.
        const backup = getDraftBackup(sessionId);
        const generation = voiceTranscriptLandedSignal.value.get(sessionId);
        const landingLive = generation !== undefined && isLandingLive(sessionId);
        if (!ok) {
          // The load failed: restore only while a LIVE landing keeps saves
          // suppressed (the refresh retries). An expired landing cannot
          // suppress, and restoring its backup against an unreadable draft
          // could clobber an unknown merged transcript — leave it in storage.
          if (backup !== null && landingLive) contentSignal.value = backup;
          return;
        }
        if (pendingRetained) {
          // Still staged (draft too full): restore the edits; a LIVE landing
          // stays deferred for the refresh below.
          if (backup !== null) contentSignal.value = backup;
          return;
        }
        // The initial get has ALREADY merged any staged transcript server-side,
        // so settle the landing right here instead of racing a second refresh
        // get against the restore above:
        // - with a backup: fold the transcripts into it, so the re-enabled
        //   saves persist the combined draft rather than clobbering the merged
        //   transcript with the transcript-free backup;
        // - without a backup: the loaded draft already contains the transcript.
        // The aggregate is exact for in-tab sequences, but a cross-tab
        // concurrent flush can leave it under-inclusive, so it only wins when
        // the merged draft actually ends with it.
        const transcript = landingLive ? getLandingTranscript(sessionId) : null;
        if (backup === null) {
          if (landingLive) consumeLanding(sessionId, generation);
          return;
        }
        if (transcript && draft?.endsWith(transcript)) {
          // Appended blindly rather than substring-checked: the user's draft
          // may legitimately contain the same PHRASE as the transcript, and a
          // presence check would then drop the new voice occurrence when the
          // re-enabled save overwrites the merged (two-occurrence) draft. The
          // transcripts provably never reached the backup: every fold path
          // that puts them into local content consumes the landing (lifting
          // the suppression) before another backup can be written.
          contentSignal.value = appendDraftText(backup, transcript);
          if (landingLive) consumeLanding(sessionId, generation); // also retires the backup
          return;
        }
        // Transcripts unknown or not yet merged: a LIVE landing defers to the
        // refresh below (restore now; it owns the fold).
        if (landingLive) contentSignal.value = backup;
      }
    );
    return () => {
      cancelled = true;
    };
  }, [sessionId, contentSignal, loadDraft]);

  // Per-session previous content: the clear-detection below must be scoped to
  // the CURRENT session — a deferred landing in another session must not make
  // this session's freshly-loading empty composer look like an explicit clear
  // (which would delete its persisted draft before the merge).
  const prevReplayContentRef = useRef<{ sessionId: string | null; content: string }>({
    sessionId: null,
    content: '',
  });
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
  useSignalEffect(() => {
    const generation = voiceTranscriptLandedSignal.value.get(sessionId);
    if (generation === undefined || !isLandingLive(sessionId)) return;
    // Wait for the initial load: its settle handler owns applying the loaded
    // draft, and a refresh racing it could write a stale merged draft over
    // the fresher load.
    if (initialLoadSettledRef.current !== sessionId) return;
    void connectionState.value;
    const content = contentSignal.value;
    // The composer just emptied (a send/clear) when ITS OWN previous content
    // was non-empty: the possibly-stale server draft must be reconciled
    // BEFORE the merge is treated as delivered — or the merge could
    // resurrect already-sent text. A fresh-mount empty composer keeps the
    // get only.
    const justCleared =
      prevReplayContentRef.current.sessionId === sessionId &&
      prevReplayContentRef.current.content.trim() !== '';
    // An owed clear overrides the non-empty deferral: the content is the
    // SERVER's merged draft (applied by the failed attempt's own get), not
    // user typing — deferring here would leave text the user already sent
    // resurrected for the rest of this page life. Genuine typing still wins:
    // it re-runs this effect, whose cleanup cancels the chain's stale gets,
    // and the reconcile-on-cancel fold merges the transcripts into the typed
    // text instead of overwriting it.
    prevReplayContentRef.current = { sessionId, content };
    if (content.trim() !== '' && pendingClearRef.current !== sessionId) return;
    let cancelled = false;
    // A clear is owed but cannot commit yet: keep it in memory for the next
    // effect run AND persist a tombstone so a RELOAD before the reconnect
    // does not restore the pre-clear backup and resurrect the sent text.
    const oweClear = () => {
      pendingClearRef.current = sessionId;
      const persisted = saveClearTombstone(sessionId);
      if (!persisted) {
        // localStorage refused the tombstone: the clear intent cannot survive
        // a reload, and the retained backup would restore the sent text. The
        // safe fallback is to drop the durable copy — its content is pre-clear
        // text the user already sent or deleted.
        clearDraftBackup(sessionId);
      }
    };
    // The chained reconciles below guard on the SESSION, not the effect's
    // `cancelled`: applying the merged draft to the composer is itself a
    // content change that re-runs this effect and flips `cancelled`, which
    // would otherwise abort the refresh mid-chain. Only a real session
    // switch (or unmount) must stop the reconcile.
    const stillCurrent = () => currentSessionIdRef.current === sessionId;
    const refresh = () => {
      if (!stillCurrent()) return;
      loadDraft(
        sessionId,
        () => cancelled,
        (ok, pendingRetained, _wasCancelled) => {
          // Consume even when this run was cancelled mid-get: a RESOLVED get
          // already merged (and cleared) the pending server-side, so the
          // landing is handled — leaving it pending would let a later clear
          // delete the merged transcript.
          if (ok && !pendingRetained) consumeLanding(sessionId, generation);
        },
        // A replay get cancelled by typing must reconcile the merged transcript
        // into the local draft (see loadDraft) so the re-enabled save does not
        // overwrite it.
        true
      );
    };
    if (justCleared || pendingClearRef.current === sessionId) {
      // A clear is owed (just detected, or still owed from a failed attempt).
      const hub = connectionManager.getHubIfConnected();
      if (!hub) {
        oweClear(); // no socket — retry on reconnect
        return () => {
          cancelled = true;
        };
      }
      pendingClearRef.current = null;
      // Persist the owed clear BEFORE the chain's first async step: a session
      // switch mid-get cancels the failure callback (oweClear never runs), and
      // only the tombstone survives to reconcile after a reload — without it,
      // the retained backup could restore text the user already sent. Retired
      // only by a successful reconciliation (consumeLanding / the reconciles).
      // A failed persist falls back to dropping the backup (oweClear's rule).
      if (!saveClearTombstone(sessionId)) clearDraftBackup(sessionId);
      // Get FIRST: session.get performs (or reveals) the pending merge, so the
      // transcript is IN the draft before anything is cleared. An unconditional
      // inputDraft:null here could delete a transcript ANOTHER tab already
      // merged while this tab's landing was deferred.
      loadDraft(
        sessionId,
        () => cancelled,
        (ok, pendingRetained, _wasCancelled, draft) => {
          if (!ok) {
            oweClear(); // get failed — retry on reconnect
            return;
          }
          if (pendingRetained) {
            // Still staged: clear the stale baseline the merge would land on —
            // CONDITIONALLY, so a newer draft saved meanwhile survives — then
            // the refresh get merges the pending onto a clean draft.
            hub
              .request<{ cleared?: boolean }>('session.clearInputDraftIf', {
                sessionId,
                expected: draft ?? '',
              })
              .then((result) => {
                if (!result.cleared) {
                  // A concurrent draft write raced the clear — refreshing now
                  // would merge the pending onto the stale pre-clear text and
                  // consume the landing, abandoning the user's clear intent
                  // and resurrecting the old text. Keep the clear owed.
                  oweClear();
                  return;
                }
                if (stillCurrent()) refresh();
              })
              .catch(() => {
                // The clear did not commit — the merge must wait, or the
                // pending would land on the stale draft and resurrect
                // already-sent text.
                oweClear();
              });
            return;
          }
          // Merged — by this get or another tab's. The merge landed on
          // whatever draft was current; adopt the server's draft through the
          // refresh, which consumes the landing once it sees the pending
          // fully merged.
          refresh();
        },
        true
      );
      // Register the cleanup so switching sessions mid-chain cancels the
      // refresh (the stale session's draft must not load into the signal now
      // backing another session).
      return () => {
        cancelled = true;
      };
    }
    refresh();
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

    // If sessionId changed, flush the previous session's draft immediately —
    // its LAST KNOWN state. Skip only when nothing is known to flush: content,
    // or an explicit deletion whose clear should be retried. The transient
    // pre-load '' is never recorded, so it cannot wipe the previous draft.
    if (prevSessionIdRef.current && prevSessionIdRef.current !== sessionId) {
      const prevSessionId = prevSessionIdRef.current;
      const last = lastSeenContentRef.current;
      const trimmedContent = last.sessionId === prevSessionId ? last.content.trim() : '';

      // A departed session with a PENDING landing is skipped — its merged
      // transcript must not be overwritten by stale local text; the backup
      // keeps the edits for a reload/return. The session ref still advances
      // below so the active session is not stuck matching an old landing.
      if (isLandingLive(prevSessionId)) {
        prevSessionIdRef.current = sessionId;
        return;
      }

      const hub = connectionManager.getHubIfConnected();
      if (hub && (trimmedContent || (last.sessionId === prevSessionId && last.cleared))) {
        hub
          .request<{ draftVersion?: number; draftValue?: string }>('session.update', {
            sessionId: prevSessionId,
            expectedDraftVersion: draftVersionsRef.current.get(prevSessionId),
            metadata: {
              inputDraft: trimmedContent || null,
            },
          })
          .then((ack) => {
            if (typeof ack?.draftValue !== 'string') {
              advanceDraftVersion(prevSessionId, ack?.draftVersion);
            }
          })
          .catch(() => {
            /* ignore flush errors */
          });
      }
    }
    prevSessionIdRef.current = sessionId;

    // While a landing is pending for THIS session, the server draft may have
    // been updated (this tab's or another tab's refresh merged the landed
    // transcript), so this tab's local copy is stale and a debounced save would
    // overwrite the transcript. Suppress until the landing is consumed by the
    // idle refresh — but PERSIST the evolving local draft to the draft backup
    // (restored on reload / when the landing resolves), so protecting the
    // landed transcript does not disable draft durability. The generation is
    // stored so the reconciliation retires exactly this landing's backup.
    if (isLandingLive(sessionId)) {
      if (content.trim() !== '') {
        const backedUp = saveDraftBackup(sessionId, content, getLandingGeneration(sessionId) ?? 0);
        if (backedUp) return;
        // localStorage refused the backup (disabled / quota): suppressing the
        // save would leave the typed text only in the composer signal — lost
        // to a switch, reload, or close. Fall through to the NORMAL save: the
        // typed text is newer than the server draft and must not vanish.
      } else {
        return;
      }
    }

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
          .request<{ draftVersion?: number; draftValue?: string }>('session.update', {
            sessionId,
            expectedDraftVersion: draftVersionsRef.current.get(sessionId),
            metadata: {
              inputDraft: null,
            },
          })
          .then((ack) => {
            // A folded clear/flush must NOT advance the cache: the applied
            // draft gained transcripts this composer does not hold, and the
            // reconciliation chains own adopting them — staying stale makes
            // the next write fold again instead of clearing the baseline.
            if (typeof ack?.draftValue !== 'string') {
              advanceDraftVersion(sessionId, ack?.draftVersion);
            }
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
        const ack = await hub.request<{ draftVersion?: number; draftValue?: string }>(
          'session.update',
          {
            sessionId,
            // Echo the draft version this composer last READ: the daemon applies
            // the write as-is only when it matches (a mismatch marks a stale
            // in-flight save, whose transcripts it folds back in).
            expectedDraftVersion: draftVersionsRef.current.get(sessionId),
            metadata: {
              inputDraft: trimmedContent,
            },
          }
        );
        if (typeof ack?.draftValue === 'string') {
          // The daemon FOLDED transcripts into this write: its value is the
          // true draft. Adopt it when THIS session's composer still shows what
          // we sent (the shared contentSignal could otherwise belong to a
          // different session whose composer happens to hold the same text);
          // if the user typed meanwhile, leave the version cache STALE so the
          // next save folds onto the newer content — advancing without
          // adopting would let that save apply as-is and clear the baseline,
          // deleting the transcript from the draft.
          if (
            currentSessionIdRef.current === sessionId &&
            contentSignal.peek().trim() === trimmedContent
          ) {
            contentSignal.value = ack.draftValue;
            advanceDraftVersion(sessionId, ack.draftVersion);
          }
          return;
        }
        // Advance the cache to the APPLIED version: without it, a concurrent
        // daemon-side bump (another tab's folded save) would leave this
        // composer echoing a stale version forever, and every later edit
        // would be misclassified as stale and folded (duplicating the
        // transcript it already contains).
        advanceDraftVersion(sessionId, ack?.draftVersion);
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
