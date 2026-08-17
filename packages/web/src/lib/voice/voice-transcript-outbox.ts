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
 * Everything after delivery is DAEMON-coordinated: the server presents the
 * composition of typing + staged transcript on read, consumes the staging on
 * an adopting write or the voice-aware send-clear, and announces landings via
 * the `session.voiceLanded` channel event. This module holds no landing
 * state, no draft backups, and no cross-tab markers.
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

import { effect } from '@preact/signals';
import { generateUUID } from '@hyperneo/shared';
import { connectionManager } from '../connection-manager';
import { connectionState } from '../state';

export interface PendingTranscript {
  id: string;
  sessionId: string;
  text: string;
  createdAt: number;
}

const STORAGE_PREFIX = 'hyperneo_voice_transcript_outbox_v1.entry.';
const MAX_ENTRIES = 20;
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h — a transcript older than this is stale
const FLUSH_DELAY_MS = 500; // let subscriptions settle, like outbound-queue
const RETRY_DELAY_MS = 5_000; // base delay before a retained-entry retry
const MAX_RETRY_DELAY_MS = 60_000; // backoff ceiling for retained-entry retries

// Key namespaces written by the retired client-coordinated design (landing
// markers, draft backups, clear tombstones, supersede records, tab
// heartbeats). Nothing prunes them anymore, so a one-time sweep at startup
// keeps users' localStorage from carrying them forever.
const LEGACY_KEY_PREFIXES = [
  'hyperneo_voice_transcript_outbox_v1.landed.',
  'hyperneo_voice_transcript_outbox_v1.draft.',
  'hyperneo_voice_transcript_outbox_v1.clear.',
  'hyperneo_voice_transcript_outbox_v1.superseded.',
  'hyperneo_tab_heartbeat.',
];

function sweepLegacyKeys(): void {
  try {
    const staleKeys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && LEGACY_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        staleKeys.push(key);
      }
    }
    for (const key of staleKeys) localStorage.removeItem(key);
  } catch {
    /* storage unavailable — nothing to sweep */
  }
}

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
 * backoff. Landing announcements are the daemon's job: it emits
 * `session.voiceLanded` on the session channel for every genuine commit.
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
        await hub.request<{ success: boolean; deduped?: boolean }>('session.appendVoiceDraft', {
          sessionId: entry.sessionId,
          text: entry.text,
          dedupId: entry.id,
        });
        removePendingTranscript(entry.id);
        delivered += 1;
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
 * Cross-tab outbox sharing via the `storage` event (fires in OTHER tabs when
 * this tab writes localStorage, and vice versa): an entry key was written or
 * removed by another tab → that tab's disconnected enqueue is now visible
 * here — schedule a flush while this tab is connected.
 */
function handleStorageEvent(event: StorageEvent): void {
  const key = event.key;
  if (!key) return; // localStorage.clear()
  if (!key.startsWith(STORAGE_PREFIX)) return;
  if (event.newValue === null) {
    // Another tab flushed this shared entry and removed its key — drop the
    // local mirror too, or allEntries() (where the mirror wins on conflict)
    // would resurrect the entry here and replay an already-delivered id.
    mirror.delete(key.slice(STORAGE_PREFIX.length));
  }
  if (connectionState.value === 'connected') {
    setTimeout(() => void flushPendingTranscripts(), FLUSH_DELAY_MS);
  }
}

/** Flush when the connection (re)establishes. Mirrors outbound-queue. */
export function startVoiceTranscriptOutboxFlush(): void {
  if (cleanupAutoFlush) return;
  // TTL-clean at startup: expired entries are filtered from READS anyway, but
  // if the app reopens after >24h and no new transcript is ever enqueued,
  // nothing else would delete their keys. pruneExpired only — the capacity
  // RESERVATION in prune() assumes an enqueue follows and would otherwise
  // drop a still-deliverable transcript merely for reopening the app at the
  // cap. Also sweep the retired design's key namespaces once.
  pruneExpired();
  sweepLegacyKeys();
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
}
