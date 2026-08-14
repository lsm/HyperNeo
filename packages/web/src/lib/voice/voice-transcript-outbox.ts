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
import { generateUUID } from '@hyperneo/shared';
import { connectionManager } from '../connection-manager';
import { connectionState } from '../state';

export interface PendingTranscript {
  id: string;
  sessionId: string;
  text: string;
  createdAt: number;
}

/**
 * Sessions for which the outbox landed an entry since the last time a mounted
 * composer refreshed for them — a SET so later landings for other sessions
 * cannot erase a deferred one. A mounted composer for a session in the set
 * refreshes its draft (the pending field is otherwise only merged by the
 * daemon during session.get, which the composer runs only on session change),
 * then consumes its own session via `consumeVoiceTranscriptLanded`.
 */
export const voiceTranscriptLandedSignal = signal<ReadonlySet<string>>(new Set());

/**
 * Record that an entry landed for `sessionId` (called by the flush). The
 * localStorage marker lets OTHER tabs learn of the landing via the `storage`
 * event, since the signal itself is process-local.
 */
export function markVoiceTranscriptLanded(sessionId: string): void {
  voiceTranscriptLandedSignal.value = new Set(voiceTranscriptLandedSignal.value).add(sessionId);
  try {
    localStorage.setItem(`${LANDED_PREFIX}${sessionId}`, String(Date.now()));
  } catch {
    /* mirror-only — this tab still refreshes via the signal */
  }
}

/**
 * Forget a landing once its session's composer has refreshed for it, and drop
 * the cross-tab marker so a later storage event does not resurrect it.
 */
export function consumeVoiceTranscriptLanded(sessionId: string): void {
  const current = voiceTranscriptLandedSignal.value;
  const next = new Set(current);
  next.delete(sessionId);
  voiceTranscriptLandedSignal.value = next;
  try {
    localStorage.removeItem(`${LANDED_PREFIX}${sessionId}`);
  } catch {
    /* marker best-effort */
  }
}

const STORAGE_PREFIX = 'hyperneo_voice_transcript_outbox_v1.entry.';
const LANDED_PREFIX = `${STORAGE_PREFIX}landed.`;
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
  // Enforce the cap on the live (non-expired) set.
  const live = allEntries();
  if (live.length <= MAX_ENTRIES) return;
  for (const entry of live.slice(0, live.length - MAX_ENTRIES)) {
    removeEntry(entry.id);
  }
  // Drop stale cross-tab landed markers (older than the TTL) so they cannot
  // accumulate; a fresh landing rewrites its marker.
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(LANDED_PREFIX)) continue;
      const ts = Number(localStorage.getItem(key) ?? 0);
      if (now - ts >= MAX_AGE_MS) localStorage.removeItem(key);
    }
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
  writeEntry({ id: id ?? generateUUID(), sessionId, text, createdAt: Date.now() });
  prune();
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
let consecutiveRetries = 0;
const MAX_CONSECUTIVE_RETRIES = 12; // ~2-3 min of backoff, then wait for a reconnect/reload

function clearRetryTimer(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  retryDelayMs = RETRY_DELAY_MS;
  consecutiveRetries = 0;
}

/**
 * Schedule a follow-up flush for entries retained on a retryable rejection
 * (timeout, character limit). The connection-state effect does not re-fire
 * while already connected, so without this a retained entry would wait for an
 * unrelated reconnect or reload. Backs off exponentially, bounded by a retry
 * cap (a permanently-stuck entry then waits for a reconnect/reload; the TTL
 * bounds it overall).
 */
function scheduleFollowUpFlush(): void {
  if (retryTimer) return;
  if (consecutiveRetries >= MAX_CONSECUTIVE_RETRIES) return;
  consecutiveRetries += 1;
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
  try {
    for (const entry of pending) {
      if (!connectionManager.getHubIfConnected()) break; // dropped mid-flush
      try {
        await hub.request('session.appendVoiceDraft', {
          sessionId: entry.sessionId,
          text: entry.text,
          dedupId: entry.id,
        });
        removePendingTranscript(entry.id);
        delivered += 1;
        markVoiceTranscriptLanded(entry.sessionId);
      } catch (error) {
        // Socket dropped mid-flush: keep for the next reconnect. Otherwise the
        // daemon answered while connected: a timeout is ambiguous (the append
        // may have committed with a lost ack), and any non-permanent refusal is
        // retryable — keep those. Only a missing session can never recover.
        if (!connectionManager.getHubIfConnected()) break;
        if (isPermanentAppendRefusal(error)) removePendingTranscript(entry.id);
      }
    }
  } finally {
    flushInProgress = false;
  }
  // Retained entries (timeout / retryable refusal) need another pass; the
  // connection-state effect won't re-fire while already connected. Progress
  // resets the retry budget.
  if (delivered > 0) consecutiveRetries = 0;
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
    if (connectionState.value === 'connected') {
      setTimeout(() => void flushPendingTranscripts(), FLUSH_DELAY_MS);
    }
  } else if (key.startsWith(LANDED_PREFIX) && event.newValue !== null) {
    const sessionId = key.slice(LANDED_PREFIX.length);
    voiceTranscriptLandedSignal.value = new Set(voiceTranscriptLandedSignal.value).add(sessionId);
  }
}

/** Flush when the connection (re)establishes. Mirrors outbound-queue. */
export function startVoiceTranscriptOutboxFlush(): void {
  if (cleanupAutoFlush) return;
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
  voiceTranscriptLandedSignal.value = new Set();
}
