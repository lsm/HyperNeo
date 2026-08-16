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
import { appendDraftText, generateUUID } from '@hyperneo/shared';
import { connectionManager } from '../lib/connection-manager';
import { connectionState } from '../lib/state';
import {
  clearDraftBackup,
  consumeVoiceTranscriptLanded,
  getClearTombstone,
  getDraftBackup,
  getLandingGeneration,
  getLandingTranscript,
  hasClearTombstone,
  isLandingAggregateOrdered,
  isLandingLive,
  peekExpiredDraftBackup,
  removeClearTombstone,
  retireDraftBackupClaim,
  saveClearTombstone,
  saveDraftBackup,
  voiceTranscriptLandedSignal,
  type DraftBackupClaim,
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
  // The landing generation whose reconciliation was already folded into local
  // content (or consumed). Overlapping refresh gets can both observe the same
  // merged draft; without this, each cancelled response blindly appends the
  // full transcript and one voice occurrence becomes two.
  const foldedLandingRef = useRef<Map<string, number>>(new Map());
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
  // Arm the backup-flush retry backoff from outside the retry effect (the
  // connection subscription alone only fires on connection CHANGES).
  const flushKickRef = useRef<() => void>(() => {});
  // Claim ids of ACTIVE-CONTENT merges keyed per session, BOUND to the exact
  // content they make idempotent: the id must survive retries of the SAME
  // content (a merge that committed with a lost ack is recognized, not
  // rewritten), but NEWER content must mint its own id — reusing the old one
  // would let the daemon dedup the request as the earlier merge and return
  // its value, replacing newer edits with older committed content.
  const activeMergeClaimsRef = useRef<Map<string, { claimId: string; content: string }>>(new Map());
  // Backup retirements DEFERRED until the combined draft they produced is
  // durably persisted: a reconciliation that folds a backup into the composer
  // signal persists it only through the next debounced save, so deleting the
  // durable copy at consumption would lose the user's edits to a reload,
  // crash, or dropped socket inside that window. The first acknowledged save
  // after the fold flushes the deferred retirement.
  const deferredBackupRetiresRef = useRef<
    Map<string, { generation: number; claim?: DraftBackupClaim }>
  >(new Map());

  // Advance the cached draft version MONOTONICALLY: overlapping saves and
  // gets can acknowledge out of order, and an older response must never move
  // the cache backward (the next save would then be misclassified as stale
  // and fold a transcript the draft already contains).
  const advanceDraftVersion = (sid: string, version: number | undefined): void => {
    if (typeof version !== 'number') return;
    const cached = draftVersionsRef.current.get(sid);
    if (cached === undefined || version > cached) draftVersionsRef.current.set(sid, version);
  };
  // Consume a landing generation and record it as reconciled — every path
  // that settles a landing goes through here, so the fold guard above and the
  // clear tombstone below stay consistent with what was actually handled.
  // The tombstone removal and consumption are gated on the generation still
  // being CURRENT: a newer landing that arrived mid-reconciliation owns that
  // state now, and dropping the tombstone out from under it would leave the
  // newer sequence's pre-clear backup unprotected. `deferClaim` keeps the
  // landing's backup durable until the save-ack flush retires it.
  const consumeLanding = useCallback(
    (sessionId: string, generation: number, deferClaim?: DraftBackupClaim | null): void => {
      foldedLandingRef.current.set(sessionId, generation);
      if (voiceTranscriptLandedSignal.peek().get(sessionId) !== generation) {
        return; // a newer landing owns the tombstone/backup state
      }
      removeClearTombstone(sessionId);
      if (deferClaim !== undefined) {
        deferredBackupRetiresRef.current.set(sessionId, {
          generation,
          claim: deferClaim ?? undefined,
        });
        consumeVoiceTranscriptLanded(sessionId, generation, true);
        return;
      }
      consumeVoiceTranscriptLanded(sessionId, generation);
    },
    []
  );
  // Retire deferred backups once the session's combined draft is ACKNOWLEDGED
  // server-side — the durable copy is superseded only now that the combined
  // text is itself durable. `expected` binds the retirement to the deferred
  // entry the acknowledged request CAPTURED at send time: an earlier save
  // still in flight when the fold happened persisted PRE-landing content, and
  // flushing whatever entry is current would delete a newer fold's only
  // durable copy before anything persisted it.
  const flushDeferredBackupRetire = useCallback(
    (sessionId: string, expected: { generation: number; claim?: DraftBackupClaim }): void => {
      const deferred = deferredBackupRetiresRef.current.get(sessionId);
      if (!deferred || deferred !== expected) return;
      deferredBackupRetiresRef.current.delete(sessionId);
      if (deferred.claim) retireDraftBackupClaim(deferred.claim);
      clearDraftBackup(sessionId, deferred.generation);
    },
    []
  );

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
  // the get was in flight, `draft` is the merged server draft the daemon
  // returned, `baseline`/`baselineSeq` identify the pending sequence the
  // baseline snapshot belongs to (the clear-before-merge reconciliation
  // validates both — draft text alone cannot distinguish a baseline a NEWER
  // sequence replaced). A RESOLVED get is a side-effecting server-side merge
  // even if the client no longer applies the response (the draft write is
  // guarded below), so `onResult` still fires so the landing can be consumed —
  // otherwise a later clear could delete the merged transcript. The initial
  // load marks itself settled only when not cancelled; the replay refresh
  // consumes its landing on a successful FULL merge regardless of
  // cancellation.
  const loadDraft = useCallback(
    (
      targetSessionId: string,
      isCancelled: () => boolean,
      onResult?: (
        ok: boolean,
        pendingRetained?: boolean,
        wasCancelled?: boolean,
        draft?: string,
        baseline?: string | null,
        baselineSeq?: number | null
      ) => void,
      reconcileOnCancel?: boolean,
      applyGuard?: () => boolean
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
              inputDraftVoiceBaseline?: string | null;
              inputDraftVoiceBaselineSeq?: number | null;
              inputDraftVersion?: number | null;
            };
          };
        }>('session.get', {
          sessionId: targetSessionId,
        })
        .then((response) => {
          const cancelled = isCancelled();
          const draft = response.session?.metadata?.inputDraft;
          const baseline = response.session?.metadata?.inputDraftVoiceBaseline;
          const baselineSeq = response.session?.metadata?.inputDraftVoiceBaselineSeq;
          const pendingRetained = !!response.session?.metadata?.inputDraftVoicePending;
          const draftVersion = response.session?.metadata?.inputDraftVersion;
          // Whether this response's draft (or its transcripts) actually
          // reached the local content. The version cache may advance ONLY
          // then: a get whose application was refused and whose
          // cancellation-fold declined (no baseline, untrusted aggregate)
          // describes a merged draft the local content does NOT carry, and
          // echoing its version on the next save would let the daemon apply
          // that save as-is and clear the baseline — irrecoverably deleting
          // the merged transcript. A stale echo instead makes the daemon fold
          // the transcripts back in (idempotently, by suffix).
          let adopted = draft === undefined || draft === '';
          // An `applyGuard` lets the owed-clear chains decline the local
          // application: their get returns the STALE pre-clear draft plus
          // transcripts, and applying it would overwrite typing (or a
          // restored post-clear backup) that is NEWER user state — the strip
          // fold below merges the transcripts into that content instead.
          if (!cancelled && draft && (applyGuard ? applyGuard() : true)) {
            contentSignal.value = draft;
            adopted = true;
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
              transcriptsFromMerge(draft, baseline) ??
              (isLandingAggregateOrdered(targetSessionId)
                ? getLandingTranscript(targetSessionId)
                : null);
            if (transcript) {
              contentSignal.value = appendDraftText(contentSignal.peek(), transcript);
              adopted = true;
            }
            if (requestedGeneration !== undefined) {
              foldedLandingRef.current.set(targetSessionId, requestedGeneration);
            }
          }
          if (typeof draftVersion === 'number' && adopted) {
            // Monotonic, like save acks: overlapping gets can complete out of
            // order, and an older response must not regress the cache (the
            // next save would fold a transcript the draft already contains).
            advanceDraftVersion(targetSessionId, draftVersion);
          }
          onResult?.(true, pendingRetained, cancelled, draft, baseline, baselineSeq);
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

  // Reconcile an owed clear when NO live landing remains (its marker expired
  // past the TTL while the tombstone is still fresh): the replay effect exits
  // at its liveness guard, so reconcile directly against the daemon — a fresh
  // get performs (or reveals) the merge, then the baseline strip keeps only
  // the transcripts, or a conditional clear removes the stale pre-clear draft
  // when nothing ever merged. The tombstone is retired only once a reconcile
  // commits, so a dropped socket retries on the next reconnect.
  const reconcileOwedClear = useCallback(
    (targetSessionId: string): void => {
      const hub = connectionManager.getHubIfConnected();
      if (!hub) return;
      const tombstone = getClearTombstone(targetSessionId);
      hub
        .request<{
          session?: {
            metadata?: {
              inputDraft?: string;
              inputDraftVoicePending?: string | null;
              inputDraftVoiceBaseline?: string | null;
              inputDraftVoiceBaselineSeq?: number | null;
              inputDraftVoiceLastStrippedSeq?: number | null;
            };
          };
        }>('session.get', { sessionId: targetSessionId })
        .then((response) => {
          const meta = response.session?.metadata ?? {};
          // The composer content the reconcile observed (its get's draft) —
          // adoptions below must not overwrite typing that began mid-flight.
          const observedDraft = meta.inputDraft ?? '';
          const canAdopt = (): boolean =>
            currentSessionIdRef.current === targetSessionId &&
            (contentSignal.peek().trim() === '' || contentSignal.peek() === observedDraft);
          if (
            tombstone?.baselineSeq !== undefined &&
            meta.inputDraftVoiceLastStrippedSeq === tombstone.baselineSeq &&
            // A NEWER unstripped sequence must NOT be satisfied by the old
            // strip marker: sequence N+1 can have replaced the baseline (and
            // merged) after N's strip committed, and retiring the tombstone
            // here would leave N+1's pre-clear baseline resurrected. The old
            // strip satisfies the owed clear only when no newer baseline is
            // live.
            !(
              typeof meta.inputDraftVoiceBaseline === 'string' &&
              typeof meta.inputDraftVoiceBaselineSeq === 'number' &&
              meta.inputDraftVoiceBaselineSeq > tombstone.baselineSeq
            )
          ) {
            // The owed strip COMMITTED but its acknowledgement was lost: the
            // draft already holds only the transcripts and the baseline is
            // gone. The no-baseline fallback below would conditionally CLEAR
            // this transcript-only draft — adopt it and retire the tombstone.
            if (canAdopt()) {
              contentSignal.value = meta.inputDraft ?? '';
            } else if (
              currentSessionIdRef.current === targetSessionId &&
              (meta.inputDraft ?? '').trim() !== ''
            ) {
              // The composer holds NEWER user state (typing, or the post-clear
              // backup the settle path restored): the daemon holds ONLY the
              // transcripts (the strip cleared the baseline), so retiring the
              // tombstone without folding them would let the next ordinary
              // save overwrite the transcript-only draft with this content —
              // permanently losing the voice text. Fold them in (the newer
              // content provably never contained them), mirroring the
              // live-landing strip path's fold discipline — but ONLY into the
              // SAME session's composer (a mismatched session means the hook
              // moved on and the shared signal now backs another session),
              // and ONLY when the complete combination fits: appendDraftText
              // silently truncates at the limit, and a truncated fold adopted
              // with a retired tombstone would let the next save drop the
              // transcript's tail. Keep the clear owed until it fits.
              const localContent = contentSignal.peek();
              const daemonTranscripts = meta.inputDraft ?? '';
              const combined = appendDraftText(localContent, daemonTranscripts);
              const fits =
                combined === `${localContent}${daemonTranscripts}` ||
                combined === `${localContent} ${daemonTranscripts}`;
              if (!fits) {
                flushKickRef.current(); // stays owed — retry when room appears
                return;
              }
              contentSignal.value = combined;
            } else if (currentSessionIdRef.current !== targetSessionId) {
              // Session moved on: never mutate the shared signal, but the
              // strip DID commit — retire the tombstone (its owed clear is
              // satisfied server-side).
            }
            removeClearTombstone(targetSessionId);
            if (pendingClearRef.current === targetSessionId) {
              pendingClearRef.current = null;
            }
            return;
          }
          if ((meta.inputDraftVoicePending ?? '').trim() !== '') {
            // The get RETAINED the pending (draft too full): stripping now
            // would clear the draft while the transcript stays staged — and
            // with the landing expired there is no replay effect to issue the
            // merging session.get, leaving the transcript invisible until a
            // later navigation. Clear the stale baseline CONDITIONALLY first,
            // then a fresh get merges the pending onto the clean draft.
            return hub
              .request<{ cleared?: boolean }>('session.clearInputDraftIf', {
                sessionId: targetSessionId,
                expected: meta.inputDraft ?? '',
              })
              .then((result) => {
                if (!result.cleared) {
                  // Raced a newer draft — stays owed; no replay effect exists
                  // (landing expired) and connectionState did not change, so
                  // arm the bounded retry pass explicitly.
                  flushKickRef.current();
                  return;
                }
                return hub
                  .request<{
                    session?: { metadata?: { inputDraft?: string; inputDraftVersion?: number } };
                  }>('session.get', {
                    sessionId: targetSessionId,
                  })
                  .then((merged) => {
                    if (currentSessionIdRef.current === targetSessionId) {
                      // Only over an idle composer or unchanged observed text:
                      // typing that began mid-reconcile is newer user state.
                      const mergedDraft = merged.session?.metadata?.inputDraft ?? '';
                      if (
                        contentSignal.peek().trim() === '' ||
                        contentSignal.peek() === observedDraft
                      ) {
                        contentSignal.value = mergedDraft;
                        // The clear re-anchored the baseline to '' and THIS
                        // get merged the retained pending onto it, so the
                        // daemon draft is baseline + transcripts with the
                        // version this response carries. Adopting the value
                        // without the version leaves the next debounced edit
                        // echoing the PRE-clear version: the daemon would
                        // classify it stale and fold the entire
                        // transcript-only draft into content that already
                        // carries the transcript — duplicating the voice text
                        // (the transcript sits at the FRONT here, so the
                        // daemon's suffix guard cannot catch it).
                        advanceDraftVersion(
                          targetSessionId,
                          merged.session?.metadata?.inputDraftVersion
                        );
                      }
                    }
                    removeClearTombstone(targetSessionId);
                    if (pendingClearRef.current === targetSessionId) {
                      pendingClearRef.current = null;
                    }
                  });
              })
              .catch(() => {
                /* stays owed — the reconnect subscription or bounded retry re-runs this */
                flushKickRef.current();
              });
          }
          if (
            typeof meta.inputDraftVoiceBaseline === 'string' &&
            typeof meta.inputDraftVoiceBaselineSeq === 'number'
          ) {
            // Version the tombstone with the sequence BEFORE the strip is in
            // flight: a tombstone saved without one (the original owe ran
            // offline, before any get) could never be matched against
            // inputDraftVoiceLastStrippedSeq if the strip commits but its
            // acknowledgement is lost — the retry would fall into the
            // no-baseline conditional clear and delete the transcript-only
            // draft the strip produced.
            saveClearTombstone(targetSessionId, meta.inputDraftVoiceBaselineSeq);
            return hub
              .request<{ updated?: boolean; value?: string }>('session.stripVoiceBaseline', {
                sessionId: targetSessionId,
                expected: meta.inputDraft ?? '',
                expectedSeq: meta.inputDraftVoiceBaselineSeq,
              })
              .then((result) => {
                if (!result.updated) {
                  // Raced a newer sequence — the clear stays owed, and no
                  // replay effect exists to retry it (the landing expired).
                  // Arm the bounded retry pass, which re-runs this reconcile.
                  flushKickRef.current();
                  return;
                }
                if (canAdopt()) {
                  contentSignal.value = result.value ?? '';
                } else if (
                  currentSessionIdRef.current === targetSessionId &&
                  (result.value ?? '').trim() !== ''
                ) {
                  // Typing began mid-reconcile: the daemon now holds ONLY the
                  // transcripts (the strip cleared the baseline), and this
                  // composer's next ordinary save would overwrite them with
                  // transcript-free typing. Fold the stripped transcripts
                  // into the newer content — the live-landing strip path's
                  // once-per-generation discipline — so the re-enabled save
                  // carries BOTH. Same-session only (the signal may back a
                  // different composer now), and only when the COMPLETE
                  // combination fits — a truncating fold retired here would
                  // let the next save drop the transcript's tail.
                  const localContent = contentSignal.peek();
                  const stripped = result.value ?? '';
                  const combined = appendDraftText(localContent, stripped);
                  const fits =
                    combined === `${localContent}${stripped}` ||
                    combined === `${localContent} ${stripped}`;
                  if (!fits) {
                    flushKickRef.current(); // stays owed — retry when room appears
                    return;
                  }
                  contentSignal.value = combined;
                }
                removeClearTombstone(targetSessionId);
                // Clear the IN-MEMORY owed-clear marker too: a stale ref would
                // make the replay effect treat a LATER landing (the user
                // navigated away and back) as another owed clear and strip the
                // new sequence's baseline.
                if (pendingClearRef.current === targetSessionId) {
                  pendingClearRef.current = null;
                }
              });
          }
          return hub
            .request<{ cleared?: boolean }>('session.clearInputDraftIf', {
              sessionId: targetSessionId,
              expected: meta.inputDraft ?? '',
            })
            .then((result) => {
              if (!result.cleared) {
                flushKickRef.current(); // stays owed — arm the bounded retry
                return;
              }
              if (canAdopt()) {
                contentSignal.value = '';
              }
              removeClearTombstone(targetSessionId);
              if (pendingClearRef.current === targetSessionId) {
                pendingClearRef.current = null;
              }
            });
        })
        .catch(() => {
          /* stays owed — the reconnect subscription or bounded retry re-runs this */
          flushKickRef.current();
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
        // A clear the previous page life owed but could not COMMIT (socket
        // down) persists as a tombstone: do NOT restore the pre-clear backup
        // (that would resurrect text the user already sent or deleted) —
        // re-arm the owed clear so the replay effect's reconcile runs as soon
        // as the connection allows, and leave the landing for it to consume.
        if (hasClearTombstone(sessionId)) {
          // A backup written AFTER the tombstone is POST-clear typing (the
          // user kept editing after sending/clearing): the scan's tombstone
          // skip already excluded pre-clear copies, so whatever survives it
          // here IS newer user state and must be restored — otherwise the
          // early return below discards it. The owed-clear chain's apply
          // guard keeps its merged-draft application off this content, and
          // the strip fold merges the transcripts into it.
          const postClearClaim = peekExpiredDraftBackup(sessionId);
          if (postClearClaim && postClearClaim.content.trim() !== '') {
            contentSignal.value = postClearClaim.content;
            // The restored claim is superseded only by the first ACKNOWLEDGED
            // save of this content (or its fold with the daemon transcripts):
            // retire it through the deferred mechanism, not now — leaving the
            // content-only record as the freshest durable claim would let a
            // later session switch push this transcript-free copy over the
            // combined draft the save persisted.
            deferredBackupRetiresRef.current.set(sessionId, {
              generation: postClearClaim.generation,
              claim: postClearClaim,
            });
          }
          pendingClearRef.current = sessionId;
          if (isLandingLive(sessionId)) {
            // Re-trigger the replay effect directly: the settle-time draft
            // application changed content while that effect was dormant (it
            // cannot subscribe to content before its settled guard without
            // re-running on every keystroke), and the owed clear must
            // reconcile the merged draft instead of leaving the sent text on
            // screen.
            voiceTranscriptLandedSignal.value = new Map(voiceTranscriptLandedSignal.value);
          } else {
            // The landing EXPIRED (its marker pruned) while the tombstone is
            // still fresh: the replay effect would exit at the liveness guard
            // and the merged pre-clear text would resurrect. Reconcile the
            // owed clear directly against the daemon's baseline snapshot.
            void reconcileOwedClear(sessionId);
          }
          return;
        }
        // Restore any draft backup from a deferred-landing session (the user's
        // edits persisted locally while the server draft kept the transcript),
        // so a reload does not lose what they were typing. A backup whose
        // landing EXPIRED (marker pruned past the TTL) while its edits stayed
        // fresh is recovered too — peek bypasses the liveness gate — because
        // those edits must not die with the marker; the fold below reconciles
        // the transcripts through the daemon's baseline snapshot so the
        // re-enabled saves persist BOTH instead of clobbering the merged
        // transcript with the transcript-free backup.
        const claimed = peekExpiredDraftBackup(sessionId);
        const backup = getDraftBackup(sessionId) ?? claimed?.content ?? null;
        const generation = voiceTranscriptLandedSignal.value.get(sessionId);
        const landingLive = generation !== undefined && isLandingLive(sessionId);
        if (!ok) {
          // The load failed: restore only while a LIVE landing keeps saves
          // suppressed (the refresh retries). An expired landing cannot
          // suppress, and restoring its backup against an unreadable draft
          // could clobber an unknown merged transcript — leave it to the
          // departed-session flush, whose daemon-side merge folds-or-declines.
          if (backup !== null && landingLive) contentSignal.value = backup;
          return;
        }
        if (pendingRetained) {
          // Still staged (draft too full): restore the edits; a LIVE landing
          // stays deferred for the refresh below. An EXPIRED landing persists
          // the restore through the daemon-side MERGE (its staged branch makes
          // the restored edits the draft the pending later merges onto) and
          // retires the durable copy only once that write is ACKNOWLEDGED —
          // the debounced save alone could be lost to a reload, crash, or
          // dropped socket before it commits, deleting the only copy of the
          // newer edits while the daemon still holds the older full draft.
          if (backup !== null) {
            contentSignal.value = backup;
            if (!landingLive && claimed) {
              // Queue through the merge map rather than a one-shot request:
              // the claim ID is retained across retries (a merge that
              // committed with a lost ack replays idempotently instead of a
              // later flush re-merging the stale backup under a fresh ID),
              // and the retry loop handles decline/backoff/ack-retire.
              pendingBackupFlushRef.current.set(sessionId, {
                content: claimed.content.trim(),
                generation: claimed.generation,
                key: claimed.key,
                claimId: generateUUID(),
                ts: claimed.ts,
              });
              flushKickRef.current();
            }
          }
          return;
        }
        // The initial get has ALREADY merged any staged transcript server-side,
        // so settle the landing right here instead of racing a second refresh
        // get against the restore above:
        // - with a backup: fold the transcripts into it (extracted
        //   structurally from the daemon's baseline snapshot — exact across
        //   tabs and duplicate phrases alike), so the re-enabled saves persist
        //   the combined draft rather than clobbering the merged transcript
        //   with the transcript-free backup;
        // - without a backup: the loaded draft already contains the transcript.
        // Prefer the server's structural answer; fall back to the landing
        // aggregate (verified against the draft's tail) when it covers MORE —
        // the aggregate is exact for in-tab sequences (a multi-sequence merge
        // can leave text the current baseline snapshot no longer spans), but a
        // cross-tab concurrent flush can leave it under-inclusive, so it only
        // wins when the merged draft actually ends with it. (Expired landings
        // have no aggregate — the marker is pruned — so they rely on the
        // structural answer alone.)
        let transcripts = transcriptsFromMerge(draft, baseline);
        // An ORDER-TRUSTED aggregate only: a union mixing sequenced and
        // unsequenced entries (a stale pre-upgrade tab still publishing
        // unsequenced markers) has no reliable client-side order, and a
        // reversed aggregate must neither tail-match nor restore.
        const aggregate =
          landingLive && isLandingAggregateOrdered(sessionId)
            ? getLandingTranscript(sessionId)
            : null;
        if (
          aggregate &&
          draft?.endsWith(aggregate) &&
          aggregate.length > (transcripts?.length ?? -1)
        ) {
          transcripts = aggregate;
        }
        if (backup === null) {
          // Verify this response actually OBSERVED the merge before settling
          // the landing: a landing that raced the REQUEST (another tab's
          // flush, or this tab's outbox ack) leaves the transcript still
          // staged in inputDraftVoicePending, and consuming here would hide
          // it until the next navigation. Structural extraction or a
          // matching aggregate tail proves the merge; otherwise issue the
          // replay refresh to merge and consume it now.
          const merged =
            transcripts !== null || (aggregate !== null && !!draft?.endsWith(aggregate));
          if (landingLive && !merged) {
            loadDraft(
              sessionId,
              () => cancelled,
              (refreshOk, refreshRetained) => {
                if (
                  refreshOk &&
                  !refreshRetained &&
                  currentSessionIdRef.current === sessionId &&
                  voiceTranscriptLandedSignal.peek().get(sessionId) === generation
                ) {
                  consumeLanding(sessionId, generation);
                }
              },
              true
            );
            return;
          }
          if (landingLive) consumeLanding(sessionId, generation);
          return;
        }
        if (transcripts === null) {
          // Transcripts unknown. A LIVE landing defers to the refresh below
          // (restore now; it owns the fold). An EXPIRED landing can no longer
          // defer: restoring the transcript-free backup would let the enabled
          // saves clobber the merged draft — keep the server draft and leave
          // the durable backup for the departed-session flush.
          if (landingLive) contentSignal.value = backup;
          return;
        }
        // The COMPLETE combination must fit before adopting: appendDraftText
        // silently slices at the composer limit, and a truncated fold adopted
        // here would let the re-enabled save overwrite the complete server
        // draft — permanently dropping the transcript's tail. Keep the
        // landing deferred (saves stay suppressed into the backup) until the
        // draft has room for both; the daemon-side merge declines truncating
        // combinations for the same reason.
        const combined = appendDraftText(backup, transcripts);
        const fits =
          combined === `${backup}${transcripts}` || combined === `${backup} ${transcripts}`;
        if (!fits) {
          if (landingLive) contentSignal.value = backup;
          return;
        }
        // Appended blindly rather than substring-checked: the user's draft
        // may legitimately contain the same PHRASE as the transcript, and a
        // presence check would then drop the new voice occurrence when the
        // re-enabled save overwrites the merged (two-occurrence) draft. The
        // transcripts provably never reached the backup: every fold path
        // that puts them into local content consumes the landing (lifting
        // the suppression) before another backup can be written.
        contentSignal.value = combined;
        // The composer now holds the COMBINED content — a queued backup
        // flush (from an earlier switch away) still carries the
        // transcript-free backup: its active-content merge would push the
        // already-combined text and the daemon's baseline-identified
        // transcript would be appended a second time. The save path owns
        // persisting the combination; drop the queued claim.
        dropQueuedBackupFlush(sessionId);
        if (landingLive) {
          // The combined text is durable only in the composer signal until
          // the debounced save commits — DEFER the backup retirement to that
          // save's acknowledgement instead of deleting the only durable copy
          // of the user's edits at consumption.
          consumeLanding(sessionId, generation, claimed);
        }
        // The claimed backup's edits (plus transcripts) are now in a composer
        // with saves enabled. An EXPIRED landing has no consumption to defer
        // through, so defer directly to the acknowledged save: retiring NOW
        // would write the supersede boundary (and remove the claimed key)
        // before anything durable holds the combined text — a reload or
        // crash in that window would leave every older sibling unrestorable
        // AND the claimed copy gone, discarding all locally recoverable
        // edits while the daemon still holds the pre-fold draft.
        else if (claimed) {
          deferredBackupRetiresRef.current.set(sessionId, {
            generation: claimed.generation,
            claim: claimed,
          });
        }
      }
    );
    return () => {
      cancelled = true;
    };
  }, [sessionId, contentSignal, loadDraft, consumeLanding, reconcileOwedClear]);

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
    if (justCleared) {
      // The composer emptied over its OWN previous text — an explicit
      // send/clear, including under a live landing where the save effect's
      // empty branch is suppressed and this chain owns the clear.
      dropQueuedBackupFlush(sessionId);
    }
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
    // `baselineSeq`, when the owed step was a strip, names the sequence so a
    // retry can recognize a strip that committed with a lost acknowledgement.
    const oweClear = (baselineSeq?: number) => {
      pendingClearRef.current = sessionId;
      const persisted = saveClearTombstone(sessionId, baselineSeq);
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
    // would otherwise abort the strip/refresh mid-chain. Only a real session
    // switch (or unmount) must stop the reconcile.
    const stillCurrent = () => currentSessionIdRef.current === sessionId;
    // The owed-clear chain's gets return the STALE pre-clear draft (plus
    // transcripts): applying it must never overwrite typing or a restored
    // post-clear backup that is NEWER user state. Apply only into an EMPTY
    // composer — the strip's fold then merges the transcripts into whatever
    // newer content is showing.
    const applyOnlyWhenIdle = () => contentSignal.peek().trim() === '';
    const refresh = (chainDraft?: string) => {
      if (!stillCurrent()) return;
      loadDraft(
        sessionId,
        () => cancelled,
        (ok, pendingRetained, _wasCancelled, draft, baseline) => {
          if (!ok || pendingRetained) return;
          // The apply guard may have REFUSED the merged draft's application
          // (the composer holds post-clear typing or another restored backup —
          // newer user state the chain's get must not overwrite). Consuming
          // the landing without folding would let the next ordinary save
          // overwrite the transcript-only daemon draft: fold the merged
          // transcripts into the newer content (fits-checked), or keep the
          // clear owed when the combination cannot fit whole.
          const current = contentSignal.peek();
          // Once per generation: a CANCELLED run's reconcile-on-cancel fold
          // already merged this generation's transcripts into the typing.
          const alreadyFolded = foldedLandingRef.current.get(sessionId) === generation;
          // "Guard refused" = the composer shows something OTHER than what
          // this chain applied (chainDraft) or this refresh just applied
          // (the draft itself): newer user state the application skipped.
          // SESSION-GATED: after a switch the signal backs the NEW session's
          // composer — classifying its text as "guard refused" would fold the
          // OLD session's transcripts into a session they never belonged to.
          const guardRefused =
            stillCurrent() && current.trim() !== '' && current !== chainDraft && current !== draft;
          if (guardRefused && !alreadyFolded) {
            // Structural extraction first (the daemon's baseline snapshot is
            // exact across tabs); fall back to the landing aggregate ONLY
            // when its commit order is trusted. With NEITHER there is no
            // trustworthy transcript source: folding the ENTIRE server draft
            // (the old fallback) would resurrect non-voice content and
            // duplicate the transcript — keep the clear owed instead.
            const transcripts =
              transcriptsFromMerge(draft, baseline) ??
              (isLandingAggregateOrdered(sessionId) ? getLandingTranscript(sessionId) : null);
            if (transcripts === null) {
              oweClear();
              flushKickRef.current();
              return;
            }
            if (transcripts.trim() !== '') {
              const combined = appendDraftText(current, transcripts);
              const fits =
                combined === `${current}${transcripts}` || combined === `${current} ${transcripts}`;
              if (!fits) {
                oweClear();
                flushKickRef.current();
                return;
              }
              contentSignal.value = combined;
            }
          }
          // Consume even when this run was cancelled mid-get: a RESOLVED get
          // already merged (and cleared) the pending server-side, so the
          // landing is handled — leaving it pending would let a later clear
          // delete the merged transcript.
          consumeLanding(sessionId, generation);
        },
        // A replay get cancelled by typing must reconcile the merged transcript
        // into the local draft (see loadDraft) so the re-enabled save does not
        // overwrite it.
        true,
        // The chain's own follow-up refresh may also replace the stale draft
        // the chain's previous get APPLIED (`chainDraft`) — that text is not
        // user typing.
        chainDraft === undefined
          ? applyOnlyWhenIdle
          : () => {
              const c = contentSignal.peek();
              return c.trim() === '' || c === chainDraft;
            }
      );
    };
    if (justCleared || pendingClearRef.current === sessionId) {
      // A clear is owed (just detected, or still owed from a failed attempt).
      const hub = connectionManager.getHubIfConnected();
      if (!hub) {
        oweClear(); // no socket — retry on reconnect, survive a reload
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
      // transcript is IN the draft before anything is cleared. The previous
      // unconditional inputDraft:null here could delete a transcript ANOTHER
      // tab already merged while this tab's landing was deferred.
      loadDraft(
        sessionId,
        () => cancelled,
        (ok, pendingRetained, _wasCancelled, draft, _baseline, baselineSeq) => {
          if (!ok) {
            oweClear(); // get failed — retry on reconnect
            flushKickRef.current(); // …and on the bounded retry if still connected
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
                if (stillCurrent()) refresh(draft);
              })
              .catch(() => {
                // The clear did not commit — the merge must wait, or the
                // pending would land on the stale draft and resurrect
                // already-sent text. Arm the bounded retry: a rejection while
                // still connected (timeout) never re-fires the connection
                // subscription on its own.
                oweClear();
                flushKickRef.current();
              });
            return;
          }
          // Merged — by this get or another tab's. Ask the DAEMON to strip the
          // pre-sequence baseline (draft := transcripts): its baseline
          // snapshot is exact across tabs and every entry of the sequence, so
          // the strip never discards a transcript another tab merged; the
          // `expected` + `expectedSeq` guards keep a NEWER draft (or a
          // baseline a newer sequence replaced) intact. A declined strip just
          // adopts the server draft via a refresh.
          // Version the tombstone with the sequence BEFORE the strip is in
          // flight, so a strip that commits with a lost acknowledgement (or
          // a crash before the catch) is recognized on retry instead of
          // falling into the no-baseline conditional clear.
          if (typeof baselineSeq === 'number') saveClearTombstone(sessionId, baselineSeq);
          hub
            .request<{ updated?: boolean; value?: string }>('session.stripVoiceBaseline', {
              sessionId,
              expected: draft ?? '',
              expectedSeq: baselineSeq ?? undefined,
            })
            .then((result) => {
              if (!stillCurrent()) return;
              if (result.updated) {
                // Apply the stripped value only while the composer still
                // shows what the chain's get applied (or is empty): typing
                // since that get is NEWER user state, and overwriting it
                // here would drop the keystrokes. But that typing never
                // received the transcripts anywhere (this chain was not
                // CANCELLED, so the reconcile-on-cancel fold never ran), and
                // the strip just cleared the daemon baseline — consuming
                // without folding would lift the save suppression so the
                // next plain save replaces the transcript-only server draft
                // with transcript-free typing, losing the voice text
                // permanently. Fold the stripped transcripts into the newer
                // content (blind append — the once-per-generation fold
                // discipline) so the re-enabled save carries BOTH. Skip the
                // fold when a CANCELLED get already folded this generation's
                // transcripts into the typing — appending again would
                // duplicate the voice text.
                const alreadyFolded =
                  foldedLandingRef.current.get(sessionId) === generation &&
                  contentSignal.peek().trim() !== '' &&
                  contentSignal.peek() !== (draft ?? '');
                const currentContent = contentSignal.peek();
                const stripped = result.value ?? '';
                if (currentContent.trim() === '' || currentContent === (draft ?? '')) {
                  contentSignal.value = stripped;
                } else if (stripped.trim() !== '' && !alreadyFolded) {
                  const combined = appendDraftText(currentContent, stripped);
                  const fits =
                    combined === `${currentContent}${stripped}` ||
                    combined === `${currentContent} ${stripped}`;
                  if (!fits) {
                    // appendDraftText silently truncated at the limit, and
                    // consuming the landing anyway would let the next plain
                    // save overwrite the daemon's complete transcript-only
                    // draft with the truncated combination. Keep the clear
                    // owed — the versioned tombstone records the strip that
                    // already committed — and retry when room appears.
                    oweClear(baselineSeq ?? undefined);
                    flushKickRef.current();
                    return;
                  }
                  contentSignal.value = combined;
                }
                consumeLanding(sessionId, generation);
              } else {
                refresh(draft); // raced a newer writer/sequence — adopt the server's draft
              }
            })
            .catch(() => {
              // The strip may have COMMITTED with a lost ack — the versioned
              // tombstone above lets the retry recognize it as done. Arm the
              // bounded retry for a while-connected rejection.
              oweClear(baselineSeq ?? undefined);
              flushKickRef.current();
            });
        },
        true,
        applyOnlyWhenIdle
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
  // Departed sessions' backup flushes that could not run or commit during
  // their switch (socket down / update failed), keyed per session: switching
  // offline through several sessions must queue one flush EACH, not overwrite
  // the earlier one. The switch is otherwise the ONLY trigger and the session
  // ref has already advanced — without this retry the expired-landing backups
  // are never pushed and are eventually pruned.
  const pendingBackupFlushRef = useRef<
    Map<
      string,
      {
        content: string;
        generation: number;
        key: string;
        claimId: string;
        ts: number;
        // Set when the content was captured from the ACTIVE composer (the
        // active-merge retries below) rather than a departed session's
        // backup: an idle composer at retry time then means the user SENT or
        // deleted that text, and adopting it back would resurrect it.
        fromActive?: boolean;
      }
    >
  >(new Map());
  // An explicit clear invalidates any QUEUED backup flush for the session:
  // its content is pre-clear text the user just sent or deleted, and the
  // retry pass's idle-adoption would merge it back into the daemon and adopt
  // it into the composer — resurrecting it. The durable claim retires too,
  // so no restore path can bring the pre-clear text back either.
  const dropQueuedBackupFlush = useCallback((sid: string): void => {
    const queuedClaim = pendingBackupFlushRef.current.get(sid);
    if (!queuedClaim) return;
    pendingBackupFlushRef.current.delete(sid);
    if (queuedClaim.key) {
      retireDraftBackupClaim({
        key: queuedClaim.key,
        generation: queuedClaim.generation,
        ts: queuedClaim.ts,
      });
    }
  }, []);
  // Retry retained backup flushes once the connection is restored. A flush
  // whose session is active again is ADOPTED into an idle composer (its edits
  // are newer than the stale server draft; normal saves then persist them) —
  // a composer with text supersedes the backup, whose durable copy stays for
  // a later switch. Subscribed explicitly (not via a signal effect) so
  // connection changes do not re-run the component's other signal effects.
  useEffect(() => {
    // A failed flush while still CONNECTED (RPC timeout / daemon transient)
    // would never be retried by the connection subscription alone — back off
    // and retry until it commits.
    const flushRetryTimerRef: { current: ReturnType<typeof setTimeout> | null } = {
      current: null,
    };
    let flushRetryDelayMs = 5_000;
    const scheduleFlushRetry = () => {
      if (flushRetryTimerRef.current) return;
      flushRetryTimerRef.current = setTimeout(() => {
        flushRetryTimerRef.current = null;
        retryBackupFlush();
      }, flushRetryDelayMs);
      flushRetryDelayMs = Math.min(flushRetryDelayMs * 2, 60_000);
    };
    const retryBackupFlush = () => {
      if (connectionState.value !== 'connected') return;
      // An owed clear whose landing expired has no replay effect to retry it —
      // reconcile it directly for the active session. One whose landing is
      // still LIVE is retried by re-triggering that effect (the signal write
      // re-runs it; its chain is idempotent), because no content or
      // connection change will.
      if (hasClearTombstone(currentSessionIdRef.current)) {
        if (!isLandingLive(currentSessionIdRef.current)) {
          reconcileOwedClear(currentSessionIdRef.current);
        } else if (pendingClearRef.current === currentSessionIdRef.current) {
          voiceTranscriptLandedSignal.value = new Map(voiceTranscriptLandedSignal.value);
        }
      }
      const hub = connectionManager.getHubIfConnected();
      if (!hub) return; // not actually reachable yet — retry on the next change
      const queued = [...pendingBackupFlushRef.current.entries()];
      pendingBackupFlushRef.current.clear();
      // Requeue a failed/declined claim WITHOUT clobbering a NEWER claim that
      // was queued while its merge was in flight (another landing + switch):
      // the newer entry supersedes this retry — merging the older content
      // would push obsolete edits while the newer backup went unscheduled.
      // The older claim's durable key is skipped later via the supersede
      // marker the newer claim's acknowledged retire writes.
      const requeueClaim = (
        flushSessionId: string,
        entry: {
          content: string;
          generation: number;
          key: string;
          claimId: string;
          ts: number;
          fromActive?: boolean;
        }
      ) => {
        const newer = pendingBackupFlushRef.current.get(flushSessionId);
        if (
          newer &&
          (newer.generation > entry.generation ||
            (newer.generation === entry.generation && newer.ts > entry.ts))
        ) {
          return; // a newer claim superseded this retry
        }
        pendingBackupFlushRef.current.set(flushSessionId, entry);
        scheduleFlushRetry();
      };
      for (const [
        flushSessionId,
        { content, generation, key, claimId, ts, fromActive },
      ] of queued) {
        if (flushSessionId === currentSessionIdRef.current) {
          if (contentSignal.peek().trim() === '') {
            if (fromActive) {
              // The queued content was the ACTIVE composer text captured when
              // its merge was declined — an empty composer now means the user
              // SENT or deleted that text since. Adopting it back through the
              // idle branch would resurrect it; retire the durable claim (its
              // supersede marker also blocks stale restores). A TRANSIENT
              // pre-load '' (initial load not settled) is not a user clear —
              // keep the claim and retry after the load settles.
              if (initialLoadSettledRef.current !== flushSessionId) {
                requeueClaim(flushSessionId, { content, generation, key, claimId, ts, fromActive });
                continue;
              }
              if (key) retireDraftBackupClaim({ key, generation, ts });
              continue;
            }
            // ADOPT into the idle composer through the daemon-side MERGE: it
            // persists the backup PLUS any merged transcripts in one atomic
            // write (the backup alone is transcript-free), so the durable
            // copy cannot be dropped by a reload before a debounced save. The
            // backup retires only on the acknowledged merge, and only the
            // exact key and generation it captured: a NEWER landing can
            // rewrite the backup while this update is in flight, and clearing
            // it here would strand that landing's suppressed edits. A failure
            // or a declined merge (newer sequence unresolved) re-queues it
            // under the SAME claim id, so a merge that committed with a lost
            // ack is recognized idempotently on the retry.
            hub
              .request<{ merged?: boolean; stale?: boolean; value?: string }>(
                'session.mergeVoiceDraftBackup',
                {
                  sessionId: flushSessionId,
                  content,
                  claimId,
                  // Echo the draft version this tab last read: a mismatch
                  // means a NEWER write or merge already committed, and this
                  // (older) claim lost the last-writer-wins race — pushing it
                  // over the newer draft would discard both the newer edits
                  // and any merged transcript.
                  expectedDraftVersion: draftVersionsRef.current.get(flushSessionId),
                }
              )
              .then((result) => {
                if (!result.merged) {
                  if (result.stale) {
                    // Superseded by a newer committed write — retire the
                    // durable claim instead of requeueing an eternally-stale
                    // push (in-memory claims carry no key and simply drop).
                    if (key) retireDraftBackupClaim({ key, generation, ts });
                    return;
                  }
                  requeueClaim(flushSessionId, { content, generation, key, claimId, ts });
                  return;
                }
                if (currentSessionIdRef.current === flushSessionId) {
                  // Still current and idle (checked at queue time; typing
                  // since supersedes the adoption — its saves are newer).
                  if (contentSignal.peek().trim() === '') {
                    contentSignal.value = result.value ?? content;
                  }
                }
                if (key) retireDraftBackupClaim({ key, generation, ts });
              })
              .catch(() => {
                requeueClaim(flushSessionId, { content, generation, key, claimId, ts });
              });
          } else {
            // Active content supersedes the backup: the user returned to a
            // non-empty composer (their draft or typing). But that content is
            // only scheduled through the normal debounced save — deleting the
            // durable copy NOW would lose the draft to a reload, crash, or
            // second disconnect before the save is acknowledged, while the
            // daemon still holds the older value. Persist the ACTIVE content
            // through the daemon-side merge (transcripts folded atomically)
            // and retire the backup only once that write is acknowledged; a
            // failure requeues the backup claim itself.
            const active = contentSignal.peek().trim();
            // One claim id per session's active-merge sequence, reused across
            // retries (the daemon's idempotent replay acknowledges a committed
            // merge instead of rewriting); retired once the merge commits.
            const boundClaim = activeMergeClaimsRef.current.get(flushSessionId);
            const activeClaimId =
              boundClaim && boundClaim.content === active ? boundClaim.claimId : generateUUID();
            activeMergeClaimsRef.current.set(flushSessionId, {
              claimId: activeClaimId,
              content: active,
            });
            hub
              .request<{ merged?: boolean; stale?: boolean; value?: string }>(
                'session.mergeVoiceDraftBackup',
                {
                  sessionId: flushSessionId,
                  content: active,
                  claimId: activeClaimId,
                  expectedDraftVersion: draftVersionsRef.current.get(flushSessionId),
                }
              )
              .then((result) => {
                if (result.stale && !result.merged) {
                  // STALE only means a newer committed write superseded this
                  // PUSH — nothing of the active content was persisted, and
                  // its normal debounced save may still be unacknowledged.
                  // Retiring the durable backup now would delete the tab's
                  // only copy of those edits before ANY acknowledged save;
                  // keep it and requeue the active content under the SAME id
                  // (the retry merge folds transcripts and retires then).
                  requeueClaim(flushSessionId, {
                    content: active,
                    generation,
                    key,
                    claimId: activeClaimId,
                    ts,
                    fromActive: true,
                  });
                  return;
                }
                if (result.merged) {
                  // Delete the binding ONLY when it still names THIS merge: a
                  // newer active merge (e.g. a switch away and back queued a
                  // fresher claim) replaced it meanwhile, and deleting that
                  // binding would let the newer merge's lost-ack retry mint a
                  // fresh claim id the daemon cannot recognize as its
                  // committed replay — rewriting the draft through the plain
                  // branch and discarding merged voice text.
                  const boundClaim = activeMergeClaimsRef.current.get(flushSessionId);
                  if (!boundClaim || boundClaim.claimId === activeClaimId) {
                    activeMergeClaimsRef.current.delete(flushSessionId);
                  }
                  // Retire through the claim path so the SUPERSEDE boundary
                  // is recorded: other tabs' older same-generation backups
                  // must become unrestorable over this committed draft. The
                  // boundary must describe the ACTIVE reconciliation that
                  // just committed — not the queued claim's older
                  // generation/timestamp: a same-generation sibling written
                  // after the claim was queued, or a newer landing's backup
                  // captured before this acknowledgement, must become
                  // unrestorable over the acknowledged draft too, or a later
                  // reload could merge the obsolete backup over it.
                  if (key) {
                    retireDraftBackupClaim({
                      key,
                      generation: getLandingGeneration(flushSessionId) ?? generation,
                      ts: Date.now(),
                    });
                  }
                  // ADOPT the daemon's value while the composer still shows
                  // the content we sent: after a voice sequence merged, the
                  // value is active + transcripts and the baseline cleared —
                  // leaving the composer transcript-free would let its next
                  // save overwrite the merged value and delete the voice text.
                  if (
                    flushSessionId === currentSessionIdRef.current &&
                    contentSignal.peek().trim() === active
                  ) {
                    contentSignal.value = result.value ?? active;
                  }
                  return;
                }
                // Still owed: requeue the ACTIVE content under the SAME id —
                // not the older backup, whose transcript-free text must never
                // overwrite the draft the active merge committed.
                requeueClaim(flushSessionId, {
                  content: active,
                  generation,
                  key,
                  claimId: activeClaimId,
                  ts,
                  fromActive: true,
                });
              })
              .catch(() => {
                requeueClaim(flushSessionId, {
                  content: active,
                  generation,
                  key,
                  claimId: activeClaimId,
                  ts,
                  fromActive: true,
                });
              });
          }
          continue;
        }
        hub
          .request<{ merged?: boolean; stale?: boolean }>('session.mergeVoiceDraftBackup', {
            sessionId: flushSessionId,
            content,
            claimId,
            expectedDraftVersion: draftVersionsRef.current.get(flushSessionId),
          })
          .then((result) => {
            if (result.merged) {
              if (key) retireDraftBackupClaim({ key, generation, ts });
              return;
            }
            if (result.stale) {
              // A newer committed write superseded this backup — retire
              // instead of requeueing an eternally-stale push (in-memory
              // claims carry no key and simply drop).
              if (key) retireDraftBackupClaim({ key, generation, ts });
              return;
            }
            // Declined (a newer sequence is unresolved — the draft diverged
            // from its baseline): requeue with backoff, or the backup would
            // never retry and could expire without reaching the daemon.
            requeueClaim(flushSessionId, { content, generation, key, claimId, ts });
          })
          .catch(() => {
            requeueClaim(flushSessionId, { content, generation, key, claimId, ts });
          });
      }
    };
    flushKickRef.current = () => {
      if (connectionState.value === 'connected') scheduleFlushRetry();
    };
    const unsubscribe = connectionState.subscribe(retryBackupFlush);
    return () => {
      unsubscribe();
      flushKickRef.current = () => {};
      if (flushRetryTimerRef.current) clearTimeout(flushRetryTimerRef.current);
    };
  }, [contentSignal, reconcileOwedClear]);
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
      if (prevHasLanding) {
        // The live landing blocks the departed session's plain flush, but its
        // save-suppressed backup must not be ABANDONED: nothing rechecks an
        // inactive session when the marker later expires, so a user who never
        // returns loses the only copy to TTL pruning. Schedule the claim
        // through the merge queue instead — the daemon-side merge preserves
        // any transcripts regardless of sequence state (staged re-anchors,
        // merged folds), so an early push is safe and converges with the
        // final backup the user writes if they return.
        const liveClaim = peekExpiredDraftBackup(prevSessionId);
        if (liveClaim?.content.trim()) {
          pendingBackupFlushRef.current.set(prevSessionId, {
            content: liveClaim.content.trim(),
            generation: liveClaim.generation,
            key: liveClaim.key,
            claimId: generateUUID(),
            ts: liveClaim.ts,
          });
          flushKickRef.current();
        } else if (trimmedContent) {
          // No durable backup exists (localStorage refused it), so the
          // composer's text was the only copy — e.g. a save the daemon REFUSED
          // because the transcripts could not fold whole. Queue it as an
          // IN-MEMORY claim (empty key: nothing durable to retire) so the
          // merge retry keeps attempting after the switch instead of
          // abandoning the text with the composer.
          pendingBackupFlushRef.current.set(prevSessionId, {
            content: trimmedContent,
            generation: getLandingGeneration(prevSessionId) ?? 0,
            key: '',
            claimId: generateUUID(),
            ts: Date.now(),
          });
          flushKickRef.current();
        }
        prevSessionIdRef.current = sessionId;
        return;
      }
      // While the landing was live, saves were suppressed into the draft
      // backup and lastSeenContent went stale — with the landing gone, that
      // backup is the freshest record. PEEK it (read WITHOUT removing — the
      // flush is best-effort, and destroying the only durable copy before
      // the update is acknowledged would lose those edits if the socket
      // drops mid-flush) so the departed session's edits reach the server
      // instead of dying with the expired marker.
      const claimed = peekExpiredDraftBackup(prevSessionId);
      // One idempotency token per claim, reused by every retry: a merge that
      // COMMITTED but whose ack was lost is recognized on retry instead of
      // rewriting the draft with the transcript-free backup.
      const flushClaimId = claimed ? generateUUID() : null;
      const flushContent = claimed?.content.trim() || trimmedContent;
      const queueRetry = () => {
        if (claimed?.content.trim()) {
          // Carry the claimed GENERATION, exact KEY, and the claim's
          // idempotency token: the retry's acknowledged merge must retire
          // only the backup it actually persisted, never one a newer landing
          // wrote in the meantime — and a retry whose merge already COMMITTED
          // with a lost ack must be recognized, not rewritten.
          pendingBackupFlushRef.current.set(prevSessionId, {
            content: claimed.content.trim(),
            generation: claimed.generation,
            key: claimed.key,
            claimId: flushClaimId ?? generateUUID(),
            ts: claimed.ts,
          });
          // Arm the retry pass NOW: this first attempt failed while
          // CONNECTED (the merge was declined or the RPC errored), so
          // neither the connection subscription (fires only on CHANGES)
          // nor a later switch will revisit the claim — without this it
          // idles in localStorage until the TTL prunes it. The kick is a
          // no-op while disconnected (the reconnect subscription owns that
          // case).
          flushKickRef.current();
        }
      };
      const pushBackup = () => {
        const hub = connectionManager.getHubIfConnected();
        if (!hub) {
          // Offline (or the update failed): retain the flush for the
          // reconnect effect below — the switch is the only other trigger,
          // and the session ref has already advanced past this session.
          queueRetry();
          return;
        }
        if (!flushContent && !(last.sessionId === prevSessionId && last.cleared)) return;
        if (!claimed) {
          // No voice backup involved — a plain draft write.
          hub
            .request<{ draftVersion?: number; draftValue?: string }>('session.update', {
              sessionId: prevSessionId,
              expectedDraftVersion: draftVersionsRef.current.get(prevSessionId),
              metadata: {
                inputDraft: flushContent || null,
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
          return;
        }
        // A claimed BACKUP goes through the daemon-side MERGE, never a bare
        // session.update: the backup is transcript-free, and the departed
        // session's draft may hold transcripts the expired landing merged —
        // the merge folds them in (exactly, via the baseline snapshot) or
        // declines while a newer sequence is unresolved, instead of
        // clobbering them.
        hub
          .request<{ merged?: boolean; stale?: boolean }>('session.mergeVoiceDraftBackup', {
            sessionId: prevSessionId,
            content: flushContent,
            claimId: flushClaimId ?? undefined,
            expectedDraftVersion: draftVersionsRef.current.get(prevSessionId),
          })
          .then((result) => {
            // Acknowledged — now the durable copy is safely superseded,
            // retired (with its same-generation siblings) by the exact key
            // and generation it held. A STALE decline means a newer write
            // superseded the backup — retire it rather than requeue. A
            // declined merge (newer sequence unresolved) is requeued for
            // retry.
            if (result.merged || result.stale) retireDraftBackupClaim(claimed);
            else queueRetry();
          })
          .catch(() => {
            queueRetry();
          });
      };
      pushBackup();
      prevSessionIdRef.current = sessionId;
      return;
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
        const backedUp = saveDraftBackup(sessionId, content, getLandingGeneration(sessionId) ?? 0);
        if (backedUp) return;
        // localStorage refused the backup (disabled / quota): suppressing the
        // save would leave the typed text only in the composer signal — lost
        // to a switch, reload, or close. Fall through to the NORMAL save: the
        // daemon's expectedDraftVersion check folds any merged transcripts
        // into the write, so the fallback is transcript-safe.
      } else {
        // The composer emptied under a live landing — an explicit send/clear
        // whose reconciliation the replay effect's chain owns. Any queued
        // backup flush holds pre-clear text the user just sent or deleted;
        // drop it (this effect reads the content signal FIRST, so unlike the
        // replay effect it cannot miss the clear through a lost
        // subscription) or the retry's idle-adoption would resurrect it.
        dropQueuedBackupFlush(sessionId);
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
      dropQueuedBackupFlush(sessionId);
      const hub = connectionManager.getHubIfConnected();
      if (hub) {
        // Bind any deferred retirement to the entry present when THIS request
        // is sent (see flushDeferredBackupRetire).
        const deferredAtSend = deferredBackupRetiresRef.current.get(sessionId);
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
            // Any backup whose retirement THIS request's content deferred is
            // now safely superseded (a fold that landed after the send keeps
            // waiting for its own save).
            if (deferredAtSend) flushDeferredBackupRetire(sessionId, deferredAtSend);
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

      // Bind any deferred retirement to the entry present when THIS request
      // is sent (see flushDeferredBackupRetire): a fold that lands while the
      // request is in flight must survive until its own later save acks.
      const deferredAtSend = deferredBackupRetiresRef.current.get(sessionId);
      try {
        const ack = await hub.request<{
          draftVersion?: number;
          draftValue?: string;
          foldRefused?: boolean;
          staleRefused?: boolean;
        }>('session.update', {
          sessionId,
          // Echo the draft version this composer last READ: the daemon applies
          // the write as-is only when it matches (a mismatch marks a stale
          // in-flight save, whose transcripts it folds back in).
          expectedDraftVersion: draftVersionsRef.current.get(sessionId),
          metadata: {
            inputDraft: trimmedContent,
          },
        });
        if (typeof ack?.draftValue === 'string' && !ack?.foldRefused) {
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
            if (deferredAtSend) flushDeferredBackupRetire(sessionId, deferredAtSend);
          }
          return;
        }
        if (ack?.foldRefused) {
          // The daemon REFUSED the fold (our too-long write could not retain
          // the transcripts whole) and retained the merged draft: NOTHING of
          // ours was persisted. Keep the local content (it was never saved —
          // adopting the retained draft here would silently discard it) and
          // keep the version cache STALE: advancing to the retained draft's
          // version would make the NEXT save apply as-is, clearing the
          // baseline and deleting the transcripts from the draft.
          return;
        }
        if (ack?.staleRefused) {
          // The daemon REFUSED this write as a stale echo over an EMPTY
          // draft (another tab or the send already cleared it past our
          // version): nothing was persisted, and the refusal itself proves
          // the daemon state — it fires only over an empty draft — while the
          // ack carries that state's version. Adopt both when the composer
          // still shows EXACTLY the refused text; newer typing is fresher
          // user state to keep (its own next save re-attempts, and the
          // daemon re-refuses rather than resurrecting).
          if (
            currentSessionIdRef.current === sessionId &&
            contentSignal.peek() === trimmedContent
          ) {
            contentSignal.value = '';
            advanceDraftVersion(sessionId, ack?.draftVersion);
          }
          return;
        }
        // Advance the cache to the APPLIED version: without it, a concurrent
        // daemon-side bump (another tab's folded save) would leave this
        // composer echoing a stale version forever, and every later edit
        // would be misclassified as stale and folded (duplicating the
        // transcript it already contains).
        advanceDraftVersion(sessionId, ack?.draftVersion);
        // The combined draft this request persisted is now durable — retire
        // the backup whose deletion was deferred to THIS acknowledgement.
        if (deferredAtSend) flushDeferredBackupRetire(sessionId, deferredAtSend);
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

  // Stable clear function. The user's EXPLICIT clear invalidates any queued
  // backup flush for this session (its content is pre-clear text the user
  // just sent or deleted — the retry's idle-adoption would resurrect it).
  // Done here, not in a signal effect: effect scheduling around session
  // switches can skip or re-order runs (a stale prev-session branch returns
  // early), while this callback fires exactly when the user clears.
  const clear = useCallback(() => {
    contentSignal.value = '';
    dropQueuedBackupFlush(currentSessionIdRef.current);
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
