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
 * Fired (non-null) whenever the outbox successfully lands an entry for a
 * session, so a MOUNTED composer for that session can refresh its draft —
 * the pending field is otherwise only merged by the daemon during session.get,
 * which the composer runs only on session change.
 */
export const voiceTranscriptLandedSignal = signal<{ sessionId: string } | null>(null);

const STORAGE_PREFIX = 'hyperneo_voice_transcript_outbox_v1.entry.';
const MAX_ENTRIES = 20;
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h — a transcript older than this is stale
const FLUSH_DELAY_MS = 500; // let subscriptions settle, like outbound-queue

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
  const entries = allEntries();
  if (entries.length <= MAX_ENTRIES) return;
  for (const entry of entries.slice(0, entries.length - MAX_ENTRIES)) {
    removeEntry(entry.id);
  }
}

/** Park a transcript for delivery once the daemon is reachable again. */
export function enqueueTranscript(sessionId: string, text: string): void {
  writeEntry({ id: generateUUID(), sessionId, text, createdAt: Date.now() });
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

/**
 * Replay all outbox entries through `session.appendVoiceDraft`, removing each
 * once the daemon acks (including an idempotent `deduped` ack — the entry
 * already merged). Stops early if the connection drops mid-flush. A REFUSAL
 * while the socket is still up (session gone, character limit) is permanent —
 * the entry is dropped rather than retried forever; only transport failures
 * keep the entry for the next reconnect.
 */
export async function flushPendingTranscripts(): Promise<void> {
  if (flushInProgress) return;
  const hub = connectionManager.getHubIfConnected();
  if (!hub) return;
  const pending = getPendingTranscripts();
  if (pending.length === 0) return;

  flushInProgress = true;
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
        voiceTranscriptLandedSignal.value = { sessionId: entry.sessionId };
      } catch {
        // If the socket dropped mid-flush, keep the entry for the next
        // reconnect. If it is still up, the daemon refused the append — that
        // is permanent, so drop the entry instead of retrying forever.
        if (!connectionManager.getHubIfConnected()) break;
        removePendingTranscript(entry.id);
      }
    }
  } finally {
    flushInProgress = false;
  }
}

let cleanupAutoFlush: (() => void) | null = null;

/** Flush when the connection (re)establishes. Mirrors outbound-queue. */
export function startVoiceTranscriptOutboxFlush(): void {
  if (cleanupAutoFlush) return;
  cleanupAutoFlush = effect(() => {
    if (connectionState.value === 'connected' && getPendingTranscripts().length > 0) {
      setTimeout(() => void flushPendingTranscripts(), FLUSH_DELAY_MS);
    }
  });
}

export function stopVoiceTranscriptOutboxFlush(): void {
  if (cleanupAutoFlush) {
    cleanupAutoFlush();
    cleanupAutoFlush = null;
  }
}

// HMR cleanup: tear down the old effect subscription before module re-eval.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (cleanupAutoFlush) {
      cleanupAutoFlush();
      cleanupAutoFlush = null;
    }
  });
}

/** For tests: reset module state. */
export function resetVoiceTranscriptOutbox(): void {
  flushInProgress = false;
  clearPendingTranscripts();
}
