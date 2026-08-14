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
 * and its landing session remain at risk) in localStorage so it survives a
 * page reload, and replays it through the same append RPC on reconnect.
 *
 * Replay is idempotent via a per-entry `dedupId`: the daemon records the last
 * merged outbox id per session and skips a re-append that already committed
 * (the socket can drop between the daemon's write and its ack). Mirrors the
 * outbound-queue reconnect-flush pattern.
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

const STORAGE_KEY = 'hyperneo_voice_transcript_outbox_v1';
const MAX_ENTRIES = 20;
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h — a transcript older than this is stale
const FLUSH_DELAY_MS = 500; // let subscriptions settle, like outbound-queue

function readStored(): PendingTranscript[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return [];
    const entries: PendingTranscript[] = JSON.parse(stored);
    if (!Array.isArray(entries)) return [];
    return entries
      .filter((e) => typeof e.id === 'string' && typeof e.sessionId === 'string')
      .filter((e) => Date.now() - (e.createdAt ?? 0) < MAX_AGE_MS);
  } catch {
    return [];
  }
}

function writeStored(entries: PendingTranscript[]): void {
  try {
    // Keep the NEWEST cap — the oldest are the most likely to be stale.
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
  } catch {
    /* storage unavailable/full — the in-memory fallback is best-effort */
  }
}

/** Park a transcript for delivery once the daemon is reachable again. */
export function enqueueTranscript(sessionId: string, text: string): void {
  const entries = readStored();
  entries.push({ id: generateUUID(), sessionId, text, createdAt: Date.now() });
  writeStored(entries);
}

export function getPendingTranscripts(): PendingTranscript[] {
  return readStored();
}

export function removePendingTranscript(id: string): void {
  writeStored(readStored().filter((e) => e.id !== id));
}

/** Drop everything (tests / user clear). */
export function clearPendingTranscripts(): void {
  writeStored([]);
}

let flushInProgress = false;

/**
 * Replay all outbox entries through `session.appendVoiceDraft`, removing each
 * once the daemon acks (including an idempotent `deduped` ack — the entry
 * already merged). Stops early if the connection drops mid-flush; entries are
 * kept on any error and retried on the next reconnect, bounded by the TTL.
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
      } catch {
        if (!connectionManager.getHubIfConnected()) break;
        // Daemon reachable but refused (session gone, limit) — keep the entry;
        // TTL bounds how long a permanently-dead entry retries.
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
