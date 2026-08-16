/**
 * Voice Transcript Outbox — durable last-resort preservation for transcripts
 * that complete after their composer unmounted (the user navigated away
 * mid-transcription) when the daemon is unreachable.
 *
 * The unmounted delivery path stages the transcript into the session's
 * `inputDraftVoicePending` field via `session.appendVoiceDraft`. That RPC
 * needs a live socket; if the connection drops in the moment of delivery, the
 * staging fails and — before this module — the transcript was lost. This
 * outbox parks the TEXT (the audio is already transcribed; only the result
 * and its landing session remain at risk) so it survives a page reload, and
 * replays it through the same append RPC on reconnect.
 *
 * Storage: each entry lives under its OWN localStorage key (no shared array),
 * so two tabs enqueueing/removing concurrently cannot clobber each other's
 * read-modify-write. An in-session memory mirror always holds the entries, so
 * a localStorage failure (disabled, over quota) degrades to "preserved for
 * this session" instead of silently dropping the only copy.
 *
 * Replay is idempotent via a per-entry `dedupId`: the daemon records the set
 * of merged outbox ids per session and skips a re-append that already
 * committed (the socket can drop between the daemon's write and its ack).
 * Mirrors the outbound-queue reconnect-flush pattern.
 */

import { effect, signal } from '@preact/signals';
import { appendDraftText, generateUUID } from '@hyperneo/shared';
import { connectionManager } from '../connection-manager';
import { connectionState } from '../state';

export interface PendingTranscript {
  id: string;
  sessionId: string;
  text: string;
  createdAt: number;
}

/**
 * Per-session GENERATION of landings awaiting a mounted-composer refresh. Two
 * entries landing for the same session while one refresh is in flight would
 * collapse into a single set membership; the generation lets the refresh
 * consume exactly the count it observed, so a landing that arrived mid-refresh
 * still gets its own refresh. A session key present = its composer should
 * refresh; absent = nothing pending.
 */
export const voiceTranscriptLandedSignal = signal<ReadonlyMap<string, number>>(new Map());

/**
 * Record that an entry landed for `sessionId` (called by the flush). The
 * localStorage marker lets OTHER tabs learn of the landing via the `storage`
 * event, since the signal itself is process-local. The marker carries the
 * transcript TEXT so any tab (or a later reload) can reconcile a draft backup
 * or strip a stale baseline without guessing which part of the merged server
 * draft is the transcript.
 */
// Deferred re-verification of a surviving landed-marker write (see the CAS
// loop in markVoiceTranscriptLanded): localStorage has no cross-tab
// atomicity, so a writer that read the OLD marker can replace the union just
// after this tab observed its own write and exited. The spaced checks re-union
// when this sequence's entries vanish; each writer's repair unions from the
// other's marker, so the aggregates converge for interleaves inside the
// window (the daemon's baseline snapshot stays the authoritative transcript
// source, so this bounds — not eliminates — the exposure).
const markerVerifyTimers = new Map<string, ReturnType<typeof setTimeout>[]>();
// PER-SESSION repair budget shared by every verification chain (a repair's
// own mark schedules a fresh chain): without a shared budget a storage layer
// whose reads never observe the writes would repair forever.
const markerRepairBudget = new Map<string, number>();
const MARKER_VERIFY_DELAYS_MS = [25, 250, 2000];
function scheduleMarkerVerification(sessionId: string, announced: LandingEntry[]): void {
  if (announced.length === 0) return;
  // A newer landing's chain SUPERSEDES any pending one: its announced set is
  // current, and the older chain would otherwise interpret legitimate
  // eviction (below) as a clobber.
  for (const timer of markerVerifyTimers.get(sessionId) ?? []) clearTimeout(timer);
  const timers: ReturnType<typeof setTimeout>[] = [];
  markerVerifyTimers.set(sessionId, timers);
  markerRepairBudget.set(sessionId, 3);
  const check = (pass: number) => {
    try {
      // No repair once this tab CONSUMED a marker or its landing expired: the
      // live marker then belongs to a newer sequence (whose writer unions with
      // ours), and re-marking would re-announce already-merged transcripts.
      if (!consumedMarkers.has(sessionId) && isLandingLive(sessionId)) {
        const raw = localStorage.getItem(`${LANDED_PREFIX}${sessionId}`);
        const marker = parseLandedMarker(raw);
        // The captured RECORDS repair from data the clobber's own storage
        // event cannot destroy: the handler REPLACES the local aggregate with
        // the incoming (possibly clobbering) marker, so the missing entries
        // are gone from landingEntries by the time this runs — re-marking
        // from the captured records restores them into the live aggregate and
        // the rewritten marker. Ids OUR OWN cap eviction dropped are exempt:
        // their absence from the marker is legitimate, and re-announcing them
        // would mint a false landing whose reconciliation appends the
        // aggregate again, duplicating voice text.
        const evicted = evictedEntryIds.get(sessionId) ?? new Set<string>();
        const missing = announced.filter(
          (entry) => !evicted.has(entry.id) && (!marker || !marker.ids.includes(entry.id))
        );
        const budget = markerRepairBudget.get(sessionId) ?? 0;
        if (missing.length > 0 && budget > 0) {
          markerRepairBudget.set(sessionId, budget - 1);
          for (const entry of missing) {
            markVoiceTranscriptLanded(sessionId, entry.text, entry.id, entry.seq);
          }
          return;
        }
      }
    } catch {
      /* storage unavailable — nothing to verify */
    }
    if (pass + 1 >= MARKER_VERIFY_DELAYS_MS.length) return;
    timers.push(
      setTimeout(
        () => check(pass + 1),
        MARKER_VERIFY_DELAYS_MS[pass + 1] - MARKER_VERIFY_DELAYS_MS[pass]
      )
    );
  };
  timers.push(setTimeout(() => check(0), MARKER_VERIFY_DELAYS_MS[0]));
}

function clearMarkerVerifications(): void {
  for (const timers of markerVerifyTimers.values()) {
    for (const timer of timers) clearTimeout(timer);
  }
  markerVerifyTimers.clear();
}

export function markVoiceTranscriptLanded(
  sessionId: string,
  text?: string,
  entryId?: string,
  entrySeq?: number
): void {
  // The GENERATION is the marker's persisted counter (not a process-local
  // count): a reload rehydrates the same generation from the marker, so a
  // draft backup saved as generation N is still retired by exactly the
  // consumption of generation N instead of being orphaned by a restarted
  // counter.
  // Collision-resistant allocation: two tabs can read the SAME marker and
  // both pick existing.n + 1 before either writes, and equal generations let a
  // refresh consume a NEWER landing as though it never arrived. The wall
  // clock (plus a per-tab offset hashed from the tab id) breaks the tie — a
  // later landing always observes the winner's n, so the counter stays
  // strictly monotonic from there.
  let seq = Math.max(1, Date.now() + TAB_SEQ_OFFSET);
  let markerExisted = false;
  let existing: ReturnType<typeof parseLandedMarker> = null;
  let rawMarker: string | null = null;
  try {
    rawMarker = localStorage.getItem(`${LANDED_PREFIX}${sessionId}`);
    existing = parseLandedMarker(rawMarker);
    if (existing) {
      markerExisted = true;
      // The COUNTER path carries the per-tab offset too: when a large prior
      // generation dominates the clock, two tabs reading the same marker
      // would otherwise pick the identical existing.n + 1 — equal
      // generations let a refresh consume a NEWER landing as though none
      // arrived. Offsets differ per tab, so the picks collide only on a
      // 1-in-997 hash collision.
      seq = Math.max(existing.n + 1 + TAB_SEQ_OFFSET, Date.now() + TAB_SEQ_OFFSET);
    }
  } catch {
    /* storage unavailable — start a fresh sequence */
  }
  if (!markerExisted) {
    // A fresh GENERATION EPOCH: the previous sequence's marker expired, so
    // its counters restart. The epoch's SUPERSEDE records are keyed by
    // generation number and must not outlive the epoch — a stale
    // higher-generation record would suppress every backup of the new
    // epoch's lower-numbered landings (their generations compare lower
    // regardless of their newer timestamps), making them unrestorable while
    // their landing suppresses the owner's server saves. Clear BOTH the
    // legacy single record and the per-content record keys.
    try {
      const epochPrefix = `${SUPERSEDED_PREFIX}${sessionId}`;
      const epochRecordKeys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith(epochPrefix)) continue;
        if (key.length > epochPrefix.length && key[epochPrefix.length] !== '.') continue;
        epochRecordKeys.push(key);
      }
      for (const key of epochRecordKeys) localStorage.removeItem(key);
    } catch {
      /* storage unavailable */
    }
  }
  markVoiceTranscriptLandedLocal(
    sessionId,
    text,
    false,
    seq,
    entryId,
    undefined,
    undefined,
    undefined,
    entrySeq
  );
  // Another tab may have landed entries whose `storage` event this context
  // has not yet processed — the rewrite must UNION with the persisted
  // aggregate, not replace it (a replacement drops the earlier transcripts
  // from every future reconciliation that falls back to the marker). Runs
  // AFTER the local accumulation above, which restarts the aggregate when no
  // local landing was live.
  // ...but skip a marker THIS TAB already consumed (the per-tab ack still
  // names it): consumption means the sequence's pending fully merged
  // server-side, so the next sequence legitimately starts a fresh aggregate —
  // unioning here would re-announce already-merged transcripts.
  //
  // Identity is decided by ENTRY ID, never by substring: a separate
  // occurrence can legitimately CONTAIN another entry's phrase ('hello' vs
  // 'hello world'), and a substring check would silently drop the earlier
  // dictated occurrence while the marker still advertises both ids. The
  // persisted aggregate appends when ANY persisted id is not yet ours, and
  // no-id markers (test-only writes) never trigger the union.
  const consumeMarker = (marker: ReturnType<typeof parseLandedMarker>): void => {
    if (!marker) return;
    const ours = new Set(landingIds.get(sessionId) ?? []);
    // ENTRY granularity: append ONLY the entries whose ids we lack — merging
    // the whole aggregate would duplicate entries the local sequence already
    // holds (local [e1,e3] vs marker [e1,e2] appends only e2). Pre-entries
    // markers fall back to the aggregate append keyed by the id set.
    if (marker.entries.length > 0) {
      // DAEMON COMMIT order: the union is ordered by each entry's commit
      // sequence (see orderLandingEntries) — a persisted marker is NOT proof
      // its entries committed before the local one, because acknowledgements
      // can publish out of order, and an arrival-ordered union would reverse
      // dictated transcripts and break the aggregate's tail-match against the
      // merged draft.
      const unseen = marker.entries.filter((entry) => !ours.has(entry.id));
      if (unseen.length > 0) {
        const known = new Set((landingEntries.get(sessionId) ?? []).map((e) => e.id));
        const merged = orderLandingEntries([
          ...marker.entries.filter((e) => !known.has(e.id)),
          ...(landingEntries.get(sessionId) ?? []),
        ]);
        recordEntryEvictions(sessionId, merged);
        const mergedEntries = merged.slice(-MAX_ENTRIES);
        landingEntries.set(sessionId, mergedEntries);
        landingTexts.set(
          sessionId,
          mergedEntries.reduce((acc, entry) => appendDraftText(acc, entry.text), '')
        );
        // DERIVE the announced-id set from the RETAINED entries, then fill any
        // remaining slots with older ids: the previous local-first ordering
        // let the two bounded slices retain DIFFERENT sets at the cap,
        // leaving a retained entry whose id was dropped — a delayed ack for
        // that entry then looked unannounced and minted a FALSE landing whose
        // fallback reconciliation appended its transcript again.
        const retainedIds = mergedEntries.map((entry) => entry.id);
        for (const id of retainedIds) ours.add(id);
        const extras = [...ours].filter((id) => !retainedIds.includes(id));
        const room = Math.max(0, MAX_ENTRIES - retainedIds.length);
        landingIds.set(sessionId, [...retainedIds, ...extras.slice(-room)]);
      }
      return;
    }
    if (marker.text && marker.ids.some((id) => !ours.has(id))) {
      landingTexts.set(sessionId, appendDraftText(landingTexts.get(sessionId) ?? '', marker.text));
    }
    if (marker.ids.length) {
      const mergedIds = new Set(landingIds.get(sessionId) ?? []);
      for (const id of marker.ids) mergedIds.add(id);
      landingIds.set(sessionId, [...mergedIds].slice(-MAX_ENTRIES));
    }
  };
  const consumedRaw = (raw: string | null): boolean =>
    raw !== null && consumedMarkers.get(sessionId) === raw;
  if (!consumedRaw(rawMarker)) consumeMarker(existing);
  try {
    // Timestamp + monotonic counter so two landings within the same Date.now()
    // tick still change the value — a same-value write would not emit a
    // storage event in other tabs, which would then never learn of the second.
    // The marker carries the AGGREGATE text and announced ENTRY IDS of the
    // live landing sequence (see markVoiceTranscriptLandedLocal).
    //
    // COMPARE-AND-REVALIDATE: two tabs can read the SAME old marker, build
    // independent aggregates, and the last write would silently drop the
    // other's entries. localStorage writes are atomic per call, so re-reading
    // immediately before writing catches a concurrent tab's marker that
    // landed in between — re-union from it and retry (bounded) until the
    // write lands against the state just read.
    const key = `${LANDED_PREFIX}${sessionId}`;
    let markerRaw = rawMarker;
    for (let attempt = 0; attempt < 3; attempt++) {
      const currentRaw = localStorage.getItem(key);
      if (currentRaw !== markerRaw && !consumedRaw(currentRaw)) {
        const revalidated = parseLandedMarker(currentRaw);
        if (revalidated) {
          consumeMarker(revalidated);
          // RAISE the generation from the revalidated marker before writing:
          // a higher-offset tab can have published first, and writing our
          // already-computed (now lower) `seq` would REGRESS the persisted
          // generation — backups created under the higher generation would no
          // longer match it and could survive consumption as stale restores.
          seq = Math.max(seq, revalidated.n + 1 + TAB_SEQ_OFFSET, Date.now() + TAB_SEQ_OFFSET);
        }
      }
      const written = JSON.stringify({
        v: 1,
        ts: Date.now(),
        n: seq,
        text: landingTexts.get(sessionId) ?? null,
        ids: landingIds.get(sessionId) ?? [],
        entries: landingEntries.get(sessionId) ?? [],
      });
      localStorage.setItem(key, written);
      markerRaw = localStorage.getItem(key);
      // Stop once the write SURVIVED: re-reading a different value means a
      // concurrent tab landed in between (retry the union); equal means this
      // tab's write is the live marker and further attempts would only churn
      // `ts`/`n` and broadcast redundant storage events that re-arm the same
      // generation in every other tab.
      if (markerRaw === null || markerRaw === written) {
        // …but a successful readback is NOT a compare-and-swap across tabs:
        // another tab that read the OLD marker before this write can still
        // overwrite the union right after this tab exits (localStorage offers
        // no atomicity primitive). A short series of spaced re-checks re-unions
        // if this sequence's entries vanished — each writer's repair unions
        // from the other's marker, so the aggregates converge for any
        // interleaving inside the window. Only a VISIBLE surviving write can
        // be verified: `markerRaw === null` means reads never observed the
        // write (storage failing), and verifying against a permanently
        // unreadable marker would repair forever.
        if (markerRaw === written) {
          scheduleMarkerVerification(sessionId, landingEntries.get(sessionId) ?? []);
        }
        break;
      }
    }
  } catch {
    /* mirror-only — this tab still refreshes via the signal */
  }
}

/**
 * Update ONLY this tab's process-local landing state (no localStorage write).
 * Used by the `storage` event handler: re-persisting the marker there would
 * fire another storage event in the writing tab, which would write again —
 * a cross-tab event/write loop that churns the generation counter.
 */
// Wall-clock of each session's most recent local landing mark, so a landing
// deferred past the marker TTL can expire on its own (not just via other-tab
// marker-removal events) instead of suppressing draft saves forever.
const landingMarkedAt = new Map<string, number>();
// AGGREGATE transcript text of each session's live landing sequence. Multiple
// outbox entries can land for one session before any refresh consumes them;
// the daemon accumulates ALL of them into inputDraftVoicePending (cleared
// only by a full merge), so the reconciliation paths need the accumulated
// text — stripping to just the latest marker's transcript would discard the
// earlier entries. Accumulation runs only while a landing is LIVE: consuming
// a landing implies a get fully merged the pending (clearing it server-side),
// so the next landing sequence starts fresh. Mirrors the daemon's
// appendDraftText joining, so endsWith() checks against the merged draft line
// up exactly.
const landingTexts = new Map<string, string>();
// OUTBOX ENTRY IDS each session's live landing sequence announced, parallel to
// landingTexts and persisted in the marker. The flush's deduped-ack check
// matches identity by ID, never by transcript TEXT: a retained marker from an
// older sequence can legitimately contain the same PHRASE as a newer
// transcript, and a text match would then silently skip announcing the new
// entry's genuine landing.
const landingIds = new Map<string, string[]>();
// PER-ENTRY landing records (id + text), the authoritative granularity for
// marker merges: a persisted aggregate is only appendable as a WHOLE, so
// merging by ID set alone duplicates entries the local aggregate already
// holds (local [e1,e3] vs marker [e1,e2] must append ONLY e2's text). The
// marker carries these records; the derived text/ids fields stay for
// compatibility with every reader of the aggregate.
export interface LandingEntry {
  id: string;
  text: string;
  /** DAEMON COMMIT position (the append ack's `seq`), when known. */
  seq?: number;
}
const landingEntries = new Map<string, LandingEntry[]>();
// Entry ids THIS TAB's own cap eviction dropped from its local aggregate.
// The marker-verification repair must treat a missing id as a cross-tab
// clobber only when the local aggregate did not evict it itself — but the
// storage-event handler REPLACES the local ids from the incoming marker, so
// a clobbered-away id is indistinguishable from a locally evicted one by
// presence alone. Recording our own evictions separates the two: a missing
// id is repairable exactly when it was never evicted locally.
const evictedEntryIds = new Map<string, Set<string>>();
let syntheticEntryCounter = 0;

function recordEntryEvictions(sessionId: string, ordered: LandingEntry[]): void {
  if (ordered.length <= MAX_ENTRIES) return;
  const evicted = evictedEntryIds.get(sessionId) ?? new Set<string>();
  for (const entry of ordered.slice(0, ordered.length - MAX_ENTRIES)) evicted.add(entry.id);
  evictedEntryIds.set(sessionId, evicted);
}

// Order a landing sequence's entries by DAEMON COMMIT sequence: append
// acknowledgements can publish out of order across entries (a slower first
// append committing before a faster second one whose ack lands first), and an
// aggregate ordered by arrival no longer matches the merged draft's tail that
// reconciliation must verify against — a fallback restore would then push a
// reversed aggregate over the server draft. Entries without a `seq` (legacy
// markers from before the counter shipped) sit at the FRONT: the daemon
// appended them first, and sequences start at 1, so 0 orders every legacy
// entry ahead of all sequenced ones while keeping their relative order.
function orderLandingEntries(entries: LandingEntry[]): LandingEntry[] {
  return [...entries].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

function markVoiceTranscriptLandedLocal(
  sessionId: string,
  text?: string | null,
  replaceAggregate = false,
  explicitGeneration?: number,
  entryId?: string,
  markerIds?: string[],
  markerEntries?: LandingEntry[],
  markedAt?: number,
  entrySeq?: number
): void {
  const current = voiceTranscriptLandedSignal.value;
  const hadLiveLanding = current.has(sessionId);
  const next = new Map(current);
  // An explicit (marker-derived) generation is authoritative but never
  // regresses below one already observed locally.
  const generation =
    explicitGeneration !== undefined
      ? Math.max(current.get(sessionId) ?? 0, explicitGeneration)
      : (current.get(sessionId) ?? 0) + 1;
  next.set(sessionId, generation);
  voiceTranscriptLandedSignal.value = next;
  // A hydrated/received marker carries its OWN wall clock: stamping "now"
  // would keep a near-expiry marker's local landing alive almost a full TTL
  // past its persisted expiry, disagreeing with storage-side pruning and
  // aggregating a stale transcript into later landings of the same session.
  landingMarkedAt.set(sessionId, markedAt ?? Date.now());
  if (typeof text === 'string') {
    // Record the per-entry (id, text) pair at the same granularity the marker
    // merges at — a fresh landing appends; a hydration replaces wholesale.
    // The record's id (explicit or synthetic) also joins the announced-id set:
    // consumeMarker matches identity by id, and a synthetic id missing from
    // the set would let a tab re-append its OWN earlier entry.
    const record: LandingEntry = {
      id: entryId ?? `synthetic-${++syntheticEntryCounter}`,
      text,
      ...(entrySeq !== undefined ? { seq: entrySeq } : {}),
    };
    const fresh = hadLiveLanding && !replaceAggregate;
    const prevEntries = fresh ? (landingEntries.get(sessionId) ?? []) : [];
    const ordered = orderLandingEntries([...prevEntries, record]);
    recordEntryEvictions(sessionId, ordered);
    const bounded = ordered.slice(-MAX_ENTRIES);
    landingEntries.set(sessionId, bounded);
    // The entries are the authoritative aggregate granularity — derive the
    // text and the announced-id set from the RETAINED entries (older ids fill
    // the remaining slots), so the marker's bounded fields always describe
    // the same set in the same order.
    landingTexts.set(
      sessionId,
      bounded.reduce((acc, e) => appendDraftText(acc, e.text), '')
    );
    const retainedIds = bounded.map((e) => e.id);
    const fillIds = [
      ...new Set([...(fresh ? (landingIds.get(sessionId) ?? []) : []), record.id]),
    ].filter((id) => !retainedIds.includes(id));
    const room = Math.max(0, MAX_ENTRIES - retainedIds.length);
    landingIds.set(sessionId, [...retainedIds, ...fillIds.slice(-room)]);
  }
  if (entryId !== undefined) {
    // Accumulate the announced id alongside the aggregate text (bounded to the
    // outbox cap — the sequence can announce at most that many entries).
    // DEDUPE: the record block above already inserted a text-bearing entry's
    // id, and appending it again would evict the oldest announced id at the
    // cap while all its records remain — a delayed ack for that entry would
    // then look unannounced and mint a false landing.
    const prevIds = hadLiveLanding ? (landingIds.get(sessionId) ?? []) : [];
    landingIds.set(sessionId, [...new Set([...prevIds, entryId])].slice(-MAX_ENTRIES));
  } else if (replaceAggregate) {
    // A hydrated marker replaces the local id set wholesale — it is the
    // authoritative sequence from the writing tab.
    landingIds.set(sessionId, (markerIds ?? []).slice(-MAX_ENTRIES));
    if (markerEntries) {
      landingEntries.set(sessionId, orderLandingEntries(markerEntries).slice(-MAX_ENTRIES));
    }
  }
}

/**
 * The EFFECTIVE landing generation for `sessionId`: the process-local signal
 * when this tab knows the landing, otherwise the persisted marker's counter
 * (this tab may not have processed the marker's `storage` event yet — writing
 * a backup as generation 0 in that window would orphan it: a later
 * generation-matched consumption could never retire it, leaving it restorable
 * over text the user already sent or cleared).
 */
export function getLandingGeneration(sessionId: string): number | undefined {
  const local = voiceTranscriptLandedSignal.value.get(sessionId);
  // Compare BOTH sources and take the NEWEST: another tab can have written a
  // newer marker while this tab's `storage` event is still in flight, and a
  // backup tagged with the stale LOCAL generation would escape the
  // generation-matched retirement of the landing that actually lands.
  // A marker this tab already consumed is done — never revive it.
  try {
    const raw = localStorage.getItem(`${LANDED_PREFIX}${sessionId}`);
    if (raw !== null && consumedMarkers.get(sessionId) !== raw) {
      const marker = parseLandedMarker(raw);
      const persisted = marker?.n;
      if (typeof persisted === 'number' && (local === undefined || persisted > local)) {
        // ADVANCE the local signal to the persisted generation (no aggregate
        // changes — no text): a backup saved against this EFFECTIVE generation
        // must be retired by a consumption carrying the SAME generation. With
        // the signal left behind, a later consume would match the OLD local
        // generation — clearing only an older-generation backup while acking
        // the newer marker as consumed — and the mismatched backup would
        // restore already-sent text through the peek paths after a reload.
        markVoiceTranscriptLandedLocal(
          sessionId,
          undefined,
          false,
          persisted,
          undefined,
          undefined,
          undefined,
          marker?.ts
        );
        return persisted;
      }
    }
  } catch {
    /* storage unavailable — local only */
  }
  return local;
}

/**
 * The AGGREGATE transcript text of `sessionId`'s live landing sequence, if
 * known — from this tab's local marks, or from the shared marker (another
 * tab's landings, or a reload). The marker is retained after consumption, so
 * reconciliation paths that run after the landing is consumed can still
 * recover the text until the TTL prunes it. null when the landing predates
 * markers carrying text.
 */
export function getLandingTranscript(sessionId: string): string | null {
  const local = landingTexts.get(sessionId);
  if (local !== undefined) return local;
  try {
    return parseLandedMarker(localStorage.getItem(`${LANDED_PREFIX}${sessionId}`))?.text ?? null;
  } catch {
    return null;
  }
}

/**
 * The OUTBOX ENTRY IDS whose landing the live (or retained-but-consumed)
 * sequence announced for `sessionId`, if any are known — from this tab's local
 * marks, or from the shared marker. Used by the flush to decide whether a
 * DEDUPED ack's landing was already announced elsewhere.
 */
export function getAnnouncedEntryIds(sessionId: string): string[] {
  const local = landingIds.get(sessionId);
  if (local !== undefined) return local;
  try {
    return parseLandedMarker(localStorage.getItem(`${LANDED_PREFIX}${sessionId}`))?.ids ?? [];
  } catch {
    return [];
  }
}

/**
 * Parse a landed marker value; null when absent or from an unknown format.
 * `n` is the persisted generation counter — the process-local signal is
 * rehydrated from it so generations (and the draft-backup retirement keyed by
 * them) survive reloads.
 */
function parseLandedMarker(raw: string | null): {
  ts: number;
  n: number;
  text: string | null;
  ids: string[];
  entries: LandingEntry[];
} | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      ts?: unknown;
      n?: unknown;
      text?: unknown;
      ids?: unknown;
      entries?: unknown;
    };
    if (typeof parsed.ts !== 'number') return null;
    const entries: LandingEntry[] = Array.isArray(parsed.entries)
      ? parsed.entries
          .filter(
            (e): e is { id: string; text: string; seq?: unknown } =>
              !!e &&
              typeof (e as LandingEntry).id === 'string' &&
              typeof (e as LandingEntry).text === 'string'
          )
          .map((e) => ({
            id: e.id,
            text: e.text,
            ...(typeof e.seq === 'number' ? { seq: e.seq } : {}),
          }))
      : [];
    // Derived for compatibility with readers of the aggregate form.
    let text: string | null = typeof parsed.text === 'string' ? parsed.text : null;
    if (text === null && entries.length > 0) {
      text = entries.reduce((acc, e) => appendDraftText(acc, e.text), '');
    }
    let ids: string[] = Array.isArray(parsed.ids)
      ? parsed.ids.filter((id): id is string => typeof id === 'string')
      : [];
    if (ids.length === 0 && entries.length > 0) ids = entries.map((e) => e.id);
    return {
      ts: parsed.ts,
      n: typeof parsed.n === 'number' ? parsed.n : 0,
      text,
      ids,
      entries,
    };
  } catch {
    return null;
  }
}

/**
 * Drop a session from the LOCAL landing map (no localStorage write). Used when
 * another tab pruned the shared marker (TTL expired): an expired landing must
 * not keep this tab's save-suppression active forever. The caller guards
 * against concurrent fresh landings before invoking.
 */
function dropLocalLanding(sessionId: string): void {
  const current = voiceTranscriptLandedSignal.value;
  if (!current.has(sessionId)) return;
  const next = new Map(current);
  next.delete(sessionId);
  voiceTranscriptLandedSignal.value = next;
  landingTexts.delete(sessionId);
  landingIds.delete(sessionId);
  landingEntries.delete(sessionId);
}

/**
 * Forget the landing of generation `generation` once its session's composer
 * has refreshed for it — but only if no NEWER landing arrived meanwhile (the
 * count is unchanged), so a landing that landed mid-refresh keeps its own
 * pending refresh. The cross-tab landed MARKER and the draft BACKUP are
 * deliberately KEPT (TTL prunes them): consumption is local to this tab, so a
 * later tab must still be able to hydrate the marker, and another tab's own
 * draft backup must not be erased by this tab's consumption.
 */
export function consumeVoiceTranscriptLanded(
  sessionId: string,
  generation: number,
  keepBackup = false
): void {
  const current = voiceTranscriptLandedSignal.value;
  if (current.get(sessionId) !== generation) return; // a newer landing arrived
  const next = new Map(current);
  next.delete(sessionId);
  voiceTranscriptLandedSignal.value = next;
  // Per-tab acknowledgement of the shared marker we consumed (see
  // isLandingLive): the marker is deliberately KEPT for other tabs, but THIS
  // tab must not treat the very marker it consumed as a live landing again.
  try {
    const raw = localStorage.getItem(`${LANDED_PREFIX}${sessionId}`);
    if (raw !== null) consumedMarkers.set(sessionId, raw);
  } catch {
    /* storage unavailable — no marker, nothing to acknowledge */
  }
  // Retire the backup created for THIS landing: a reload must show the
  // freshly-merged transcript, not the text the user already sent/cleared.
  // `keepBackup` defers that retirement to the caller — a reconciliation
  // that folded the backup into the composer signal persists the combined
  // text only through a LATER debounced save, and deleting the durable copy
  // at consumption would lose the user's edits to a reload or crash inside
  // that window.
  if (!keepBackup) clearDraftBackup(sessionId, generation);
}

/**
 * The raw marker value each session's landing was consumed against. Kept per
 * tab (not persisted): consumption is local, so only this tab needs to know
 * that exact marker is done. A DIFFERENT (newer) marker value means a fresh
 * landing arrived and is live again.
 */
const consumedMarkers = new Map<string, string>();

const DRAFT_BACKUP_TTL_MS = 24 * 60 * 60 * 1000;

// Draft backups and clear tombstones are TAB-OWNED: each tab defers its own
// evolving edits / owed clears under `${prefix}${sessionId}.${tabId}`. A
// single shared key let one tab's landing consumption retire ANOTHER tab's
// deferred backup or owed clear (consumption is local, but the keys were not)
// — the editing tab kept suppressing server saves while its only durable copy
// was deleted, or its clear intent vanished so a retained backup resurrected
// text the user had sent. The tab id lives in sessionStorage: isolated per
// browser tab, yet STABLE ACROSS RELOADS of the same tab — exactly the
// ownership the reload-survival of these records requires.
/** Resolve this context's tab id (exported for the clone-detection tests). */
export function readTabId(): string {
  let stored: string | null = null;
  try {
    stored = sessionStorage.getItem('hyperneo_tab_id');
  } catch {
    // sessionStorage unavailable (tests without a stub) — an ephemeral id
    // still keeps this module instance's records distinct from others'.
    return generateUUID();
  }
  if (!stored) {
    const id = generateUUID();
    try {
      sessionStorage.setItem('hyperneo_tab_id', id);
    } catch {
      /* best-effort persistence */
    }
    return id;
  }
  // CLONED-TAB detection: duplicating a tab (or opening through an opener
  // that retains it) initializes the copy's sessionStorage from the source,
  // so both contexts would share the stored id and "tab-owned" keys would
  // collide — divergent drafts overwrite each other and one context's
  // consumption removes the other's only durable copy. A heartbeat marks the
  // id LIVE while its owner runs: a fresh heartbeat at startup means the id
  // belongs to a still-running context, so this one mints a new id. An
  // ordinary reload finds no heartbeat (the previous context removed it on
  // pagehide), preserving identity across reloads; a hard crash's heartbeat
  // goes stale within the freshness window, so only a restart within seconds
  // of a crash mints a new id.
  try {
    const raw = localStorage.getItem(`hyperneo_tab_heartbeat.${stored}`);
    const beat = raw === null ? 0 : Number(raw);
    if (Number.isFinite(beat) && Date.now() - beat < TAB_HEARTBEAT_FRESH_MS) {
      const id = generateUUID();
      sessionStorage.setItem('hyperneo_tab_id', id);
      return id;
    }
  } catch {
    /* storage unavailable — keep the stored id */
  }
  return stored;
}

// Generous freshness: background tabs throttle timers to ~1/minute, so a
// short window would call a still-live source tab dead and hand its id to a
// duplicate. visibilitychange/pageshow/resume refreshes cover the exact
// duplication moment (the source hides or resumes as the clone opens).
const TAB_HEARTBEAT_FRESH_MS = 90_000;
const TAB_HEARTBEAT_INTERVAL_MS = 2000;

const TAB_ID = readTabId();

// Mark this tab id LIVE while this context runs, so a cloned copy of it
// detects the collision and mints its own id. Removed on pagehide so an
// ordinary reload immediately reclaims the identity. `stopTabHeartbeat` is
// hoisted so Vite HMR disposal can tear the interval and lifecycle listeners
// down with the module — otherwise every hot re-eval leaks another timer set
// and its fresh heartbeat makes the replacement module mint a new TAB_ID.
let stopTabHeartbeat: (() => void) | null = null;
try {
  const heartbeatKey = `hyperneo_tab_heartbeat.${TAB_ID}`;
  const beat = () => {
    try {
      localStorage.setItem(heartbeatKey, String(Date.now()));
    } catch {
      /* best-effort liveness */
    }
  };
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  const startHeartbeat = () => {
    if (heartbeatTimer !== null) return;
    beat();
    heartbeatTimer = setInterval(beat, TAB_HEARTBEAT_INTERVAL_MS);
    // pagehide tears the heartbeat down (an ordinary reload reclaims the id
    // immediately); re-arm on the NEXT pageshow, including a BFCache restore
    // of this same context — the once-listener is gone after its first fire,
    // and a restored live tab must keep proving its liveness or a duplicate
    // made later would inherit its id.
    window.addEventListener('pagehide', stopHeartbeat, { once: true });
  };
  const onVisibilityChange = () => beat();
  const onPageShow = (event: Event) => {
    beat();
    if ((event as PageTransitionEvent).persisted) startHeartbeat();
  };
  const onResume = () => beat();
  // Stop the heartbeat STATE only (interval + storage key): pagehide fires
  // this when the document enters the back-forward cache, and the pageshow
  // listener must SURVIVE so the restored page re-arms — tearing it down here
  // would let the 90s freshness window lapse and hand a duplicate of the
  // still-live tab its session-storage tab id.
  const stopHeartbeat = () => {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    try {
      localStorage.removeItem(heartbeatKey);
    } catch {
      /* best-effort */
    }
  };
  // Full teardown for HMR disposal: also removes the lifecycle listeners — a
  // bare state stop leaves the callbacks registered, and a later BFCache
  // pageshow would re-arm the OLD module's interval alongside its
  // hot-replacement's, accumulating heartbeat timers and storage writes.
  const disposeHeartbeat = () => {
    stopHeartbeat();
    window.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('pageshow', onPageShow);
    window.removeEventListener('resume', onResume);
  };
  // Timer throttling makes the interval unreliable in background tabs;
  // lifecycle transitions refresh the beat exactly when a clone is likely
  // being created (this tab hiding or resuming).
  window.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pageshow', onPageShow);
  window.addEventListener('resume', onResume);
  startHeartbeat();
  stopTabHeartbeat = disposeHeartbeat;
} catch {
  /* storage unavailable — clone detection degrades to the stored id */
}

// Deterministic per-tab offset that breaks same-millisecond generation ties
// between concurrently-landing tabs (hash of the tab id; 0 collides only with
// itself, and a tab cannot race itself on the single-threaded event loop).
const TAB_SEQ_OFFSET = (() => {
  let hash = 0;
  for (let i = 0; i < TAB_ID.length; i++) hash = (hash * 31 + TAB_ID.charCodeAt(i)) % 997;
  return hash;
})();

function draftBackupKey(sessionId: string): string {
  return `${DRAFT_BACKUP_PREFIX}${sessionId}.${TAB_ID}`;
}

/** A draft backup located in storage, including the exact key it lives under. */
export interface DraftBackupClaim {
  key: string;
  content: string;
  generation: number;
  ts: number;
}

// A committed backup reconciliation: the freshest claim of `generation` was
// durably persisted (server merge or composer fold), so same-generation
// backups written BEFORE this timestamp are SUPERSEDED — their edits lost the
// last-writer-wins race and must not be restored later. Same-generation
// backups written AFTER it are a still-active tab's newer edits and survive.
// Superseded keys are SKIPPED on read (not deleted — deleting would cross the
// tab-ownership boundary and could destroy a live tab's only durable copy);
// the TTL prunes them.
const SUPERSEDED_PREFIX = 'hyperneo_voice_transcript_outbox_v1.superseded.';

/**
 * EVERY supersede record for `sessionId` (the full boundary list, not one
 * selected record). Records are written under content-derived keys
 * (`${prefix}${sessionId}.${generation}.${beforeTs}`) so two tabs
 * acknowledging claims concurrently can both read "no marker" and write their
 * own without a weaker last write un-superseding a stronger one. Because
 * suppression depends on BOTH fields, the boundaries are NON-DOMINATED IN
 * COMBINATION: a lower-generation record can carry a LATER timestamp than a
 * higher-generation one (an older-generation tab whose reconciliation
 * committed last), and selecting a single lexicographic maximum would drop
 * its region — readers must test every record.
 */
function readSuperseded(sessionId: string): Array<{ generation: number; beforeTs: number }> {
  const records: Array<{ generation: number; beforeTs: number }> = [];
  try {
    const prefix = `${SUPERSEDED_PREFIX}${sessionId}`;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      // Exact match (legacy single record) or a '.'-delimited record key —
      // a bare prefix match would leak session `s1` into `s10`'s reads.
      if (!key || !key.startsWith(prefix)) continue;
      if (key.length > prefix.length && key[prefix.length] !== '.') continue;
      const parsed = JSON.parse(localStorage.getItem(key) ?? 'null') as {
        generation?: unknown;
        beforeTs?: unknown;
      } | null;
      if (!parsed || typeof parsed.generation !== 'number' || typeof parsed.beforeTs !== 'number') {
        continue;
      }
      records.push({ generation: parsed.generation, beforeTs: parsed.beforeTs });
    }
  } catch {
    return records;
  }
  return records;
}

/**
 * Scan every TAB-OWNED backup key for `sessionId` and return the FRESHEST
 * in-TTL, not-yet-superseded claim (the delimiter terminates the session id,
 * so `s1` never matches `s10`'s keys). null when none exists. Does NOT remove
 * anything — the caller retires the exact `key` once the content is durably
 * persisted or folded.
 */
/** The given OWNER's fresh clear-tombstone timestamp, or null when none. */
function ownerClearTombstoneTs(sessionId: string, owner: string): number | null {
  try {
    const raw = localStorage.getItem(`${CLEAR_TOMBSTONE_PREFIX}${sessionId}.${owner}`);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as { ts?: number } | null;
    if (!parsed || typeof parsed.ts !== 'number') return null;
    if (Date.now() - parsed.ts >= DRAFT_BACKUP_TTL_MS) return null;
    return parsed.ts;
  } catch {
    return null;
  }
}

function freshestDraftBackup(sessionId: string): DraftBackupClaim | null {
  // THIS TAB's own backup is preferred whenever it is valid: a foreign tab's
  // record can carry a newer timestamp, but restoring it while this tab's own
  // key holds different edits would retire the wrong copy on reconciliation —
  // an abandoned foreign record is recovered only when this tab has none.
  let ownClaim: DraftBackupClaim | null = null;
  let foreignFreshest: DraftBackupClaim | null = null;
  // EVERY boundary participates: suppression is a per-record test (see
  // readSuperseded) — a backup is superseded when ANY record's generation is
  // at least its own AND the record's timestamp boundary covers its write.
  const superseded = readSuperseded(sessionId);
  try {
    const staleKeys: string[] = [];
    const prefix = `${DRAFT_BACKUP_PREFIX}${sessionId}.`;
    const ownKey = draftBackupKey(sessionId);
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(prefix)) continue;
      const parsed = JSON.parse(localStorage.getItem(key) ?? 'null') as {
        content?: unknown;
        ts?: unknown;
        generation?: unknown;
      } | null;
      if (!parsed || typeof parsed.content !== 'string') continue;
      const ts = typeof parsed.ts === 'number' ? parsed.ts : 0;
      if (Date.now() - ts >= DRAFT_BACKUP_TTL_MS) {
        staleKeys.push(key);
        continue;
      }
      const generation = typeof parsed.generation === 'number' ? parsed.generation : 0;
      if (
        superseded.some(
          (record) =>
            generation <= record.generation &&
            // The TIMESTAMP boundary applies to older generations too: a tab
            // that has not yet processed the newer marker's storage event can
            // still be editing and write a FRESH backup tagged with its older
            // local generation — suppressing it by generation alone would
            // strand and eventually prune those newer edits.
            ts <= record.beforeTs
        )
      ) {
        continue; // superseded by a committed reconciliation — never restorable
      }
      // Skip backups whose OWNER durably recorded a clear: that tab sent or
      // deleted this text before it closed, and restoring it would resurrect
      // what the user already cleared. The tombstone is keyed by the same
      // owner suffix as the backup key, so a foreign owner's intent is
      // honored even though only THIS tab's tombstone is ever re-armed here.
      // The owner's clear suppresses only backups written BEFORE it: the
      // user can have kept typing after clearing, and those newer writes are
      // live edits that must stay restorable for the tombstone's whole TTL.
      const owner = key.slice(key.lastIndexOf('.') + 1);
      const clearedAt = ownerClearTombstoneTs(sessionId, owner);
      if (clearedAt !== null && ts <= clearedAt) continue;
      const claim: DraftBackupClaim = { key, content: parsed.content, generation, ts };
      if (key === ownKey) {
        ownClaim = claim;
      } else if (!foreignFreshest || ts >= foreignFreshest.ts) {
        foreignFreshest = claim;
      }
    }
    for (const key of staleKeys) localStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
  return ownClaim ?? foreignFreshest;
}

/**
 * Persist the evolving local draft for a session whose landing is deferred
 * (the composer has text, so its server saves are suppressed to protect the
 * landed transcript). A reload or session switch then restores the user's
 * edits instead of losing them, while the server draft keeps the transcript.
 * The landing GENERATION is stored so a reconciliation retires exactly the
 * backup for the landing it merged — not a newer one. Written under THIS
 * tab's key, so another tab's consumption or retirement cannot drop it.
 */
export function saveDraftBackup(sessionId: string, content: string, generation: number): boolean {
  try {
    localStorage.setItem(
      draftBackupKey(sessionId),
      JSON.stringify({ content, ts: Date.now(), generation })
    );
    return true;
  } catch {
    /* backup best-effort — the caller falls back to the normal save */
    return false;
  }
}

/**
 * Whether a landing is currently LIVE for `sessionId` — either marked in this
 * tab's process-local signal, or a fresh cross-tab marker in storage.
 */
export function isLandingLive(sessionId: string): boolean {
  if (voiceTranscriptLandedSignal.value.has(sessionId)) {
    const markedAt = landingMarkedAt.get(sessionId);
    // No timestamp = a manually-set/test landing (always live); production
    // marks always set one, so a landing aged past the marker TTL here is dead
    // and dropped, lifting the save-suppression (a fresh marker re-marks).
    if (markedAt === undefined || Date.now() - markedAt < MAX_AGE_MS) return true;
    dropLocalLanding(sessionId);
  }
  try {
    const raw = localStorage.getItem(`${LANDED_PREFIX}${sessionId}`);
    if (!raw) return false;
    const marker = parseLandedMarker(raw);
    if (!marker || Date.now() - marker.ts >= MAX_AGE_MS) return false;
    // This tab already consumed THIS exact marker — it is done here. A
    // different value is a NEWER landing (the counter increments per write),
    // which is live; drop the stale acknowledgement while at it.
    if (consumedMarkers.get(sessionId) === raw) return false;
    if (consumedMarkers.has(sessionId)) consumedMarkers.delete(sessionId);
    return true;
  } catch {
    return false;
  }
}

export function getDraftBackup(sessionId: string): string | null {
  const claim = freshestDraftBackup(sessionId);
  if (!claim) return null;
  // Restore only while the landing is still live: an EXPIRED landing no
  // longer suppresses saves, so restoring the backup would let the normal
  // debounce overwrite the freshly-merged transcript.
  if (!isLandingLive(sessionId)) return null;
  return claim.content;
}

/**
 * Remove THIS TAB's draft backup for `sessionId`. When `generation` is given,
 * only a backup created for that exact landing generation is retired. Only
 * ever touches this tab's own key: consumption and retirement are local, and
 * another tab's deferred edits under its own key must survive them — their
 * tab retires its backup when IT consumes or pushes the content.
 */
export function clearDraftBackup(sessionId: string, generation?: number): void {
  removeDraftBackupKey(draftBackupKey(sessionId), generation);
}

/**
 * Retire the exact backup key a caller claimed (any tab's — the caller
 * persisted or folded that content, so the durable copy is superseded). When
 * `generation` is given, the stored generation must still match: a NEWER
 * landing can have rewritten the backup while the claim was in flight. When
 * `expectedTs` is also given, the stored timestamp must match too — the same
 * tab can have RESUMED editing during the claim and rewritten this key with
 * newer content under the SAME generation; deleting that copy would lose
 * still-suppressed edits that never reached the daemon.
 */
export function removeDraftBackupKey(key: string, generation?: number, expectedTs?: number): void {
  try {
    if (generation !== undefined || expectedTs !== undefined) {
      const parsed = JSON.parse(localStorage.getItem(key) ?? 'null') as {
        generation?: number;
        ts?: number;
      } | null;
      if (generation !== undefined && parsed?.generation !== generation) return;
      if (expectedTs !== undefined && parsed?.ts !== expectedTs) return;
    }
    localStorage.removeItem(key);
  } catch {
    /* backup best-effort */
  }
}

/**
 * Retire a claimed backup whose content just became durable (persisted to the
 * server draft, or folded into a composer with saves enabled) and record the
 * SUPERSEDE point: same-generation backups written at or before the claim's
 * timestamp are older edits of the same deferral window and must never be
 * restored over the committed content. The superseded keys themselves are NOT
 * deleted — equal generations do not mean identical content (both tabs can
 * edit independently), and deleting another still-active tab's only durable
 * copy while it suppresses server saves would lose that tab's draft on a
 * crash. Instead they are skipped by future claim scans; the TTL prunes them.
 */
export function retireDraftBackupClaim(claim: {
  key: string;
  generation: number;
  ts: number;
}): void {
  removeDraftBackupKey(claim.key, claim.generation, claim.ts);
  try {
    const sessionId = claim.key.slice(DRAFT_BACKUP_PREFIX.length, claim.key.lastIndexOf('.'));
    // The record's key is CONTENT-DERIVED (generation + beforeTs): a weaker
    // late acknowledgement writes its own record and can never overwrite a
    // stronger one another tab already wrote — readers select the maximum
    // (see readSuperseded), so the strongest boundary always wins.
    localStorage.setItem(
      `${SUPERSEDED_PREFIX}${sessionId}.${claim.generation}.${claim.ts}`,
      JSON.stringify({ generation: claim.generation, beforeTs: claim.ts })
    );
  } catch {
    /* marker best-effort — the claimed key itself is already retired */
  }
}

/**
 * Read (WITHOUT removing) the draft backup for `sessionId`, bypassing the
 * landing-liveness gate the restore path applies. Used when a landing EXPIRED
 * while the session's saves were suppressed into that backup: the departed
 * session's flush pushes it to the server draft, and the durable copy is
 * retired ONLY after that update is acknowledged — claiming it destructively
 * up front would leave nothing behind when the flush fails on a dropped
 * socket. null when no in-TTL backup exists.
 */
/**
 * Persist that the user cleared/sent the composer while a landing was
 * deferred but the clear-reconcile could not COMMIT (socket down, or the
 * conditional RPC failed). `pendingClearRef` lives only in memory — without
 * this tombstone, a reload before reconnection restores the pre-clear draft
 * backup and resurrects text the user already deleted or sent. Written under
 * THIS tab's key: another tab's owed clear must survive this tab's landing
 * consumption (which retires only its own tombstone). `baselineSeq`, when
 * known, names the voice sequence the reconcile was about to strip, so a
 * retry can recognize a strip that COMMITTED but whose ack was lost.
 */
export function saveClearTombstone(sessionId: string, baselineSeq?: number): boolean {
  try {
    const key = `${CLEAR_TOMBSTONE_PREFIX}${sessionId}.${TAB_ID}`;
    // Re-arming WITHOUT a new sequence must not drop a recorded one: a
    // versioned tombstone (from a lost-ack strip) is strictly stronger, and
    // overwriting it with an unversioned write would leave the committed
    // strip unrecognizable after a reload.
    let seqToWrite = baselineSeq;
    if (seqToWrite === undefined) {
      const existing = JSON.parse(localStorage.getItem(key) ?? 'null') as {
        baselineSeq?: number;
      } | null;
      if (typeof existing?.baselineSeq === 'number') seqToWrite = existing.baselineSeq;
    }
    localStorage.setItem(key, JSON.stringify({ ts: Date.now(), baselineSeq: seqToWrite }));
    return true;
  } catch {
    /* tombstone best-effort — the caller must fall back to a safe state */
    return false;
  }
}

/** The owed clear's record for THIS tab, if one is still within its TTL. */
export function getClearTombstone(sessionId: string): { ts: number; baselineSeq?: number } | null {
  try {
    const raw = localStorage.getItem(`${CLEAR_TOMBSTONE_PREFIX}${sessionId}.${TAB_ID}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { ts?: number; baselineSeq?: number };
    if (typeof parsed.ts !== 'number') return null;
    if (Date.now() - parsed.ts >= DRAFT_BACKUP_TTL_MS) return null;
    return typeof parsed.baselineSeq === 'number'
      ? { ts: parsed.ts, baselineSeq: parsed.baselineSeq }
      : { ts: parsed.ts };
  } catch {
    return null;
  }
}

/** Whether an uncommitted clear is still owed for `sessionId` (TTL-gated). */
export function hasClearTombstone(sessionId: string): boolean {
  return getClearTombstone(sessionId) !== null;
}

/** Drop THIS TAB's tombstone once its clear-reconcile committed server-side. */
export function removeClearTombstone(sessionId: string): void {
  try {
    localStorage.removeItem(`${CLEAR_TOMBSTONE_PREFIX}${sessionId}.${TAB_ID}`);
  } catch {
    /* tombstone best-effort */
  }
}

export function peekExpiredDraftBackup(sessionId: string): DraftBackupClaim | null {
  return freshestDraftBackup(sessionId);
}

const STORAGE_PREFIX = 'hyperneo_voice_transcript_outbox_v1.entry.';
const LANDED_PREFIX = `${STORAGE_PREFIX}landed.`;
const DRAFT_BACKUP_PREFIX = 'hyperneo_voice_transcript_outbox_v1.draft.';
const CLEAR_TOMBSTONE_PREFIX = 'hyperneo_voice_transcript_outbox_v1.clear.';
const MAX_ENTRIES = 20;
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h — a transcript older than this is stale
const FLUSH_DELAY_MS = 500; // let subscriptions settle, like outbound-queue
const RETRY_DELAY_MS = 5_000; // base delay before a retained-entry retry
const MAX_RETRY_DELAY_MS = 60_000; // backoff ceiling for retained-entry retries

/** In-session mirror — always authoritative for THIS session's reads. */
const mirror = new Map<string, PendingTranscript>();

function entryKey(id: string): string {
  return `${STORAGE_PREFIX}${id}`;
}

/** Collect entries from localStorage (each under its own key — no RMW races). */
function collectFromStorage(): Map<string, PendingTranscript> {
  const out = new Map<string, PendingTranscript>();
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(STORAGE_PREFIX)) continue;
      try {
        const entry = JSON.parse(localStorage.getItem(key) ?? '') as PendingTranscript;
        if (entry && typeof entry.id === 'string' && typeof entry.sessionId === 'string') {
          out.set(entry.id, entry);
        }
      } catch {
        /* corrupt entry — skip */
      }
    }
  } catch {
    /* storage unavailable — mirror only */
  }
  return out;
}

function allEntries(): PendingTranscript[] {
  const merged = collectFromStorage();
  // The mirror wins on conflict: it reflects this session's most recent write,
  // including an entry localStorage refused to persist.
  for (const [id, entry] of mirror) merged.set(id, entry);
  return [...merged.values()]
    .filter((e) => Date.now() - (e.createdAt ?? 0) < MAX_AGE_MS)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Whether the entry reached durable storage (false = mirror-only). */
function writeEntry(entry: PendingTranscript): boolean {
  mirror.set(entry.id, entry);
  try {
    localStorage.setItem(entryKey(entry.id), JSON.stringify(entry));
    return true;
  } catch {
    /* storage unavailable/full — the mirror holds the entry for this session */
    return false;
  }
}

function removeEntry(id: string): void {
  mirror.delete(id);
  try {
    localStorage.removeItem(entryKey(id));
  } catch {
    /* mirror already dropped it */
  }
}

/** Enforce the cap (oldest dropped) and clear expired entries. */
function prune(): void {
  pruneExpired();
  // Enforce the cap on the live (non-expired) set, leaving ONE free slot:
  // prune runs immediately before a write, so a near-full localStorage at the
  // cap would otherwise have no room for the new entry and setItem would fail.
  // (This reservation is why startup calls pruneExpired() directly — with no
  // enqueue following, reserving a slot here would delete a still-deliverable
  // transcript merely for reopening the app.)
  const live = allEntries();
  if (live.length < MAX_ENTRIES) return;
  for (const entry of live.slice(0, live.length - (MAX_ENTRIES - 1))) {
    removeEntry(entry.id);
  }
}

/** TTL cleanup only — no capacity reservation; safe outside an enqueue. */
function pruneExpired(): void {
  const now = Date.now();
  const stored = collectFromStorage();
  // Remove TTL-expired keys outright: allEntries() filters them from reads, so
  // without this they would accumulate in localStorage unboundedly despite the
  // entry cap.
  for (const [id, entry] of stored) {
    if (now - (entry.createdAt ?? 0) >= MAX_AGE_MS) removeEntry(id);
  }
  for (const [id, entry] of mirror) {
    if (now - (entry.createdAt ?? 0) >= MAX_AGE_MS) removeEntry(id);
  }
  // Drop stale cross-tab landed markers (older than the TTL) so they cannot
  // accumulate; a fresh landing rewrites its marker. Runs INDEPENDENTLY of
  // entry-cap pruning — a live queue under the cap still returns, but markers
  // from deliveries to never-opened sessions must not linger forever.
  // Collect-then-remove: removing while iterating by index shifts later keys
  // into the current index and silently skips them.
  try {
    const staleMarkers: Array<{ key: string; raw: string | null }> = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(LANDED_PREFIX)) continue;
      const raw = localStorage.getItem(key);
      const marker = parseLandedMarker(raw);
      if (!marker || now - marker.ts >= MAX_AGE_MS) staleMarkers.push({ key, raw });
    }
    for (const { key, raw } of staleMarkers) {
      // COMPARE-AND-DELETE: another tab can write a FRESH landing to the same
      // key between this scan and the removal — deleting it would broadcast a
      // removal event that makes every tab drop its fresh local landing,
      // lifting draft-save suppression over the newly merged transcript.
      let current: string | null = null;
      try {
        current = localStorage.getItem(key);
      } catch {
        current = null;
      }
      if (current !== raw) continue;
      localStorage.removeItem(key);
      // localStorage removals do not emit a `storage` event in the WRITING
      // tab, so this tab's own expired landing state would linger: a later
      // landing for the same session would treat it as a live aggregate
      // prefix and republish "old + new", re-announcing the already-merged
      // old transcript into reconciliations. Drop it here — but only when
      // the LOCAL mark is equally expired (a fresh local mark with a stale
      // marker means the marker write failed; the landing itself is live).
      const sessionId = key.slice(LANDED_PREFIX.length);
      const markedAt = landingMarkedAt.get(sessionId);
      if (markedAt === undefined || now - markedAt >= MAX_AGE_MS) {
        dropLocalLanding(sessionId);
      }
    }
  } catch {
    /* storage unavailable */
  }
  // Drop expired draft backups proactively — a backup whose session is never
  // reopened would otherwise linger past its TTL with nothing to prune it.
  // Same collect-then-remove discipline as the marker scan. Clear tombstones
  // and supersede markers follow the same TTL (their timestamps are wall
  // clocks too).
  try {
    const staleBackupKeys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      const isBackup = key?.startsWith(DRAFT_BACKUP_PREFIX);
      const isTombstone = key?.startsWith(CLEAR_TOMBSTONE_PREFIX);
      const isSuperseded = key?.startsWith(SUPERSEDED_PREFIX);
      if (!key || (!isBackup && !isTombstone && !isSuperseded)) continue;
      const parsed = JSON.parse(localStorage.getItem(key) ?? 'null') as {
        ts?: number;
        beforeTs?: number;
      } | null;
      const stamp = parsed?.ts ?? parsed?.beforeTs ?? 0;
      if (parsed && now - stamp >= DRAFT_BACKUP_TTL_MS) staleBackupKeys.push(key);
    }
    for (const key of staleBackupKeys) localStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

/**
 * The only GENUINELY permanent refusal: the session no longer exists, so no
 * retry can ever merge the transcript. Everything else the daemon can reject
 * while connected (e.g. a pending draft at the character limit — room appears
 * once the user sends or clears it, or a `Request timeout` whose append may
 * have committed with a lost ack) is retryable and must not be dropped.
 * Shared by the flush (drop only these) and MessageInput's staging fallback
 * (enqueue everything except these).
 */
export function isPermanentAppendRefusal(error: unknown): boolean {
  return error instanceof Error && /Session not found/.test(error.message);
}

/**
 * Park a transcript for delivery once the daemon is reachable again. `id`
 * (optional) is the dedup id used by the INITIAL staging attempt, so when that
 * attempt commits but its ack is lost in a disconnect, the queued retry
 * reuses the same id and the daemon's dedup set skips the double-append.
 * Returns whether the entry reached DURABLE storage: a localStorage failure
 * leaves it only in the in-session mirror, which survives until this page
 * closes — the caller must not promise the user it survives a reload.
 */
export function enqueueTranscript(sessionId: string, text: string, id?: string): boolean {
  // Prune BEFORE writing: dropping an expired/over-cap old entry frees the
  // quota the new entry needs, so a near-full localStorage still persists it
  // instead of leaving it only in the in-session mirror (which a reload loses).
  prune();
  const durable = writeEntry({ id: id ?? generateUUID(), sessionId, text, createdAt: Date.now() });
  // A same-tab enqueue emits no `storage` event and the connection-state
  // effect does not re-run while already connected — so kick the first flush
  // here. The flush's own retained-entry logic then schedules the backoff
  // retries until the transcript is delivered.
  if (connectionState.value === 'connected') {
    setTimeout(() => void flushPendingTranscripts(), FLUSH_DELAY_MS);
  }
  return durable;
}

export function getPendingTranscripts(): PendingTranscript[] {
  // OLDEST-first, with NO batch cap: the flush defers later entries of a
  // session whose older entry was retryably refused (per-session FIFO), so a
  // cap would let one blocked session's batch hide another session's
  // deliverable entry entirely — global head-of-line blocking for up to the
  // 24h TTL. The TTL bounds the live set, and each tab's pre-write prune still
  // caps its OWN stored keys; the only over-cap live sets come from concurrent
  // tabs, and draining them oldest-first preserves the dictate order.
  return allEntries();
}

export function removePendingTranscript(id: string): void {
  removeEntry(id);
}

/** Drop everything (tests / user clear). */
export function clearPendingTranscripts(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(STORAGE_PREFIX)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    /* mirror cleared below */
  }
  mirror.clear();
}

let flushInProgress = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelayMs = RETRY_DELAY_MS;

function clearRetryTimer(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  retryDelayMs = RETRY_DELAY_MS;
}

/**
 * Schedule a follow-up flush for entries retained on a retryable rejection
 * (timeout, character limit). The connection-state effect does not re-fire
 * while already connected, so without this a retained entry would wait for an
 * unrelated reconnect or reload. Backs off exponentially up to a slow steady
 * cadence that continues indefinitely while the entry remains — so a draft
 * that later frees up (the user sends/clears it) is picked up without any
 * external trigger. The TTL bounds the entry's overall lifetime.
 */
function scheduleFollowUpFlush(): void {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void flushPendingTranscripts();
  }, retryDelayMs);
  retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS);
}

/**
 * Replay all outbox entries through `session.appendVoiceDraft`, removing each
 * once the daemon acks (including an idempotent `deduped` ack — the entry
 * already merged). Stops early if the connection drops mid-flush. Only a
 * GENUINELY permanent refusal (session not found) drops an entry; timeouts
 * and other refusals (e.g. a pending draft at the character limit — room
 * appears once the user sends or clears it) are retained and re-flushed with
 * backoff.
 */
export async function flushPendingTranscripts(): Promise<void> {
  if (flushInProgress) return;
  const hub = connectionManager.getHubIfConnected();
  if (!hub) return;
  const pending = getPendingTranscripts();
  if (pending.length === 0) {
    // An expired-but-still-stored entry hides from reads — a long-lived tab
    // never re-runs the startup prune, so clean it here rather than leaving
    // the key in localStorage forever.
    pruneExpired();
    return;
  }

  flushInProgress = true;
  let delivered = 0;
  // Sessions whose older entry was retained on a retryable failure: later
  // entries for the SAME session are deferred this pass so per-session FIFO is
  // preserved (a long older transcript must not be overtaken by a newer short
  // one that fits), while other sessions still proceed.
  const deferredSessions = new Set<string>();
  try {
    for (const entry of pending) {
      if (!connectionManager.getHubIfConnected()) break; // dropped mid-flush
      if (deferredSessions.has(entry.sessionId)) continue;
      try {
        const ack = await hub.request<{ success: boolean; deduped?: boolean; seq?: number }>(
          'session.appendVoiceDraft',
          {
            sessionId: entry.sessionId,
            text: entry.text,
            dedupId: entry.id,
          }
        );
        removePendingTranscript(entry.id);
        delivered += 1;
        // Announcing a landing for an entry that was ALREADY announced (by
        // this tab or another) is wrong: the first announcement may already
        // have been consumed (or its marker aged out past the TTL), and a
        // fresh generation with no staged pending would let a later
        // clear-reconcile resurrect the already-merged transcript. Identity
        // is matched by ENTRY ID against the announced set, REGARDLESS of
        // whether THIS response was the deduplicated one — two tabs flushing
        // the same shared entry race, and the tab whose ack lands LAST (even
        // the original, non-deduped ack) must not re-announce what the other
        // already announced. When the id is not on record (or the marker is
        // gone), this ack is the only signal the transcript merged and the
        // landing must be announced. The ack's `seq` (the ORIGINAL commit's,
        // on a deduped replay) carries the daemon's ordering.
        const alreadyAnnounced = getAnnouncedEntryIds(entry.sessionId).includes(entry.id);
        if (!alreadyAnnounced) {
          markVoiceTranscriptLanded(
            entry.sessionId,
            entry.text,
            entry.id,
            typeof ack?.seq === 'number' ? ack.seq : undefined
          );
        }
      } catch (error) {
        // Socket dropped mid-flush: keep for the next reconnect. Otherwise the
        // daemon answered while connected: a timeout is ambiguous (the append
        // may have committed with a lost ack), and any non-permanent refusal is
        // retryable — keep those. Only a missing session can never recover.
        if (!connectionManager.getHubIfConnected()) break;
        if (isPermanentAppendRefusal(error)) removePendingTranscript(entry.id);
        else deferredSessions.add(entry.sessionId);
      }
    }
  } finally {
    flushInProgress = false;
    // TTL-clean on every pass: a long-lived tab never re-runs the startup
    // prune, and an entry that ages past the TTL mid-retry would otherwise
    // leave its key in localStorage forever (reads filter it, so nothing else
    // would remove it).
    pruneExpired();
  }
  // Retained entries (timeout / retryable refusal) need another pass; the
  // connection-state effect won't re-fire while already connected, and no
  // storage change marks the session when its draft later frees up — so keep a
  // slow periodic retry going (bounded by the TTL) instead of a hard stop.
  if (delivered > 0) retryDelayMs = RETRY_DELAY_MS; // progress re-arms a fast first retry
  if (getPendingTranscripts().length > 0 && connectionManager.getHubIfConnected()) {
    scheduleFollowUpFlush();
  } else {
    clearRetryTimer();
  }
}

let cleanupAutoFlush: (() => void) | null = null;
let cleanupStorageListener: (() => void) | null = null;

/**
 * Cross-tab coordination via the `storage` event (fires in OTHER tabs when
 * this tab writes localStorage, and vice versa):
 * - an entry key was written/removed by another tab → that tab's disconnected
 *   enqueue is now visible here — schedule a flush while this tab is connected
 * - a landed marker appeared (another tab's flush succeeded) → add the session
 *   to the landed set so THIS tab's mounted composer refreshes its draft
 */
function handleStorageEvent(event: StorageEvent): void {
  const key = event.key;
  if (!key) return; // localStorage.clear()
  if (key.startsWith(STORAGE_PREFIX) && !key.startsWith(LANDED_PREFIX)) {
    if (event.newValue === null) {
      // Another tab flushed this shared entry and removed its key — drop the
      // local mirror too, or allEntries() (where the mirror wins on conflict)
      // would resurrect the entry here and replay an already-delivered id as
      // a false landing.
      mirror.delete(key.slice(STORAGE_PREFIX.length));
    }
    if (connectionState.value === 'connected') {
      setTimeout(() => void flushPendingTranscripts(), FLUSH_DELAY_MS);
    }
  } else if (key.startsWith(LANDED_PREFIX)) {
    const sessionId = key.slice(LANDED_PREFIX.length);
    const marker = parseLandedMarker(event.newValue);
    if (marker) {
      // The marker is the AUTHORITATIVE aggregate from the writing tab —
      // replace, don't append onto this tab's stale local aggregate. Its own
      // `ts` becomes the local mark time so both expiry clocks agree.
      markVoiceTranscriptLandedLocal(
        sessionId,
        marker.text,
        true,
        marker.n,
        undefined,
        marker.ids,
        marker.entries,
        marker.ts
      );
    } else if (event.newValue === null && localStorage.getItem(key) === null) {
      // Another tab pruned the marker (TTL expired) and no fresh marker was
      // written since — clear this tab's local landing so an expired landing
      // does not keep the save-suppression active forever.
      dropLocalLanding(sessionId);
    }
  }
}

/**
 * Load existing LANDED_PREFIX markers into the process-local signal at startup.
 * A transcript delivered before this page loaded has no outbox entry left, so
 * its marker is the ONLY trigger that reconnects a mounted composer to a
 * failed initial load — without this, the listener (which only sees FUTURE
 * events) would leave it unrefreshed.
 */
function hydrateLandedMarkers(): void {
  const now = Date.now();
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(LANDED_PREFIX)) continue;
      const marker = parseLandedMarker(localStorage.getItem(key));
      if (marker && now - marker.ts < MAX_AGE_MS) {
        markVoiceTranscriptLandedLocal(
          key.slice(LANDED_PREFIX.length),
          marker.text,
          true,
          marker.n,
          undefined,
          marker.ids,
          marker.entries,
          marker.ts
        );
      }
    }
  } catch {
    /* storage unavailable */
  }
}

/** Flush when the connection (re)establishes. Mirrors outbound-queue. */
export function startVoiceTranscriptOutboxFlush(): void {
  if (cleanupAutoFlush) return;
  // TTL-clean at startup: expired entries, landed markers, and draft backups
  // are filtered from READS anyway, but if the app reopens after >24h and no
  // new transcript is ever enqueued, nothing else would delete their keys.
  // pruneExpired only — the capacity RESERVATION in prune() assumes an
  // enqueue follows and would otherwise drop a still-deliverable transcript
  // merely for reopening the app at the cap.
  pruneExpired();
  hydrateLandedMarkers();
  window.addEventListener('storage', handleStorageEvent);
  cleanupStorageListener = () => window.removeEventListener('storage', handleStorageEvent);
  cleanupAutoFlush = effect(() => {
    if (connectionState.value === 'connected' && getPendingTranscripts().length > 0) {
      setTimeout(() => void flushPendingTranscripts(), FLUSH_DELAY_MS);
    }
  });
}

export function stopVoiceTranscriptOutboxFlush(): void {
  clearRetryTimer();
  if (cleanupAutoFlush) {
    cleanupAutoFlush();
    cleanupAutoFlush = null;
  }
  if (cleanupStorageListener) {
    cleanupStorageListener();
    cleanupStorageListener = null;
  }
}

// HMR cleanup: tear down the old effect subscription before module re-eval.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (cleanupAutoFlush) {
      cleanupAutoFlush();
      cleanupAutoFlush = null;
    }
    if (cleanupStorageListener) {
      cleanupStorageListener();
      cleanupStorageListener = null;
    }
    if (stopTabHeartbeat) {
      stopTabHeartbeat();
      stopTabHeartbeat = null;
    }
    clearRetryTimer();
    clearMarkerVerifications();
  });
}

/** For tests: reset module state. */
export function resetVoiceTranscriptOutbox(): void {
  flushInProgress = false;
  clearRetryTimer();
  clearMarkerVerifications();
  clearPendingTranscripts();
  voiceTranscriptLandedSignal.value = new Map();
  landingMarkedAt.clear();
  landingTexts.clear();
  landingIds.clear();
  landingEntries.clear();
  evictedEntryIds.clear();
  consumedMarkers.clear();
}
