// @ts-nocheck
/**
 * Tests for the durable voice-transcript outbox: transcripts staged when the
 * daemon was unreachable during an unmounted voice delivery are parked in
 * localStorage (each entry under its own key) and replayed through
 * session.appendVoiceDraft (with a per-entry dedupId) once the connection is
 * restored. A localStorage failure degrades to the in-session mirror instead
 * of dropping the copy, and a permanent RPC refusal while connected drops the
 * entry rather than retrying it forever.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hubRequest = vi.fn(async () => ({ success: true }));

vi.mock('../../connection-manager', () => ({
  connectionManager: { getHubIfConnected: vi.fn(() => ({ request: hubRequest })) },
}));

import {
  enqueueTranscript,
  flushPendingTranscripts,
  getPendingTranscripts,
  removePendingTranscript,
  resetVoiceTranscriptOutbox,
  startVoiceTranscriptOutboxFlush,
  stopVoiceTranscriptOutboxFlush,
} from '../voice-transcript-outbox.ts';
import { connectionManager } from '../../connection-manager.ts';
import { connectionState } from '../../state.ts';

// happy-dom's localStorage is unreliable across module boundaries — stub the
// global with an in-memory Storage, the established pattern in this repo.
function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k: string) => store.get(k) ?? null,
    key: (i: number) => [...store.keys()][i] ?? null,
    removeItem: (k: string) => void store.delete(k),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
  } as Storage;
}

const originalStorage = globalThis.localStorage;

describe('voice transcript outbox', () => {
  beforeEach(() => {
    globalThis.localStorage = createMemoryStorage();
    resetVoiceTranscriptOutbox();
    // mockReset (not clear) so a mockRejectedValueOnce left unconsumed by one
    // test cannot leak into the next as its first hubRequest call.
    hubRequest.mockReset().mockImplementation(async () => ({ success: true }));
    vi.mocked(connectionManager.getHubIfConnected).mockReset().mockReturnValue({
      request: hubRequest,
    });
    connectionState.value = 'disconnected';
  });

  afterEach(() => {
    globalThis.localStorage = originalStorage;
    stopVoiceTranscriptOutboxFlush();
    vi.useRealTimers();
  });

  it('parks a transcript and reads it back', () => {
    enqueueTranscript('s1', 'hello world');
    const entries = getPendingTranscripts();
    expect(entries).toHaveLength(1);
    expect(entries[0].sessionId).toBe('s1');
    expect(entries[0].text).toBe('hello world');
    expect(typeof entries[0].id).toBe('string');
  });

  it('prunes to the entry cap (oldest dropped)', () => {
    for (let i = 0; i < 25; i++) enqueueTranscript('s1', `t${i}`);
    const entries = getPendingTranscripts();
    expect(entries.length).toBeLessThanOrEqual(20);
    // The newest survive.
    expect(entries[entries.length - 1].text).toBe('t24');
  });

  it('preserves the entry in the in-session mirror when localStorage rejects writes', () => {
    // Storage disabled / over quota: setItem throws. The mirror must still hold
    // the entry so the user's "saved" toast is true for this session.
    const throwStorage = createMemoryStorage();
    throwStorage.setItem = () => {
      throw new DOMException('quota', 'QuotaExceededError');
    };
    globalThis.localStorage = throwStorage;

    enqueueTranscript('s1', 'survives storage failure');
    const entries = getPendingTranscripts();
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe('survives storage failure');
  });

  it('flushes entries through appendVoiceDraft with a dedupId and removes on ack', async () => {
    enqueueTranscript('s1', 'first');
    enqueueTranscript('s1', 'second');
    await flushPendingTranscripts();

    expect(hubRequest).toHaveBeenCalledTimes(2);
    const calls = hubRequest.mock.calls.map(([m, data]) => data);
    expect(calls.every((d) => d.sessionId === 's1')).toBe(true);
    expect(calls.every((d) => typeof d.dedupId === 'string' && d.dedupId.length > 0)).toBe(true);
    expect(getPendingTranscripts()).toHaveLength(0);
  });

  it('drops only an entry whose session no longer exists (permanent, no infinite retry)', async () => {
    enqueueTranscript('s1', 'gone');
    hubRequest.mockRejectedValueOnce(new Error('Session not found'));
    await flushPendingTranscripts();
    // A missing session can never recover — dropping avoids retrying forever.
    expect(getPendingTranscripts()).toHaveLength(0);
  });

  it('retains an entry the daemon refuses for a RETRYABLE reason (full pending draft)', async () => {
    enqueueTranscript('s1', 'blocked');
    hubRequest.mockRejectedValueOnce(new Error('Pending voice draft is at the character limit'));
    await flushPendingTranscripts();
    // The refusal is not permanent — the user can send/clear the draft to make
    // room, so a transcript promised as saved must not be dropped. The follow-up
    // retry timer is cleared by afterEach.
    expect(getPendingTranscripts()).toHaveLength(1);
  });

  it('keeps an entry on an ambiguous Request timeout (append may have committed)', async () => {
    enqueueTranscript('s1', 'ambiguous');
    // The socket dropped after the request was sent — the append may have
    // committed with a lost ack, or never arrived. Retain the entry; the
    // daemon's dedup set makes the eventual retry idempotent either way.
    hubRequest.mockRejectedValueOnce(
      new Error('Request timeout: session.appendVoiceDraft (10000ms)')
    );
    await flushPendingTranscripts();
    expect(getPendingTranscripts()).toHaveLength(1);
  });

  it('kicks a flush when enqueuing while already connected', async () => {
    vi.useFakeTimers();
    connectionState.value = 'connected';
    enqueueTranscript('s1', 'fresh');
    expect(getPendingTranscripts()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(600);
    expect(hubRequest).toHaveBeenCalled();
    expect(getPendingTranscripts()).toHaveLength(0);
  });

  it('persists a new entry when pruning frees the quota it needs (prune-before-write)', () => {
    // Seed 21 outbox keys directly (over the cap) in a quota-limited store: an
    // outbox-entry setItem throws while at capacity, so the new entry persists
    // only if prune() runs FIRST and removes an over-cap slot.
    const backing = new Map<string, string>();
    for (let i = 0; i < 21; i++) {
      backing.set(
        `hyperneo_voice_transcript_outbox_v1.entry.old-${i}`,
        JSON.stringify({ id: `old-${i}`, sessionId: 's1', text: `t${i}`, createdAt: Date.now() })
      );
    }
    const quotaStorage = {
      get length() {
        return backing.size;
      },
      clear: () => backing.clear(),
      getItem: (k: string) => backing.get(k) ?? null,
      key: (i: number) => [...backing.keys()][i] ?? null,
      removeItem: (k: string) => void backing.delete(k),
      setItem: (k: string, v: string) => {
        if (k.startsWith('hyperneo_voice_transcript_outbox_v1.entry.') && backing.size >= 21) {
          throw new DOMException('quota', 'QuotaExceededError');
        }
        backing.set(k, String(v));
      },
    } as Storage;
    globalThis.localStorage = quotaStorage;

    enqueueTranscript('s1', 'newest');
    // The new entry survived in localStorage (a reload would keep it), not
    // just the in-session mirror.
    expect([...backing.values()].some((raw) => raw.includes('newest'))).toBe(true);
  });

  it('resumes delivery once a full draft frees up (no hard retry cap)', async () => {
    vi.useFakeTimers();
    enqueueTranscript('s1', 'blocked');
    // First flush: the pending draft is full → the entry is retained and a
    // follow-up retry is scheduled.
    hubRequest.mockRejectedValueOnce(new Error('Pending voice draft is at the character limit'));
    await flushPendingTranscripts();
    expect(getPendingTranscripts()).toHaveLength(1);
    // The user sends/clears the draft → room appears → the steady backoff
    // retry keeps checking and now succeeds, with no cap that permanently
    // stops delivery.
    hubRequest.mockResolvedValue({ success: true });
    await vi.advanceTimersByTimeAsync(70_000);
    expect(getPendingTranscripts()).toHaveLength(0);
  });

  it('prunes expired keys even when the live set is under the cap', () => {
    // Seed a stale entry directly (createdAt beyond the TTL) so allEntries()
    // hides it from reads — but prune() must still remove the key from storage,
    // or expired entries would accumulate unboundedly.
    const stale = {
      id: 'stale-1',
      sessionId: 's1',
      text: 'old',
      createdAt: Date.now() - 25 * 60 * 60 * 1000,
    };
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.entry.stale-1',
      JSON.stringify(stale)
    );
    enqueueTranscript('s1', 'fresh');
    expect(getPendingTranscripts().map((e) => e.text)).toEqual(['fresh']);
    expect(localStorage.getItem('hyperneo_voice_transcript_outbox_v1.entry.stale-1')).toBeNull();
  });

  it('keeps entries for retry when the socket drops mid-flush', async () => {
    enqueueTranscript('s1', 'a');
    enqueueTranscript('s1', 'b');
    // The second append's RPC drops (socket goes down) after the first landed.
    hubRequest.mockImplementationOnce(async () => ({ success: true }));
    hubRequest.mockRejectedValueOnce(new Error('socket closed'));
    vi.mocked(connectionManager.getHubIfConnected)
      .mockReturnValueOnce({ request: hubRequest }) // flush start
      .mockReturnValueOnce({ request: hubRequest }) // loop check for 'a'
      .mockReturnValueOnce({ request: hubRequest }) // loop check for 'b'
      .mockReturnValue(null); // connection dropped after the RPC failed
    await flushPendingTranscripts();
    expect(getPendingTranscripts()).toHaveLength(1);
    expect(getPendingTranscripts()[0].text).toBe('b');
  });

  it('defers later entries for a session after an older one is retained (per-session FIFO)', async () => {
    enqueueTranscript('s1', 'older');
    enqueueTranscript('s1', 'newer');
    enqueueTranscript('s2', 'other');
    // The older s1 entry is retained (draft too full); the NEWER s1 entry must
    // not be appended ahead of it, while s2 still proceeds.
    hubRequest.mockRejectedValueOnce(new Error('Pending voice draft is at the character limit'));
    await flushPendingTranscripts();
    const sessions = hubRequest.mock.calls.map(([m, d]) => d?.sessionId);
    expect(sessions.filter((s) => s === 's2')).toHaveLength(1);
    expect(sessions.filter((s) => s === 's1')).toHaveLength(1); // only the older s1 was attempted
    expect(getPendingTranscripts().map((e) => e.text)).toEqual(['older', 'newer']);
  });

  it('keeps a full live queue intact at startup (no slot reservation without an enqueue)', () => {
    // Exactly MAX live entries (all fresh): startup must NOT enforce the
    // pre-enqueue slot reservation — that assumes a write follows, and here it
    // would permanently drop the oldest still-deliverable transcript.
    const entries = Array.from({ length: 20 }, (_, i) => ({
      id: `e${i}`,
      sessionId: 's1',
      text: `t${i}`,
      createdAt: Date.now() - i,
    }));
    for (const entry of entries) {
      localStorage.setItem(
        `hyperneo_voice_transcript_outbox_v1.entry.${entry.id}`,
        JSON.stringify(entry)
      );
    }
    startVoiceTranscriptOutboxFlush();
    for (const entry of entries) {
      expect(
        localStorage.getItem(`hyperneo_voice_transcript_outbox_v1.entry.${entry.id}`)
      ).not.toBeNull();
    }
    stopVoiceTranscriptOutboxFlush();
  });

  it('removes an entry that the daemon reports as already merged (deduped ack)', async () => {
    enqueueTranscript('s1', 'already landed');
    hubRequest.mockResolvedValueOnce({ success: true, deduped: true });
    await flushPendingTranscripts();
    expect(getPendingTranscripts()).toHaveLength(0);
  });

  it('cleans an entry whose TTL expires in a long-lived tab on the next flush', async () => {
    enqueueTranscript('s1', 'ages out');
    // The entry expires (24h pass) while the tab stays open: reads filter it,
    // and without this flush-path cleanup its key would linger forever (the
    // startup prune never re-runs).
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(25 * 60 * 60 * 1000);
    expect(getPendingTranscripts()).toHaveLength(0);
    await flushPendingTranscripts();
    expect(getPendingTranscripts()).toHaveLength(0);
    const keys = Object.keys(localStorage) as string[];
    expect(keys.some((k) => k.startsWith('hyperneo_voice_transcript_outbox_v1.entry.'))).toBe(
      false
    );
  });

  it('does nothing when the connection is down', async () => {
    enqueueTranscript('s1', 'waiting');
    vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(null);
    await flushPendingTranscripts();
    expect(hubRequest).not.toHaveBeenCalled();
    expect(getPendingTranscripts()).toHaveLength(1);
  });

  it('auto-flushes when the connection (re)establishes', async () => {
    vi.useFakeTimers();
    enqueueTranscript('s1', 'queued while down');
    startVoiceTranscriptOutboxFlush();
    connectionState.value = 'connected';
    await vi.advanceTimersByTimeAsync(600);
    expect(hubRequest).toHaveBeenCalled();
    expect(getPendingTranscripts()).toHaveLength(0);
  });

  it('flushes an entry another tab wrote to shared storage (storage event)', async () => {
    vi.useFakeTimers();
    // Another tab wrote the entry to the shared localStorage, then the storage
    // event fired here — this connected tab must flush it rather than wait for
    // an unrelated reconnect.
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.entry.other',
      JSON.stringify({ id: 'other', sessionId: 's2', text: 'hi', createdAt: Date.now() })
    );
    startVoiceTranscriptOutboxFlush();
    connectionState.value = 'connected';
    window.dispatchEvent(
      new StorageEvent('storage', { key: 'hyperneo_voice_transcript_outbox_v1.entry.other' })
    );
    await vi.advanceTimersByTimeAsync(600);
    expect(hubRequest).toHaveBeenCalledWith(
      'session.appendVoiceDraft',
      expect.objectContaining({ sessionId: 's2', text: 'hi' })
    );
    stopVoiceTranscriptOutboxFlush();
  });

  it('drops the local mirror when another tab removes a shared entry key', () => {
    // Tab A enqueues (mirror + shared key); connected tab B flushes the shared
    // entry and removes its key. A's mirror must follow the removal, or
    // allEntries() (mirror wins on conflict) resurrects the entry here and
    // replays an already-delivered id as a FALSE landing that suppresses
    // draft saves.
    enqueueTranscript('s1', 'shared text');
    expect(getPendingTranscripts()).toHaveLength(1);
    const [entry] = getPendingTranscripts();
    localStorage.removeItem(`hyperneo_voice_transcript_outbox_v1.entry.${entry.id}`);
    startVoiceTranscriptOutboxFlush();
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: `hyperneo_voice_transcript_outbox_v1.entry.${entry.id}`,
        newValue: null,
      })
    );
    expect(getPendingTranscripts()).toHaveLength(0);
    stopVoiceTranscriptOutboxFlush();
  });

  it('prunes expired entries at startup even if nothing is ever enqueued again', () => {
    // The app reopens >24h after transcripts were queued: reads filter the
    // entries out, but without a startup prune their keys would linger forever
    // (prune otherwise runs only before an enqueue write).
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.entry.stale',
      JSON.stringify({
        id: 'stale',
        sessionId: 's1',
        text: 'old',
        createdAt: Date.now() - 25 * 60 * 60 * 1000,
      })
    );
    startVoiceTranscriptOutboxFlush();
    expect(localStorage.getItem('hyperneo_voice_transcript_outbox_v1.entry.stale')).toBeNull();
    stopVoiceTranscriptOutboxFlush();
  });

  it('delivers the OLDEST batch when concurrent enqueues exceed the cap', () => {
    // Two tabs' pre-write prunes cannot see each other's writes, so more
    // than 20 live keys can exist. The flush batch must start at the OLDEST
    // entry, or the hidden older transcript would append AFTER the newer
    // ones and reverse the order the user dictated them in.
    for (let i = 0; i < 25; i++) {
      localStorage.setItem(
        `hyperneo_voice_transcript_outbox_v1.entry.over-${i}`,
        JSON.stringify({
          id: `over-${i}`,
          sessionId: 's1',
          text: `t${i}`,
          createdAt: Date.now() + i,
        })
      );
    }
    const pending = getPendingTranscripts();
    expect(pending).toHaveLength(20);
    expect(pending[0].text).toBe('t0'); // oldest-first
    expect(pending[19].text).toBe('t19');
  });

  it('removePendingTranscript drops a single entry', () => {
    enqueueTranscript('s1', 'a');
    enqueueTranscript('s1', 'b');
    const [first] = getPendingTranscripts();
    removePendingTranscript(first.id);
    const rest = getPendingTranscripts();
    expect(rest).toHaveLength(1);
    expect(rest[0].text).toBe('b');
  });
});
