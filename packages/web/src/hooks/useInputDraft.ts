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
  getLandingTranscript,
  isLandingLive,
  peekExpiredDraftBackup,
  saveDraftBackup,
  voiceTranscriptLandedSignal,
} from '../lib/voice/voice-transcript-outbox';

/**
 * Structurally extract the merged voice transcripts from a server draft using
 * the daemon's baseline snapshot: the merged draft is always baseline +
 * pending (appendDraftText-joined), so the transcripts are exactly the draft
 * minus the baseline prefix. null when the structure is unknown (no snapshot,
 * or the draft diverged from it) — callers fall back to the landing aggregate.
 */
function transcriptsFromMerge(
  draft: string | undefined,
  baseline: string | null | undefined
): string | null {
  if (typeof baseline !== 'string' || draft === undefined) return null;
  if (draft === baseline) return '';
  if (draft.startsWith(`${baseline} `)) return draft.slice(baseline.length + 1);
  if (draft.startsWith(baseline)) return draft.slice(baseline.length);
  return null;
}

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
  // session — reconcile the merged transcript into the local draft) from "the
  // hook moved to another session" (never touch the new session's content).
  const currentSessionIdRef = useRef(sessionId);
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
  // succeeded (no hub counts as a failure), `pendingRetained` reports whether
  // the daemon KEPT `inputDraftVoicePending` (draft too full to merge — the
  // transcript is still staged, so a landing must not be consumed as
  // delivered), `wasCancelled` reports whether the effect was torn down while
  // the get was in flight, and `draft` is the merged server draft the daemon
  // returned (the clear-before-merge reconciliation below needs it to strip a
  // stale baseline conditionally). A RESOLVED get is a side-effecting
  // server-side merge even if the client no longer applies the response (the
  // draft write is guarded below), so `onResult` still fires so the landing
  // can be consumed — otherwise a later clear could delete the merged
  // transcript. The initial load marks itself settled only when not cancelled;
  // the replay refresh consumes its landing on a successful FULL merge
  // regardless of cancellation.
  const loadDraft = useCallback(
    (
      targetSessionId: string,
      isCancelled: () => boolean,
      onResult?: (
        ok: boolean,
        pendingRetained?: boolean,
        wasCancelled?: boolean,
        draft?: string,
        baseline?: string | null
      ) => void,
      reconcileOnCancel?: boolean
    ): void => {
      const hub = connectionManager.getHubIfConnected();
      if (!hub) {
        onResult?.(false);
        return;
      }
      hub
        .request<{
          session: {
            metadata?: {
              inputDraft?: string;
              inputDraftVoicePending?: string | null;
              inputDraftVoiceBaseline?: string | null;
            };
          };
        }>('session.get', {
          sessionId: targetSessionId,
        })
        .then((response) => {
          const cancelled = isCancelled();
          const draft = response.session?.metadata?.inputDraft;
          const baseline = response.session?.metadata?.inputDraftVoiceBaseline;
          const pendingRetained = !!response.session?.metadata?.inputDraftVoicePending;
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
            currentSessionIdRef.current === targetSessionId
          ) {
            // A cancelled REPLAY get still merged the transcript server-side.
            // Fold ONLY the transcripts — extracted structurally from the
            // daemon's baseline snapshot (the rest of the merged draft is the
            // stale pre-landing baseline), falling back to the landing
            // aggregate when no snapshot exists — into the local typed text so
            // a subsequent save does not overwrite it (consuming the landing
            // below re-enables saves). Appended blindly, NOT via a substring
            // check: the user may legitimately have typed the same phrase, and
            // skipping then would drop the voice occurrence. Scoped to the
            // SAME session — a stale get from a moved-on session must never
            // touch the new session's content.
            const transcript =
              transcriptsFromMerge(draft, baseline) ?? getLandingTranscript(targetSessionId);
            if (transcript) {
              contentSignal.value = appendDraftText(contentSignal.peek(), transcript);
            }
          }
          onResult?.(true, pendingRetained, cancelled, draft, baseline);
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
      (ok, pendingRetained, wasCancelled, draft, baseline) => {
        if (wasCancelled) return; // session changed / unmounted — not our load
        // Only a load that was NOT cancelled (session still current) marks the
        // initial load settled; a stale rejection must not settle a newer load.
        initialLoadSettledRef.current = sessionId;
        // Restore any draft backup from a deferred-landing session (the user's
        // edits persisted locally while the server draft kept the transcript),
        // so a reload does not lose what they were typing.
        const backup = getDraftBackup(sessionId);
        if (backup !== null) contentSignal.value = backup;
        // The initial get has ALREADY merged any staged transcript server-side
        // (pendingRetained false), so settle the landing right here instead of
        // racing a second refresh get against the restore above:
        // - with a backup: fold the transcripts into it (extracted
        //   structurally from the daemon's baseline snapshot — exact across
        //   tabs and duplicate phrases alike), so the re-enabled saves persist
        //   the combined draft rather than clobbering the merged transcript
        //   with the transcript-free backup;
        // - without a backup: the loaded draft already contains the transcript.
        // A retained pending (draft too full) keeps the landing pending for the
        // deferred refresh path below.
        const generation = voiceTranscriptLandedSignal.value.get(sessionId);
        if (!ok || pendingRetained || generation === undefined || !isLandingLive(sessionId)) {
          return;
        }
        // Prefer the server's structural answer; fall back to the landing
        // aggregate (verified against the draft's tail) when it covers MORE —
        // the aggregate is exact for in-tab sequences (a multi-sequence merge
        // can leave text the current baseline snapshot no longer spans), but a
        // cross-tab concurrent flush can leave it under-inclusive, so it only
        // wins when the merged draft actually ends with it.
        let transcripts = transcriptsFromMerge(draft, baseline);
        const aggregate = getLandingTranscript(sessionId);
        if (
          aggregate &&
          draft?.endsWith(aggregate) &&
          aggregate.length > (transcripts?.length ?? -1)
        ) {
          transcripts = aggregate;
        }
        if (backup !== null && transcripts === null) return; // unknown — defer to the refresh
        if (backup !== null && transcripts) {
          // Appended blindly rather than substring-checked: the user's draft
          // may legitimately contain the same PHRASE as the transcript, and a
          // presence check would then drop the new voice occurrence when the
          // re-enabled save overwrites the merged (two-occurrence) draft. The
          // transcripts provably never reached the backup: every fold path
          // that puts them into local content consumes the landing (lifting
          // the suppression) before another backup can be written.
          contentSignal.value = appendDraftText(contentSignal.peek(), transcripts);
        }
        consumeVoiceTranscriptLanded(sessionId, generation);
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
  // Per-session previous content: the clear-detection below must be scoped to
  // the CURRENT session — a deferred landing in another session must not make
  // this session's freshly-loading empty composer look like an explicit clear
  // (which would delete its persisted draft before the merge).
  const prevReplayContentRef = useRef<{ sessionId: string | null; content: string }>({
    sessionId: null,
    content: '',
  });
  // A session awaiting a COMMITTED clear before its landing can be merged.
  // While set, the refresh must not run: merging the pending onto the old
  // draft would resurrect text the user already sent or cleared. The clear is
  // retried on the next effect run (reconnect / content change).
  const pendingClearRef = useRef<string | null>(null);
  useSignalEffect(() => {
    const generation = voiceTranscriptLandedSignal.value.get(sessionId);
    if (generation === undefined || !isLandingLive(sessionId)) return;
    // Wait for the initial load: its settle handler owns the reload
    // reconciliation (backup restore + transcript fold), and a refresh racing
    // that restore could write the merged draft over the restored backup or
    // consume the landing first. The settle path leaves the landing live only
    // when the pending was retained, and the content change settling the load
    // applies re-runs this effect once the guard passes.
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
    prevReplayContentRef.current = { sessionId, content };
    if (content.trim() !== '') return;
    let cancelled = false;
    const refresh = () => {
      if (cancelled) return;
      loadDraft(
        sessionId,
        () => cancelled,
        (ok, pendingRetained, _wasCancelled) => {
          // Consume even when this run was cancelled mid-get: a RESOLVED get
          // already merged (and cleared) the pending server-side, so the
          // landing is handled — leaving it pending would let a later clear
          // delete the merged transcript.
          if (ok && !pendingRetained) consumeVoiceTranscriptLanded(sessionId, generation);
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
        pendingClearRef.current = sessionId; // no socket — retry on reconnect
        return () => {
          cancelled = true;
        };
      }
      pendingClearRef.current = null;
      // Get FIRST: session.get performs (or reveals) the pending merge, so the
      // transcript is IN the draft before anything is cleared. The previous
      // unconditional inputDraft:null here could delete a transcript ANOTHER
      // tab already merged while this tab's landing was deferred.
      loadDraft(
        sessionId,
        () => cancelled,
        (ok, pendingRetained, _wasCancelled, draft) => {
          if (!ok) {
            pendingClearRef.current = sessionId; // get failed — retry on reconnect
            return;
          }
          if (pendingRetained) {
            // Still staged: clear the stale baseline the merge would land on —
            // CONDITIONALLY, so a newer draft saved meanwhile survives — then
            // the refresh get merges the pending onto a clean draft.
            hub
              .request('session.clearInputDraftIf', { sessionId, expected: draft ?? '' })
              .then(() => {
                if (!cancelled) refresh();
              })
              .catch(() => {
                // The clear did not commit — the merge must wait, or the
                // pending would land on the stale draft and resurrect
                // already-sent text.
                pendingClearRef.current = sessionId;
              });
            return;
          }
          // Merged — by this get or another tab's. Ask the DAEMON to strip the
          // pre-sequence baseline (draft := transcripts): its baseline
          // snapshot is exact across tabs and every entry of the sequence, so
          // the strip never discards a transcript another tab merged; the
          // `expected` guard keeps a NEWER draft saved meanwhile intact. A
          // declined strip (no snapshot / raced) just adopts the server draft.
          hub
            .request<{ updated?: boolean; value?: string }>('session.stripVoiceBaseline', {
              sessionId,
              expected: draft ?? '',
            })
            .then((result) => {
              if (cancelled) return;
              if (result.updated) {
                contentSignal.value = result.value ?? '';
                consumeVoiceTranscriptLanded(sessionId, generation);
              } else {
                refresh(); // raced a newer writer — adopt the server's draft
              }
            })
            .catch(() => {
              pendingClearRef.current = sessionId;
            });
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
    // pre-load '' is never recorded, so it cannot wipe the previous draft. A
    // departed session with a PENDING landing is also skipped — its merged
    // transcript must not be overwritten by stale local text — but the session
    // ref still advances below so the active session is not stuck matching an
    // old landing.
    if (prevSessionIdRef.current && prevSessionIdRef.current !== sessionId) {
      const prevSessionId = prevSessionIdRef.current;
      const last = lastSeenContentRef.current;
      const trimmedContent = last.sessionId === prevSessionId ? last.content.trim() : '';
      // Liveness (not raw signal membership): an EXPIRED landing no longer
      // suppresses anything, and checking it here also drops the stale local
      // entry — otherwise a >24h-old landing would block the departed
      // session's flush while its equally-old backup is rejected on restore,
      // losing the more recent edits.
      const prevHasLanding = isLandingLive(prevSessionId);

      const hub = connectionManager.getHubIfConnected();
      if (!prevHasLanding && hub) {
        // While the landing was live, saves were suppressed into the draft
        // backup and lastSeenContent went stale — with the landing gone, that
        // backup is the freshest record. PEEK it (read WITHOUT removing — the
        // flush is best-effort, and destroying the only durable copy before
        // the update is acknowledged would lose those edits if the socket
        // drops mid-flush) so the departed session's edits reach the server
        // instead of dying with the expired marker.
        const claimed = peekExpiredDraftBackup(prevSessionId);
        const flushContent = claimed?.content.trim() || trimmedContent;
        if (flushContent || (last.sessionId === prevSessionId && last.cleared)) {
          hub
            .request('session.update', {
              sessionId: prevSessionId,
              metadata: {
                inputDraft: flushContent || null,
              },
            })
            .then(() => {
              // Acknowledged — now the durable copy is safely superseded.
              if (claimed) clearDraftBackup(prevSessionId);
            })
            .catch(() => {
              /* ignore flush errors — the backup stays for a later retry */
            });
        }
      }
    }
    prevSessionIdRef.current = sessionId;

    // While a landing is pending for THIS session, the server draft may have
    // been updated (this tab's or another tab's refresh merged the landed
    // transcript), so this tab's local copy is stale and a debounced save would
    // overwrite the transcript. Suppress until the landing is consumed by the
    // idle refresh, which itself owns the clear-before-merge for an explicit
    // send/clear — but PERSIST the evolving local draft to the draft backup
    // (restored on reload / when the landing resolves), so protecting the
    // landed transcript does not disable draft durability. The generation is
    // stored so the reconciliation retires exactly this landing's backup.
    if (isLandingLive(sessionId)) {
      if (content.trim() !== '') {
        saveDraftBackup(sessionId, content, voiceTranscriptLandedSignal.value.get(sessionId) ?? 0);
      }
      return;
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
