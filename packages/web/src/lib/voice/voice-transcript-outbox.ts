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

export function markVoiceTranscriptLanded(sessionId: string, text?: string): void {
  // The GENERATION is the marker's persisted counter (not a process-local
  // count): a reload rehydrates the same generation from the marker, so a
  // draft backup saved as generation N is still retired by exactly the
  // consumption of generation N instead of being orphaned by a restarted
  // counter.
  let seq = 1;
  try {
    const existing = parseLandedMarker(localStorage.getItem(`${LANDED_PREFIX}${sessionId}`));
    if (existing) seq = existing.n + 1;
  } catch {
    /* storage unavailable — start a fresh sequence */
  }
  markVoiceTranscriptLandedLocal(sessionId, text, false, seq);
  try {
    // Timestamp + monotonic counter so two landings within the same Date.now()
    // tick still change the value — a same-value write would not emit a
    // storage event in other tabs, which would then never learn of the second.
    // The marker carries the AGGREGATE text of the live landing sequence (see
    // markVoiceTranscriptLandedLocal).
    localStorage.setItem(
      `${LANDED_PREFIX}${sessionId}`,
      JSON.stringify({
        v: 1,
        ts: Date.now(),
        n: seq,
        text: landingTexts.get(sessionId) ?? null,
      })
    );
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

function markVoiceTranscriptLandedLocal(
  sessionId: string,
  text?: string | null,
  replaceAggregate = false,
  explicitGeneration?: number
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
  landingMarkedAt.set(sessionId, Date.now());
  if (typeof text === 'string') {
    // A fresh landing APPENDS onto the live sequence's aggregate; a hydrated
    // cross-tab marker REPLACES it — the marker is the authoritative aggregate
    // from the tab that performed the landings.
    const prev = hadLiveLanding && !replaceAggregate ? (landingTexts.get(sessionId) ?? '') : '';
    landingTexts.set(sessionId, prev ? appendDraftText(prev, text) : text);
  }
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
 * Parse a landed marker value; null when absent or from an unknown format.
 * `n` is the persisted generation counter — the process-local signal is
 * rehydrated from it so generations (and the draft-backup retirement keyed by
 * them) survive reloads.
 */
function parseLandedMarker(raw: string | null): {
  ts: number;
  n: number;
  text: string | null;
} | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { ts?: unknown; n?: unknown; text?: unknown };
    if (typeof parsed.ts !== 'number') return null;
    return {
      ts: parsed.ts,
      n: typeof parsed.n === 'number' ? parsed.n : 0,
      text: typeof parsed.text === 'string' ? parsed.text : null,
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
export function consumeVoiceTranscriptLanded(sessionId: string, generation: number): void {
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
  clearDraftBackup(sessionId, generation);
}

/**
 * The raw marker value each session's landing was consumed against. Kept per
 * tab (not persisted): consumption is local, so only this tab needs to know
 * that exact marker is done. A DIFFERENT (newer) marker value means a fresh
 * landing arrived and is live again.
 */
const consumedMarkers = new Map<string, string>();

const DRAFT_BACKUP_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Persist the evolving local draft for a session whose landing is deferred
 * (the composer has text, so its server saves are suppressed to protect the
 * landed transcript). A reload or session switch then restores the user's
 * edits instead of losing them, while the server draft keeps the transcript.
 * The landing GENERATION is stored so a reconciliation retires exactly the
 * backup for the landing it merged — not a newer one.
 */
export function saveDraftBackup(sessionId: string, content: string, generation: number): void {
  try {
    localStorage.setItem(
      `${DRAFT_BACKUP_PREFIX}${sessionId}`,
      JSON.stringify({ content, ts: Date.now(), generation })
    );
  } catch {
    /* backup best-effort */
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
  try {
    const raw = localStorage.getItem(`${DRAFT_BACKUP_PREFIX}${sessionId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { content?: string; ts?: number };
    if (typeof parsed.content !== 'string') return null;
    if (Date.now() - (parsed.ts ?? 0) >= DRAFT_BACKUP_TTL_MS) {
      localStorage.removeItem(`${DRAFT_BACKUP_PREFIX}${sessionId}`);
      return null;
    }
    // Restore only while the landing is still live: an EXPIRED landing no
    // longer suppresses saves, so restoring the backup would let the normal
    // debounce overwrite the freshly-merged transcript.
    if (!isLandingLive(sessionId)) return null;
    return parsed.content;
  } catch {
    return null;
  }
}

/**
 * Remove the draft backup for `sessionId`. When `generation` is given, only a
 * backup created for that exact landing generation is retired — a backup from
 * a NEWER (or another tab's) landing is preserved.
 */
export function clearDraftBackup(sessionId: string, generation?: number): void {
  try {
    const key = `${DRAFT_BACKUP_PREFIX}${sessionId}`;
    if (generation !== undefined) {
      const parsed = JSON.parse(localStorage.getItem(key) ?? 'null') as {
        generation?: number;
      } | null;
      if (parsed?.generation !== generation) return;
    }
    localStorage.removeItem(key);
  } catch {
    /* backup best-effort */
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
 * backup and resurrects text the user already deleted or sent.
 */
export function saveClearTombstone(sessionId: string): void {
  try {
    localStorage.setItem(
      `${CLEAR_TOMBSTONE_PREFIX}${sessionId}`,
      JSON.stringify({ ts: Date.now() })
    );
  } catch {
    /* tombstone best-effort */
  }
}

/** Whether an uncommitted clear is still owed for `sessionId` (TTL-gated). */
export function hasClearTombstone(sessionId: string): boolean {
  try {
    const raw = localStorage.getItem(`${CLEAR_TOMBSTONE_PREFIX}${sessionId}`);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { ts?: number };
    return Date.now() - (parsed.ts ?? 0) < DRAFT_BACKUP_TTL_MS;
  } catch {
    return false;
  }
}

/** Drop the tombstone once the clear-reconcile committed server-side. */
export function removeClearTombstone(sessionId: string): void {
  try {
    localStorage.removeItem(`${CLEAR_TOMBSTONE_PREFIX}${sessionId}`);
  } catch {
    /* tombstone best-effort */
  }
}

export function peekExpiredDraftBackup(
  sessionId: string
): { content: string; generation: number } | null {
  try {
    const raw = localStorage.getItem(`${DRAFT_BACKUP_PREFIX}${sessionId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      content?: string;
      ts?: number;
      generation?: number;
    };
    if (typeof parsed.content !== 'string') return null;
    if (Date.now() - (parsed.ts ?? 0) >= DRAFT_BACKUP_TTL_MS) return null;
    return { content: parsed.content, generation: parsed.generation ?? 0 };
  } catch {
    return null;
  }
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

function writeEntry(entry: PendingTranscript): void {
  mirror.set(entry.id, entry);
  try {
    localStorage.setItem(entryKey(entry.id), JSON.stringify(entry));
  } catch {
    /* storage unavailable/full — the mirror holds the entry for this session */
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
    const staleMarkerKeys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(LANDED_PREFIX)) continue;
      const marker = parseLandedMarker(localStorage.getItem(key));
      if (!marker || now - marker.ts >= MAX_AGE_MS) staleMarkerKeys.push(key);
    }
    for (const key of staleMarkerKeys) localStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
  // Drop expired draft backups proactively — a backup whose session is never
  // reopened would otherwise linger past its TTL with nothing to prune it.
  // Same collect-then-remove discipline as the marker scan. Clear tombstones
  // follow the same TTL.
  try {
    const staleBackupKeys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      const isBackup = key?.startsWith(DRAFT_BACKUP_PREFIX);
      const isTombstone = key?.startsWith(CLEAR_TOMBSTONE_PREFIX);
      if (!key || (!isBackup && !isTombstone)) continue;
      const parsed = JSON.parse(localStorage.getItem(key) ?? 'null') as { ts?: number } | null;
      if (parsed && now - (parsed.ts ?? 0) >= DRAFT_BACKUP_TTL_MS) staleBackupKeys.push(key);
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
 */
export function enqueueTranscript(sessionId: string, text: string, id?: string): void {
  // Prune BEFORE writing: dropping an expired/over-cap old entry frees the
  // quota the new entry needs, so a near-full localStorage still persists it
  // instead of leaving it only in the in-session mirror (which a reload loses).
  prune();
  writeEntry({ id: id ?? generateUUID(), sessionId, text, createdAt: Date.now() });
  // A same-tab enqueue emits no `storage` event and the connection-state
  // effect does not re-run while already connected — so kick the first flush
  // here. The flush's own retained-entry logic then schedules the backoff
  // retries until the transcript is delivered.
  if (connectionState.value === 'connected') {
    setTimeout(() => void flushPendingTranscripts(), FLUSH_DELAY_MS);
  }
}

export function getPendingTranscripts(): PendingTranscript[] {
  return allEntries().slice(-MAX_ENTRIES);
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
  if (pending.length === 0) return;

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
        await hub.request('session.appendVoiceDraft', {
          sessionId: entry.sessionId,
          text: entry.text,
          dedupId: entry.id,
        });
        removePendingTranscript(entry.id);
        delivered += 1;
        markVoiceTranscriptLanded(entry.sessionId, entry.text);
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
      // replace, don't append onto this tab's stale local aggregate.
      markVoiceTranscriptLandedLocal(sessionId, marker.text, true, marker.n);
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
          marker.n
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
    clearRetryTimer();
  });
}

/** For tests: reset module state. */
export function resetVoiceTranscriptOutbox(): void {
  flushInProgress = false;
  clearRetryTimer();
  clearPendingTranscripts();
  voiceTranscriptLandedSignal.value = new Map();
  landingMarkedAt.clear();
  landingTexts.clear();
  consumedMarkers.clear();
}
