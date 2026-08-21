import { generateUUID } from '@hyperneo/shared';
import { effect } from '@preact/signals';
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
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FLUSH_DELAY_MS = 500;
const RETRY_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 60_000;

const LEGACY_KEY_PREFIXES = [
  'hyperneo_voice_transcript_outbox_v1.entry.landed.',
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
  } catch {}
}

const mirror = new Map<string, PendingTranscript>();

function entryKey(id: string): string {
  return `${STORAGE_PREFIX}${id}`;
}

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
      } catch {}
    }
  } catch {}
  return out;
}

function allEntries(): PendingTranscript[] {
  const merged = collectFromStorage();
  for (const [id, entry] of mirror) merged.set(id, entry);
  return [...merged.values()]
    .filter((e) => Date.now() - (e.createdAt ?? 0) < MAX_AGE_MS)
    .sort((a, b) => a.createdAt - b.createdAt);
}

function writeEntry(entry: PendingTranscript): boolean {
  mirror.set(entry.id, entry);
  try {
    localStorage.setItem(entryKey(entry.id), JSON.stringify(entry));
    return true;
  } catch {
    return false;
  }
}

function removeEntry(id: string): void {
  mirror.delete(id);
  try {
    localStorage.removeItem(entryKey(id));
  } catch {}
}

function prune(): void {
  pruneExpired();
  const live = allEntries();
  if (live.length < MAX_ENTRIES) return;
  for (const entry of live.slice(0, live.length - (MAX_ENTRIES - 1))) {
    removeEntry(entry.id);
  }
}

function pruneExpired(): void {
  const now = Date.now();
  const stored = collectFromStorage();
  for (const [id, entry] of stored) {
    if (now - (entry.createdAt ?? 0) >= MAX_AGE_MS) removeEntry(id);
  }
  for (const [id, entry] of mirror) {
    if (now - (entry.createdAt ?? 0) >= MAX_AGE_MS) removeEntry(id);
  }
}

export function isPermanentAppendRefusal(error: unknown): boolean {
  return error instanceof Error && /Session not found/.test(error.message);
}

export function enqueueTranscript(sessionId: string, text: string, id?: string): boolean {
  prune();
  const durable = writeEntry({ id: id ?? generateUUID(), sessionId, text, createdAt: Date.now() });
  if (connectionState.value === 'connected') {
    setTimeout(() => void flushPendingTranscripts(), FLUSH_DELAY_MS);
  }
  return durable;
}

export function getPendingTranscripts(): PendingTranscript[] {
  return allEntries();
}

export function removePendingTranscript(id: string): void {
  removeEntry(id);
}

export function clearPendingTranscripts(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(STORAGE_PREFIX)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {}
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

function scheduleFollowUpFlush(): void {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void flushPendingTranscripts();
  }, retryDelayMs);
  retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS);
}

export async function flushPendingTranscripts(): Promise<void> {
  if (flushInProgress) return;
  const hub = connectionManager.getHubIfConnected();
  if (!hub) return;
  const pending = getPendingTranscripts();
  if (pending.length === 0) {
    pruneExpired();
    return;
  }

  flushInProgress = true;
  let delivered = 0;
  const deferredSessions = new Set<string>();
  try {
    for (const entry of pending) {
      if (!connectionManager.getHubIfConnected()) break;
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
        if (!connectionManager.getHubIfConnected()) break;
        if (isPermanentAppendRefusal(error)) removePendingTranscript(entry.id);
        else deferredSessions.add(entry.sessionId);
      }
    }
  } finally {
    flushInProgress = false;
    pruneExpired();
  }
  if (delivered > 0) retryDelayMs = RETRY_DELAY_MS;
  if (getPendingTranscripts().length > 0 && connectionManager.getHubIfConnected()) {
    scheduleFollowUpFlush();
  } else {
    clearRetryTimer();
  }
}

let cleanupAutoFlush: (() => void) | null = null;
let cleanupStorageListener: (() => void) | null = null;

function handleStorageEvent(event: StorageEvent): void {
  const key = event.key;
  if (!key) return;
  if (!key.startsWith(STORAGE_PREFIX)) return;
  if (event.newValue === null) {
    mirror.delete(key.slice(STORAGE_PREFIX.length));
  }
  if (connectionState.value === 'connected') {
    setTimeout(() => void flushPendingTranscripts(), FLUSH_DELAY_MS);
  }
}

export function startVoiceTranscriptOutboxFlush(): void {
  if (cleanupAutoFlush) return;
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

export function resetVoiceTranscriptOutbox(): void {
  flushInProgress = false;
  clearRetryTimer();
  clearPendingTranscripts();
}
